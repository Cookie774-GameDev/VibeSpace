# Terminal persistence across shutdown, updates, and tray

> **Status:** Implementation spec (June 2026)  
> **Audience:** Engineers implementing durable terminal restore in VibeSpace  
> **Related:** `app/src/features/terminals/`, `app/src-tauri/src/terminal.rs`, `app/src-tauri/src/launcher.rs`

---

## Problem statement

Users expect terminal panes to survive:

| Event | User expectation | Today (0.1.42) |
|-------|------------------|----------------|
| Close window → tray | PTYs keep running; layout + scrollback intact | **Works** — process stays alive |
| Reopen from tray | Same shells, same scrollback | **Works** — live cache + Rust PTY map |
| Normal app quit (Exit tray menu) | Optional: save layout + scrollback tail | **Partial** — transcripts flush if `beforeunload` runs |
| **Auto-update / relaunch** | Layout + scrollback restored after restart | **Weak** — PTYs die; restore depends on flush timing |
| **OS shutdown / reboot** | Same as update | **Weak** — hard kill; debounced writes may be lost |
| **`jarvis` in terminal** | Opens **latest installed** build | **Fixed in launcher** — picks highest `ProductVersion` among install paths |

**Important distinction:** PTY processes **cannot** survive a full process exit (update, reboot, Exit). What we can persist is:

1. **Pane layout** — which tiles, commands, cwd, agent tags, pane ids  
2. **Scrollback tail** — last ~32 KB per session (plain text, ANSI stripped)  
3. **Current input line** — partial command typed before kill  
4. **Live re-attach** — only while the Rust process is still running (tray hide)

Interactive TUIs (`claude`, `opencode`, etc.) **intentionally** do not replay scrollback into a new PTY (see `restoreSession.ts` → `restoredTextForDeadSession`). A fresh TUI session starts clean; only plain shells get text reinjected.

---

## Architecture today

### Layer 1 — Rust PTY (`app/src-tauri/src/terminal.rs`)

- One `jarvis` desktop process owns all PTYs in a `HashMap<sessionId, Session>`.
- **Dies** when the process exits (tray → Exit, updater relaunch, OS shutdown).
- Commands: `terminal_spawn`, `terminal_write`, `terminal_list`, `terminal_kill`, `terminal_move`.

### Layer 2 — WebView / xterm (`TerminalView.tsx`)

- Subscribes to `terminal://output` and `terminal://exit`.
- On unmount: **does not** `terminal_kill` — sessions stay alive for re-attach.
- Uses `resolveTerminalRestoreSession()` to attach or respawn.

### Layer 3 — Transcript store (`transcriptStore.ts`)

| Key | Purpose |
|-----|---------|
| `jarvis-terminal-transcripts` | Primary Zustand persist blob |
| `jarvis-terminal-transcripts-backup` | Fallback if primary empty/corrupt |

- Cap: 10 sessions, 32 KB each, 512 KB total.
- Flush: debounced 350 ms; `pagehide`, `beforeunload`, `visibilitychange`.
- **Gap:** Updater `relaunch()` and Windows shutdown may skip `beforeunload`.

### Layer 4 — Pane tree (`terminalProjectMove.ts`, `TerminalsPage.tsx`)

| Key | Purpose |
|-----|---------|
| `jarvis-terminal-pane-tree:<projectId>` | Split layout + leaf metadata |

- Persists: pane ids, commands, cwd, `agentSlug`, **`sessionId`** (when saved).
- Debounced 350 ms on tree change; flush on React effect cleanup.
- **Gap:** Tray hide does not unmount `TerminalsPage` on all routes — tree may be stale until next edit.

### Layer 5 — Live cache (`terminalLiveCache.ts`)

- In-memory `Map<projectId, PaneNode>` with live `sessionId`s.
- Survives project switch and route changes **within one process lifetime**.
- **Lost** on any full process restart.

### Layer 6 — Workspace UI (`stores/ui.ts`)

- `jarvis-ui` — active chat, project, nav state (debounced 400 ms).
- Route is **transient** (not restored after reload).

---

## Why “close to tray” works but update/reboot does not

