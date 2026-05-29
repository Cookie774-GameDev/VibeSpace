# Plan C - Terminal Subsystem (V2)

> Planner C scope: PTY backend, xterm-based renderer, split-pane grid, presets, per-project sessions, Jarvis control surface, hotkeys, persistence, multi-project dashboard, performance guardrails. Inspired by BridgeMind's BridgeSpace ADE; reframed for a general-purpose AI workspace.

Author: Planner C
Status: Proposed
Coordinates with: Planner A (theme/motion), Planner B (data + sync), Planner D (voice/agents/intent), Planner E (settings/installer).

---

## 0. Summary

V2 introduces real, PTY-backed terminals as a first-class workspace surface. Every project owns N sessions; they tile in a split-pane grid where every pane is visible and writable. A shipped library of presets covers Claude Code, OpenCode, raw shells, and language REPLs. A user-defined preset table lets users author their own. Jarvis (voice + palette + agents) can spawn, focus, write, and read from any session through a single event bus and a small set of Tauri commands. Sessions survive view changes (detach/reattach) but die when the app exits; layouts and preset definitions persist.

---

## 1. PTY Backend (Rust)

### 1.1 Crate choice

**`portable-pty = "0.8"`** (Wez Furlong / wezterm). Justification:

- First-class **Windows ConPTY** support (auto-falls-back to winpty on Win7, but we require Win10+ via Tauri so ConPTY only).
- Unified API across macOS/Linux/Windows. We need one set of code paths, not three.
- Clean child-process lifetime model (`Child` returned with `wait()`, `kill()`, `try_wait()`) and resizable masters (`MasterPty::resize`).
- Battle-tested in wezterm; far fewer pitfalls than rolling our own around `winapi::um::consoleapi::CreatePseudoConsole` + `nix::pty::openpty`.
- Active maintenance.

Alternatives considered:
- `pty-process` - Unix only, no ConPTY.
- `tokio-pty` - thin Unix wrapper, abandoned.
- `conpty` (crate) - Windows only, lower-level.
- Hand-rolled `nix` + `winapi` - not worth the maintenance burden.

### 1.2 Cargo additions

Append to `app/src-tauri/Cargo.toml`:

```toml
[dependencies]
# ...existing...
portable-pty = "0.8"
tokio = { version = "1.40", features = ["rt-multi-thread", "sync", "io-util", "macros", "time"] }
tokio-util = { version = "0.7", features = ["io"] }
parking_lot = "0.12"
dashmap = "6"
bytes = "1.7"
base64 = "0.22"
tracing = "0.1"
anyhow = "1"
thiserror = "1"
once_cell = "1.19"
which = "6"        # discover claude / opencode / pwsh / etc. on PATH
```

No new Tauri plugins. PTY work happens in our own module (no plugin abstraction needed).

### 1.3 File layout

```
app/src-tauri/src/
  lib.rs                       (existing - register pty commands and Registry state)
  pty/
    mod.rs                     (public surface, command exports, types)
    error.rs                   (PtyError + serde repr for JS)
    registry.rs                (DashMap<SessionId, Arc<Session>> + spawn/list/kill)
    session.rs                 (Session struct + IO loops + lifecycle)
    spawn.rs                   (preset/shell resolution, env, cwd validation)
    scrollback.rs              (ring buffer + spill-to-disk)
    osc.rs                     (parser for OSC 0/2 title and BEL events)
    discovery.rs               (probe PATH for claude/opencode/pwsh/etc.)
```

### 1.4 Type contracts (the JS<->Rust IPC surface)

```rust
// pty/mod.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub preset_id: Option<String>,
    pub preset_slug: Option<String>,
    pub title: Option<String>,
    pub one_shot: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Running,
    Detached,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,         // ses_<nanoid>
    pub title: String,
    pub status: SessionStatus,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub cwd: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub preset_id: Option<String>,
    pub preset_slug: Option<String>,
    pub one_shot: bool,
    pub created_at: i64,
    pub last_active_at: i64,
    pub exit_code: Option<i32>,
}
```

### 1.5 Tauri commands (signatures)

All commands return a serializable error (see `error.rs`); the JS bridge maps them to typed `PtyError` at the call site.

```rust
// pty/mod.rs

use tauri::{AppHandle, State};
use crate::pty::{registry::Registry, error::PtyError};

#[tauri::command]
pub async fn pty_spawn(
    opts: SpawnOptions,
    app: AppHandle,
    registry: State<'_, Registry>,
) -> Result<SessionInfo, PtyError> {
    registry.spawn(opts, &app).await
}

#[tauri::command]
pub async fn pty_write(
    session_id: String,
    data: String,                   // base64 of utf-8 bytes
    registry: State<'_, Registry>,
) -> Result<(), PtyError> {
    registry.write(&session_id, &data).await
}

#[tauri::command]
pub async fn pty_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, Registry>,
) -> Result<(), PtyError> {
    registry.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn pty_kill(
    session_id: String,
    registry: State<'_, Registry>,
) -> Result<(), PtyError> {
    registry.kill(&session_id).await
}

#[tauri::command]
pub async fn pty_list(
    registry: State<'_, Registry>,
) -> Result<Vec<SessionInfo>, PtyError> {
    Ok(registry.list())
}

#[tauri::command]
pub async fn pty_attach(
    session_id: String,
    app: AppHandle,
    registry: State<'_, Registry>,
) -> Result<SessionInfo, PtyError> {
    registry.attach(&session_id, &app).await
}

#[tauri::command]
pub async fn pty_detach(
    session_id: String,
    registry: State<'_, Registry>,
) -> Result<(), PtyError> {
    registry.detach(&session_id).await
}

#[tauri::command]
pub async fn pty_scrollback(
    session_id: String,
    max_lines: Option<usize>,
    registry: State<'_, Registry>,
) -> Result<String, PtyError> {     // base64 of utf-8 raw
    registry.scrollback(&session_id, max_lines.unwrap_or(200)).await
}

#[tauri::command]
pub async fn pty_discover() -> Result<Vec<DiscoveredCli>, PtyError> {
    crate::pty::discovery::probe()
}
```

