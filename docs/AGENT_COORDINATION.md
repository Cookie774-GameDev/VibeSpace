# VibeSpace — Agent Coordination Ledger

> **Single source of truth for multi-agent Cursor work.**  
> **Repo:** `C:\Users\viper\VibeSpace`  
> **Rule:** `.cursor/rules/agent-coordination.mdc` (always applied)

---

## Purpose

Prevent five concurrent Cursor agents from overwriting, reverting, or force-pushing each other's in-progress work. This document is the **coordination ledger**: read it before every task; update it after planning and after every significant action (commit, release, lock change).

---

## Rules

1. **Read first** — Open this file before any code change, commit, push, or release.
2. **Update after** — Append a work-log entry after planning and again after commit/release (or when abandoning work).
3. **Claim before edit** — Add rows to **File ownership / lock table** before touching shared areas.
4. **Never force-push** over another agent's in-progress branch or version without explicit user approval.
5. **Never revert** another agent's committed features without explicit user approval.
6. **One version target** — All agents work toward **Active version target** below unless the user directs otherwise.
7. **Release gate** — On "commit and push to next version", run the full verified release pipeline; **block publish on any error** (see [Release checklist](#release-checklist-reference)).
8. **Append-only log** — Do not delete or rewrite past work-log entries; add corrections as new entries.

---

## Active version target

| Field | Value |
|-------|-------|
| **Current released** | **v0.1.43** (2026-06-16) |
| **Next target** | **v0.1.44** (unstarted) |
| **Release channel** | `releases/channel.json` → GitHub Releases |
| **Branch convention** | `main` for releases; feature branches optional with ledger note |

---

## Agent registry

| Agent | Role | Primary duties |
|-------|------|----------------|
| **VibeSpace Helper** | Coordinator / release | Commits, pushes, releases, Q&A, ledger upkeep, conflict resolution |
| **VibeSpace Main** | Primary development | Major fixes, architecture, cross-cutting refactors |
| **VibeSpace Worker 1** | Feature worker | Fixes, updates, isolated features |
| **VibeSpace Worker 2** | Feature worker | Fixes, updates, isolated features (parallel to Worker 1) |
| **VibeSpace Tester** | Cloud QA (read-only) | Run actual app, report pass/fail — **no commit/push/edits** |

**Division of labor:** Main owns broad design; Workers 1/2 own scoped tasks; Helper owns git/release/coordination; Tester validates only.

**Live dashboard:** Open `agent-command-center.canvas.tsx` in Cursor Glass (Agent Command Center).

## Live status board (2026-06-17 — corrected)

| Agent | Status | Current task | Conflict? |
|-------|--------|--------------|-----------|
| **VibeSpace Helper** | **Active** | Live board, coordination ledger, releases when asked | No |
| **VibeSpace Main** | **Active** | URGENT 4-fix terminal pass (distortion, white screen, scrollback, APPLE prompt) | **Yes** — vs Worker 1 on agent prompts |
| **VibeSpace Worker 1** | **Active** | URGENT provider/model dropdown registry (Hive screenshot — no manual Model ID) | **Yes** — vs Worker 2 on `lib/ai/**`, `auth.ts`, `Hive.tsx` |
| **VibeSpace Worker 2** | **Active** | Hands-free voice turn-taking + URGENT model selection persistence | **Yes** — vs Worker 1 on `lib/ai/**`, `auth.ts`; overwrites own StackPicker |
| **VibeSpace Tester** | Standby | Cloud read-only QA — not running now | No |

**4 of 5 agents active.** Tester is the idle 5th.

### Active conflicts (needs your decision)

1. **CRITICAL — Worker 1 ↔ Worker 2** — Both edit `lib/ai/**` (providerRegistry vs modelSelection), `stores/auth.ts`, `Hive.tsx` with **no ledger locks**.
2. **HIGH — Main ↔ Worker 1** — `agentPromptDelivery.ts` (terminals) vs `AgentManager.tsx` (agents UI) — APPLE test alignment.
3. **HIGH — install.ps1 deleted** — `install/install.ps1` deleted locally; `install_new.ps1` untracked — v0.1.43 UTF-8 installer at risk.
4. **HIGH — Worker 2 router rewrite** — `router.ts` −138 lines — may break v0.1.43 chat routing.
5. **MEDIUM — Ledger unused** — Only Main claimed locks; Workers never claimed before editing.

---

## Current work log

Append new entries at the **bottom** of the relevant agent section. Use [How to update this doc](#how-to-update-this-doc).

### VibeSpace Helper

#### 2026-06-16 — UTF-8 install.ps1 hotfix + testing guide

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-16 (post v0.1.43 release) |
| **Version** | v0.1.43 (docs/install follow-up) |
| **Plan** | Restore UTF-8-safe `install/install.ps1`; add agent QA documentation |
| **Files touched** | `install/install.ps1`, `docs/AGENT_TESTING_GUIDE.md` |
| **Status** | committed |
| **Commit** | `023a69a` — `fix: restore UTF-8 install.ps1 and add agent testing guide` |

#### 2026-06-17 — Promote updater channel to v0.1.43

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.43 (channel promote) |
| **Plan** | Push `releases/channel.json` 0.1.42 → 0.1.43; archive manifest |
| **Files touched** | `releases/channel.json`, `releases/manifests/v0.1.43.json` |
| **Status** | committed + pushed |
| **Commit** | `484dfc8` — `Promote in-app updater channel to v0.1.43.` |

---

### VibeSpace Main

#### 2026-06-16 — v0.1.43 release (primary dev)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-16 |
| **Version** | v0.1.43 |
| **Plan** | Composer STT, workspace flush, Hive polish, voice/terminal improvements, version bump |
| **Files touched** | See **Committed this version** (92 files in release commit) |
| **Status** | released |
| **Commit** | `36fdbe5` — `Release v0.1.43: Composer STT, workspace flush, and Hive polish.` |

#### 2026-06-17 — Terminal production reliability pass

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 10:35 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Fix terminal route-switch distortion, white fallback risk, scrollback isolation, and terminal-agent prompt delivery |
| **Files touched** | `app/src/features/terminals/**`, `app/src/components/layout/PageRouter.tsx`, `docs/AGENT_COORDINATION.md` |
| **Status** | implemented locally; focused action/runtime/context tests, broader action/AI tests, typecheck, and edited-file lints passing |
| **Commit** | — |

#### 2026-06-17 — Terminal reliability follow-up from trace agents

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 11:28 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Add explicit terminal refits after layout transitions, WebGL context-loss recovery, Gemini instruction-file delivery, and CLI defaults for terminal agent panes |
| **Files touched** | `app/src/features/terminals/TileGrid.tsx`, `TileGrid.refit.test.tsx`, `TerminalView.tsx`, `TerminalsPage.tsx`, `TerminalsPage.command.test.ts`, `agentPromptDelivery.ts`, `agentPromptDelivery.test.ts`, `docs/AGENT_COORDINATION.md` |
| **Status** | in-progress |
| **Commit** | — |

#### 2026-06-18 — Terminal swarm coordination system

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 9:41 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Add opt-in coordinated terminal agent mode, no-context isolation, project-local coordination ledger, file-lock snapshots, and mode-aware CLI prompt delivery |
| **Files touched** | `app/src/features/terminals/**`, `app/src-tauri/src/agent_coordination.rs`, `app/src-tauri/src/lib.rs`, `docs/AGENT_COORDINATION.md` |
| **Status** | in-progress |
| **Commit** | — |

#### 2026-06-18 — Terminal swarm coordination implementation checkpoint

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 10:32 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Implemented typed coordination helpers, native `.vibespace` persistence commands, mode-aware prompt delivery, picker mode UI, and coordinated terminal registration/heartbeat |
| **Files touched** | `app/src/features/terminals/**`, `app/src-tauri/src/agent_coordination.rs`, `app/src-tauri/src/lib.rs`, `docs/AGENT_COORDINATION.md` |
| **Status** | implemented locally; frontend verification passing; native verification partially blocked by Windows Application Control policy |
| **Commit** | — |

#### 2026-06-18 — Terminal scrollback real-terminal behavior fix

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 11:10 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Fix terminal scroll-up lock and visual scrollback junk by separating xterm viewport behavior from transcript restore replay; preserve Jarvis transcript context and terminal coordination changes |
| **Files touched** | `app/src/features/terminals/TerminalView.tsx`, `restoreSession.ts`, `restoreSession.test.ts`, `transcriptStore.ts`, `terminalViewport.ts`, `terminalViewport.test.ts`, `TerminalsPage.tsx`, `docs/AGENT_COORDINATION.md` |
| **Status** | in-progress |
| **Commit** | — |

#### 2026-06-18 — Terminal scrollback implementation checkpoint

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 11:23 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Implemented real-terminal scroll behavior: active attach skips visual transcript replay, dead OpenCode-in-shell replay is suppressed, output flush respects user scroll position, and reset forgets killed session transcripts |
| **Files touched** | `TerminalView.tsx`, `restoreSession.ts`, `restoreSession.test.ts`, `terminalViewport.ts`, `terminalViewport.test.ts`, `TerminalsPage.tsx`, `TerminalsPage.reset.test.ts`, `docs/AGENT_COORDINATION.md` |
| **Status** | implemented locally; `npm run test -- src/features/terminals` and `npm run typecheck` passing |
| **Commit** | — |

#### 2026-06-18 — Jarvis chat action routing fix

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 12:58 PM CT |
| **Version** | v0.1.44 |
| **Plan** | Make Jarvis chat produce approval-gated app action cards for commands like open five terminals, add chat-only concise action persona, and surface bounded coordination context |
| **Files touched** | `app/src/lib/actions/fallbackActions.ts`, `fallbackActions.test.ts`, `promptAddendum.ts`, `app/src/lib/ai/runtime.ts`, `runtime.test.ts`, `context.ts`, `docs/AGENT_COORDINATION.md` |
| **Status** | implemented locally; focused action/runtime/context tests, broader action/AI tests, typecheck, and edited-file lints passing |
| **Commit** | — |

#### 2026-06-18 — Billing hardening and Hive Balance rollout

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 6:05 PM CT → 6:55 PM CT |
| **Version** | v0.1.44 |
| **Plan** | Fix apex tier schema gaps, wire Supabase Edge Function checkout/portal, remove "Available Soon" for wired paths, add Hive Balance 5-model pipeline, hide fast/quality/ultra/custom presets, coerce old stored presets safely, gate Balance behind paid plan |
| **Files touched** | `supabase/migrations/0027_apex_tier.sql` (new), `app/src/lib/supabase/types.ts`, `app/src/App.tsx`, `app/src/lib/billing/checkout.ts` (new), `app/src/lib/billing/checkout.test.ts` (new), `app/src/lib/supabase/apexTier.test.ts` (new), `app/src/features/settings/sections/Plans.tsx`, `app/src/features/settings/sections/Hive.tsx`, `app/src/features/billing/HostedJarvis.tsx`, `app/src/lib/ai/stacks/frontierModels.ts`, `app/src/lib/ai/stacks/presets.ts`, `app/src/lib/ai/stacks/presets.test.ts`, `app/src/lib/ai/stacks/hiveBalance.test.ts` (new), `DOWNLOAD.md` |
| **Status** | implemented locally; frontend stress pass complete; native/Supabase live checks blocked by local environment; no commit/push per user instruction |
| **Commit** | — (no commit per user instruction) |
| **Test evidence** | `npm run test` → 107 files / 614 tests passed; `npm run typecheck` passed; `npm run build` passed; edited-file lints clean; `cargo test --lib` blocked by Windows Application Control policy; Supabase CLI not installed and `SUPABASE_DB_URL` missing |

---

### VibeSpace Worker 1

#### 2026-06-18 — Kanban page rebuild on milestone store

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 |
| **Version** | v0.1.44 |
| **Plan** | Replace empty Dexie-task Kanban with full-page Inspector milestone board; shared zustand persist store |
| **Files touched** | `app/src/features/kanban/**`, `Inspector.tsx` (KanbanContextPanel) |
| **Status** | implemented locally; typecheck + kanban tests passing |
| **Commit** | — |

#### 2026-06-17 — Provider/model dropdown registry (URGENT)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.44 |
| **Plan** | Replace manual Model ID typing with provider-aware dropdowns; providerRegistry; API-key gating; Hive screenshot fix |
| **Files touched** | `app/src/lib/ai/providerRegistry.ts`, `providerModelCatalog.ts`, `useProviderModelOptions.ts`, `app/src/components/ai/ProviderModelSelect.tsx`, `Hive.tsx`, `Providers.tsx`, `AgentManager.tsx`, `AgentDetail.tsx` |
| **Status** | in-progress |
| **Commit** | — |

---

### VibeSpace Worker 2

#### 2026-06-17 — Hands-free voice + model selection persistence (URGENT)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.44 |
| **Plan** | voiceTurnCommit for hands-free turn-taking; model selection state persistence; no fake defaults |
| **Files touched** | `app/src/features/voice/voiceTurnCommit.ts`, `VoiceModal.tsx`, `Voice.tsx`, `app/src/lib/ai/modelSelection.ts`, `router.ts`, `runtime.ts`, `stores/auth.ts`, `Composer.tsx`, `StackPicker.tsx` |
| **Status** | in-progress |
| **Commit** | — |

#### 2026-06-17 — Voice module close + hands-free setting respect (URGENT)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.44 |
| **Plan** | Instant speech stop on voice module close; session invalidation; wake word only in hands-free mode |
| **Files touched** | `voiceRouter.ts`, `streamingVoice.ts`, `WakeWordHost.tsx`, `wakeWord.ts`, `ui.ts`, `App.tsx`, `VoiceModal.tsx`, `runtime.ts`, tests |
| **Status** | committed (tests passing) |
| **Commit** | — |

#### 2026-06-18 — Top-bar mic → composer STT (not Jarvis module)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 |
| **Version** | v0.1.44 |
| **Plan** | Top-right mic button triggers chat composer speech-to-text; no Jarvis voice modal |
| **Files touched** | `TopBar.tsx`, `Composer.tsx`, `composerSttService.ts`, `stores/ui.ts` |
| **Status** | committed (tests passing) |
| **Commit** | — |

---
| **Files touched** | `app/src/lib/persistence/workspaceFlush.ts`, `app/src/features/chat/StackPicker.tsx`, `app/src/lib/ai/stacks/**`, `docs/HIVE_PIPELINE_SIMULATION_TIERS.md`, `docs/TERMINAL_PERSISTENCE_SHUTDOWN_UPDATE_TRAY.md` |
| **Status** | committed (in `36fdbe5`) |
| **Commit** | `36fdbe5` |

---

### VibeSpace Tester

#### 2026-06-17 — Cloud QA (read-only)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.43+ |
| **Plan** | Validate app behavior via `npm run jarvis` or installed build — report only |
| **Files touched** | None (no edits) |
| **Status** | standby |
| **Commit** | — |

---

## File ownership / lock table

> **Current v0.1.44:** No active locks. Claim rows before editing.

| Path / area | Owner agent | Version | Status | Notes |
|-------------|-------------|---------|--------|-------|
| `app/src/features/terminals/**` | VibeSpace Main | v0.1.44 | in-progress | Urgent terminal stability, scrollback isolation, agent prompt delivery |
| `app/src/components/layout/PageRouter.tsx` | VibeSpace Main | v0.1.44 | in-progress | Keep terminal surfaces stable across route switches |
| `docs/AGENT_COORDINATION.md` | VibeSpace Main | v0.1.44 | in-progress | Coordination ledger for terminal reliability fix |
| `app/src-tauri/src/agent_coordination.rs` | VibeSpace Main | v0.1.44 | in-progress | Native atomic project-local terminal agent coordination ledger |
| `app/src-tauri/src/lib.rs` | VibeSpace Main | v0.1.44 | in-progress | Register terminal agent coordination commands only |
| `app/src/features/terminals/agentCoordination*` | VibeSpace Main | v0.1.44 | in-progress | Typed terminal swarm state, locks, summaries, and tests |
| `app/src/features/terminals/agentPromptPayload*` | VibeSpace Main | v0.1.44 | in-progress | Mode-aware terminal prompt payload builder |
| `app/src/features/voice/voiceRouter.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Voice module lifecycle + instant speech stop on close |
| `app/src/features/voice/streamingVoice.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Session-gated streaming TTS; no zombie playback |
| `app/src/features/voice/WakeWordHost.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | Gate wake word on hands-free mode only |
| `app/src/features/voice/wakeWord.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | `isWakeWordAutoOpenAllowed` helper |
| `app/src/stores/ui.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Sync voice open/close with lifecycle |
| `app/src/App.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | VoiceModuleLifecycle backup sync |
| `app/src/features/voice/VoiceModal.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | Close button instant stop |
| `app/src/components/layout/TopBar.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | Top-bar mic → composer STT (not Jarvis module) |
| `app/src/features/composer-stt/composerSttService.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Toolbar STT toggle helper |
| `app/src/features/inspector/**` | VibeSpace Worker 2 | v0.1.44 | in-progress | Right-hand panel: Today, Quick Launch, Context, Tools Run, Trace milestones, Active Work |
| `app/src/components/layout/Inspector.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | Inspector wiring for production-ready right panel |
| `app/src/features/launcher/launch.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | openExternal for Quick Launch URLs/apps/files |
| `app/src/features/kanban/**` | VibeSpace Worker 1 | v0.1.44 | in-progress | Rebuild Kanban on Inspector milestone store |
| `app/src/components/layout/Inspector.tsx` (KanbanContextPanel only) | VibeSpace Worker 1 | v0.1.44 | in-progress | Align inspector kanban strip with milestones |
| `app/src/features/skills/**` | VibeSpace Worker (skills) | v0.1.44 | in-progress | Unified skills catalog, SkillsPage editor, /skills picker |
| `app/src/lib/agents/skills.ts` | VibeSpace Worker (skills) | v0.1.44 | in-progress | resolveSkills delegates to unified catalog |
| `app/src/features/chat/Composer.tsx` (/skills only) | VibeSpace Worker (skills) | v0.1.44 | in-progress | /skills picker reads unified catalog |
| `app/src/lib/ai/runtime.ts` (skills block) | VibeSpace Worker (skills) | v0.1.44 | in-progress | getSelectedSkillsBlock via resolveCatalogSkills |
| `app/src/lib/actions/promptAddendum.ts` (skills list) | VibeSpace Worker (skills) | v0.1.44 | in-progress | Available skills section from catalog |

#### 2026-06-18 — Skills system unification

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 |
| **Version** | v0.1.44 |
| **Plan** | Unified catalog (16 presets + custom), SkillsPage inline editor, /skills picker + runtime resolve, localStorage persistence |
| **Files touched** | `features/skills/**`, `lib/agents/skills.ts`, `Composer.tsx`, `promptAddendum.ts` |
| **Status** | complete (uncommitted) |
| **Commit** | — |

#### 2026-06-18 — Right-hand inspector panel production pass

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-18 |
| **Version** | v0.1.44 |
| **Plan** | Schedule/Open Tasks, Quick Launch fix, Context DnD+editor, Tools Run, Trace milestones, Active Work panel |
| **Files touched** | `features/inspector/**`, `Inspector.tsx`, `launch.ts`, `TileGrid.tsx`, `App.tsx` |
| **Status** | in-progress |
| **Commit** | — |

--- (CRITICAL — Worker 1 + Worker 2 both editing):** `app/src/lib/ai/**`, `app/src/stores/auth.ts`, `app/src/features/settings/sections/Hive.tsx`, `app/src/features/agents/**` (Worker 1 + Main overlap)

**How to claim:** Add a row with `Status: in-progress` before editing. Remove or set `Status: committed` after merge/commit.

---

## Committed this version (v0.1.43)

Do **not** revert or overwrite without user approval.

| Feature / area | Key paths | Commit(s) |
|----------------|-----------|-----------|
| **Composer STT** | `app/src/features/composer-stt/**`, `app/src-tauri/src/faster_whisper.rs`, Settings → Composer STT | `36fdbe5` |
| **Workspace flush** | `app/src/lib/persistence/workspaceFlush.ts`, tray/shutdown hooks in `App.tsx` | `36fdbe5` |
| **Hive StackPicker + polish** | `app/src/features/chat/StackPicker.tsx`, `app/src/lib/ai/stacks/**`, `supabase/functions/stack-complete/` | `36fdbe5` |
| **Voice / terminal improvements** | `app/src/features/voice/**`, `app/src/features/terminals/**` | `36fdbe5` |
| **Local models expansion** | `app/src/features/settings/sections/LocalModels.tsx`, `app/src/lib/ai/localModelCatalog.ts` | `36fdbe5` |
| **UTF-8 install.ps1 fix** | `install/install.ps1` | `36fdbe5`, `023a69a` |
| **Agent testing guide** | `docs/AGENT_TESTING_GUIDE.md` | `023a69a` |
| **Release metadata** | `CHANGELOG.md`, `releases/RELEASE_NOTES_0.1.43.md`, version bumps in `package.json`, `app/package.json`, `tauri.conf.json`, `Cargo.toml` | `36fdbe5` |

**Release commits:** `36fdbe5`, `023a69a`

---

## Blocked / do-not-touch

| Item | Reason | Owner | Until |
|------|--------|-------|-------|
| *(none active)* | — | — | — |

### Known issues (not locks — coordinate before fixing)

| Issue | Notes |
|-------|-------|
| **`install/install.ps1` OS path lock on Windows** | UTF-8 rewrite landed in `023a69a`; Windows may still lock the script path during silent install or `irm \| iex`. Test with `docs/09-jarvis-calling-account-release.md` §6 smoke test before changing installer behavior. |

---

## Release checklist reference

Run **all** steps before tagging/pushing a new version. **Stop and fix on any failure** — do not publish.

| Step | Command / doc |
|------|----------------|
| Typecheck | `npm run typecheck` |
| Unit tests | `npm --prefix app run test` |
| Production build | `npm run build` |
| Release manifest | `npm run test:release-manifest` |
| Rust compile | `cd app/src-tauri && cargo check --release` |
| Windows release | `npm run release:windows` then `npm run release:stage` |
| UTF-8 installer | Verify `install/install.ps1` is UTF-8 (no BOM issues); smoke: `docs/09-jarvis-calling-account-release.md` §6 |
| Version bump | `package.json`, `app/package.json`, `app/src-tauri/Cargo.toml`, `tauri.conf.json`, `releases.ts`, `CHANGELOG.md`, release notes |
| Signing | `TAURI_SIGNING_*`, Authenticode per `docs/09-jarvis-calling-account-release.md` §6 |
| Pre-publish gate | `docs/09-jarvis-calling-account-release.md` §7 Verification checklist |
| QA reference | `docs/AGENT_TESTING_GUIDE.md` §7 Test Commands |

**Helper agent** owns running this pipeline on "commit and push to next version" requests.

---

## How to update this doc

### 1. Work-log entry (after planning or commit)

Add a new `####` subsection under the agent's **Current work log** section:

```markdown
#### YYYY-MM-DD — Short task title

| Field | Value |
|-------|-------|
| **Timestamp** | ISO or date |
| **Version** | v0.1.44 |
| **Plan** | One-line summary |
| **Files touched** | `path/a`, `path/b` or directory globs |
| **Status** | in-progress \| committed \| released \| abandoned |
| **Commit** | `abc1234` or — |
```

### 2. File lock (before editing)

Add a row to **File ownership / lock table**. Update **Status** when done.

### 3. New committed feature (after merge)

Add a row to **Committed this version** for the active target version.

### 4. Block another agent

Add a row to **Blocked / do-not-touch** with owner and expected completion.

### 5. Version bump

Update **Active version target**, roll **Committed this version** into CHANGELOG (already done in git), and start a fresh committed table for the new version.

---

*Maintained by all four agents. Last seeded: 2026-06-16 — v0.1.43 (`36fdbe5`, `023a69a`).*

---

### VibeSpace Worker 1 (subagent)

#### 2026-06-21 — Jarvis slash-surface targeting + close-terminal action bugfix

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-21 08:44 AM CT |
| **Version** | v0.1.44 |
| **Plan** | (1) Add `terminal.bulkClose` registered action + queue plumbing. (2) Fix fallback detection for "close N terminals" + slash-prefix stripping. (3) Fix Composer route slash commands to pass remainder text to AI instead of discarding. (4) Update promptAddendum with surface-targeting and close guidance. |
| **Files touched** | `app/src/features/terminals/terminalCommandQueue.ts`, `app/src/features/terminals/TerminalsPage.tsx`, `app/src/lib/actions/registry.ts`, `app/src/lib/actions/fallbackActions.ts`, `app/src/lib/actions/promptAddendum.ts`, `app/src/features/chat/Composer.tsx`, `app/src/lib/actions/fallbackActions.test.ts`, `app/src/lib/ai/runtime.test.ts` |
| **Status** | implemented; 10/10 fallbackActions tests GREEN, 13/13 runtime tests GREEN, typecheck clean, no lints |
| **Commit** | — |