```
┌─────────────────────────────────────────────────────────────┐
│  User closes window (X)                                      │
│    → lib.rs: CloseRequested → hide window, prevent_close    │
│    → Process + PTYs + live cache STAY ALIVE                   │
│    → jarvis:before-hide → flushWorkspacePersistence (0.1.42+) │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  User chooses Exit from tray OR updater relaunch OR reboot    │
│    → Process TERMINATES → all PTYs killed                      │
│    → Only localStorage + IndexedDB survive                     │
│    → Must have flushed transcripts + pane trees BEFORE exit    │
└─────────────────────────────────────────────────────────────┘
```

---

## `jarvis` terminal launcher (Windows)

**Location:** `%USERPROFILE%\.jarvis\bin\` (installed on app boot via `install_terminal_launcher`)

| File | Role |
|------|------|
| `Jarvis.cmd` / `jarvis` | Boot animation wrapper |
| `JarvisUpdate.ps1` | Checks `releases/channel.json`, runs silent installer if newer |
| `JarvisCore.ps1` | Starts installed exe |

**Install paths scanned (highest `ProductVersion` wins):**

- `%LOCALAPPDATA%\Programs\VibeSpace\jarvis.exe`
- `%LOCALAPPDATA%\Programs\VibeSpace\VibeSpace.exe`
- `%LOCALAPPDATA%\VibeSpace\jarvis.exe` / `VibeSpace.exe`
- Legacy `Jarvis One` paths (same names)

**After updating VibeSpace:** Open the app once from Start Menu (refreshes launcher scripts), or run:

```powershell
# Re-register PATH launcher after manual install
& "$env:LOCALAPPDATA\Programs\VibeSpace\jarvis.exe"
```

Typing `jarvis` in a **new** terminal session runs `JarvisUpdate.ps1` first, then launches the newest binary.

---

## Implementation plan

### Phase 1 — Flush hooks (shipped 0.1.42+)

**Goal:** Stop losing debounced data on hide/update.

| Hook | Action |
|------|--------|
| `jarvis:before-hide` | `flushWorkspacePersistence()` |
| `checkForAppUpdate({ install: true })` | flush before `downloadAndInstall` |
| `pagehide` / `beforeunload` | transcripts already flush; workspace flush on hide |

**Files:**

- `app/src/lib/persistence/workspaceFlush.ts` — orchestrator
- `app/src/App.tsx` — tray hide
- `app/src/lib/updates.ts` — pre-install

**Verify:**

1. Open terminals, type without waiting 400 ms, hide to tray → reopen → layout intact.
2. Trigger update → after relaunch, pane **shapes** and transcript **tails** restore.

### Phase 2 — Rust pre-exit snapshot (recommended next)

**Goal:** Reliable flush even when WebView does not get `beforeunload`.

1. Add Tauri command `workspace_request_persist` → emit `jarvis:persist-now` to frontend.
2. On `RunEvent::ExitRequested` (tray Exit only, not hide):
   - Invoke persist hook with 2 s timeout
   - Then allow exit
3. Updater plugin: call same hook before `relaunch()`.

**Rust sketch (`lib.rs`):**

```rust
RunEvent::ExitRequested { api, .. } => {
    let _ = app.emit("jarvis:persist-now", ());
    // optional: block up to 2s waiting for frontend ack
    api.prevent_exit(); // only if implementing graceful shutdown UI
}
```

**Frontend (`App.tsx`):**

```typescript
listen('jarvis:persist-now', () => flushWorkspacePersistence('rust-exit'));
```

### Phase 3 — Persist pane trees on every tray hide (not only Terminals route)

**Goal:** User on Chat route still has terminal trees saved.

1. On `jarvis:before-hide`, `forEachLiveTree` already runs via `workspaceFlush`.
2. Additionally: read all `jarvis-terminal-pane-tree:*` keys and merge with live cache (live wins).
3. Optional: persist active project id in `jarvis-ui` (already partialed).

### Phase 4 — Boot reconciliation (`terminal_list` + `restoreSession`)

**Goal:** After reload, reattach to orphaned PTYs if process survived (single-instance edge case).

Already partially spec'd in `terminalLiveCache.ts` caveats.

1. On boot, `invoke('terminal_list')`.
2. For each backend session, match `projectId` + `command` + `cwd` to pane leaves.
3. Rewrite `sessionId` on leaves before `TerminalView` mounts.

### Phase 5 — Disk-backed scrollback (longer history)

**Goal:** Survive reboot with more than 32 KB per pane.

From `implementation-plan/v2/plan-C-terminals.md` §1.3 `scrollback.rs`:

- Rust ring buffer per session, spill to `%APPDATA%\VibeSpace\terminals\<sessionId>.scroll`.
- On spawn-after-death, stream tail back into xterm via `terminal_write` or initial paste.

### Phase 6 — TUI session markers (optional, hard)

For `claude` / `opencode` / `codex`:

- Do **not** paste old scrollback (breaks TUI state).
- Persist metadata: “was running claude in pane X” → show banner: *“Session ended — press Up for history or re-run claude”*.
- Future: integrate with tool-specific resume flags if CLI supports them.

---

## Data model reference

### Transcript session (`SessionTranscript`)

```typescript
{
  sessionId: string;
  paneId: string | null;
  projectId: string | null;
  agentSlug: string | null;
  command: string | null;
  text: string;           // ANSI-stripped tail
  rawText: string;
  currentInput: string;   // restored on respawn
  lastWriteAt: number;
}
```

### Pane leaf (`paneTree.ts`)

```typescript
{
  kind: 'leaf';
  id: string;              // stable pane id (persisted)
  sessionId: string | null;
  projectId: string | null;
  command?: string;
  startupCommand?: string;
  cwd?: string;
  agentSlug?: string;
  // ...
}
```

### Restore decision (`restoreSession.ts`)

| `kind` | When |
|--------|------|
| `attach` | Backend still has `sessionId` |
| `spawn` | New PTY; may inject `restoredText` + `restoredInput` |

---

## Testing checklist

### Tray

- [ ] Open 2 panes, run `echo hello`, close window (X), reopen from tray → both panes alive, output visible.
- [ ] Same with app on Chat route (not Terminals page) before hide.

### Update (0.1.41 → 0.1.42)

- [ ] Leave terminals open, accept update, relaunch → pane **layout** returns; scrollback **tail** visible for plain shell.
- [ ] `claude` pane → new empty TUI (expected); pane slot and command preserved.

### Reboot

- [ ] Plain shell with unique string in output → reboot → reopen app → string appears in restored tail (after Phase 1–2).

### Launcher

- [ ] `jarvis` in PowerShell opens `%LOCALAPPDATA%\Programs\VibeSpace\` binary with **highest** `ProductVersion`.
- [ ] After GitHub update, `jarvis` runs update script then opens new build.

---

## Files to touch (summary)

| File | Phase |
|------|-------|
| `app/src/lib/persistence/workspaceFlush.ts` | 1 ✓ |
| `app/src/App.tsx` | 1 ✓ |
| `app/src/lib/updates.ts` | 1 ✓ |
| `app/src-tauri/src/launcher.rs` | 1 ✓ (exe resolution) |
| `app/src-tauri/src/lib.rs` | 2 (exit persist) |
| `app/src/features/terminals/restoreSession.ts` | 4 |
| `app/src-tauri/src/terminal.rs` + `scrollback.rs` | 5 |
| `app/src/features/updates/UpdateWarningHost.tsx` | 1 (call flush on “Update Now”) |

---

## User-facing copy (Settings → About → Terminals)

> **Terminal persistence**  
> Closing VibeSpace to the tray keeps your shells running.  
> Quitting, updating, or restarting your PC saves your layout and recent output; interactive tools (Claude Code, OpenCode) restart fresh in the same pane.

---

## Open questions

1. **Exit vs hide:** Should tray → Exit kill PTYs immediately or offer “Save and quit”?
2. **Multi-instance:** Single-instance plugin is active — document that second `jarvis` focuses existing window.
3. **Supabase sync:** Plan B mentioned `terminal_scrollback` table — out of scope until cloud sync ships.