`DiscoveredCli` describes whether `claude`, `opencode`, `pwsh`, `bash`, `zsh`, `python`, `node`, `git`, `docker` are on PATH; powers preset gating.

### 1.6 Tauri events (Rust -> JS)

| Event | Payload |
|---|---|
| `pty:data` | `{ sessionId: string, seq: number, data: string /* base64 */ }` |
| `pty:exit` | `{ sessionId: string, code: number \| null }` |
| `pty:title` | `{ sessionId: string, title: string }` (parsed from OSC 0/2) |
| `pty:bell` | `{ sessionId: string }` |
| `pty:status` | `{ sessionId: string, status: 'running' \| 'detached' \| 'exited' }` |

`pty:data` is microbatched: at most one event per session per ~16 ms. Bytes are base64 because Tauri events are JSON strings and many shells emit non-UTF8 sequences during transitions.

### 1.7 Concurrency model

Per session:

```
                   +-----------------------+
   pty_write  ---->| writer mpsc<Vec<u8>>  |---> writer task ---> PTY master.write()
                   +-----------------------+
                                                          (raw bytes)
                                                                v
                                                            child shell
                                                                v
   PTY master.read() (sync, blocking) -- spawn_blocking task
       v
   batcher mpsc<Bytes>
       v
   emitter task (tokio interval 16ms) -- AppHandle.emit("pty:data", ...)
                                      -- scrollback ring buffer append
                                      -- OSC parser for title/bell
       v
   ChildExitWatcher (try_wait every 100ms or on EOF)
       -- emit("pty:exit", ...)
       -- mark status=Exited
```

The blocking reader is wrapped in `tokio::task::spawn_blocking` to avoid hogging the runtime. The writer is straight tokio. Lifetime: spawn -> attach (logical, no actual reattach work needed since we always emit) -> detach (mark in registry, keep IO running) -> kill OR exit (cleanup). Detach is purely a UI/persistence flag; bytes keep flowing until kill or natural exit.

### 1.8 Lifecycle and state

```
Spawn -> Running
Running -> Detached  (UI dropped from view, IO still flowing)
Running -> Exited    (child exited or kill())
Detached -> Running  (re-attached to a pane)
Detached -> Exited   (timeout reached, configured per-preset; default never)
Exited -> (terminal state; scrollback retained until session deleted)
```

### 1.9 Cross-platform shell defaults

```rust
// pty/spawn.rs (excerpt)
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        if which::which("pwsh.exe").is_ok() { ("pwsh.exe".into(), vec!["-NoLogo".into()]) }
        else if which::which("powershell.exe").is_ok() { ("powershell.exe".into(), vec!["-NoLogo".into()]) }
        else { ("cmd.exe".into(), vec![]) }
    }
    #[cfg(target_os = "macos")]
    {
        let s = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        (s, vec!["-l".into()])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let s = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        (s, vec!["-l".into()])
    }
}
```

CWD resolution order: `opts.cwd` -> `project.cwd` (looked up via DB on the JS side and passed in opts) -> `workspace.cwd` -> `dirs::home_dir()`. Always validated before spawn (see 1.10).

### 1.10 Security stance

This is the user's own machine; we trust them to run what they want. **But** we still add cheap guardrails because terminals are the easiest path to "Jarvis ran something I didn't expect":

1. **CWD allowlist (default ON).** A spawn must originate inside one of: project root, workspace root, OS home. A setting `terminals.allowUnrestrictedCwd: false` flips this off; Settings UI exposes it under Advanced.
2. **Command allowlist toggle (default OFF for personal use; default ON in "Locked" profile).** When ON, only built-in preset commands and user-saved presets can be spawned; ad-hoc `pty_spawn(command='rm -rf /')` is rejected.
3. **`JARVIS_SESSION_ID` injected env var** so a child can later call back via MCP / future API to know which session it lives in.
4. **No env sanitization beyond that.** We pass the user's full env. We document this.
5. **No setuid / capability checks.** Out of scope; the OS already enforces.
6. **Refuse to spawn binaries that don't exist on PATH** with a friendly error mapped to a "Install X first" toast.
7. **Per-pane "what's running" indicator** so the user can always see PID + command line at a glance.

### 1.11 ConPTY / Windows quirks

- ConPTY's pseudo-console converts the screen buffer to UTF-8 ANSI for us. xterm.js handles this.
- ConPTY redraws the entire visible region on resize. xterm.js handles this; we just call `master.resize(cols, rows)` and let it do its thing.
- ConPTY does **not** support raw mouse mode for legacy console apps. For Claude Code / OpenCode this is fine since they speak modern ANSI. We document the limitation.
- Running `wsl.exe` should work but is not a default preset. A `WSL: Ubuntu` preset can be added later via discovery (probe `wsl --list --quiet`).

### 1.12 Error model

```rust
// pty/error.rs
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "kebab-case")]
pub enum PtyError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("command not on PATH: {0}")]
    NotOnPath(String),
    #[error("cwd not permitted: {0}")]
    CwdDenied(String),
    #[error("max sessions reached ({0})")]
    Capacity(usize),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("invalid base64 payload")]
    InvalidPayload,
    #[error("internal: {0}")]
    Internal(String),
}
```

The JS bridge converts the discriminated union into typed handlers (e.g. `NotOnPath` -> "Install Claude Code" dialog).

### 1.13 Registration in `lib.rs`

```rust
// in run()
use crate::pty::registry::Registry;

tauri::Builder::default()
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .manage(Registry::new())
    .invoke_handler(tauri::generate_handler![
        greet, app_version,
        pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill,
        pty::pty_list, pty::pty_attach, pty::pty_detach, pty::pty_scrollback,
        pty::pty_discover,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

### 1.14 Capabilities

Append to `app/src-tauri/capabilities/default.json` permissions array - all of these are first-party commands so we just need `core:event:default` (already present) plus our own commands need not be permission-gated by Tauri (only plugin commands are by default). No change required, but we document the policy.

---

## 2. Frontend Renderer

### 2.1 Library + addons (pinned versions)

Append to `app/package.json` dependencies:

```json
"@xterm/xterm": "5.5.0",
"@xterm/addon-fit": "0.10.0",
"@xterm/addon-web-links": "0.11.0",
"@xterm/addon-search": "0.15.0",
"@xterm/addon-webgl": "0.18.0",
"@xterm/addon-unicode11": "0.8.0",
"@xterm/addon-clipboard": "0.1.0",
"@xterm/addon-serialize": "0.13.0",
"react-resizable-panels": "2.1.7"
```

We use the renamed `@xterm/*` packages, not the legacy `xterm` package. Versions pinned exactly (no caret) to avoid silent xterm upgrades breaking the renderer.

`@xterm/addon-webgl` is preferred over canvas for performance; if WebGL fails to initialise (rare on older integrated GPUs in a webview), we fall back to the default DOM renderer transparently.

### 2.2 Component design

```
app/src/features/terminals/
  TerminalGrid.tsx              (main grid - layouts, splitters, focus)
  Terminal.tsx                  (single xterm-bound pane)
  TerminalHeader.tsx            (preset icon, title, status dot, kebab menu)
  TerminalLauncher.tsx          (preset picker UI)
  TerminalDashboard.tsx         (multi-project tile view)
  PresetEditor.tsx              (CRUD for user presets)
  themes.ts                     (Voltage -> xterm ITheme bridge)
  useTerminalSession.ts         (spawn + bind + cleanup hook)
  useTerminalEvents.ts          (subscribe to pty:* events for one session)
  useTerminalShortcuts.ts       (pane-scoped key handling)
  store.ts                      (zustand: layouts, focus, view mode)
  registry.ts                   (in-memory map of attached terminals for Jarvis)
  presets.ts                    (built-in preset definitions)
  intents.ts                    (terminal-specific voice intent helpers)
  index.ts
```

### 2.3 Terminal component

```tsx
// Terminal.tsx (sketch)
export interface TerminalProps {
  session: SessionInfo;
  focused: boolean;
  onFocus: () => void;
  onTitleChange?: (title: string) => void;
}

export function Terminal({ session, focused, onFocus, onTitleChange }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const term = new XTerm({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: buildVoltageTheme(),
      scrollback: 5000,
      windowsMode: navigator.userAgent.includes('Windows'),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    try { term.loadAddon(new WebglAddon()); } catch { /* fall back */ }
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';

    term.open(hostRef.current!);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const unsubData = onPtyEvent('pty:data', session.session_id, (chunk) => {
      term.write(b64ToBytes(chunk.data));
    });
    const unsubTitle = onPtyEvent('pty:title', session.session_id, (e) => {
      onTitleChange?.(e.title);
    });
    const dispose = term.onData((data) => {
      ptyWrite(session.session_id, bytesToB64(data));
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      ptyResize(session.session_id, term.cols, term.rows);
    });
    ro.observe(hostRef.current!);

    return () => { unsubData(); unsubTitle(); dispose.dispose(); ro.disconnect(); term.dispose(); };
  }, [session.session_id]);

  // Re-theme on Voltage changes
  useThemeSync(termRef);

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onFocus={onFocus}
      data-focused={focused || undefined}
      className="h-full w-full bg-background outline-none"
    />
  );
}
```

`onPtyEvent`, `ptyWrite`, `ptyResize` live in `app/src/lib/tauri.ts` extensions (added by Planner C - extends the existing module rather than creating a parallel one).

### 2.4 Voltage theme bridge

```ts
// themes.ts
export function buildVoltageTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (k: string) => `hsl(${css.getPropertyValue(k).trim()})`;
  return {
    background: v('--background'),
    foreground: v('--foreground'),
    cursor: v('--accent'),
    cursorAccent: v('--background'),
    selectionBackground: v('--accent') + '40',
    black:        v('--terminal-black')        || '#000',
    red:          v('--terminal-red')          || '#ff5c8a',
    green:        v('--terminal-green')        || '#7ee787',
    yellow:       v('--terminal-yellow')       || '#ffd166',
    blue:         v('--terminal-blue')         || '#7aa2ff',
    magenta:      v('--terminal-magenta')      || '#c792ea',
    cyan:         v('--terminal-cyan')         || '#5cf2ff',
    white:        v('--terminal-white')        || '#e6edf3',
    brightBlack:  v('--terminal-bright-black') || '#6e7681',
    // ... bright colors
  };
}
```

I will add 16 Voltage `--terminal-*` tokens to globals.css scaffolding (coordinate with Planner A; tokens listed in the Voltage section). On theme change, `useThemeSync` reads vars and calls `term.options.theme = buildVoltageTheme()`.

### 2.5 Bridge extensions in `lib/tauri.ts`

Extends the existing module - same lazy-import pattern, same web-fallback shape (web returns a no-op session that says "Terminals require the desktop app"):

```ts
// new exports in lib/tauri.ts (web fallbacks emit a single "unsupported" pty:exit)
export async function ptySpawn(opts: SpawnOptions): Promise<SessionInfo> { ... }
export async function ptyWrite(sessionId: string, b64: string): Promise<void> { ... }
export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> { ... }
export async function ptyKill(sessionId: string): Promise<void> { ... }
export async function ptyList(): Promise<SessionInfo[]> { ... }
export async function ptyAttach(sessionId: string): Promise<SessionInfo> { ... }
export async function ptyDetach(sessionId: string): Promise<void> { ... }
export async function ptyScrollback(sessionId: string, maxLines?: number): Promise<string> { ... }
export async function ptyDiscover(): Promise<DiscoveredCli[]> { ... }

export function onPtyEvent<E extends PtyEventName>(
  event: E,
  sessionId: string | '*',
  handler: (payload: PtyEventPayload<E>) => void,
): () => void { ... }
```

---

## 3. Grid Layout

### 3.1 View modes

```ts
type TerminalViewMode = 'grid' | 'tabs' | 'dashboard';
```

- **grid** - the marquee view: every pane visible, write to focused pane.
- **tabs** - one pane visible, tab strip on top. Useful for narrow windows.
- **dashboard** - all open projects' active terminals tiled as read-only previews + chat composer below.

### 3.2 Grid layouts

```ts
type GridLayoutId =
  | 'full'        // 1 pane
  | 'vsplit'      // 2 side-by-side
  | 'hsplit'      // 2 stacked
  | '3-1l-2r'     // 1 left, 2 stacked right
  | '3-2t-1b'     // 2 top, 1 bottom
  | '4-2x2'
  | '6-3x2'       // 3 cols x 2 rows
  | '8-4x2';      // 4 cols x 2 rows
```

Each layout defines a tree of `react-resizable-panels` `<PanelGroup>` + `<Panel>` + `<PanelResizeHandle>` with default sizes summing to 100. Splitter widths follow Voltage spacing (1px hairline + 4px hit zone).

### 3.3 Pane assignment

```ts
interface GridState {
  projectId: string;
  layoutId: GridLayoutId;
  paneSlots: (string | null)[];   // sessionId per slot, null = empty pane
  focusedSlot: number;
}
```

Empty slots show a launcher (preset picker + "blank shell" button). Dragging a session header onto another slot swaps. Right-click on a pane's kebab: split horizontally / vertically (promotes layout up one level), detach (removes from grid, keeps process), kill (kills process, removes from grid), promote-to-tab (switches to tabs view focused on this session).

### 3.4 Focus model

- One pane is `focused`. `Mod+1..8` selects a slot by index. Click selects.
- xterm captures all keys when its host is focused (it sets `tabIndex=0` and is the focused element). When focus leaves the xterm host, app-level hotkeys take over again. `Esc` from xterm pulls focus back to the grid container so users can use app shortcuts immediately.
- Focused pane gets a 1px `--accent` border + 6px `--accent / 30%` outer glow.

### 3.5 Per-project persistence

`terminal_layouts` row per project (see section 5.3). Layout written on every commit (debounced 500 ms). Restored on project open.

### 3.6 Dashboard mode

See section 9.

---

## 4. Terminal Presets

### 4.1 Schema

```ts
// app/src/types/terminal.ts
export interface TerminalPreset {
  id: string;                       // tpr_<nanoid>
  workspace_id: string | null;      // null for built-in
  name: string;
  slug: string;                     // unique within workspace; lowercase kebab
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;               // null = use project root
  color_hue: number;                // 0..359 for the pane accent
  icon: string;                     // lucide icon name
  one_shot: boolean;                // exit-on-complete vs persistent
  auto_run: boolean;                // attach to project open?
  requires: PresetRequirement | null;
  user_defined: boolean;
  created_at: number;
  updated_at: number;
}

export type PresetRequirement =
  | 'claude-cli' | 'opencode-cli' | 'pwsh' | 'bash' | 'zsh'
  | 'python' | 'node' | 'git' | 'docker' | 'wsl';
```

### 4.2 Built-in presets

Shipped in `presets.ts` (read-only, `user_defined: false`, `workspace_id: null`):

| Slug | Name | Command | Args | One-shot | Requires |
|---|---|---|---|---|---|
| `claude-code` | Claude Code | `claude` | `[]` | no | `claude-cli` |
| `opencode` | OpenCode | `opencode` | `[]` | no | `opencode-cli` |
| `bash` | Bash | `/bin/bash` | `['-l']` | no | `bash` |
| `zsh` | Zsh | `/bin/zsh` | `['-l']` | no | `zsh` |
| `pwsh` | PowerShell | `pwsh` (or `powershell.exe`) | `['-NoLogo']` | no | `pwsh` |
| `cmd` | Cmd (Windows) | `cmd.exe` | `[]` | no | - (Windows only) |
| `python` | Python REPL | `python3` (fallback `python`) | `['-i']` | no | `python` |
| `node` | Node REPL | `node` | `[]` | no | `node` |
| `git-status` | Git Status | `git` | `['status']` | yes | `git` |
| `npm-dev` | npm dev | `npm` | `['run', 'dev']` | no, `auto_run: true` | `node` (+ package.json with `dev` script) |
| `docker-ps` | Docker (containers) | `docker` | `['ps', '-a']` | yes | `docker` |
| `ssh` | SSH... | `ssh` | (prompt user for host) | no | - |

Discovery (`pty_discover`) marks unavailable presets disabled. UI shows them grayed with a "Install X" affordance opening a friendly dialog with copy-pastable install instructions (no auto-install).

### 4.3 User-defined presets

CRUD via `PresetEditor.tsx`. Stored in `terminal_presets` table (Planner B). Validation:

- `slug` regex `/^[a-z0-9][a-z0-9-]{1,31}$/`, unique within workspace.
- `command` non-empty, refuses obvious foot-guns (e.g. `:(){:|:&};:` - the fork bomb pattern - rejected at validation, but only as a one-line cosmetic check; real safety is the OS).
- `env` keys regex `/^[A-Z_][A-Z0-9_]*$/i`.

### 4.4 Launchers

Three entry points:

1. **Per-project quick-launch grid** at the top of the terminal canvas: every preset as an icon-button. Click = spawn into focused empty slot (or the focused slot if it has a session, with confirmation).
2. **Cmd+Shift+P inside terminal canvas** -> preset picker (cmdk).
3. **Command palette (`Mod+K`)** -> "New terminal..." action -> sub-page listing presets. Implemented by `registerAction` from `app/src/features/terminals/intents.ts` at module load.

---

## 5. Per-Project Terminals

### 5.1 Data needs from Planner B

I need four new tables in Planner B's Dexie schema and the matching Postgres migration. ID prefixes (matches existing `usr_*` / `wsp_*` / `prj_*` convention): `ses_*` for sessions, `tpr_*` for presets, `tlo_*` for layouts (or use `project_id` as PK - see below).

#### 5.1.1 `terminal_sessions`

```
id                text PK              ses_<nanoid>
workspace_id      text FK workspaces
project_id        text FK projects nullable        (null = scratch)
preset_id         text FK terminal_presets nullable
preset_slug       text nullable                    (denormalized for built-ins)
title             text
shell_command     text                             (resolved at spawn)
shell_args        json text                        (resolved at spawn)
status            text                             ('running' | 'detached' | 'exited')
pid               integer nullable
cols              integer
rows              integer
cwd               text
env               json text                        (the resolved env at spawn time)
exit_code         integer nullable
one_shot          integer (0/1)
created_at        integer (epoch ms)
last_active_at    integer (epoch ms)
```

Dexie indices needed: `id, workspace_id, project_id, status, [project_id+status], last_active_at`.

#### 5.1.2 `terminal_scrollback`

```
session_id        text FK terminal_sessions
chunk_seq         integer
data              text    (base64 of raw bytes for this chunk)
created_at        integer
PRIMARY KEY (session_id, chunk_seq)
```

Dexie compound primary `[session_id+chunk_seq]`. Chunks of ~8 KB raw written every ~5 s while session active OR when detaching.

#### 5.1.3 `terminal_presets`

```
id                text PK              tpr_<nanoid>
workspace_id      text FK workspaces nullable      (null = global / built-in mirror)
name              text
slug              text                              (UNIQUE within workspace)
command           text
args              json text
env               json text
cwd               text nullable
color_hue         integer
icon              text
one_shot          integer (0/1)
auto_run          integer (0/1)
requires          text nullable
user_defined      integer (0/1)
created_at        integer
updated_at        integer
```

Dexie indices: `id, workspace_id, &[workspace_id+slug], updated_at`.

Built-in presets are NOT stored in the DB; they live in code (`presets.ts`). Only user-defined presets go in this table.

#### 5.1.4 `terminal_layouts`

```
project_id        text PK FK projects
view_mode         text                              ('grid' | 'tabs' | 'dashboard')
layout_id         text                              ('full' | 'vsplit' | ... )
pane_assignments  json text                         (sessionId per slot index)
panel_sizes       json text                         (react-resizable-panels sizes)
updated_at        integer
```

Dexie index: `project_id, updated_at`.

#### 5.1.5 Settings keys (existing `settings` table)

I will write these keys via the existing `settingsRepo`:

- `terminals.maxActiveSessions` (number, default 16)
- `terminals.scrollbackLines` (number, default 5000)
- `terminals.scrollbackSpillBytes` (number, default 5_000_000)
- `terminals.allowUnrestrictedCwd` (boolean, default false)
- `terminals.commandAllowlistEnabled` (boolean, default false)
- `terminals.detachOnAppClose` (boolean, default true - though see section 8)
- `terminals.defaultShell.windows` / `.macos` / `.linux` (strings, optional overrides)

### 5.2 Reattach flow

On project open:

1. Read `terminal_sessions WHERE project_id = ? AND status IN ('running','detached')`. (After a crash or reopen, there will be no Running rows because the OS killed the children when Tauri exited. We treat both states the same here.)
2. For each row, since the actual PTY is dead, offer a tile labelled **"Reconnect (will spawn fresh)"**. Clicking re-spawns with the same preset/cwd/env and inherits the title; scrollback from the prior session is shown above the new prompt as a faded "previous run" block sourced from `terminal_scrollback`.
3. Sessions in `Exited` state are shown as read-only scrollback panes labelled with the exit code and "Closed". Users can dismiss them or one-click-rerun.

### 5.3 Active session tracking

A registry hook (`registry.ts`) keeps an in-memory map of `sessionId -> { term: XTerm, info: SessionInfo }` so Jarvis (section 6) can address sessions by id, slot index, slug, or "the focused one". The DB is the source of truth for *what exists*, the registry is the source of truth for *what's mounted right now*.

---

## 6. Jarvis Control Surface

### 6.1 Event bus contract

Jarvis (voice + palette + agents) does not call PTY commands directly. It dispatches events on the existing `window` bus (the same pattern `emitJarvisEvent` already uses). The terminal subsystem subscribes globally via a `<TerminalEventBridge />` mounted near `AppShell`.

```ts
// app/src/features/terminals/events.ts

export type TerminalRunPayload = {
  // Targeting (one required):
  targetSessionId?: string;
  targetSlug?: string;          // route to first matching preset; spawn if none open
  targetSlot?: number;          // 1..8 within current grid
  targetFocused?: boolean;      // route to focused pane
  // Action:
  text: string;
  runImmediately?: boolean;     // append \n if true; otherwise just type it
};

// jarvis:terminal:run            -> write text into a session
// jarvis:terminal:spawn          -> { presetSlug, projectId?, slot? }
// jarvis:terminal:focus          -> { sessionId? | slot? }
// jarvis:terminal:kill           -> { sessionId? | slot? }
// jarvis:terminal:list           -> request a fresh list (callback via response event)
// jarvis:terminal:list:result    -> { sessions: SessionInfo[], focused: string|null }
// jarvis:terminal:read           -> { sessionId? | slot?, lines? } (replies on :read:result)
// jarvis:terminal:read:result    -> { sessionId, text }
```

A small `terminalCommandBus` helper exposes typed senders:

```ts
import { sendTerminalRun, requestTerminalRead, requestTerminalList } from '@/features/terminals/events';
```

### 6.2 Voice intents (extension to `IntentClassifier.ts`)

Add a new intent family before the existing `app_command` fallback. New `Intent` union members:

```ts
type Intent =
  | 'chat' | 'task_create' | 'task_modify' | 'task_complete' | 'task_query'
  | 'agent_route' | 'app_command' | 'dictation' | 'memory_recall'
  | 'conversation'
  // V2 additions:
  | 'terminal_run'
  | 'terminal_spawn'
  | 'terminal_focus'
  | 'terminal_kill'
  | 'terminal_list'
  | 'terminal_read';
```

New slots:

```ts
interface VoiceSlots {
  // ...existing...
  terminal_target?: 'focused' | { slot: number } | { slug: string } | { sessionId: string };
  terminal_command?: string;
  terminal_lines?: number;
}
```

Patterns:

```
terminal_run     "run X in (the )? terminal"                       -> { command: X, target: focused }
                 "run X in (claude|opencode|terminal N)"           -> { command: X, target: matched }
terminal_spawn   "open (a )? new (claude|opencode|...) terminal"   -> { presetSlug }
                 "spawn (a )? terminal"                            -> default shell preset
terminal_focus   "switch to terminal N"                            -> { slot: N }
                 "focus the (claude|opencode|...) terminal"
terminal_kill    "stop terminal( N)?", "kill terminal X"
terminal_list    "list (the )? terminals", "what terminals are open"
terminal_read    "what'?s in terminal N",
                 "what did terminal X (just )?say",
                 "read (the last|me) (\\d+ lines from )? terminal N"
```

These regexes live in a new `terminal_intents.ts` re-exported into the existing `IntentClassifier` so we don't bloat that file. Confidence floor 0.8 for all matches.

### 6.3 Read-back / summarisation

`requestTerminalRead({ sessionId, lines: 200 })` resolves to plain UTF-8 text (the bridge decodes the base64 from `pty_scrollback`). For voice, the modal then asks the current default agent (Planner D's AI router) for a one-paragraph summary using a system prompt:

```
You are summarising a terminal scrollback for the user. Be concise.
If there is an error, say so plainly. If a build succeeded, say so.
Quote at most 2 short lines. Do not invent output.
```

The summary is spoken via TTS. The full text is written into the chat thread as a code block for reference.

### 6.4 Command palette additions

`registerAction` from `terminals/intents.ts` at module init registers:

| Action id | Label | Page | Hotkey |
|---|---|---|---|
| `terminal-toggle-canvas` | Show terminals | root | `Mod+\`` |
| `terminal-new` | New terminal... | root | `Mod+Shift+T` |
| `terminal-new-claude` | New Claude Code terminal | new | - |
| `terminal-new-opencode` | New OpenCode terminal | new | - |
| `terminal-new-shell` | New shell | new | - |
| `terminal-layout-full` ... `terminal-layout-8` | Layout: ... | terminal-layout | - |
| `terminal-view-grid/tabs/dashboard` | View: ... | terminal-view | - |
| `terminal-kill-focused` | Kill focused terminal | terminal | `Mod+Alt+W` |

A new `PageId` value `'terminal'` is added (Planner B's command palette already supports this extensibly via `pages.tsx` - I will extend in lockstep, no schema change).

### 6.5 Agents calling into terminals

Future-facing: a simple `terminals` tool function exposed to the AI router (Planner D):

```ts
// agent tool surface
type TerminalTool =
  | { kind: 'spawn'; presetSlug: string; project_id?: string }
  | { kind: 'run';   sessionId: string; text: string; runImmediately?: boolean }
  | { kind: 'read';  sessionId: string; lines?: number }
  | { kind: 'list' };
```

Agents are gated behind the same approval policy as any other tool call (Planner D's responsibility). Out of Planner C's scope to design that policy; in scope to expose the API.

---

## 7. Hotkeys

### 7.1 New entries (extend `lib/hotkeys.ts`)

```ts
export const HOTKEYS = {
  // ...existing...
  TERMINAL_FOCUS_GRID:        'Mod+`',
  TERMINAL_NEW:               'Mod+Shift+T',
  TERMINAL_CLOSE_PANE:        'Mod+Shift+W',
  TERMINAL_FOCUS_PANE_1:      'Mod+1',
  TERMINAL_FOCUS_PANE_2:      'Mod+2',
  TERMINAL_FOCUS_PANE_3:      'Mod+3',
  TERMINAL_FOCUS_PANE_4:      'Mod+4',
  TERMINAL_FOCUS_PANE_5:      'Mod+5',
  TERMINAL_FOCUS_PANE_6:      'Mod+6',
  TERMINAL_FOCUS_PANE_7:      'Mod+7',
  TERMINAL_FOCUS_PANE_8:      'Mod+8',
  TERMINAL_SPLIT_RIGHT:       'Mod+Shift+ArrowRight',
  TERMINAL_SPLIT_DOWN:        'Mod+Shift+ArrowDown',
  TERMINAL_SPLIT_LEFT:        'Mod+Shift+ArrowLeft',
  TERMINAL_SPLIT_UP:          'Mod+Shift+ArrowUp',
  TERMINAL_TOGGLE_VIEW_MODE:  'Mod+Shift+G',         // grid <-> tabs <-> dashboard
  TERMINAL_PRESET_PICKER:     'Mod+P',               // when terminal canvas focused
} as const;
```

### 7.2 Conflicts to resolve with the user

Two collisions with existing V1 hotkeys:

- **`Mod+Shift+T`** is already `TOGGLE_TODO`. The brief explicitly asks for `Ctrl+Shift+T` for new terminal. I propose moving `TOGGLE_TODO` to `Mod+Shift+L` (for "list") or `Mod+0`. **Flagged for your call.**
- **`Mod+1..8`** has no current binding so it's free, but it conflicts with browser tab switching in some environments. We only consume the key event when the terminal canvas is the active root view, otherwise let it pass through.
- **`Mod+\``** has no existing binding.
- **`Mod+P`** isn't currently bound but is muscle memory for "Quick open" in IDEs - we only bind it when the terminal canvas is focused.

### 7.3 Dispatch

Hotkeys for terminal actions resolve into the same event bus (section 6), so the *only* code path is the `jarvis:terminal:*` events. xterm captures keys when its host is focused; pane-level keys are caught at the grid container before xterm via `e.preventDefault()` for the small set above (others fall through to the shell).

---

## 8. Persistence + Recovery

### 8.1 What survives an app restart

| Item | Persisted? | Restored? |
|---|---|---|
| Layout (which panes, what sizes, which view mode) | Yes (`terminal_layouts`) | Yes |
| Preset list (user-defined) | Yes (`terminal_presets`) | Yes |
| Session metadata (title, preset_id, cwd, env) | Yes (`terminal_sessions`) | Tile placeholder; user clicks to respawn |
| Scrollback (last N lines on disk) | Yes (`terminal_scrollback`) | Shown above the new prompt as a faded "previous run" |
| **Live shell process** | No, OS-bound to parent | No (see below) |

### 8.2 Honest answer on session resumption

When Tauri exits, every PTY child dies with it. There is no portable way to keep them alive; the options are:

1. **Accept process death** (default) - we restore *layout + preset placeholders*. User clicks "Reconnect" and we respawn the same preset with the same cwd/env/title; scrollback from before is shown as historical context. **This is what we ship in V2.**
2. **`tmux` / `screen` adapter** (opt-in, macOS/Linux only) - wrap commands in `tmux new-session -A -s ses_<id> -- <cmd>`. Subsequent attach uses `tmux attach -t ses_<id>`. Pros: real session resumption, scrollback preserved by tmux. Cons: requires tmux installed; alters the user's shell behaviour subtly (PROMPT_COMMAND, signals). Setting `terminals.useTmuxOnUnix: false` by default; user toggles in Advanced.
3. **Long-running daemon** (out of scope for V2) - a separate `jarvis-pty-daemon` binary that owns PTYs and outlives the app. Cleanest UX, biggest engineering cost. Park for V3.

I recommend shipping option 1 in V2 with option 2 as an opt-in flag, and revisit option 3 once we know how often users hit the pain.

### 8.3 Detach vs kill on app close

Setting `terminals.detachOnAppClose: true` is mostly cosmetic in option 1 (the process dies regardless). What it actually controls:

- `true` (default): write scrollback chunks to `terminal_scrollback`, mark each row `status='detached'`, then exit.
- `false`: emit a "kill all" beforehand, mark `status='exited'` with `exit_code=null` and a note "killed by app close", *then* exit.

One-shot presets (`one_shot: true`) always end up as `Exited` (their nature) with their actual exit code preserved.

### 8.4 Spill-to-disk strategy

Per session in memory: ring buffer capped at `terminals.scrollbackLines` lines (default 5000). When the buffer rotates a chunk out, that chunk is appended to `terminal_scrollback` with monotonic `chunk_seq`. On scrollback reads from the UI, we splice the on-disk chunks before the in-memory buffer. Total per-session disk cap is `terminals.scrollbackSpillBytes` (default 5 MB); oldest chunks are deleted FIFO when exceeded.

---

## 9. Multi-Project Dashboard

### 9.1 Goal

A single "Dashboard" view shows every open project's most-active terminals as live read-only previews, with chat/composer below. Click a tile to enter that project at the focused pane.

### 9.2 Layout

```
+---------------------------------------------------+
|  Project: Acme Frontend          [Open] [Pin]     |
|  +-------+  +-------+  +-------+  +-------+        |
|  | npm   |  | claude|  | bash  |  | logs  |        |
|  | dev   |  |  code |  |       |  |       |        |
|  +-------+  +-------+  +-------+  +-------+        |
|                                                    |
|  Project: Backend API            [Open] [Pin]      |
|  +-------+  +-------+                              |
|  | tests |  | psql  |                              |
|  +-------+  +-------+                              |
|                                                    |
|  +----------------------------------------------+ |
|  | Composer (chat to Jarvis or @agent)          | |
|  +----------------------------------------------+ |
+---------------------------------------------------+
```

Each tile renders the last 8-12 lines of scrollback in a faded read-only xterm instance with `disableStdin` + `cursorBlink:false`. Tile updates on `pty:data` for the matching session, throttled to 2 Hz.

### 9.3 Data flow

```
useDashboard(workspaceId) =>
  list projects in workspace where last_active_at within 7 days
  for each project: top 4 terminal_sessions ordered by last_active_at desc
  subscribe to pty:data for each (with throttle)
  render tiles
```

A project is "open" if it has at least one session with `status != 'exited'`. Pinned projects (a setting `dashboard.pinnedProjects: string[]`) always show.

### 9.4 Composer

The dashboard composer is the same chat composer used by the chat feature (Planner D's). A small `dashboardChatService` posts to whichever agent is the workspace default; the user can prefix with `@coder` etc. exactly like the regular chat. Outside Planner C's scope to redesign.

### 9.5 Switch-to-project

Click a tile -> route to that project, set the focused pane to the clicked session, switch view mode to `grid`. Keyboard: `Mod+J` then a project number (the existing project navigator hotkey, owned by Planner B/E - just hooking in).

---

## 10. Performance & Safety Guardrails

### 10.1 Backpressure on PTY -> WebView

- Reader fills a per-session bounded mpsc (capacity 256 `Bytes` chunks). When full, the reader task `try_send`s and drops oldest chunk + sets a sentinel byte sequence in the next emit so xterm shows a `[output dropped]` line.
- Emitter task fires on a 16 ms tokio interval (matches a 60 fps frame). Each tick: drain the mpsc per session, base64 once, emit one event.
- This caps the emit rate to ~62/sec/session regardless of how chatty the shell is.

### 10.2 Scrollback caps

- In-memory: 5000 lines (configurable). Lines, not bytes - we count `\n` because that's what users care about.
- On-disk per session: 5 MB (configurable). Older chunks deleted FIFO.
- Total on-disk across all sessions: 200 MB (`terminals.totalScrollbackCapBytes`, configurable). Enforced lazily on append.

### 10.3 Session count

`terminals.maxActiveSessions` default 16. `pty_spawn` returns `PtyError::Capacity` past the cap. UI shows a friendly modal and offers to detach the oldest idle session.

### 10.4 Memory ceiling per session

Soft cap on the in-flight write/read buffers: 1 MB combined. Beyond that we drop with a sentinel as in 10.1.

### 10.5 CPU budget

xterm WebGL renderer is preferred. With 8 visible panes at idle, the renderer should sit < 2% CPU on a baseline laptop. A perf test in the CI smoke run renders 8 sessions running `yes` for 5 seconds and asserts the main thread doesn't block > 16 ms.

### 10.6 Safety toggles (recap)

- CWD allowlist on by default.
- Command allowlist off by default in Personal profile, on in Locked profile.
- One-shot presets cannot be auto-run unless explicitly opted-in per preset.
- Voice intents that result in destructive commands (`rm`, `del /s`, `git reset --hard`, `DROP`) require an explicit confirm from the user before being typed - intercepted in the voice modal before `jarvis:terminal:run` fires. Pattern list lives in `terminals/dangerous.ts`.

---

## 11. Open Questions / Cross-Planner Dependencies

### 11.1 For Planner B (data + sync)

Add tables (full DDL in section 5.1). Specifically:

- `terminal_sessions` with the columns and indices listed
- `terminal_scrollback` (compound PK)
- `terminal_presets`
- `terminal_layouts`

Plus:

- New ID prefixes: `ses_*`, `tpr_*`. Reserve in id-generator.
- New settings keys (section 5.1.5) - no schema change since `settings` is k/v.
- Postgres mirror in the migration with RLS following the existing `workspaces -> owner_id` pattern.

### 11.2 For Planner A (theme + motion)

- 16 new `--terminal-*` HSL CSS variables in `globals.css` for the ANSI palette in both dark and light Voltage themes.
- A motion preset for "pane glow" focus indicator (subtle 200 ms accent ring).
- Confirm pane splitter colour token (we'd like `--border-strong` if it exists, else `--border`).

### 11.3 For Planner D (voice + agents)

- Extend `IntentClassifier` `Intent` union with the six terminal intents (section 6.2). Implementation file is in our scope, but the type union touches Planner D's contract.
- Confirm `dangerous-command guard` should live before voice -> terminal dispatch (pre-emit) or after (in the terminal subsystem). I prefer pre-emit; flagged.
- Provide the AI router endpoint name we should use for scrollback summarisation (e.g. `ai.complete({ system, user })`) - I have assumed it; confirm.

### 11.4 For Planner E (settings + installer)

- An "Advanced > Terminals" section in Settings exposing the keys in 5.1.5.
- A "First run: discover CLIs" step in Onboarding that calls `pty_discover` and shows a green/red list with copy-paste install commands for missing ones.
- Updater channel has nothing to add here; a future bump to xterm or portable-pty will go through the regular update.

### 11.5 Hotkey conflicts (need user call)

- `Mod+Shift+T` collides with V1 `TOGGLE_TODO`. **Recommendation:** move `TOGGLE_TODO` to `Mod+Shift+L`.
- `Mod+\`` is currently free; safe to claim.
- `Mod+1..8` only consumed when terminal canvas is the active root view.

### 11.6 Risk decisions I'm making

1. **Session resumption strategy:** Accept process death in V2; restore layout + preset placeholders. Optional tmux wrap on Unix as opt-in. Defer a daemon to V3. *Risk: users will expect "Reattach to running shell" to literally reattach. We mitigate with a clear "Reconnect (will respawn)" label.*
2. **Single shared `Registry` State** in Tauri's State container. *Risk: state ordering bug at startup if any other module touches the registry before `manage()` runs. Mitigation: `Registry::new()` is cheap and pure; called inline in builder.*
3. **xterm WebGL by default with DOM fallback.** *Risk: GPU bugs in Tauri's webview on Windows ARM. Mitigation: try/catch the addon load, log to tracing, fall back silently.*
4. **CWD allowlist on by default.** *Risk: users hit "cwd not permitted" on day one and feel boxed in. Mitigation: clear error message + Settings link. Default workspace cwd to `dirs::home_dir()` which gives plenty of room.*
5. **Voice "what did terminal 2 say" routes through the LLM router.** *Risk: cost on long scrollbacks. Mitigation: cap input at 200 lines (configurable), summary prompt is short.*

### 11.7 Things I still want your call on

- Tmux opt-in or omit entirely from V2?
- Should `Mod+Shift+T` belong to terminals (per the brief) or stay as TOGGLE_TODO?
- Approval gating for AI-driven terminal writes: same as other tool approvals, or a stricter per-command confirm?
- Do we ship a "Locked" profile in V2 (defaults command-allowlist on), or only "Personal"?
- Should the dashboard composer route to a single project or to a multiplexed "all projects" agent?

---

*End of Plan C.*
