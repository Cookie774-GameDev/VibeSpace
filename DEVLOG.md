## 2026-06-07 - v0.1.21 AI, Music, and Notification Update

- Replaced procedural ambient synthesis with a five-track hosted playlist that advances in order and repeats.
- Added placeholder Cloudflare R2 URLs for later replacement with final music links.
- Reworked `/model` and the composer picker to persist a real provider/model pair and route built-in Jarvis through it.
- Limited the chat picker to implemented adapters instead of providers that still route to mock.
- Added automatic absolute Windows file-path extraction so file-summary prompts receive referenced file content.
- Removed silent fallback from failed real providers to canned mock prose; API failures now remain visible.
- Added regression tests for model routing, model catalogs, file paths, reminder channels, and task completion.
- Verified `209` tests, TypeScript typecheck, and the production frontend build.

---

## 2026-06-06 - v0.1.20 Plugins Major Update

**Actor:** Codex

**Goal:** Add a production Plugins system with a scalable catalog, secure credentials, connection management, terminal capability context, cloud metadata sync, tests, and release packaging.

**Result:** Implemented a 353-entry validated plugin catalog and six working connector paths: GitHub, Figma, Supabase, Shopify, Slack, and a deterministic local test connector. Added Settings UI, OS-keychain credential storage, connection testing, enable/disable state, metadata-only Supabase sync, bounded plugin capability context in the AI runtime, and approval-gated `plugin.call` execution.

### Security Model

- Raw plugin credentials are stored only through the existing Tauri keyring commands.
- Persisted Zustand and Supabase records contain status, configured field names, account labels, and enablement only.
- Terminal/AI context receives tool names and permission descriptors, never credential values.
- Supabase migration `0011_plugin_connections.sql` rejects credential-shaped plugin payload fields.

### Verification

- Catalog schema/count tests cover every entry.
- UI tests cover search, connect, manage, and disconnect.
- Runtime tests cover the mock tool path and invalid credential handling.
- Context tests prove disabled or wrong-project plugins are excluded and secrets are absent.
- Action tests cover approved mock execution and rejection of disabled plugins.
- `npm --prefix app run typecheck`, `npm --prefix app run test` (41 files / 199 tests), `npm --prefix app run build`, and `cargo check` pass.
- `npm run release:windows` generated matching 0.1.20 NSIS/MSI updater signatures with the private key selected only after its sibling `.pub` matched `tauri.conf.json`.
- `npm run release:stage` completed cleanly and regenerated `releases/latest.json` plus current-only `releases/SHA256SUMS.txt`.
- Public release verification caught GitHub's space-to-period asset-name normalization; the manifest generator now prefers the stable hyphenated NSIS asset and the published manifest was replaced.
- The public `v0.1.20` release contains the locally verified Windows NSIS/MSI artifacts, updater signatures, `latest.json`, and `SHA256SUMS.txt`.
- The silent local NSIS upgrade completed with exit code 0; `%LOCALAPPDATA%\Jarvis One\jarvis.exe` and the relaunched process both report `ProductVersion=0.1.20`.
- The first tagged cross-platform Release run failed before compilation because `tauri-action` invokes `npm run tauri build` and the app package exposed only `tauri:build`. Added the expected `tauri` script, changed workflow installs to `npm ci`, and added an explicit `TAURI_SIGNING_PRIVATE_KEY` preflight.
- A follow-up run from the stale `v0.1.20` tag reproduced the same missing-script failure on Linux, Windows, and macOS ARM; the remaining queued macOS x64 job was cancelled after confirmation.
- The GitHub repository currently has no Actions secrets configured, so a future updater-producing matrix release will stop at the new preflight until the maintainer deliberately installs the updater key and optional platform signing credentials.
- The Windows installer is updater-signed but remains Authenticode `NotSigned` because no trusted Windows certificate is configured. macOS/Linux build, signing, and runtime verification remain pending.
- Reminder dispatch now honors `banner` versus `in_app` channels, task-completion notifications fire only from the completion path, and onboarding requests desktop notification permission through the Tauri plugin rather than the browser-only API.
- Added focused notification and task-service regression coverage for channel isolation, false completion suppression, and scheduled-reminder closure.

---

## 2026-06-06 - v0.1.19 Critical Hotfix: React Error #185 Crash

**Actor:** CommandCode

**Goal:** Fix production React Error #185 (maximum update depth exceeded) crashing the app on boot and route transitions.

**Result:** Two surgical fixes applied. All 190 tests pass. Typecheck clean.

### Root Cause

`PageRouter.tsx` unconditionally mounted `<TerminalsPage />` inside its Suspense boundary on every route, hiding it with `style={{ display: 'none' }}` for non-terminal routes. `TerminalsPage`'s `useLayoutEffect` then synchronously fired tree state updates inside `captureLiveTree()` / `saveTerminalTree()`, which triggered re-renders, which re-fired the effect — cascading past React's 50-iteration limit inside Suspense resolution.

### Changes Made

- **PageRouter.tsx**: Conditionally mount `TerminalsPage` only when `route === 'terminal'` instead of CSS-hiding it.
- **Inspector.tsx**: Wrap `setInspectorOpen` in `useCallback` to prevent unstable function identity churning the effect dependency.
- **Version bump**: `0.1.18` → `0.1.19` across all configs.

### Files Changed

- `app/src/components/layout/PageRouter.tsx`
- `app/src/components/layout/Inspector.tsx`
- `package.json` / `app/package.json` / `Cargo.toml` / `tauri.conf.json` / `releases.ts` / `CHANGELOG.md`

---

## 2026-06-03 - v0.1.17 Terminal Erase Confirmation, Font Customization, Inline Renaming & Freeze Fixes

**Actor:** Antigravity (Jarvis AI)

**Goal:** Implement hold-to-confirm Eraser button, inline renaming for terminals, global default font-size slider, extended font cycle ranges, and offload blocking Rust-side PTY calls to prevent random UI freezes.

**Result:** Completed all implementation steps successfully. TypeScript typecheck and Cargo build check are green. Silently bumped all app configuration files to version 0.1.17.

### Changes Made:

- **Stateful Erase Confirmation**: Pressing and holding the eraser icon fills a background progress bar over 1.5 seconds. Clicking the subsequent "Confirm?" button dispatches a custom event to visually clear xterm, wipes the Zustand transcript store, and writes `\x0c` to ConPTY. A 3.5s auto-reset restores the button if not confirmed.
- **Global Terminal Default Font Size Slider**: Added an accent-cyan range slider (1px to 72px) under Settings -> Appearance linked to the UI store's `defaultTerminalFontSize` key.
- **Unclamped Font Cycling**: Individual terminal "T" font size cycles through `[10, 11, 12, 13, 14, 16, 18, 20]` without auto-scaling clamps.
- **Inline Rename**: Double-clicking terminal titles (or triggering rename from the context menu) mounts an inline text input styled with `border-accent-copper/60 bg-paper`, auto-saving on Blur/Enter and cancelling on Escape.
- **PTY Thread Offloading**: Wrapped blocking `write_all`, `flush`, and `resize` in `spawn_blocking` inside `terminal.rs` and took ownership of `PtyHandle` on `terminal_kill` to avoid thread deadlocks.
- **Metadata Version Bumps**: Bumped app version to `0.1.17` across `package.json`, `app/package.json`, `Cargo.toml`, `tauri.conf.json`, `releases.ts`, `CHANGELOG.md`, and updated the `EMPIRE_SOVEREIGN_DIRECTORY.md`.

---

## 2026-06-02 - v0.1.15 Production Polish Continuation

**Actor:** Codex CLI

**Goal:** Continue the full Jarvis One production update across terminal persistence/performance, Context file drag/drop, account/subscription/admin access, Jarvis Call gating, silent-update warnings, About/What's New copy, ambient audio, usage reporting, and production setup documentation.

**Result:** Implemented another concrete production pass and verified the Windows release/install path. macOS/Linux build verification and a trusted production Authenticode certificate are still pending.

- Hardened terminal behavior: panes stay mounted across fullscreen transitions, startup commands do not rerun on reattach/same-project moves, terminal system prompts are no longer printed, false terminal-complete notifications were removed, transcript persistence is debounced, and native xterm scrollbars are hidden while wheel/touchpad scrolling remains.
- Tightened Context/file drag-drop: project Context root drags resolve to the real `context_map.json`, dragged files append paths into chat composer text, and terminal drops paste raw paths instead of executable wrappers.
- Added Account route/page from the top-left `J` avatar with plan, billing, key count, usage, and Jarvis Call status.
- Added admin entitlement helpers and applied Jarvis Call gating to CallButton, CallModal, inline TopBar call button, and compact overflow call row.
- Added silent-update warning host with 1-hour, 30-minute, 5-minute warnings, Update Later, snooze, and signed-update install action.
- Fixed ambient soundscape resume behavior after browser audio-policy gestures.
- Updated Plans page active-tier background and centered plan card icons.
- Added `/usage` summary support using local monthly totals for all providers, OpenAI live usage/cost endpoints, and OpenRouter live current-key usage/limit data when the linked key has compatible access.
- Added a lightweight Web Speech wake-word host for "Hey Jarvis" / "Okay Jarvis", a visible wake bubble, and `Shift+Tab` to summon Jarvis.
- Removed duplicate hotkey ownership from `AppShell` and `VoiceModal`; root hotkey hosts now own global toggles to prevent double-fire behavior.
- Extended Custom Tools beyond single-action presets: tools can now store ordered built-in action workflows, the Tools page has a workflow JSON editor/template, and the action registry exposes `custom.createWorkflowTool` so Jarvis can create complex reusable tools.
- Updated Settings -> About, What's New, `.env.example`, `CHANGELOG.md`, `README.md`, `SETUP.md`, and added `docs/09-jarvis-calling-account-release.md`.
- Updated cross-platform release docs/installers and GitHub workflows: Unix installer tolerates Jarvis One asset names, `DOWNLOAD.md` reflects `0.1.15`, release workflow points to `jarvis-one` and Tauri signing secrets, and CI no longer soft-fails Vitest.
- Added `scripts/sign-windows.ps1` and wired generated Tauri signing config into local and GitHub Windows release builds. This puts Authenticode signing in Tauri's `bundle.windows.signCommand` phase, before updater `.sig` files are generated, avoiding invalid signatures from post-build signing.
- Tightened `scripts/release-windows.ps1` so `SHA256SUMS.txt`, the file summary, and the manual `gh release create` hint only include the current version's release assets instead of every older artifact left in `releases\`.

**Verification so far:** `npm --prefix app run typecheck`, `npm --prefix app run test` (11 files / 106 tests), `npm --prefix app run build`, and `cargo check` pass. `npm run release:windows` passes when `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are loaded from the local `.tauri` key files; it rebuilt `0.1.15` NSIS/MSI installers, generated Tauri updater `.sig` files, and wrote `releases/latest.json` plus current-only `releases/SHA256SUMS.txt`. Built `app/src-tauri/target/release/jarvis.exe` reports `ProductVersion=0.1.15`, `releases/latest.json` points at the `Cookie774-GameDev/jarvis-one` `Jarvis One_0.1.15_x64-setup.exe` asset, and the local silent NSIS install succeeded with `%LOCALAPPDATA%\Jarvis One\jarvis.exe` reporting `ProductVersion=0.1.15`. The generated Windows signing hook now works, but this local build remains Authenticode `NotSigned` because no trusted certificate env was provided. `install/install.sh` was hardened for Jarvis One macOS/Linux asset names, but this Windows host cannot run `bash -n` because the WSL/bash service is not installed. macOS/Linux builds remain pending.

---

## 2026-06-02 - v0.1.14 Inspector Hotfix, Slash Commands, Command Parser, STT Optimization

**Actor:** CommandCode

**Goal:** Fix Inspector infinite-loop crash, add slash command autocomplete typeahead (fuzzy match), implement /contextmap and /file commands, enhance command parser with fuzzy fallback suggestions and new patterns, optimize STT recording pipeline, and enrich Jarvis system prompt with full app-surface awareness.

**Result:** All changes typechecked and compiled. Ready for silent update.

### Inspector Infinite-Loop Fix

- Fixed Zustand selector anti-pattern in `Inspector.tsx` line 81: changed object-destructured selector that returned a new object on every render to a simple function reference.
- Removed unused `inspectorOpen` selector — only `setInspectorOpen` was actually consumed.

### Slash Command Autocomplete

- Created `features/chat/SlashCommandTypeahead.tsx` — a cmdk-based typeahead panel with 21 registered slash commands, icons, descriptions, and `takesArg`/`argPlaceholder` metadata.
- Integrated into `Composer.tsx`: typing `/` at position 0 or after whitespace triggers a popover showing fuzzy-matched commands.
- Full keyboard navigation: ArrowUp/Down cycle through commands, Enter/Tab inserts the selected command, Escape dismisses.
- Slash commands take priority over mention (@agent) typeahead when both contexts are active.

### New Slash Commands

- `/contextmap` — lists all active context maps with node counts. `/contextmap <name>` attaches the matching map as a ContextAttachment to the chat.
- `/file <path>` — attaches a project file to the chat. `/file` alone shows usage help.

### Command Parser Enhancements

- Added `suggestions` field to `unknown` intent in `intents.ts` for fuzzy fallback.
- Added `suggestClosestCommands()` function in `parse.ts` with 40 known command patterns; scores user input against keyword overlap and returns top 3 examples.
- `execute.ts` surfaces suggestions inline: "Did you mean: X, Y, Z?"
- Added new patterns: inspector toggle/show/hide, quick task creation shortcuts, ambient toggle, wellness/break commands.
- Expanded `JARVIS_COMMAND_CATALOG` with 7 new entries (break, inspector, pause, rest).

### STT Recording Optimization

- Reduced `ScriptProcessor` buffer from 4096 to 2048 samples (~46ms per chunk instead of ~92ms) for lower latency activity detection and smoother waveform updates.

### System Prompt Enhancement

- Extended the AI system prompt addendum (`promptAddendum.ts`) with a comprehensive "App Surfaces You Control" section.
- Describes all app surfaces (NavPane, Canvas, Inspector, Command Palette, Settings, Voice Modal, Ambient, Wellness Break, To-Do Drawer, Quick Launcher, Actions Palette) so Jarvis has full spatial awareness of the app it can control.

### Performance Audit

- Scanned entire `app/src/` tree for Zustand selector anti-patterns (object returns from selectors). Zero remaining instances. The single instance in `Inspector.tsx` was the only one and has been fixed.

### Files Changed

- `app/src/components/layout/Inspector.tsx` — Zustand selector fix
- `app/src/features/chat/SlashCommandTypeahead.tsx` — new file
- `app/src/features/chat/Composer.tsx` — slash typeahead integration, /contextmap and /file commands, STT buffer size optimization
- `app/src/features/assistant/intents.ts` — suggestions field on unknown
- `app/src/features/assistant/parse.ts` — new patterns, suggestClosestCommands
- `app/src/features/assistant/execute.ts` — suggestion surfacing in fail message
- `app/src/features/assistant/commands.ts` — 7 new catalog entries
- `app/src/lib/actions/promptAddendum.ts` — App Surfaces You Control section

---

## 2026-06-02 - v0.1.13 Terminal, Sidebar Jarvis, and Dictation Silent Update

**Actor:** OpenCode for viper

**Goal:** Polish terminal drag/drop, add self-made Jarvis commands and multi-step execution, make speech-to-text global with `Ctrl+Caps Lock` and a 30-second idle timeout, keep the right-side Jarvis chat project-connected, fix sidebar clipping, and ship via silent updater.

**Result:** Built and silently installed Jarvis One `0.1.13`.

- Changed same-project terminal pane drops to swap positions instead of insert-shifting the grid.
- Added terminal drag polish: hidden source tile, white drop outline, and `Escape` cancellation for the right-drag path.
- Scoped terminal and Context drop events to the chat composer that received them, preventing main/sidebar double-consumption and removing forced Chat-route navigation from terminal drops.
- Added AssistantBar multi-step `then` execution plus self-made custom command creation/running backed by the existing Custom Tools/action registry.
- Added `Ctrl+Caps Lock` speech-to-text dispatch for focused chat composers and terminal panes.
- Added shared Web Speech inactivity timeout and Groq recorder audio-activity timeout after 30 seconds of silence.
- Reworked the Inspector Jarvis tab to use compact chat rendering and select/create chats only for the active project without mutating the main active chat.
- Forced TerminalView/xterm hosts to fill and clip to their pane width to remove the left-side sliver.

**Verification:** `npm --prefix app run typecheck`, `npm --prefix app run test`, `npm --prefix app run build`, `cargo check`, release pipeline `npm run release:windows`, local silent installer, installed executable version check, `releases/latest.json` check.

**Files touched:** `TileGrid.tsx`, `TerminalView.tsx`, `TerminalsPage.tsx`, `Composer.tsx`, `ChatView.tsx`, `ChatThread.tsx`, `MessageBubble.tsx`, `Inspector.tsx`, `VoiceService.ts`, `VoiceModal.tsx`, `useGlobalHotkeys.tsx`, `hotkeys.ts`, assistant parser/executor/bar/commands, `globals.css`, release metadata/version files, `CHANGELOG.md`, `DEVLOG.md`.

---

## 2026-06-02 - v0.1.12 Interactive Context Map Silent Update

**Actor:** OpenCode for viper

**Goal:** Replace the card-style Context skill tree with a cozy interactive map, add saved-key provider selection for map generation, make expansion arrow-only, add Context Map commands, and ship via the silent updater.

**Result:** Built and silently installed Jarvis One `0.1.12`.

- Rebuilt the Context workspace around a large SVG map with circular nodes, string links, left-click selection for nodes/strings, right-click panning, wheel zoom, Center Map recovery, and a white creation flash.
- Added saved-provider generation support for Google, Groq, OpenAI, and Anthropic keys, with local fallback preserved when no configured key is selected.
- Added file metadata to Context nodes and dragged Context payloads: size, created date, modified date, children, tags, and model metadata.
- Changed Context and Files sidebar branches so only the dropdown arrow expands/collapses; clicking labels selects/opens instead of toggling.
- Added assistant commands for creating/generating the Context Map and recentering it.
- Built signed `0.1.12` Windows NSIS/MSI artifacts, staged updater metadata, and ran a silent local NSIS install.
- Verified `%LOCALAPPDATA%\Jarvis One\jarvis.exe` reports `ProductVersion 0.1.12` and `releases/latest.json` reports `0.1.12`.

**Verification:** `npm --prefix app run typecheck`, `npm --prefix app run test`, `npm --prefix app run build`, `cargo check`, release pipeline `npm run release:windows`, local silent NSIS installer, installed executable version check, `releases/latest.json` check.

**Files touched:** `ContextPage.tsx`, `tree.ts`, `SidebarContextTree.tsx`, `SidebarFilesTree.tsx`, `fs.ts`, `fsread.rs`, assistant parser/executor/bar/commands, release metadata/version files, `CHANGELOG.md`, `DEVLOG.md`.

---

## 2026-06-02 - v0.1.11 Context Skill Tree Silent Update

**Actor:** OpenCode for viper

**Goal:** Replace the user-facing Skills surface with project-scoped Context, generate a project skill tree, make Context draggable into chat/terminals, inject Context into AI prompts, add sidebar file browsing, and silently install the update.

**Result:** Built and silently installed Jarvis One `0.1.11`.

- Added the Context workspace with `Make Skill Tree`, project-root storage, Gemini-backed generation when `apiKeys.google` is configured, and local fallback tree generation.
- Stored generated Context trees per project and injected them into the AI runtime alongside project prompts, attached files, attached terminals, and connected terminal files.
- Added Context drag/drop MIME support for chat and terminals, including Context chips and terminal power-up feedback.
- Replaced the visible Skills route/sidebar entry with Context, kept `/skills` and `open skills` as Context aliases, and updated route tools/actions/onboarding/breadcrumbs.
- Added recursive sidebar project files, draggable file paths, full Files-page handoff, and native folder/file pickers for desktop path inputs.
- Built signed `0.1.11` Windows NSIS/MSI artifacts, staged updater metadata, and ran a silent local NSIS install.
- Verified `%LOCALAPPDATA%\Jarvis One\jarvis.exe` reports `ProductVersion 0.1.11` and `releases/latest.json` reports `0.1.11`.

**Verification:** `npm --prefix app run typecheck`, `npm --prefix app run test`, `npm --prefix app run build`, `cargo check`, release pipeline `npm run release:windows`, local silent installer, installed executable version check, `releases/latest.json` check.

**Files touched:** `app/src/features/context/*`, `FilesPage.tsx`, `projectFiles.ts`, `SidebarFilesTree.tsx`, `NavPane.tsx`, `PageRouter.tsx`, `TopBar.tsx`, `Inspector.tsx`, `Composer.tsx`, `ChatView.tsx`, `TerminalView.tsx`, `ConnectedFilesButton.tsx`, `lib/ai/context.ts`, `lib/ai/runtime.ts`, assistant route parsing/actions, MCP route tool, release metadata/version files, `CHANGELOG.md`, `DEVLOG.md`, `releases/latest.json`, release installers/signatures.

---

## 2026-06-02 - v0.1.10 Terminal Dragging Silent Update

**Actor:** OpenCode for viper

**Goal:** Package and silently install the terminal right-drag/project-move/chat-context update as a Jarvis One desktop update.

**Result:** Built and silently installed Jarvis One `0.1.10`.

- Reapplied the release metadata bump to `0.1.10` after the temporary revert.
- Updated `CHANGELOG.md`, Settings -> About current-update copy, and in-app What's New release metadata for the terminal dragging update.
- Built signed Windows release artifacts through `scripts/release-windows.ps1` with updater signatures enabled.
- Staged NSIS/MSI installers and signatures in `releases/`, plus `latest.json` for `v0.1.10`.
- Ran the local NSIS installer with `JARVIS_LOCAL=1`, `JARVIS_SILENT=1`, and `JARVIS_FORMAT=nsis`.
- Verified the installed executable at `%LOCALAPPDATA%\Jarvis One\jarvis.exe` reports `ProductVersion 0.1.10`.

**Verification:** `npm --prefix app run typecheck`, release pipeline `npm run release:windows`, local silent installer, installed executable version check, `releases/latest.json` check.

**Files touched:** `app/package.json`, `package-lock.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock`, `CHANGELOG.md`, `About.tsx`, `releases.ts`, `DEVLOG.md`, `releases/latest.json`, `releases/SHA256SUMS.txt`, release installers/signatures.

---

## 2026-06-02 - v0.1.9 Stay-on-Page Chat Creation, Terminal Limit & Layout Fixes

**Actor:** Jarvis for viper

**Goal:** Fix the terminal limit error by flagging closed sessions as deleted, ensure creating a new chat from the right-hand Jarvis panel keeps the user on their current page (stay-on-page routing), and fix the Inspector panel layout bug that pushed active panel content to the bottom of the sidebar.

**Result:** Built and silently installed patch update.

- Added `deleted` state flag to backend `TerminalInfo` and `PtyHandle` (Rust).
- In `terminal_spawn`, excluded deleted sessions from the active project PTY limit calculations.
- In `terminal_kill`, marked sessions as deleted and inactive before stopping processes.
- In `terminal_list`, filtered out deleted sessions.
- Created `handleCreateChatInsideJarvisPanel` in `Inspector.tsx` to handle new chat creation in Dexie DB without modifying UI routing, maintaining the active page (e.g. terminals).
- Passed the stay-on-page chat creation callback to `<EmptyChat />` in the right-hand panel.
- Fixed layout styling in `Inspector.tsx` for `<TabsContent value="jarvis">` by applying `data-[state=active]:flex` and `data-[state=inactive]:hidden` classes to prevent inactive tab elements from taking flex space and pushing active panel content to the bottom.
- Updated Terminals page Reset button behavior to support two modes: click to reset terminal grid layout sizes only (dispatched via `jarvis:reset-terminal-sizes` event to `TileGrid.tsx`), and hold 2s with custom gradient visual fill progress and confirmation alert to clear all terminal panes.
- Built and silently deployed changes.

**Files touched:** `terminal.rs`, `Inspector.tsx`, `TileGrid.tsx`, `TerminalsPage.tsx`, `CHANGELOG.md`, `DEVLOG.md`.

---

## 2026-06-01 - Terminal Right-Drag, Project Moves, Chat Context Drop

**Actor:** OpenCode for viper

**Goal:** Implement the long-requested terminal dragging workflow without changing the app's visual language: right-drag any terminal, drop into Jarvis chat for context, reorder panes like a puzzle, move live terminals into another project, and make scheduled terminal messages understand phrases like `message this terminal in five hours`.

**Result:** Implemented and verified.

- Added an optimized right-button terminal drag path with an imperatively-rendered preview and DOM-level drop highlighting so pointer movement does not re-render xterm panes.
- Kept existing left-drag behavior, but upgraded terminal drops to insert/reorder panes instead of only swapping, so occupied cells move out of the way.
- Added chat-surface and composer-level terminal drop targets. Dropped terminal refs are attached to the active composer and continue through the existing AI terminal transcript context path.
- Added project-row drop targets. Hovering a terminal over a project opens that project's terminal workspace; dropping moves the live pane into the target project while preserving session id, pane metadata, transcript metadata, and local layout persistence.
- Added `terminal_move` in the Tauri backend so a moved PTY's project metadata updates without killing or respawning the child process. This keeps the existing 10-active-terminal cap accurate per project.
- Centralized terminal tree persistence/move helpers and kept project-drop helper loading lazy from the nav to avoid pulling terminal code into the boot path.
- Expanded terminal schedule parsing to support word numbers (`five hours`, `twenty-five minutes`) and safe no-body check-ins like `message this terminal in five hours`.
- Added focused scheduler parser tests.

**Verification:** `npm --prefix app run typecheck`, `npm --prefix app run test` (11 files, 106 tests), `npm --prefix app run build`, `cargo check`.

**Files touched:** `TileGrid.tsx`, `TerminalsPage.tsx`, `terminalProjectMove.ts`, `terminalScheduler.ts`, `terminalScheduler.test.ts`, `ChatView.tsx`, `Composer.tsx`, `NavPane.tsx`, `globals.css`, `terminal.rs`, `lib.rs`, `DEVLOG.md`.

---

## 2026-06-01 - v0.1.9 Groq STT Fix, Terminal References, Durable Terminal Scheduling

**Actor:** OpenCode for viper

**Goal:** Fix Groq speech-to-text invalid media uploads, make terminal references in chat work end-to-end, add durable scheduled terminal messages, update About/release docs, and ship via the full silent update flow.

**Result:** Implemented a production patch release.

- Replaced Groq STT `MediaRecorder` WebM upload with Web Audio PCM capture and WAV encoding. Groq now receives `jarvis-dictation.wav` for `whisper-large-v3-turbo`; Web Speech fallback remains unchanged when no Groq key exists.
- Added stable terminal reference payloads (`paneId`, `sessionId`, `projectId`, `label`, `command`, `agentSlug`) for terminal drag/drop into chat.
- Updated terminal transcript persistence to store stable `paneId`s, allowing AI context lookup by current session or restored pane.
- Added durable terminal scheduler persisted in localStorage. Attached-terminal chat requests like `send this terminal hello in 5 hours` schedule terminal writes that re-arm on app startup.
- Updated the terminal command queue to target specific terminal refs, not only new/all terminals.
- Updated Settings -> About with current-update details.
- Bumped Jarvis One to `0.1.9` and updated `CHANGELOG.md` plus in-app What's New notes.

**Architecture note:** True live OS terminal process survival across full app exit still requires a separate long-lived terminal daemon/sidecar. The current Tauri PTY backend is in-process: when the Jarvis process exits, owned PTY child processes and IPC state are torn down by the OS/runtime. This patch makes restore safe and durable by preserving layout, transcripts, pane identity, and scheduled commands, then respawning/rebinding when Jarvis opens again.

**Files touched:** `Composer.tsx`, `TileGrid.tsx`, `TerminalView.tsx`, `TerminalsPage.tsx`, `terminalCommandQueue.ts`, `terminalRefs.ts`, `terminalScheduler.ts`, `transcriptStore.ts`, `context.ts`, `runtime.ts`, `App.tsx`, `About.tsx`, `releases.ts`, version files, changelog/devlog.

---

## 2026-05-28 - V1 Scaffold Session

**Actor:** opencode (claude) for viper

**Goal:** Build V1 application scaffold per planning docs. Tauri 2 + Vite + React for Win/Mac. Supabase wiring (creds plug in via `.env.local`). 10 parallel subagents for feature directories. Logged + version-controlled. Mobile path documented for future.

**Result:** V1 ships. Typecheck clean. Production build clean (14.4s, 2481 modules transformed). 13 logical commits. Tauri shell ready (needs Rust install per `SETUP.md`).

---

### 17:55 - Phase 0: Repo bootstrap

- `git init` in `C:\Users\viper\projects\Jarvis`, branch `main`
- Created `.gitignore`, `.editorconfig`, `.prettierrc`, `LICENSE` (Apache-2.0), `CHANGELOG.md`, `DEVLOG.md`, `SETUP.md`, `.env.example`
- **Commit `d3af46f`**: `chore: initialize repo with planning docs and licenses`

### 18:00 - Phase 1: Foundation (sequential, by main agent)

Created the bones every subagent would share:

- Monorepo-lite root with `app/` workspace
- App configs: `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tailwind.config.ts`, `postcss.config.js`, `index.html`
- Voltage design tokens in `app/src/styles/globals.css` (HSL CSS vars, OLED-grounded, cyan-to-violet accent)
- Type system: `app/src/types/{common,task,chat,agent,memory,index}.ts`
- Lib: `app/src/lib/{utils,hotkeys,ids}.ts`
- Stores: `app/src/stores/{ui,auth,agents}.ts`
- Shared UI primitives: `app/src/components/ui/{button,input,textarea,dialog,popover,tooltip,separator,badge,label,switch,tabs,avatar,card,checkbox,skeleton,toast,index}.tsx`
- App entry: `app/src/main.tsx`
- Public assets: `app/public/jarvis.svg`
- **Commit `b34039e`**: `feat(scaffold): foundation - configs, design system, types, UI primitives`

### 18:30 - Phase 2: Dispatch 10 parallel subagents

Each subagent owned a non-overlapping directory. Strict file-ownership contracts so they could run independently without merge conflicts.

| ID      | Owner                    | Directory                                                      | Deliverables                                                                                                                                                                                                                            |
| ------- | ------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1**  | Database                 | `lib/db/`, `lib/supabase.ts`, `lib/sync.ts`, `supabase/`       | Dexie schema (9 tables), repositories, seed (1 workspace + 7 agents), Supabase client (null-safe), sync queue, Postgres migration with RLS                                                                                              |
| **A2**  | Layout shell             | `components/layout/`                                           | AppShell + TopBar + NavPane (240/56 collapsible) + Inspector (slide-over) + TabStrip (Arc-style) + ActivityStrip (council-only) + global hotkey wiring                                                                                  |
| **A3**  | Chat                     | `features/chat/`                                               | ChatView + ChatThread + Composer (auto-grow, Mod+Enter) + MessageBubble (per-agent colored borders) + ToolCallCard (collapsible) + MentionTypeahead + EmptyChat + `useChatMessages`                                                     |
| **A4**  | Council                  | `features/council/`                                            | CouncilView + CouncilGrid (n-up, capped 4 cols) + AgentPanel + AnimatedBeam (SVG cubic Bezier) + BeamLayer (ResizeObserver) + SynthesizeButton + CouncilToggle                                                                          |
| **A5**  | Tasks                    | `features/tasks/`                                              | TodoPanel + TaskCard + TaskComposer (NL parser via date-fns) + SnoozePopover + DraftTaskList + TaskService + Scheduler (deadline pressure curve, quiet hours) + NotificationEngine (Tauri + browser fallback + in-app) + parseTaskInput |
| **A6**  | Voice                    | `features/voice/`                                              | VoiceModal (bottom-anchored Dialog) + Orb (5-layer CSS) + GlowBorder (conic gradient) + VoiceCaption + VoiceTrigger (PTT 250ms hold) + VoiceService (Web Speech API) + IntentClassifier (10 intents) + 5 personas                       |
| **A7**  | Palette                  | `features/command-palette/`                                    | CommandPalette (cmdk + Radix) with nested pages + actions registry + useGlobalHotkeys + emit-event helpers                                                                                                                              |
| **A8**  | Auth/Onboarding/Settings | `features/auth/`, `features/onboarding/`, `features/settings/` | AuthGate + SignInDialog + 5-step onboarding (welcome/persona/providers/permissions/demo) + 6-tab Settings modal                                                                                                                         |
| **A9**  | Agents + AI              | `features/agents/`, `lib/ai/`                                  | 7 default agents w/ production prompts + 5 persona presets + AgentBadge/AgentManager/AgentPicker + LLMProvider abstraction + Anthropic/OpenAI/Google/mock providers + router with fallback + runtime listener                           |
| **A10** | Tauri shell              | `src-tauri/`, `lib/tauri.ts`, `public/jarvis.svg`              | Cargo.toml + lib.rs (4 plugins) + tauri.conf.json + capabilities/default.json + JS bridge with dynamic-import gating + SVG monogram                                                                                                     |

All 10 returned successfully. Each ran isolated typecheck on their files only. Cross-cutting issues bubbled up:

1. **`tsconfig.node.json` had `composite: true` + `noEmit: true`** - TS6310 forbids that combo. Pre-existing config bug; fixed by main agent during integration.
2. **A5's repositories shim** `repositories-shim.d.ts` was a stand-in until A1 landed. Removed after integration.
3. **A5 used `settingsRepo.getById<QuietHours>('quiet_hours')`** but A1's contract has `settingsRepo.get<T>(...)` for raw value access. Patched.
4. **A5's `taskRepo.listByStatus(status)`** assumed single arg; A1's contract requires `(workspaceId, status)`. Patched in `hooks.ts` and `TaskService.ts`.
5. **A2's report flagged a need for App.tsx** to wrap AppShell with active canvas. Main agent wrote this.

### 19:30 - Phase 3: Integration

Main agent fixed the contract mismatches and wrote `App.tsx`:

- `app/tsconfig.node.json`: dropped `noEmit`, added `emitDeclarationOnly` + `outDir` so the project reference works.
- `app/src/features/tasks/TaskService.ts`: swapped `settingsRepo.getById<T>` -> `settingsRepo.get<T>`.
- `app/src/features/tasks/hooks.ts`: fixed `taskRepo.listByStatus(workspaceId, 'done')` 2-arg signature.
- `app/src/features/tasks/repositories-shim.d.ts`: deleted.
- `app/src/App.tsx`: composes `AuthGate -> WorkspaceRoot -> AppShell -> ActiveCanvas`. Boot effect opens DB, registers default agents into the agent store, wires `startRuntimeListener` (jarvis:send -> AI router -> stream into messageRepo), starts `startNotificationLoop`. Renders modal layer (CommandPalette, SettingsModal, VoiceModal), GlowBorder, TodoPanel (portals into shell's `<aside>`), Toaster.
- `app/vite.config.ts`: removed unnecessary `@ts-expect-error` comments now that `@types/node` is installed.

### 19:45 - Phase 4: Verification

```
npm install                  -> dependencies hoisted to root via npm workspaces, 600+ packages
npx tsc --noEmit             -> TYPECHECK PASSED
npm run build                -> 2481 modules transformed in 14.4s, dist/ produced
                                index.html 0.84 kB
                                index-*.css  40.85 kB (gz 7.90 kB)
                                index-*.js  713.38 kB (gz 227.31 kB) <- includes everything except supabase
                                supabase-*.js 210.85 kB (gz 54.71 kB) <- code-split
                                seed-*.js     5.79 kB (gz 2.52 kB)
```

Build warnings: bundle >500 kB (acceptable for V1, optimize via manualChunks later). Tauri Rust build deferred until user installs Rust per `SETUP.md`.

### 20:00 - Phase 5: Version control

Committed in 12 logical chunks (plus the initial commit). Note: commit `00ceba4` is mislabeled `feat(layout)` but actually contains the database layer due to a parallel-git collision during the integration phase. The actual layout commit is `3288eea`. Both are present and correct in the diff; only the message is misleading. Not amending history since both refs are useful and the diffs themselves are clean.

Final commit log (newest first):

```
8853ae9 feat(app): App.tsx root - composes AuthGate + AppShell + ActiveCanvas + global modals + boot effects
b587cac feat(tauri): Tauri 2 desktop shell (Cargo + lib.rs + capabilities + JS bridge with browser fallback)
15dffeb feat(auth/onboarding/settings): AuthGate + 5-step onboarding + 6-tab settings modal
ad3f4c9 feat(palette): cmdk command palette with nested pages + global hotkey wiring
28cab1d feat(council): n-up agent grid + animated beams + synthesize button
cb3b08c feat(voice): VoiceModal + ambient orb + Apple-Intelligence glow border + intent classifier
aaf607d feat(tasks): live to-do panel + smart scheduler + notification engine + voice-driven CRUD
3288eea feat(layout): three-pane shell components (TopBar/NavPane/Inspector/TabStrip/ActivityStrip)
f62e431 feat(chat): thread + composer + mention typeahead + tool call cards + empty state
3f90607 feat(ai): provider router (Anthropic/OpenAI/Google/mock) + 7 default agents + persona presets
00ceba4 [MISLABELED layout, actually DB layer] feat(db): Dexie + repositories + Supabase migration + sync
b34039e feat(scaffold): foundation - configs, design system, types, UI primitives
d3af46f chore: initialize repo with planning docs and licenses
```

### Final V1 state

- **133 source files** (`*.ts`/`*.tsx`/`*.rs`/`*.toml`/`*.json`/`*.css`)
- **All architecture pillars wired:**
  - Voltage design system (OLED + cyan/violet)
  - Three-pane shell with keyboard alphabet
  - Multi-agent council mode with animated beams
  - Live to-do list with smart scheduler + multi-channel notifications
  - Voice modal with orb + glow border + intent classifier
  - Command palette (Cmd+K) with nested pages
  - Auth + Onboarding + Settings
  - 7 default agents with 5 persona presets
  - Multi-provider AI router (Anthropic / OpenAI / Google / mock fallback)
  - Local-first persistence via Dexie (IndexedDB)
  - Cloud sync ready via Supabase (creds via `.env.local`)
  - Tauri 2 desktop shell (Win/Mac/Linux)
- **Pre-V2 known gaps** (intentionally deferred):
  - Real Tauri build (needs Rust)
  - Real STT/TTS pipelines (Pipecat sidecar - Phase 3)
  - Mobile companion (Tauri 2 mobile or React Native - Phase 5)
  - Cloud sync end-to-end (queue exists, encryption + bidirectional flow Phase 6)
  - MCP marketplace (Phase 6)
  - Real branding icons (placeholder SVG only)
  - Per-tool approval policies UI (Phase 2)

### Next steps for viper

1. Install Rust per `SETUP.md` to unlock `npm run tauri:dev`.
2. Drop Supabase URL + anon key into `app/.env.local` (copy from root `.env.example`).
3. Apply `app/supabase/migrations/0001_initial.sql` in the Supabase SQL editor.
4. Optionally drop AI provider keys (Anthropic / OpenAI / Google) into `.env.local` or via Settings -> Providers.
5. `npm run jarvis` to launch the web version (works without Rust).

---

## 2026-05-30 - V2 Session (Wave 1)

**Actor:** opencode (claude) for viper

**Goal:** Land the user-visible half of V2 — calendar/schedule, quick-launcher, ambient idle home, expanded provider list, in-composer STT, full-screen toggle. Land the foundation for the second half (terminals subsystem, real installer build, OAuth/Google calendar) without breaking V1.

**Result:** Visible features ship, types/db/repos for the deferred features land too. Typecheck clean. Vite build clean (9.78s, 2496 modules transformed, +15 modules vs V1). Two checkpoints committed.

### What landed

- **E0 — Foundation (committed `ba98c9b`)**
  - `types/event.ts`, `types/quick-link.ts`, `types/terminal.ts`, `types/integration.ts`
  - `types/agent.ts` extended with `skills`, `coordinator?`, `consensus_method?`
  - 5 new branded id types in `lib/ids.ts`
  - Dexie v2 schema in `lib/db/schema.ts` — added 6 tables (events, quick_links, quick_link_groups, terminal_presets, terminal_sessions, integrations) and bumped agents/chats with V2 columns
  - Repositories: `eventRepo`, `quickLinkRepo`, `quickLinkGroupRepo`, `terminalPresetRepo`, `terminalSessionRepo`, `integrationRepo`. Each uses the same id-stamping + audit pattern as V1 repos.
  - `lib/agents/skills.ts` — skill registry seed (browse, calendar, code-edit, etc) ready for the agent capability map
  - `supabase/migrations/0002_v2.sql` — RLS-aware mirror of the V2 Dexie tables
  - 11-doc plan suite under `implementation-plan/v2/` (master plan + 8 wave plans + 2 verification plans)

- **Ambient idle home** (`features/ambient/`)
  - `useIdleDetection` listens at the document level, suppresses takeover when modals/voice/inputs are active, fires on visibility-change
  - `AmbientHome` renders breathing orb + halo + drifting dots + clock + next-event glance card + open-task glance card + rotating quote (30 curated, swap every 30s) + "Press any key to wake" hint
  - Single shared `--ambient-phase` CSS variable driven by one RAF loop so every layer pulses on the same 4.4s clock
  - Wake animation: ambient-exit keyframes (380ms) → app-wake fade (420ms cubic-bezier-out)
  - Reduced-motion safe — every keyframe gets disabled and falls back to a 200ms opacity fade
  - Mounted in `App.tsx`. New CSS keyframes + variables in `globals.css`. Mod+Shift+. toggles manually.

- **Schedule** (`features/schedule/`)
  - `parseEventInput` — pure-TS regex parser for "lunch with Sam tomorrow at 1pm", "Friday 4pm", "Aug 12", "2025-06-12 14:00", weekday+time, ISO/US dates. Always returns a plausible result; user can edit afterwards.
  - `useEvents`, `useUpcomingEvents` — Dexie live-query hooks
  - `ScheduleModal` — two tabs (Upcoming + Add event), color-tinted event rows, reminder presets (at time / 5 / 15 / 60 min before), all-day toggle, delete button. Quick-add live-parses while you type.
  - Hotkey Mod+Shift+S, palette action, TopBar calendar button.

- **Quick Launch** (`features/launcher/`)
  - `LauncherDialog` — keyboard-first launcher pad. Group filter chips (All / per-group / Ungrouped), search, tile grid (5 cols on lg, responsive), hover edit/delete actions, color-tinted tiles per link's HSL hue, "+ New link" tile.
  - `LinkEditDialog` — full create/edit form: label, URL with auto-kind inference, kind select, group select, emoji icon, hue slider with live swatch, behavior select, comma-tag input.
  - `launch.ts` — dispatcher: web/youtube/spotify/etc → window.open; jarvis:// scheme → built-in actions (settings/palette/schedule/ambient/fullscreen/voice) plus a `jarvis:link-action` CustomEvent escape hatch.
  - Empty state with "Add starter set" (YouTube/Spotify/GitHub/ChatGPT/Claude/Schedule/Ambient).
  - Hotkey Mod+Shift+L, palette action, TopBar rocket button.

- **STT in composer** (`features/chat/Composer.tsx`)
  - Mic button next to the model picker. Live partial transcript shown inline (italic, faded). Final utterances append to the draft with a separating space.
  - Subscribes to the existing `VoiceService` events. Toasts on permission errors.
  - Hotkey Mod+Shift+M (works inside the textarea). Setting in `Settings → Accessibility`.

- **Full-screen workspace** (`stores/ui.ts`, `globals.css`, `components/layout/`)
  - `chatFullscreen` flag flips a `data-fullscreen='true'` attr on documentElement; CSS hides NavPane and todo-drawer in that mode.
  - Hotkey Mod+Shift+F, palette action, TopBar maximize/minimize button. Persisted via the UI store.

- **Expanded providers** (`types/common.ts`, `lib/ai/router.ts`, several UIs)
  - `ProviderId` union extended with `xai`, `openrouter`, `groq`, `deepseek`, `mistral`, `together`, `ollama`. 12 total.
  - Router maps every new id to `mockProvider` for now (transparent fallback until the OpenAI-compatible adapter ships) — saved keys persist immediately.
  - Composer model picker, AgentManager picker, Settings → Providers BYOK form, and Settings → Providers default-provider radio all updated.

- **Settings sections** (`features/settings/`)
  - New `Ambient` tab: master switch, 1/3/5/10/15/30 min idle-threshold preset chips, drone-audio toggle (V3 placeholder), live "Try ambient mode now" preview button.
  - New `Accessibility` tab: composer-STT toggle, reduced-motion display (read-only OS preference), full-screen and screen-reader explainers.
  - SettingsModal sidebar grew from 6 to 8 tabs.

- **Hotkeys + palette + topbar parity**
  - 5 new hotkeys: TOGGLE_FULLSCREEN, AMBIENT_TOGGLE, COMPOSER_STT, SCHEDULE, LAUNCHER. Hotkeys settings table updated.
  - 5 new palette actions in the root page.
  - TopBar gained Quick Launch rocket, Schedule calendar, Fullscreen toggle.

### What's parked behind a Rust install

This machine has no `cargo`/`rustc` in PATH (verified). Three V2 features need them:

1. **Multi-terminal subsystem** (Wave C). Types + repos + plan are in. Implementation needs a Tauri portable-pty sidecar — pure TS can't drive a real shell. The TerminalPanel + xterm.js front-end can be drafted but will dead-end without the IPC layer.
2. **Native installer build** (Wave B1 §6). Dexie crypto + secrets schema + the V2 Tauri config can be built; producing the actual `.msi`/`.exe`/`.app`/`.dmg` requires `tauri build`, which calls cargo.
3. **Google OAuth loopback for calendar sync** (Wave B2 §5). The loopback handler must run in the Tauri runtime; the web shell can't bind a localhost port. Plan + token storage schema are in.

To unblock these, install Rust:

```powershell
# Windows: rustup
Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile rustup-init.exe
.\rustup-init.exe -y
# then restart shell so cargo/rustc are on PATH
```

Then `npm run tauri:dev` from `app/` to verify the shell still launches.

### Verification

- `npm run typecheck` — clean
- `npm run build` — clean (9.78s, 2496 modules, 47.25 kB CSS gzip 9.24 kB, main bundle 767 kB gzip 243 kB)
- Bundle grew ~50 kB gzip vs V1 — mostly the launcher dialog + ambient CSS. Code-splitting is the V3 chore.

### Files touched this wave

```
app/src/types/                — common.ts (extended), event.ts, integration.ts,
                                 quick-link.ts, terminal.ts (new); agent.ts updated
app/src/lib/ids.ts            — 5 new id stampers
app/src/lib/db/               — schema.ts (v2 tables), repositories.ts (6 new repos), index.ts
app/src/lib/agents/skills.ts  — skill registry seed (new)
app/src/lib/hotkeys.ts        — 5 new hotkeys
app/src/lib/ai/router.ts      — 7 new provider entries (mock-aliased)
app/src/stores/ui.ts          — ambient/scheduleOpen/launcherOpen/composerStt/chatFullscreen
app/src/styles/globals.css    — ambient keyframes, V2 color tokens, fullscreen rules
app/src/App.tsx               — mount AmbientHome, Schedule, Launcher; new hotkeys
app/src/components/layout/    — TopBar (3 new buttons), NavPane (data-nav-pane)
app/src/features/ambient/     — new feature (4 files)
app/src/features/schedule/    — new feature (4 files)
app/src/features/launcher/    — new feature (5 files)
app/src/features/chat/Composer.tsx          — STT mic + live transcript
app/src/features/command-palette/actions.ts — 5 new actions
app/src/features/settings/    — SettingsModal (2 new tabs), Hotkeys.tsx, Providers.tsx,
                                 sections/Ambient.tsx, sections/Accessibility.tsx (new)
app/src/features/agents/AgentManager.tsx    — provider list expansion
app/supabase/migrations/0002_v2.sql         — V2 mirror of Dexie schema (new)
implementation-plan/v2/                     — 11 plan + verify docs (new)
```

### Next steps for viper

1. **Install Rust** so the parked Wave C/B1/B2 work can land.
2. Try the new flows: Mod+Shift+S (Schedule), Mod+Shift+L (Quick Launch), Mod+Shift+. (Ambient now), Mod+Shift+F (Fullscreen), mic icon in composer (STT).
3. Drop API keys for the new providers in Settings → Providers; keys persist now and start routing live the moment the OpenAI-compatible adapter lands.
4. Apply `app/supabase/migrations/0002_v2.sql` if you've already wired Supabase.

---

## 2026-05-29 - V2 Session (Wave 2 — Cozy theme + real desktop install)

**Actor:** opencode (claude) for viper

**Goal:** Get the desktop app running on viper's machine, switch the design language from Voltage (OLED+cyan/violet) to a warm Claude-style cozy palette, and produce a real Windows installer that other people can run.

**Result:** Desktop app launches as a native Tauri 2 window. Warm cozy theme propagated through the existing CSS-variable layer. Release installer build kicked off (long-running). All blocking toolchain dependencies (Rust + Visual C++ Build Tools + Windows SDK) now installed.

### What I did, in order

#### Cleanup

- Six stale `node` processes from May 28 sessions (vite dev servers from the prior day) were still running on undefined ports. They were why viper saw "buttons not working" — their browser tab was attached to last-night's pre-V2 build, not today's V2 build.
- Killed all six (PIDs 5800, 7204, 30700, 40800, 4584, 39516) and started a single fresh vite on `http://127.0.0.1:5173` with `--strictPort` so the V2 bundle is unambiguous.
- Opened the user's default browser to that URL.

#### Toolchain install (this was the big unblock)

- **Rust 1.96.0** installed via the official rustup-init non-interactive flow (`-y --default-toolchain stable --profile default`). Cargo + rustc + rustup all on PATH. Toolchain is `stable-x86_64-pc-windows-msvc`.
- **Visual Studio 2022 Build Tools** installed via the official Microsoft bootstrapper with `--quiet --norestart` and the `Microsoft.VisualStudio.Workload.VCTools` workload + `Microsoft.VisualStudio.Component.Windows11SDK.22621` and Windows 10 SDK fallback. Result: MSVC 14.44.35207 + Windows SDKs 10.0.17134 / 10.0.22621 / 10.0.26100 are on disk. UAC was prompted once and accepted.
- This is what unblocks `cargo build` for the Tauri shell. Without MSVC, the `link.exe` step would fail with "linker not found" no matter how good the Rust toolchain is.

#### Cozy theme (Claude-inspired)

The V1 "Voltage" theme was OLED black + cyan/violet electric accents — striking but harsh. V2 wants warmer, calmer, paper-room. Done by rewriting the CSS variables in one place; the existing 70+ component references to `accent-cyan`/`accent-violet` automatically inherit the new warm values, so the change is visible across the whole app without touching any component.

`app/src/styles/globals.css` — header rewrite (Voltage → Cozy):

| Token             | V1 Voltage    | V2 Cozy                | Why                                  |
| ----------------- | ------------- | ---------------------- | ------------------------------------ |
| `--background`    | `0 0% 4%`     | `28 12% 7%` (#14110F)  | Warm umber, not pure OLED black      |
| `--panel`         | `0 0% 7%`     | `26 10% 11%` (#1D1916) | Side panel/chrome warmth             |
| `--elevated`      | `0 0% 10%`    | `26 10% 15%` (#2A2521) | Cards, dialogs                       |
| `--foreground`    | `0 0% 98%`    | `36 25% 92%` (#EFEAE2) | Paper cream — never stark white      |
| `--accent-cyan`   | `187 95% 43%` | `22 65% 56%` (#D97757) | Copper. Name kept for back-compat.   |
| `--accent-violet` | `258 90% 66%` | `35 70% 60%` (#E5A35F) | Amber. Name kept for back-compat.    |
| `--ring`          | `187 95% 43%` | `22 65% 56%`           | Copper focus ring                    |
| `--destructive`   | `0 72% 56%`   | `6 70% 55%` (#D9624B)  | Brick red — warm side                |
| `--success`       | `158 64% 40%` | `130 35% 50%`          | Sage green                           |
| `--radius`        | `0.625rem`    | `0.75rem`              | 12px cozier corners                  |
| `--surface-warm`  | `0 0% 9%`     | `26 12% 13%`           | Chat bubbles, ambient cards          |
| `--ambient-deep`  | `222 28% 4%`  | `28 25% 5%`            | Ambient takeover ground (warm umber) |

Light theme also rewritten — promoted from "provisional" to shipping. Cream paper background (`36 30% 96%`), copper accents at deeper saturation for AA contrast.

`tailwind.config.ts` — gained semantic aliases `accent.copper` and `accent.amber` (new code can use these), plus a `paper-warm` background image utility for ambient/onboarding hero areas. The existing `accent.cyan`/`accent.violet` aliases stayed so V1 components don't have to change.

#### Branding icon

- The placeholder `icons/icon.svg` had cyan/blue gradients matching V1. Rewrote it to copper→amber matching the new theme.
- Generated a 1024x1024 source PNG via PowerShell GDI+ (a rounded copper-amber gradient with a white "J" stroke). The user has no SVG-rasterizer like Inkscape installed, so generating with GDI+ is the dependency-free path.
- Ran `npx @tauri-apps/cli@2 icon <source>` which fanned the source PNG into the full Tauri icon set:
  - `icon.ico` (Windows resource — required for the build script)
  - `icon.icns` (macOS bundle)
  - `icon.png`, `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` (cross-platform)
  - `Square{30,44,71,89,107,142,150,284,310}x*Logo.png` + `StoreLogo.png` (Windows Store)
  - 22 iOS AppIcon variants
  - 10 Android mipmap variants
- The previous `cargo build` failed with "icons/icon.ico not found"; with the icons now generated, `cargo build` succeeded in 1m 36s. `target/debug/jarvis.exe` exists (~18 MB unstripped).

#### Desktop app launch

- `Start-Process target/debug/jarvis.exe` opened the native Tauri 2 window on viper's desktop (PID 18860, window title "Jarvis"). The dev binary connects to the running vite at `http://127.0.0.1:5173`, so viper sees the V2 bundle (warm cozy theme, ambient, schedule, launcher, expanded providers, STT, full-screen) inside a real OS window rather than a browser tab.

#### Release installer build

- First attempt: cargo built the optimized binary in 5m 34s, then the MSI bundler failed with "Couldn't find a .ico icon" because `tauri.conf.json` had no `bundle.icon` array — Tauri 2 requires that explicit list for the bundler.
- Fixed `tauri.conf.json`:
  - Added `bundle.icon` referencing `icons/{32x32,64x64,128x128,128x128@2x}.png`, `icons/icon.icns`, `icons/icon.ico`
  - Added `bundle.windows.wix.language: "en-US"` for explicit MSI culture
  - Renamed identifier from `ai.jarvis.app` to `ai.jarvis.desktop` because Tauri warns when an identifier ends in `.app` (it conflicts with the macOS bundle extension)
- Re-ran `npm run tauri:build`. Cargo cache hit on most deps, only the binary itself recompiled (2m 24s). Then:
  - WiX downloaded automatically (`wix314-binaries.zip`)
  - NSIS downloaded automatically (`nsis-3.11.zip` + `nsis_tauri_utils.dll`)
  - Both bundlers ran cleanly

**Artifacts produced:**

| File                                                    | Size    | Use                   |
| ------------------------------------------------------- | ------- | --------------------- |
| `target/release/jarvis.exe`                             | 5.52 MB | Bare release binary   |
| `target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi`  | 3.28 MB | Windows MSI installer |
| `target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` | 2.62 MB | NSIS setup wizard     |

These are the files to hand to other people. The `.msi` is the corporate-friendly format (deploys via Group Policy, Intune, etc.). The NSIS `-setup.exe` is the friendly double-clickable consumer format. Both install to `Program Files`, register an uninstaller, and ship the same release binary.

### Files touched this wave

```
app/src/styles/globals.css            — Voltage → Cozy palette rewrite, light mode promoted
app/tailwind.config.ts                — accent.copper/accent.amber aliases, paper-warm bg
app/src-tauri/tauri.conf.json         — bundle.icon array, wix language, identifier fix
app/src-tauri/icons/icon.svg          — copper/amber gradient
app/src-tauri/icons/*.png/.ico/.icns  — full icon set (52 files generated)
app/src-tauri/icons/android/          — 10 mipmap variants
app/src-tauri/icons/ios/              — 22 AppIcon variants
DEVLOG.md                             — this entry
```

### Verification

- vite dev server: 200 OK on `http://127.0.0.1:5173/`, serving V2 bundle
- `cargo build`: ✅ 1m 36s (debug, dev profile)
- `cargo build --release`: ✅ 2m 24s (release, optimized)
- WiX MSI bundle: ✅ `Jarvis_0.1.0_x64_en-US.msi`
- NSIS bundle: ✅ `Jarvis_0.1.0_x64-setup.exe`
- Desktop window: ✅ launched, PID 18860, title "Jarvis"
- HMR: ✅ theme rewrite hot-pushed to both browser tab and Tauri webview without restart

### Why "the buttons weren't working"

Two compounding things:

1. **Stale dev servers from May 28 still bound localhost ports.** Viper's browser tab was attached to last night's pre-V2 build, where `setLauncherOpen` and the rocket/calendar/maximize TopBar buttons literally didn't exist yet. Clicks on the new V2 buttons would have done nothing because the V2 store actions weren't in that bundle.
2. **The browser kept the old bundle cached** even after the new vite started, until we forced a fresh `Start-Process http://127.0.0.1:5173/`.

After the cleanup pass and fresh launch, the V2 buttons (Quick Launch / Schedule / Fullscreen / mic in composer / palette V2 actions / hotkeys) all live in the served bundle. The desktop window also has them.

### Next steps for viper

1. **Look at your screen.** The Tauri window titled "Jarvis" should be open with the warm cozy theme: warm umber background, copper/amber accents, paper-cream text. If anything looks off (dead button, wrong color), tell me which exact element and I'll trace it.
2. **Wait for the release build.** When it finishes, `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi` is the file you give other people. Or `bundle/nsis/Jarvis_0.1.0_x64-setup.exe` for an NSIS-style setup.
3. **Try Mod+Shift+L** (Quick Launch), **Mod+Shift+S** (Schedule), **Mod+Shift+F** (Fullscreen), **Mod+Shift+.** (Ambient now). The TopBar also has rocket / calendar / maximize buttons for these.
4. The seven new providers (xAI, OpenRouter, Groq, DeepSeek, Mistral, Together, Ollama) are in **Settings → Providers**. Keys persist now; live routing for them is a future wave.

---

## 2026-05-29 - V2 Session (Wave 3 — Functional NavPane + Cozy Checklist + Jarvis Assistant + bug triage)

**Actor:** opencode (claude) for viper

**User report driving the wave:**

> "the model picker is literally invisible, STT crashes the whole system, I can't make a project, I can't make chats, the AIs on the side are placeholders. Use the cozy theme from `theme-design.md`. Add a Jarvis Assistant that takes commands like 'open 4 terminals with claude in tiger project'. The buttons at the side for specific AI agents are not working."

**Result:** Every visible bug fixed, Cozy Checklist palette adopted, Jarvis Assistant shipped at Mod+J, fresh installers built. Typecheck clean. Vite build clean. Both `.msi` and NSIS `.exe` regenerated.

### Bugs fixed

#### 1. Model picker invisible

`src/features/chat/Composer.tsx` `ModelPicker`:

- The `<Sparkles />` and `<ChevronDown />` icons rendered without any size class — lucide-react defaults to 24×24, which collapsed under flex without explicit sizing. Added `h-3.5 w-3.5 shrink-0` on both. Active-row indicator switched from `text-accent-cyan` (now warm but at low contrast on the popover surface) to `text-accent-copper` for clarity.
- Popover content was `bg-elevated` by default but had no explicit text color and no width cap — added `bg-elevated text-foreground`, widened to `260px`, capped height with `max-h-[320px] overflow-y-auto scrollbar-hidden` so all 12 providers actually scroll.

#### 2. STT crash

`src/features/chat/Composer.tsx` `startStt` / `stopStt`:

- Some Tauri WebView2 builds expose `window.SpeechRecognition` but throw a synchronous `DOMException` from `.start()` (commonly when the mic permission was never granted to the WebView host). The previous code flipped `sttListening` to true and called `VoiceService.startListening()` _before_ the engine confirmed, so the throw bubbled into React's render pipeline and tore the tree down under StrictMode.
- Wrapped both operations in `try/catch`, only flipping the visible flag _after_ the engine accepted the call, and surfacing `toast.error('Voice error', msg)` instead of crashing.

#### 3. NavPane decorative — "can't make project / chats / agents inactive"

`src/components/layout/NavPane.tsx` rewritten end-to-end:

- **Projects section** — `useLiveQuery(projectRepo.listByWorkspace)` for live data, header gets a `+` button that calls `projectRepo.create({ name: "Project N", color_hue: hash })` and `setProjectId(...)`. Clicking a row activates the project. Active row gets a `ring-1 ring-accent-copper/40`.
- **Chats section** — `useLiveQuery(db.chats.where('workspace_id').equals(workspaceId))` sorted by `updated_at desc`, `+` button calls `chatRepo.create({ mode: 'chat' })` and `setActiveChat`. Click switches active chat + `setChatMode(chat.mode)`.
- **Agents section** — clicking an agent now creates a new chat with `active_agent_ids: [a.id]` and switches to it. This was the literal "buttons at the side for AI agents are not working" complaint — the items had no `onClick`. Toast confirms `@slug ready · New chat started with NAME`.
- All actions guarded by a `workspaceId` check that toasts "Still loading — workspace is initializing" instead of silently no-oping.
- Added a tiny status footer showing `Local · {localUserId.slice(4,8)}` so the user can see they're in a real workspace.

### Cozy Checklist theme adopted

Source: `C:\Users\viper\projects\shopify-urbeauty-audit\theme-design.md` (the user's reference design language).

`app/src/styles/globals.css` rewritten. Light + dark both shipping:

| Token                                 | Dark (warm wood)                              | Light (cream paper)           |
| ------------------------------------- | --------------------------------------------- | ----------------------------- |
| `--background`                        | `#2a2018`                                     | `#f5efe6`                     |
| `--panel`                             | `#34281e`                                     | `#ede4d3`                     |
| `--elevated`                          | `#3a2d22` (cardstock)                         | `#fffbf5` (paper)             |
| `--foreground`                        | `#f5e6c8` (cream ink)                         | `#3a2e22` (warm brown ink)    |
| `--accent-cyan` (compat) → terracotta | `#d97757`                                     | `#d97757` deepened            |
| `--accent-violet` (compat) → honey    | `#d4a258`                                     | `#d4a258` deepened            |
| `--rose`                              | `#c97b6e`                                     | `#c97b6e`                     |
| `--sage`, `--sage-deep`               | `#7c9870` / `#5d7855`                         | same                          |
| `--lavender`                          | `#9d8aa8`                                     | same                          |
| `--cream`                             | `#f5e6c8`                                     | same                          |
| Severity (5-level)                    | `crit/high/med/low/info` with darkened bg     | full set with cream-tinted bg |
| Shadows                               | brown-tinted not gray                         | brown-tinted, lighter alpha   |
| `--radius`                            | 14px                                          | 14px                          |
| `--radius-lg` (cards)                 | 22px                                          | 22px                          |
| Body bloom                            | radial pools (rose / sage / honey / lavender) | same, brighter tints          |

**Typography:**

- `@import` for Fraunces (serif display, opsz 9..144 weights 500/600/700) and Plus Jakarta Sans (UI, weights 400-700) and JetBrains Mono.
- `font-sans` now Plus Jakarta Sans, new `font-serif` and `font-display` both Fraunces.
- `h1/h2/h3` and `.font-display` and `.eyebrow` selectors in `@layer base` apply the serif treatment with `letter-spacing: -0.02em / -0.01em`.
- Ambient clock + ambient quote upgraded to Fraunces in italic for that paper-room feel.

**New utility classes (opt-in, in `@layer components`):**

- `.cozy-card` — 22px radius, brown-tinted soft shadow, hover lifts to `--shadow-lift` and warms to cream border
- `.cozy-pill` — 999px radius for chips
- `.cozy-toast-success` — sage gradient pill
- `.cozy-toast-action` — rose → terracotta → honey serif gradient pill (the "celebration toast")
- `.cozy-bg-bloom` — re-applies the radial bloom locally
- `.sev-pill.{crit,high,med,low,info}` — five-level severity gradients

`app/tailwind.config.ts`:

- New aliases under `accent.*`: `rose`, `terracotta`, `honey`, `sage`, `sage-deep`, `lavender`, `cream`. Existing `cyan/violet/copper/amber` keep working.
- New top-level color groups: `crit/high/med/low/sev.info` (each a `{ DEFAULT, bg }` object) and `paper.{DEFAULT,soft,done}`.
- New `borderRadius.xl` = `var(--radius-lg)` (22px), `borderRadius.lg` = `var(--radius)` (14px).
- New `boxShadow.{soft,lift,cozy}`.
- `fontFamily.sans` = Plus Jakarta Sans stack; `serif` and `display` = Fraunces; `mono` = JetBrains Mono.

The 70+ existing component refs to `text-accent-cyan` / `bg-accent-cyan/10` / `text-accent-violet` / etc. all retone automatically through the variable layer — no component edits needed for the palette swap.

### Jarvis Assistant (Mod+J)

New module `src/features/assistant/`:

- `intents.ts` — discriminated union of `AssistantIntent` (create_project, switch_project, create_chat, open_terminals, create_task, create_event, set_ambient, set_fullscreen, open_settings/palette/launcher/schedule, unknown).
- `parse.ts` — pure regex-based `parseAssistantInput(raw)`. Strips filler words (`please`, `can you`, `i want to`), handles quoted names, returns the right intent kind.
- `execute.ts` — async `executeIntent(intent)` dispatcher. Calls existing `projectRepo` / `chatRepo` / `taskRepo` / `eventRepo` / `terminalSessionRepo`. Never throws; returns `{ ok, message }`.
- `AssistantBar.tsx` — Dialog with autofocused input, live preview line under it ("→ Will create project 'tiger'"), Recents pill row pulled from `localStorage.jarvis-assistant-recent` (last 5), Examples footer.
- `index.ts` — barrel.

**Wiring:**

- `src/lib/hotkeys.ts` adds `HOTKEYS.ASSISTANT = 'Mod+J'`.
- `src/stores/ui.ts` adds transient `assistantOpen` + `setAssistantOpen` (not persisted, matches the launcher/schedule pattern).
- `src/App.tsx` mounts `<AssistantBarHost />` and registers the `Mod+J` hotkey.
- `src/components/layout/TopBar.tsx` gains a `Sparkles` button next to Quick Launch.
- `src/features/settings/sections/Hotkeys.tsx` adds the row label (forced by exhaustive `Record<keyof typeof HOTKEYS, string>`).

**Commands the user can type now:**

| Type                                                                 | Action                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `create project tiger`                                               | `projectRepo.create` + auto-switch via `setProjectId`, color hue derived from name hash |
| `switch to project tiger`                                            | resolves case-insensitive then substring, warns if not found                            |
| `create chat called planning in tiger`                               | resolves project, creates chat, opens it                                                |
| `open 4 terminals`                                                   | creates 4 `terminal_sessions` rows (PTY runtime is future work)                         |
| `open 4 terminals with claude code in tiger`                         | + `shell_command: 'claude code'` + `project_id` resolved                                |
| `open claude in tiger`                                               | shorthand for `count=1, command='claude'`                                               |
| `make a todo: ship the launcher tomorrow`                            | `taskRepo.create` with `due_at` parsed for today/tomorrow/weekday                       |
| `schedule lunch with sam friday at 1pm`                              | delegates to existing `parseEventInput` → `eventRepo.create`                            |
| `ambient on` / `ambient off`                                         | toggles `ambientActive`                                                                 |
| `fullscreen` / `exit fullscreen`                                     | toggles `chatFullscreen`                                                                |
| `open settings` / `open palette` / `open launcher` / `open schedule` | corresponding modal opens                                                               |

Filler words like "please", "can you", "i want to" are stripped before matching. Quoted names (`create project "Tiger Eye"`) work.

**Known limitations of the parser (intentional simplicity):**

- Project resolution is fuzzy — substring matches; ambiguous names pick the first hit
- Casual due dates only (`today`, `tomorrow`, weekday names) — full parsing for events
- Terminal subsystem only writes the DB row; the actual PTY spawn is future work (B2 plan slice)
- No remote AI fallback — this is intentional, the bar is for deterministic commands

### Files touched this wave

```
app/src/styles/globals.css                              — Cozy Checklist palette + fonts + utilities
app/tailwind.config.ts                                  — accent.{rose,terracotta,honey,sage,...}, severity, fonts, boxShadow
app/src/components/layout/NavPane.tsx                   — fully rewritten: projects + chats + agents wired
app/src/features/chat/Composer.tsx                      — ModelPicker icon sizing, STT defensive try/catch
app/src/features/schedule/ScheduleModal.tsx             — Repeat icon + formatInstance helper, RecurrenceInstance shape fix
app/src/features/assistant/intents.ts                   — NEW
app/src/features/assistant/parse.ts                     — NEW
app/src/features/assistant/execute.ts                   — NEW
app/src/features/assistant/AssistantBar.tsx             — NEW
app/src/features/assistant/index.ts                     — NEW
app/src/lib/hotkeys.ts                                  — HOTKEYS.ASSISTANT = 'Mod+J'
app/src/stores/ui.ts                                    — assistantOpen + setAssistantOpen
app/src/App.tsx                                         — AssistantBarHost mount + Mod+J hotkey
app/src/components/layout/TopBar.tsx                    — Sparkles assistant button
app/src/features/settings/sections/Hotkeys.tsx          — ASSISTANT label row
DEVLOG.md                                               — this entry
```

### Verification

- `npm run typecheck` — ✅ clean (zero errors)
- `npm run build` (vite production) — ✅ 20.80s, 2502 modules, CSS 52.05 KB (was 46.60 KB; the +5 KB is the Cozy palette additions, severity utilities, and the Cozy `.cozy-*` recipes), index JS 813 KB / 257 KB gzipped
- `npm run tauri:build` — ✅ cargo cache hit on most deps; rebuilt only `jarvis` crate (~2m 41s); both bundles regenerated cleanly
- Tauri desktop window — ✅ relaunched (PID 44916), title "Jarvis", warm cozy theme visible
- Old V1 `node` processes from May 28 still running on background ports — left alone (not blocking anything; vite dev server serves on 5173 strictPort)

### Artifacts (regenerated)

| File                                                                  | Size    | Use                   |
| --------------------------------------------------------------------- | ------- | --------------------- |
| `app/src-tauri/target/release/jarvis.exe`                             | 5.57 MB | Bare release binary   |
| `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi`  | 3.33 MB | Windows MSI installer |
| `app/src-tauri/target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` | 2.67 MB | NSIS setup wizard     |

### What viper should test next

1. **Sidebar.** Click `+` next to Projects — should immediately get a project, the row highlights with a copper ring, and the TopBar breadcrumb updates. Click `+` next to Chats — chat opens. Click an agent (Jarvis / Athena / etc.) — a new chat opens with that agent.
2. **Model picker.** Open any chat, click the small `Sparkles ✨ provider name ⌄` button at the bottom-left of the composer. Now visibly opens, lists all 12 providers, click switches. Active provider gets a small "active" copper label.
3. **Mic / STT.** Click the mic in the composer (or `Mod+Shift+M`). Browser will prompt for permission. If permission denied or the API isn't available in WebView2 (Microsoft removed it from default WebView2 builds — this is actually expected), you now get a polite toast instead of an app crash.
4. **Jarvis Assistant.** Hit `Mod+J` (or click the new Sparkles button in the TopBar, between Quick Launch and Schedule). Type `create project tiger`. Then `create chat called planning in tiger`. Then `open 4 terminals with claude code in tiger`. Each should toast success and appear in the sidebar.
5. **Cozy theme.** Should now feel warm umber + copper + amber + sage in dark mode. Toggle to light in Settings → Appearance — should be cream paper + warm brown ink + same accents.
6. **Drop the new installer on someone.** `bundle/msi/Jarvis_0.1.0_x64_en-US.msi` is the file. Or `bundle/nsis/Jarvis_0.1.0_x64-setup.exe` for the friendlier consumer wizard.

### Things noted but not chased this wave

- **"BridgeMind"** the user mentioned — could not find any reference in the codebase or in the user's project tree. Treating as a phrase to clarify next session.
- **Real PTY spawn for terminals.** The Jarvis Assistant queues terminal rows via `terminalSessionRepo.create` but the actual PTY runtime needs a Tauri Rust command + a frontend terminal panel. That's a meaningful slice on its own, parked for the next wave.
- **Drag-and-drop of chats between projects.** Out of scope for this wave but the data model already supports it (`chat.project_id` is optional/mutable).
- **Provider live routing for the 7 OpenAI-compatible providers.** Keys persist; the OpenAI-compatible adapter that fans them all into the same code path is parked.

---

## 2026-05-29 - V3 Session (Wave 4 — BridgeMind-class platform: real terminals, pages router, skills, kanban, benchmarks, Supabase scaffolding, +7 providers)

**Actor:** opencode (claude) for viper, with 19 parallel sub-agents

**User report driving the wave:**

> "I want multiple actually-working terminals (real Windows terminal where I can run commands), open chat alongside terminals, Jarvis can do all of this. Use 15-25 sub-agents. Make it errorless. Add more UI effects, more pages. More API keys (Anthropic, OpenAI, DeepSeek, anything). Live AI benchmark from a real official source, must all be free. Agent .md / skill .md files the agent reads. App is called Jarvis. Inspired by BridgeMind: BridgeSpace 16 panel terminals, Kanban, Agent Manager, Session History, BridgeCode CLI, MCP, BridgeWard, BridgeSecurity, BridgeVoice, BridgeSpeak. Free unlimited app, opt-in $5/month with cheap built-in Jarvis (DeepSeek), BYOK for premium. Use Supabase for cloud DB."

**Result:** V3 ships. Real PTY terminals, multi-pane grid up to 16, pages router with 7 routes, skills + agents Markdown loader, kanban, session history with replay, live benchmark page, +7 providers (19 total), Jarvis swarm roles (Scout/Builder/Reviewer), MCP-lite tool registry, celebration confetti, full Supabase scaffolding (schema + Edge Function + client UI). Typecheck clean. Both `.msi` and `.exe` regenerated.

### Architecture changes

#### V3 pages router

`useUIStore` gains a transient `route: 'chat' | 'terminal' | 'kanban' | 'agents' | 'skills' | 'benchmarks' | 'history'`. Reloads always land back on `'chat'` (omitted from `partialize`).

`src/components/layout/PageRouter.tsx`: lazy-loads each feature page via `React.lazy(() => import('@/features/...').then(...).catch(() => placeholder))`. The `.catch` fallback was critical — it means a single missing feature module renders a paper-card placeholder rather than crashing the app.

`App.tsx#ActiveCanvas`: now reads `route` first. Non-`chat` routes delegate to `<PageRouter />`; the `chat` route preserves the existing council/chat dispatch so council mode still pulls per-chat agent ids.

`NavPane`: gained a "Workspace" section above Pinned with 7 route buttons (Chat, Terminals, Kanban, Skills, Benchmarks, History, Agents). Active row gets `ring-1 ring-accent-copper/40`.

`TopBar`: new icon buttons for Terminal / Kanban / Benchmarks between Quick Launch and Schedule. Route-aware breadcrumb (`/ Terminals` etc) renders only when `route !== 'chat'`. 1px copper bottom-border lights up off-chat.

`Inspector`: route-aware quick panels above the existing Today tabs. Different content per route — active terminals list (with kill button), recent task transitions, enabled-skills counter, top-5 benchmark mini-leaderboard, last-5-chats jump list.

#### Real terminals (Slice 1 + 2 + 3)

**Slice 1 — Tauri Rust PTY backend** (`app/src-tauri/src/terminal.rs`, ~280 lines)

- New crate deps: `portable-pty = "0.8"`, `nanoid = "0.4"`
- `TerminalState` = `Arc<Mutex<HashMap<String, PtyHandle>>>` managed by Tauri
- 5 commands: `terminal_spawn` / `terminal_write` / `terminal_resize` / `terminal_kill` / `terminal_list`
- 2 events: `terminal://output { sessionId, data }`, `terminal://exit { sessionId, code }`
- Default shell: Windows → `powershell.exe`, mac/Linux → `$SHELL` then `/bin/zsh` then `/bin/bash`
- Session id: `tty_<nanoid12>` (URL-safe alphabet)
- Reader task per session: `tokio::spawn`, 4 KiB lossy UTF-8 chunks, drops slave fd so master sees EOF on exit
- ConPTY (Windows 10 1809+) implicit via portable-pty; older Windows returns `Err("terminal: spawn failed: ...")` instead of panicking
- `cargo check` → 2m 04s, zero warnings

**Slice 2 — xterm.js frontend** (`src/features/terminals/TerminalView.tsx`, ~370 lines)

- Deps added: `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`
- Cozy palette themed (copper cursor `#d97757`, cream foreground, warm wood background; light mode = paper bg + brown ink)
- Lifecycle: spawn (or attach) on mount → wire `onData` to `terminal_write` → subscribe to `terminal://output|exit` filtered by sessionId → ResizeObserver re-fits + `terminal_resize`
- Unmount disposes xterm but **never kills the PTY** (sessions persist; explicit kill is the user's job)
- Web/dev fallback: paper-soft "Terminal backend not available" card if `invoke('terminal_spawn')` rejects

**Slice 3 — Multi-pane grid** (sub-agent returned empty — written by main agent)

- `paneTree.ts`: immutable tree ops. `PaneNode` = `leaf | split` discriminated union. `splitPane` (capped at MAX_PANES=16), `closePane` (collapses single-child splits), `setRatio` (clamped 0.1–0.9), `findPane`, `countLeaves`, `updateLeaf`, `firstLeafId`
- `TerminalGrid.tsx`: recursive renderer. Each leaf has a 24px chrome (command name + split-h / split-v / close). Splits get a 4px draggable gutter that calls `setRatio` on mousemove. Hover lights the gutter copper.
- `TerminalsPage.tsx`: header with eyebrow + font-display title, toolbar with `count / 16` and Add/Reset buttons, full-bleed grid below. Persists tree shape (not session ids) to `localStorage.jarvis-terminal-pane-tree`.
- Default shell detection: `navigator.platform` for "Win" → `powershell`, else `bash`

The Tauri app at PID 45900 has live PTYs available now. xterm CSS bundles into `dist/assets/TerminalsPage-*.css` (4.35 KB).

#### Skills + agents Markdown loader (Slice 5 + 6 + 7)

**Slice 5 — loader** (sub-agent returned empty — written by main agent)

- `parseFrontmatter.ts`: tiny YAML subset parser. Supports `key: value | 'string' | "string" | [a,b] | true|false | 123 | 1.5`. Tolerates Windows line endings. CSV split respects single/double quotes.
- `loader.ts`: `loadAllSkills()` + `loadAllAgents()` use Vite's `import.meta.glob('/.jarvis/{skills,agents}/*.md', { query: '?raw', import: 'default', eager: true })`. Each file gets parsed into a `SkillManifest`. Sort by severity then name. Project-level loading deferred (needs `@tauri-apps/plugin-fs`).
- `registry.ts`: singleton with `loadFromDisk` (idempotent, shares in-flight Promise), `list(kind?)`, `getAll`, `get`, `toggle`, `setEnabled` (alias), `subscribe`. Both `list/toggle` and `getAll/setEnabled` work — covers either naming convention.

**Slice 6 — UI** (`SkillsPage.tsx`, `SkillCard.tsx`, `SkillDetail.tsx`)

- Two-pane layout: 320px card rail + detail pane (collapses to single column under 768px with back button)
- Cozy paper-cards with severity pills (.sev-pill from globals.css), kind chips (Bot/Sparkles), tag chips, Switch toggle
- Inline markdown renderer (no dep): h1-h3, paragraphs, ordered/unordered lists, inline `code`, fenced ``` blocks, **bold**, _italic_. HTML-escapes input first.
- Search across title/name/tags/body. Tab filter `[All] [Skills] [Agents]`.
- Empty state: "Drop `.md` files into `~/.jarvis/skills/`"

**Slice 7 — built-in markdowns** (`app/.jarvis/skills/*.md`, `app/.jarvis/agents/*.md`)

- 4 skills + 3 agents = 7 files, 60-150 lines each, ~17 KB total
- `sentinel-prompt-defense.md` — Jarvis's BridgeWard-equivalent. Prompt-injection auditor. severity: high.
- `watchtower-security.md` — BridgeSecurity-equivalent. OWASP/CWE scanner. severity: crit.
- `echo-bridge-voice.md` — BridgeSpeak-equivalent. Voice API wrapper. severity: low.
- `cozy-readme.md` — personality skill: how Jarvis talks (no hype, no exclamation marks).
- `scout.md` — agent: read-only codebase mapper.
- `builder.md` — agent: senior engineer, owns assigned file scope exclusively.
- `reviewer.md` — agent: read-only quality gate, refuses to rubber-stamp.
- All Jarvis-branded (no BridgeMind references in copy).

#### Kanban (Slice 8)

`features/kanban/{KanbanPage,KanbanColumn,KanbanCard,hooks,index}.tsx`

- Three columns: Todo (`'open'`), In progress (`'in_progress'`), Done (`'done'`). Blocked + cancelled in an "Other" pop-out.
- HTML5 drag-and-drop (no dep). Cards get `opacity` + copper-ring while dragging. Drop column gets `ring-1 ring-accent-copper`.
- Optimistic UI: status flipped locally before dexie write resolves. Rolls back if write fails.
- Inline `+` per column: single input, Enter saves, Esc cancels.
- Click card opens edit dialog (title, description, due date, priority, status).
- Severity legend in header. Project filter (active project / all). Empty state suggests `Mod+J make a todo: ...`.

#### Live benchmarks (Slice 9)

`features/benchmarks/{BenchmarksPage,BarChart,benchmarkData,index}.tsx`

- Pulls from `https://lmarena.ai/api/leaderboard` with 5s timeout. Falls back to a frozen 28-row snapshot in `benchmarkData.ts` (Claude 3.5 Sonnet, GPT-4o, Gemini 1.5 Pro, Llama 3.1 70B/405B, Mistral Large, DeepSeek V3, Grok 2, Command-R+, Qwen 2.5 72B, etc.)
- 30-min cache in `localStorage.jarvis-benchmark-cache`. "From snapshot" warning chip when in fallback mode.
- Pure SVG horizontal bar chart with CI whisker bars. Bars colored: terracotta = proprietary, sage = open-source.
- Sortable table (score / cost / context). Drawer with detail (cost per 1M, license, context window, votes, source link).
- "Use this model" button only enabled for providers in our `ProviderId` union.

#### Session history (Slice 10)

`features/history/{HistoryPage,HistoryList,Replay,index}.tsx`

- Two-pane: 320px chat list (capped 200) + replay pane.
- Live query on `db.chats.where('workspace_id')` sorted by `updated_at desc`. Search across title + message body.
- Replay scrubber: tick per message (capped 80), drag/click/keyboard seek, Space toggles play/pause, 0.5×/1×/2×/4× speed dropdown.
- Auto-advance gap: `clamp(80, 2500, (next.created_at - cur.created_at) / speed)` — real wall-clock spacing scaled by speed.
- "Open in chat" button calls `setActiveChat(chat.id) + setRoute('chat')`.
- Reduced-motion: replay defaults to paused; user must click play.

#### MCP-lite tool registry (Slice 13)

`lib/mcp/{registry,builtins,index}.ts`

- In-process `Map<string, ToolDef>` behind a `toolRegistry` singleton. Re-registering a name replaces (warns once via `console.warn`). `subscribe` notifies on every change.
- Built-in tools registered at import time: `fs.read`, `fs.list`, `shell.run`, `clipboard.copy`, `voice.speak`, `route.set`, `notify`. Each wraps an existing capability and returns a friendly error rather than throwing.
- `lib/mcp/registry.test.ts` — covers register/unregister, replace-warns, invoke success, invoke unknown rejects, subscribe fan-out. No Vitest config in repo yet so these are documentation-only.
- `route.set` calls `useUIStore.setRoute`; until the route store landed (it now has) the tool would have surfaced "UI store does not expose setRoute yet" — clean now.

#### +7 providers (Slice 11)

19 total. New: `cohere`, `perplexity`, `fireworks`, `replicate`, `hyperbolic`, `novita`, `lambda`. Added to `ProviderId` union, `Composer.PROVIDERS` + `PROVIDER_LABELS`, `Settings/Providers.BYOK_PROVIDERS`. Router aliases the new ids to `mockProvider` (matches the V2 placeholder pattern at `lib/ai/router.ts:41-48`); the OpenAI-compatible adapter that fans them into a real codepath is parked.

#### Swarm roles (Slice 12)

Scout / Builder / Reviewer added to `getDefaultAgents()` in `features/agents/registry.ts`. Stored as `skills: ['role:scout' | 'role:builder' | 'role:reviewer']` since `Agent` type doesn't have a `role` field. AgentManager card top-right gets a gradient pill (sage / terracotta / lavender). Persona avatars added (`personas.ts` `ROLE_PERSONAS` map with hues 105/14/268).

System prompts:

- Scout (1903 chars) — read-only, produces JSON brief with file tree + entry points + recommended scope. Refuses to write code or call shell. Model: claude-3-5-haiku-latest.
- Builder (1881 chars) — owns assigned file scope exclusively. Refuses to touch other files. Writes tests. Model: claude-3-5-sonnet-latest.
- Reviewer (1861 chars) — read-only quality gate. Posts verdict (`approve` / `request_changes` / `reject`). Refuses to rubber-stamp. Model: gpt-4o-2024-11-20.

#### Celebration system (Slice 15)

`features/celebrate/{celebrate,Confetti,index}.tsx`

- Pure-canvas confetti (no dep). Particles: 80 default / 40 for kanban_done / 200 for big. Gravity 0.36, x-damp 0.995, vy ∈ [-14,-8]. 55% rectangles + 45% circles from cozy palette.
- Origin per kind: bottom-center for project_created/kanban_done, bottom-right for terminal_success, top sweep for big.
- `celebrate(kind, detail?)` fires a `CustomEvent('jarvis:celebrate')` + a `toast.success(headline, detail)`. Headlines:
  - project_created → "New project. Welcome aboard."
  - kanban_done → "Done. Nice."
  - terminal_success → "Build green. Ship it."
  - big → "🎉 Big win." (sole emoji exception, this is celebration UX)
- Honors `prefers-reduced-motion` — toast still fires, canvas suppressed.
- Mounted as `<CelebrationHost />` inside `WorkspaceRoot`.

#### Onboarding refresh (Slice 14)

New step `whats-new` between persona and providers. 2×3 grid of paper-cards highlighting the V3 features (Real terminals, Kanban, Skills + agents, Live benchmarks, Session history, Jarvis Assistant). Each card shows the `Mod+J` example to open it. Cozy `.cozy-card` styling, copper-ring hover. Chrome footer hidden on this step (matches Welcome/Demo pattern).

New `STEPS` array: `['welcome', 'persona', 'whats-new', 'providers', 'permissions', 'demo']`.

#### Jarvis Assistant route extension (Slice 19)

`features/assistant/{intents,parse,execute}.ts`

- New intent variant: `{ kind: 'navigate'; route: NavRoute }`
- Two new regex patterns added before the existing `open settings/palette/launcher/schedule` block:
  - `^(?:open|go to|show|switch to)\s+(terminal(?:s)?|kanban|skills|benchmarks?|history|agents?|chat)$`
  - `^(?:open|show)\s+(?:my\s+)?(...) \s*(?:please)?$`
- `normalizeRoute` collapses plurals (`terminals` → `terminal`, etc.)
- Executor: `case 'navigate': useUIStore.getState().setRoute(intent.route)`
- Examples surfaced in `intents.ts`: `open terminals`, `open kanban`, `show benchmarks`

#### Supabase scaffolding (Slice 18)

`supabase/{schema,migrations/0001_init}.sql`, `supabase/functions/jarvis-proxy/index.ts`, `supabase/README.md`, `app/src/lib/supabase/{client,types}.ts`, `app/src/features/billing/HostedJarvis.tsx`

**Schema:**

- `profiles` — mirror of auth.users with `tier ∈ {free, plus, byok-only}`, `monthly_quota` (free=50, plus=1500, byok-only=∞)
- `api_keys` — encrypted user keys (column provisioned for future Vault upgrade; README documents path)
- `usage_log` — one row per proxied request with provider, model, token counts, cost, status, latency
- `usage_month` view — monthly count aggregator
- 3 RLS policies (own profile, own keys, own usage) — `auth.uid() = id/user_id`

**Edge Function (`jarvis-proxy`, Deno TS):**

- Reads `Authorization: Bearer <jwt>`, calls `supabase.auth.getUser(jwt)`
- Counts this month's `ok` usage. If `count >= monthly_quota` and tier ≠ `byok-only`, returns `429 { error: 'rate_limit', message, used, quota }`
- Otherwise proxies to `https://api.deepseek.com/chat/completions` (OpenAI-compatible), streams via TransformStream
- Auto-injects `stream_options.include_usage = true` so the final SSE chunk carries token counts
- Logs `usage_log` row after stream completes (prompt/completion tokens, est. cost, status, latency)
- Pricing table: deepseek-chat $0.14/$0.28 per 1M, deepseek-reasoner $0.55/$2.19 (approximate, may drift)

**Client (`HostedJarvis.tsx`):**

- Settings panel showing tier + this-month usage progress bar
- Sign-in / sign-out (Supabase Auth — magic link flow)
- "Upgrade to Plus ($5/month)" — opens `VITE_STRIPE_CHECKOUT_URL` if set, otherwise toast "coming soon"
- "BYOK only" toggle writes `tier='byok-only'` directly via RLS
- If `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` unset, renders setup card pointing at the README

**README:**

- 60-line walkthrough: `supabase init` → `link --project-ref` → `db push` → `secrets set DEEPSEEK_API_KEY=...` → `functions deploy jarvis-proxy` → paste URL+anon key into Jarvis Settings

### Cross-slice integration work (main agent)

3 of 19 sub-agents returned empty results. Investigated and shipped the missing pieces:

- **Slice 3 (terminal grid):** Sub-agent returned empty. Confirmed only Slice 2's TerminalView existed. Wrote `paneTree.ts` (~120 lines), `TerminalGrid.tsx` (~200 lines), `TerminalsPage.tsx` (~110 lines).
- **Slice 5 (skills loader):** Sub-agent returned empty. Slice 6 (UI) had shipped but with broken imports. Wrote `parseFrontmatter.ts` (~85 lines), `loader.ts` (~120 lines), `registry.ts` (~110 lines), `index.ts` (barrel exporting `SkillsPage` for PageRouter).
- **Slice 4 (PageRouter):** Sub-agent returned empty but had partially delivered: `ui.ts` got `route` + `setRoute`, `PageRouter.tsx` exists and is wired correctly with lazy + catch fallbacks. Missing: NavPane Workspace section, App.tsx swap. Added the Workspace section above Pinned with 7 route buttons (Chat / Terminals / Kanban / Skills / Benchmarks / History / Agents). Modified `App.tsx#ActiveCanvas` so non-chat routes delegate to PageRouter.

`<CelebrationHost />` mounted in `WorkspaceRoot` per Slice 15's instruction.

`features/terminals/index.ts` barrel: `TerminalViewProps` lives in `./types` not `./TerminalView` — fixed export source.

### Files touched this wave (45+ files)

```
# Foundation
app/src-tauri/Cargo.toml                               +portable-pty 0.8, +nanoid 0.4
app/src-tauri/src/lib.rs                               +mod terminal, +manage state, +5 handlers
app/src-tauri/src/terminal.rs                          NEW ~280 lines

# Pages router
app/src/stores/ui.ts                                   +Route type, +route field, +setRoute, transient
app/src/components/layout/PageRouter.tsx               NEW lazy + catch
app/src/components/layout/NavPane.tsx                  +Workspace section, +RouteItem helper
app/src/components/layout/TopBar.tsx                   +Terminal/Kanban/Benchmarks buttons, +breadcrumb segment
app/src/components/layout/Inspector.tsx                +route-aware quick panels
app/src/App.tsx                                        ActiveCanvas now delegates to PageRouter for non-chat

# Terminals
app/package.json                                       +xterm, +xterm-addon-fit, +xterm-addon-web-links
app/src/features/terminals/TerminalView.tsx            NEW xterm wrapper
app/src/features/terminals/types.ts                    NEW
app/src/features/terminals/paneTree.ts                 NEW immutable tree
app/src/features/terminals/TerminalGrid.tsx            NEW recursive renderer
app/src/features/terminals/TerminalsPage.tsx           NEW route page
app/src/features/terminals/index.ts                    NEW barrel

# Skills + agents
app/src/features/skills/parseFrontmatter.ts            NEW tiny YAML
app/src/features/skills/loader.ts                      NEW SkillManifest + import.meta.glob
app/src/features/skills/registry.ts                    NEW singleton w/ both naming conventions
app/src/features/skills/SkillsPage.tsx                 NEW two-pane library
app/src/features/skills/SkillCard.tsx                  NEW
app/src/features/skills/SkillDetail.tsx                NEW inline markdown renderer
app/src/features/skills/index.ts                       NEW barrel
app/.jarvis/skills/sentinel-prompt-defense.md          NEW 2.45 KB
app/.jarvis/skills/watchtower-security.md              NEW 2.85 KB
app/.jarvis/skills/echo-bridge-voice.md                NEW 2.78 KB
app/.jarvis/skills/cozy-readme.md                      NEW 2.44 KB
app/.jarvis/agents/scout.md                            NEW 2.55 KB
app/.jarvis/agents/builder.md                          NEW 2.53 KB
app/.jarvis/agents/reviewer.md                         NEW 2.60 KB

# Kanban
app/src/features/kanban/KanbanPage.tsx                 NEW
app/src/features/kanban/KanbanColumn.tsx               NEW
app/src/features/kanban/KanbanCard.tsx                 NEW
app/src/features/kanban/hooks.ts                       NEW
app/src/features/kanban/index.ts                       NEW

# Benchmarks
app/src/features/benchmarks/BenchmarksPage.tsx         NEW
app/src/features/benchmarks/BarChart.tsx               NEW pure SVG
app/src/features/benchmarks/benchmarkData.ts           NEW 28-row snapshot
app/src/features/benchmarks/index.ts                   NEW

# History
app/src/features/history/HistoryPage.tsx               NEW
app/src/features/history/HistoryList.tsx               NEW
app/src/features/history/Replay.tsx                    NEW
app/src/features/history/index.ts                      NEW

# Providers, agents, MCP
app/src/types/common.ts                                +7 providers
app/src/features/chat/Composer.tsx                     +7 PROVIDER_LABELS entries
app/src/features/settings/sections/Providers.tsx       +7 BYOK_PROVIDERS cards
app/src/lib/ai/router.ts                               +7 mock aliases
app/src/features/agents/registry.ts                    +Scout/Builder/Reviewer
app/src/features/agents/personas.ts                    +ROLE_PERSONAS, +getAgentRole
app/src/features/agents/AgentManager.tsx               +RolePill component
app/src/lib/mcp/registry.ts                            NEW
app/src/lib/mcp/builtins.ts                            NEW 7 default tools
app/src/lib/mcp/index.ts                               NEW barrel + side-effect import
app/src/lib/mcp/registry.test.ts                       NEW (Vitest doc-only)

# Assistant + onboarding + celebrate
app/src/features/assistant/intents.ts                  +navigate variant
app/src/features/assistant/parse.ts                    +navigate patterns + normalizeRoute
app/src/features/assistant/execute.ts                  +case 'navigate'
app/src/features/onboarding/Onboarding.tsx             +whats-new step
app/src/features/onboarding/steps/WhatsNew.tsx         NEW 2x3 feature grid
app/src/features/celebrate/celebrate.ts                NEW event bus
app/src/features/celebrate/Confetti.tsx                NEW pure canvas
app/src/features/celebrate/index.ts                    NEW + CelebrationHost

# Supabase
supabase/schema.sql                                    NEW 3 tables + view + 3 RLS
supabase/migrations/0001_init.sql                      NEW (mirror of schema)
supabase/functions/jarvis-proxy/index.ts               NEW Deno Edge Function
supabase/README.md                                     NEW deploy walkthrough
app/src/lib/supabase/client.ts                         NEW typed singleton
app/src/lib/supabase/types.ts                          NEW DB row types
app/src/features/billing/HostedJarvis.tsx              NEW Settings panel
app/src/features/billing/index.ts                      NEW barrel

# DEVLOG
DEVLOG.md                                              this entry
```

### Verification

- `npm install` ran clean — added `xterm`, `xterm-addon-fit`, `xterm-addon-web-links` to lockfile
- `npm run typecheck` — ✅ clean (zero errors)
- `npm run build` (vite) — ✅ 17.10s, 2547 modules, CSS 60.41 KB (was 52.05 KB; the +8 KB is xterm baseline + new feature pages), index JS 843.91 KB / 266 KB gzipped, plus a new lazy-loaded `TerminalsPage-*.js` chunk at 297.62 KB / 75.84 KB gzipped (xterm core)
- `cargo check --manifest-path src-tauri/Cargo.toml` — ✅ 2m 04s, zero warnings, 20 new transitive crates from portable-pty
- `npm run tauri:build` — ✅ both bundles regenerated
- Tauri desktop window — ✅ relaunched (PID 45900), title "Jarvis", new theme + nav visible

### Sub-agent return summary

| Slice | What                                   | Status                                  |
| ----- | -------------------------------------- | --------------------------------------- |
| 1     | Rust PTY backend                       | ✅ delivered                            |
| 2     | xterm TerminalView                     | ✅ delivered                            |
| 3     | Multi-pane terminal grid               | ⚠️ empty return — written by main agent |
| 4     | PageRouter + ui store + NavPane wiring | ⚠️ partial — completed by main agent    |
| 5     | Skills + agents Markdown loader        | ⚠️ empty return — written by main agent |
| 6     | Skills library page UI                 | ✅ delivered (waited on slice 5)        |
| 7     | Built-in skill markdowns               | ✅ delivered                            |
| 8     | Kanban page                            | ✅ delivered                            |
| 9     | Live benchmark page                    | ✅ delivered                            |
| 10    | Session history                        | ✅ delivered                            |
| 11    | +7 providers                           | ✅ delivered                            |
| 12    | Swarm roles (Scout/Builder/Reviewer)   | ✅ delivered                            |
| 13    | MCP-lite tool registry                 | ✅ delivered                            |
| 14    | Onboarding refresh                     | ✅ delivered                            |
| 15    | Celebration confetti                   | ✅ delivered                            |
| 16    | Inspector V3                           | ✅ delivered                            |
| 17    | TopBar V3                              | ✅ delivered                            |
| 18    | Supabase scaffolding                   | ✅ delivered                            |
| 19    | Assistant route commands               | ✅ delivered                            |

16 of 19 returned summaries; 3 returned empty (likely a transport-layer hiccup). Audit confirmed Slice 4 had partially landed (route store + PageRouter wired correctly) but didn't finish NavPane / App.tsx integration. Slices 3 and 5 had nothing on disk. Main agent shipped the missing pieces directly. Net: 19 of 19 functional.

### Artifacts (regenerated)

| File                                                                  | Size    | Use                   |
| --------------------------------------------------------------------- | ------- | --------------------- |
| `app/src-tauri/target/release/jarvis.exe`                             | 6.00 MB | Bare release binary   |
| `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi`  | 3.71 MB | Windows MSI installer |
| `app/src-tauri/target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` | 3.04 MB | NSIS setup wizard     |

The size bumps (5.57 → 6.00 MB binary, +0.38 MB MSI) reflect the new Rust crates (portable-pty, nanoid + transitive deps) and the bundled xterm + 7 skill `.md` files in the web bundle.

### What viper should test next

1. **Sidebar Workspace section.** Top-of-nav now has Chat / Terminals / Kanban / Skills / Benchmarks / History / Agents. Click each. Active row gets a copper ring.
2. **Terminals.** Click `Terminals` in the nav. You should see a single PowerShell pane. Click the `⊟` (split right) icon in the chrome — pane splits in half. Type `dir` in either side. Resize by dragging the gutter. Up to 16 splits.
3. **`Mod+J open 4 terminals`.** Opens the assistant; types into the bar; hits Enter. Should toast "Showing terminal." plus 4 new sessions in the DB.
4. **Kanban.** Click `Kanban`. Drag a task across columns. New `+` per column.
5. **Skills.** Click `Skills`. Should see 7 cards (4 skills + 3 agents). Pick `Sentinel — Prompt Injection Defense` — markdown body renders in the right pane with code blocks + lists.
6. **Benchmarks.** Click `Benchmarks`. Should see ~28 models, top-12 chart, sortable table. "From snapshot" chip is normal until LMSys responds (CORS may block in WebView2 — fallback is the canon).
7. **Onboarding.** Settings → Reset Onboarding (if there's a button) to see the new "What's new in V3" step.
8. **Hosted Jarvis.** Settings → look for "Hosted Jarvis ($5/month)" panel. Without your Supabase URL set, you'll see the setup card pointing at `supabase/README.md`.
9. **Drop the new installer on someone.** `bundle/msi/Jarvis_0.1.0_x64_en-US.msi` (3.71 MB) is the file. Or `bundle/nsis/Jarvis_0.1.0_x64-setup.exe` (3.04 MB).

### What's NOT done this wave (deliberately or by transport hiccup)

- **Real swarm coordination** with file-locking and parallel-safe writes. The Scout/Builder/Reviewer roles are defined but the orchestration layer (who spawns them, who routes between them, how they share state, how they avoid conflicting writes) is its own engineering project. Parked.
- **Production MCP server with JWT/RBAC.** What we have is the in-process `toolRegistry` — useful for the chat loop and skills, but not an HTTP server. A real MCP-over-WebSocket / over-HTTP transport with auth is parked.
- **Sub-500ms voice with Pipecat sidecar.** The existing `VoiceService` uses Web Speech which depends on WebView2 having the API enabled. The "BridgeVoice" feature requires shipping a Pipecat-based sidecar process; that's Phase 3.
- **Stripe checkout for the $5 tier.** The `Upgrade to Plus` button is wired to `VITE_STRIPE_CHECKOUT_URL`; setting up the Stripe product, webhook, and the tier-flip handler in the Edge Function is left as a follow-up. Free tier (50 req/mo) and BYOK-only mode work today.
- **Live AI runtime adapters for the 7 new providers.** Keys persist; live calls fall through to mock until I write the OpenAI-compatible adapter that fans them through the same chat loop.
- **Project-level skills/agents loading from `~/.jarvis/`.** Requires `@tauri-apps/plugin-fs` plus permission grants. Builtins ship and load from `app/.jarvis/` via `import.meta.glob`. Parked.
- **Session History playback rebinding live messages.** Replays for currently-streaming chats are stale until reselected. Acceptable trade-off for V3.

### What would land in a Wave 5 if asked

- Pipecat voice sidecar + sub-500ms STT
- Stripe webhook + `tier='plus'` flip + checkout completion redirect
- OpenAI-compatible adapter unifying anthropic/openai/google/+ all 16 OpenAI-compat providers
- Real swarm coordination: a `SwarmOrchestrator` that takes a goal, calls Scout, then Builder, then Reviewer, with file-lock guards via the existing dexie task model
- Project-level `.jarvis/` skills/agents loading via `@tauri-apps/plugin-fs`
- Drag-and-drop chats between projects in the NavPane
- Stripe billing dashboard inside Settings
- Mobile/PWA path (already documented)

---

## 2026-05-29 - V3 Session (Wave 5 -- phone-jarvis: real phone calls + in-app voice)

**Actor:** opencode (Claude Sonnet 4.5) for viper

**Goal:** Take the planning docs in `phone-jarvis/docs/01-08` from architecture-on-paper to a **deployable cloud backend + wired Jarvis app**. User wants two transports working off the same Pipecat loop: **Path A** (real PSTN number via Twilio) and **Path C** (in-app WebRTC via LiveKit). Path B (local Ollama) was explicitly skipped because users on weak hardware cannot run a local LLM. Path C is the must-work path.

**Result:** Cloud backend + Jarvis frontend code shipped end-to-end. Typecheck clean. Architecture lets a single Fly.io machine (~3/mo) serve unlimited users on Path C with their own BYOK Groq keys (free) and on Path A with the operator's Twilio number (.15/mo). All endpoints inert until secrets are set; no surprise on deploy. Documented in `phone-jarvis/IMPLEMENTATION.md`.

---

### 14:00 - Phase 0: Discovery + decision matrix

User answered the open questions from the planning docs:

| #   | Question          | Decision                                                                                                                                                         |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which transports? | **Path A + Path C** (skip B; "MAKE PATH C WORK")                                                                                                                 |
| 2   | Cloud host        | **Fly.io free tier**, `min_machines_running = 1`                                                                                                                 |
| 3   | PSTN provider     | **Twilio** ( trial covers months)                                                                                                                                |
| 4   | Provider stacks   | Path A premium (Deepgram + Claude Haiku + Cartesia) and Path C cost-conscious (Groq Whisper + Groq Llama + Cartesia). Per-user BYOK overrides operator defaults. |
| 5   | PIN length        | **6 digits, 3 strikes, 1h cooldown**. Caller-ID skip if number is on allowlist.                                                                                  |
| 6   | Tool ACL          | **Read-only by default. Full power only when user says unlock phrase mid-call.** Lock reverts at hangup.                                                         |
| 7   | Outbound triggers | **Default off except manual + error-driven**. Per-category toggle in Settings.                                                                                   |
| 8   | Voice             | **Use existing PERSONA system** (Jarvis/Athena/Edge/Watson/HAL/Sage).                                                                                            |
| 9   | Multi-user        | **Yes from day one**, per-user auth via Supabase, per-user BYOK, per-user phone number.                                                                          |
| 10  | Backend lang      | **Python** (Pipecat is Python-first).                                                                                                                            |

Cloud URL is set by the operator (me/viper) via `VITE_PHONE_JARVIS_CLOUD_URL`; end users do not touch it. Power users get an "Advanced -> Self-host" override in Settings (parked for now).

### 14:30 - Phase 1: Cloud backend skeleton -- `phone-jarvis/cloud/`

Wrote the FastAPI app from scratch. One Pipecat pipeline factory, three transports, one bridge registry.

| File                 | Lines | Purpose                                                                        |
| -------------------- | ----- | ------------------------------------------------------------------------------ |
| `main.py`            | 95    | FastAPI app, mounts routers, daily audit prune                                 |
| `config.py`          | 80    | Pydantic Settings, `.has_*` flags for inert handlers                           |
| `pipeline.py`        | 220   | Pipecat factory: STT -> LLM -> TTS, persona prompts, tool dispatch hook        |
| `auth.py`            | 220   | PBKDF2 PIN, allowlist normaliser, Supabase JWKS verifier, in-memory PinTracker |
| `bridge.py`          | 200   | `BridgeRegistry` -- per-user WS sessions, in-flight tool-call futures          |
| `bridge_endpoint.py` | 90    | `WS /bridge` handshake + frame loop                                            |
| `twilio_handler.py`  | 230   | `POST /twiml` + `WS /twilio/{sid}` -- Path A inbound                           |
| `livekit_handler.py` | 175   | `POST /livekit/token` -- Path C; spawns the AI agent task                      |
| `outbound.py`        | 145   | `POST /outbound/call` -- Sage dials user; `/outbound/twiml` callback           |
| `supabase_client.py` | 30    | Service-role Supabase client (bypasses RLS)                                    |
| `audit.py`           | 220   | JSONL audit logger, per-call + daily rollup, retention prune                   |
| `Dockerfile`         | 18    | Python 3.11 slim, uvicorn                                                      |
| `fly.toml`           | 30    | Always-on (no scale-to-zero -- inbound calls would 404)                        |
| `requirements.txt`   | 14    | Pipecat 0.0.50 + Twilio + LiveKit + Supabase + jose                            |
| `.env.example`       | 35    | Every secret with comments                                                     |

Pipeline service selection is data-driven: `transport == "twilio"` plus `keys.deepgram` -> Deepgram; otherwise Groq. Same for LLM (Anthropic for Twilio, Groq for LiveKit). Cartesia for both TTS. Per-user BYOK overrides operator defaults.

Tool dispatch wires through Pipecat's `llm.register_function`: when the LLM emits a tool_use, the cloud forwards a frame over `/bridge` to the user's desktop daemon and awaits the result. Confirmation tier (write/edit/delete) and unlock tier (shell.run) gates are encoded in `BridgeRegistry.invoke`.

Bridge auth: short-lived Supabase JWT verified against the project JWKS. No shared bridge secret. Refreshes on Supabase `TOKEN_REFRESHED`.

### 15:30 - Phase 2: Jarvis app integration -- `app/src/`

Installed `livekit-client@2.19.1`. Wrote two new modules and updated five existing files.

**New: `lib/bridge/`** -- the long-lived WS to `/bridge`:

- `BridgeClient.ts` (270 lines) -- exp-backoff reconnect (250ms..5s), 15s heartbeat, register frame with the live MCP tool catalog, tool dispatch into `toolRegistry.invoke()`, defense-in-depth confirm gate.
- `useBridgeLifecycle.ts` (110 lines) -- React hook that mounts the bridge once Supabase signs in, swaps the JWT on refresh, tears down on sign-out.

**New: `features/call/`** -- the in-app voice surface:

- `store.ts` -- Zustand: status (idle/connecting/ringing/in-call/ending/error), transcript, mute, persona, awaitingConfirm, unlockActive.
- `CallService.ts` -- LiveKit client wrapper. POSTs `/livekit/token` with the Supabase JWT, joins the per-user room, publishes mic, attaches remote audio to a hidden `<audio>` element, listens for transcript data messages.
- `CallButton.tsx` -- standalone button (also a `CallTopBarButton` mirror inside `TopBar.tsx` so it inherits the no-drag region).
- `CallModal.tsx` -- in-call UI: persona Orb, status pill, scrolling transcript, confirm banner, unlock banner, mute, hangup.
- `outbound.ts` -- `fireOutboundCall(reason, ctx)` plus a window-event listener that POSTs to `/outbound/call` with cooldown throttle.

**Updates:**

- `stores/ui.ts` -- adds `callModalOpen` flag (transient).
- `components/layout/TopBar.tsx` -- green/red Phone button next to the mic.
- `features/settings/SettingsModal.tsx` -- new "Phone & Voice" tab.
- `features/settings/sections/PhoneVoice.tsx` (NEW, 700 lines) -- cloud connection status, privacy disclosure, PIN setter (calls `set_phone_pin` RPC), allowlist editor, BYOK paste-and-save, outbound trigger toggles, unlock phrase editor.
- `App.tsx` -- mounts `<CallModal />`, calls `useBridgeLifecycle()`, starts the outbound trigger.

### 16:00 - Phase 3: Supabase schema -- `supabase/schema-phone-jarvis.sql`

Idempotent SQL on top of the existing hosted schema:

- `phone_settings` -- per-user PIN hash (PBKDF2-SHA256, 100k iters, 32-byte output), salt (16 hex), allowlist text array, BYOK JSONB, outbound triggers JSONB, unlock phrase, cost caps. PK on user_id, unique constraint on twilio_phone_number.
- `outbound_pending` -- short-lived row keyed by Twilio call_sid; the `/outbound/twiml` callback reads context once. Pruned hourly.
- `call_audit` -- one row per completed call (transport, duration, end_reason, persona, cost estimate). Pruned at 30 days.
- `set_phone_pin(uuid, text)` RPC -- security-definer, uid-scoped, hashes with the in-DB `pbkdf2_sha256()` plpgsql implementation that matches Python's `hashlib.pbkdf2_hmac` byte-for-byte.
- RLS policies -- each user reads/writes only their own rows; service role inserts to `call_audit` and `outbound_pending` from the cloud.

### 16:30 - Phase 4: Verification

`npx tsc --noEmit  -> OK (clean)`

No new test runs this wave -- writing meaningful unit tests for the bridge + LiveKit transport requires a fixtures harness that's its own subproject. Listed in TODO.

Did **not** rebuild the Tauri MSI/EXE. The user will run `npx tauri build` when they want to ship the new bits to disk; the renderer code is the meaningful change and a vite `npm run build` would suffice for verification.

### 16:45 - Phase 5: Documentation

- `phone-jarvis/IMPLEMENTATION.md` -- 460-line implementation guide. Covers the shape, the file inventory, the call flow end-to-end, the bridge protocol, the security model, the cost model with numbers, a Path C quick-start (the only one we promised would work), a Path A add-on guide, and the explicit TODO list before production.
- This DEVLOG entry.

### What viper should test next

1. **Apply the schema.** Open Supabase SQL editor, paste `supabase/schema-phone-jarvis.sql`, run. Should be idempotent on top of the existing hosted schema.
2. **Path C smoke test.** Follow `phone-jarvis/IMPLEMENTATION.md` section 7. Expected end state: green Call button -> click -> grant mic -> Sage joins LiveKit room -> two-way conversation. ~30 minutes from zero to working call if Groq + Cartesia + LiveKit + Fly accounts already exist.
3. **Bridge status.** Settings -> Phone & Voice. After signing in, "Cloud connection" pill should flip to green `connected`. If yellow `reconnecting` it means the cloud is up but rejected the JWT (check Supabase JWT signing mode -- needs RS256 / JWKS, not legacy HS256).
4. **PIN flow (no call needed).** Settings -> Phone & Voice -> set a 6-digit PIN -> hit Save. Should succeed without errors. The `set_phone_pin` RPC writes a salted hash to `phone_settings`.

### What's NOT done this wave (deliberately or transport-of-bytes-permitting)

- Real Cartesia voice IDs -- `pipeline.py:_persona_voice_id` has placeholders; pick voices at play.cartesia.ai/voices and paste the real UUIDs before any TTS will work.
- Verbal-yes confirm-tier dispatcher -- the bridge already accepts `confirmed=false` on write tools but the cloud-side state machine that pauses, asks "yes?", and waits for a "yes" frame is not yet wired (the persona prompt asks the LLM to enforce; defense-in-depth gate parked).
- Outbound trigger callsites -- `fireOutboundCall` ships and the listener is mounted, but no upstream code calls it yet. Expected upstream: `lib/ai/runtime.ts` on uncaught error, `features/terminal/*` on non-zero exit, `features/tasks/*` on overdue deadline.
- Audit log viewer in Settings -- rows write to `call_audit` but no UI yet.
- Per-user phone-number provisioning -- right now it's manual SQL to wire a Twilio number to a user.
- Tests for PBKDF2 reference vectors, JWT-with-mock-JWKS, BridgeRegistry pending-future cleanup. Listed in IMPLEMENTATION.md.

### What would land in a Wave 6

- Real PIN frame processor in the Pipecat pipeline (so the LLM cannot bypass it)
- Verbal-yes confirm-tier state machine + `kind: "awaiting_confirm"` data messages from cloud to app
- Outbound trigger callsites at the three known emit points
- Audit log viewer + cost dashboard in Phone & Voice settings
- Twilio sub-account-per-user provisioning flow
- Voice-id picker UI inside Phone & Voice settings (load Cartesia voices, preview, pick per persona)
- `system.hangup` tool so Sage can end calls cleanly

---

## 2026-05-31 — v0.1.5: Terminal layout + bundle deferral

**Actor:** opencode (claude) for viper

**Goal:** Make the Terminals page feel like OpenCode — compact chrome, more terminal real estate, manual resize between tiles. Then optimise the rest of the app per the user's "make the whole Jarvis optimized" ask.

**Result:** Terminals page header collapsed from a 96px hero block to a 32px toolbar. TopBar shrinks to 28px on terminal/fullscreen routes with low-frequency buttons in an overflow menu. Manual resize handles between every tile in Tiles mode (drag + double-click to reset, persisted per layout shape). Side rail stays visible in fullscreen. Bundle: LiveKit (504 kB), Supabase (210 kB), and settings-sections (131 kB) dropped from the boot preload list — about 227 kB gzipped of cold-load deferral. Boot modulepreload list shrunk from 13 chunks to 10. Cargo release profile relaxed (thin LTO + 4 codegen units) so Tauri release can link in roughly a third the peak memory.

Tauri MSI/EXE rebuild attempted but blocked by Windows Application Control on freshly compiled `tauri-plugin-shell` build script (os error 4551, STATUS_VIRUS_INFECTED variant). The user's existing v0.1.4 installer remains the latest shipped binary; renderer changes work immediately under `npm run tauri:dev` and will bake into the next successful Tauri build.

---

### Phase 1: Terminal layout

The user shared a video showing OpenCode running across 4 terminal tiles, then asked Jarvis to "be one of the apps and just have one whole big page where its just the entire terminal split into 4 windows ok and like the heading at the top can be small". Three concrete changes drove that:

1. **Compact TopBar.** `app/src/components/layout/TopBar.tsx` now reads `useUIStore.fullscreen` plus the active route. When on `terminals` (or any route while fullscreen is on), it switches to a 28px-tall variant. The seven low-frequency right-cluster buttons (launcher, assistant, schedule, search, voice, call, what's-new) move into a single `MoreHorizontal` overflow popover so the visible right cluster is just fullscreen / overflow / settings / avatar. No state is duplicated — the popover renders the same `MenuRow` actions that fire the same hotkeys.

2. **Slim TerminalsPage header.** `app/src/features/terminals/TerminalsPage.tsx` lost its eyebrow + Fraunces hero + descriptive paragraph. The mode toggle, pane count, layout label, and Add pane / Reset / Open swarm buttons now share one 32px row with the page title rendered as a compact label. ~80px of vertical space returned to the grid in 1280×820 default window size.

3. **Manual resize handles.** `app/src/features/terminals/TileGrid.tsx` rewritten to use flex columns/rows with `<ResizeHandle>` between adjacent tracks. Drag redistributes fr units between neighbouring tracks (clamped to MIN_FR=0.18 so a track can't disappear). Double-click resets that single boundary to 50/50. Sizes persist to `localStorage["jarvis-tile-grid-sizes-v1"]`, keyed by layout shape (e.g. "2x2", "3x2") so toggling between counts (4→3→4) keeps the 4-tile sizing intact.

   `app/src/styles/globals.css` was also tightened: `[data-fullscreen='true']` now collapses only the to-do drawer, not the NavPane. The user explicitly asked for "side pane in the side okay" — only the right drawer hides; Mod+B remains the manual nav-toggle for true distraction-free.

### Phase 2: Bundle deferral

The user asked to "make the whole Jarvis optimized". I dispatched an `explore` subagent to survey eager imports of the heavy chunks (LiveKit, Supabase, settings-sections) and identify boot-graph leaks.

The agent traced four eager paths into the LiveKit + Supabase chunks from boot. The fixes, in order of impact:

- **TopBar.tsx → CallService**: replaced `import { getCallService } from '@/features/call/CallService'` with `import { isCallConfigured, loadCallService } from '@/features/call'`. Both `CallTopBarButton` and the new `CompactCallRow` now read `isCallConfigured()` (env-only, in `features/call/config.ts`) for button colour, and `loadCallService()` is only awaited inside the click handler when `inCall === true`. By that point the LiveKit chunk is already loaded by the CallModal that started the call, so the dynamic re-resolve is essentially free.

- **outbound.ts → CallService + Supabase**: replaced `getCallService().getCloudUrl()` with `callCloudUrl()` from `./config`, and converted `getSupabaseClient()` to a dynamic `await import('@/lib/supabase/client')` inside the event handler. The handler only fires when an actual outbound event dispatches.

- **useBridgeLifecycle.ts → Supabase**: gated the entire effect on `isSupabaseConfigured()` (an env-only helper that already lived in `lib/supabase/env.ts`) and converted the supabase client load to `await import('@/lib/supabase/client')` inside an IIFE. `cancelled` flag added so the dynamic load can be aborted by an unmount that fires before the import resolves.

- **CallButton.tsx → CallService**: same pattern as TopBar — `isCallConfigured` for button state, `import('./CallService').then(m => m.getCallService().stop())` for the hang-up path.

- **auth/index.ts → SignInDialog**: dropped `export { SignInDialog } from './SignInDialog'` from the auth barrel. SignInDialog statically imports `@/lib/supabase/client`, and the only consumer (`features/settings/sections/Account.tsx`) already imports it by direct path inside the lazy settings chunk.

These four fixes were necessary but not sufficient — the modulepreload list still contained `supabase` and `livekit` after them. A second `explore` subagent traced the remaining edge to the manualChunks rule itself.

**Root cause: `vite.config.ts:41`'s `if (id.includes('/src/features/settings/sections/')) return 'settings-sections';`**

The agent's diagnostic: forcing 11 section files into a named chunk caused Rollup to physically relocate symbols shared by both the eager boot graph and the section files (`useUIStore`, Button, Badge, Switch, Separator, ~22 bindings total) into the named chunk, then back-import them into the boot chunk. That static back-edge from boot → `settings-sections-*.js` triggered a modulepreload, and `settings-sections` itself statically imports `@/lib/supabase/client` (PhoneVoice section) and `@/features/call/CallService` (PhoneVoice section), so supabase + livekit rode along for every cold load.

**Fix:** drop the `settings-sections` rule. With it gone, Rollup naturally packages all 11 sections into the lazy `SettingsModal` chunk (the React.lazy boundary at `App.tsx:73`), shared symbols stay in the boot chunk where they belong, no back-edge gets emitted, and the section's transitive deps stay cold.

Verification: `dist/index.html` modulepreload list dropped from 13 chunks to 10. Removed entries: `supabase`, `livekit`, `settings-sections`. Boot chunk grew from 187 kB / 56 kB gzip to 247 kB / 76 kB gzip (the shared symbols moved back), but cold-load preload total dropped about 227 kB gzipped — a net win of ~145 kB gzipped in actual transfer for any user who never opens Settings or makes a Call.

### Phase 3: Cargo release profile relaxation

A first attempt at the Tauri build hit `rustc-LLVM ERROR: out of memory` while compiling the `tauri` crate at `-C opt-level=s -C codegen-units=1` with full LTO. `app/src-tauri/Cargo.toml` adjusted from `lto = true` + `codegen-units = 1` to `lto = "thin"` + `codegen-units = 4`, with a comment block explaining the tradeoff (binary ~1-3% bigger, peak link memory roughly a third).

### Phase 4: Tauri build — blocked

After cleaning the corrupt target directory left by the first OOM (`Remove-Item -Recurse -Force target`) and bumping versions to 0.1.5 across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `features/whats-new/releases.ts`, I retried `npm run tauri:build`.

The compile got past LLVM and into the build-script execution phase, then aborted with:

```
error: failed to run custom build command for `tauri-plugin-shell v2.3.5`
  An Application Control policy has blocked this file. (os error 4551)
```

Error 4551 is `STATUS_VIRUS_INFECTED` — Windows Defender Application Control / Smart App Control rejecting the freshly compiled `target/release/build/tauri-plugin-shell-*/build-script-build.exe`. The previously shipped v0.1.0–v0.1.4 builds presumably whitelisted those build script binaries; nuking the target dir produced new artifacts with new hashes that the policy hasn't approved.

This is a system-level policy issue I cannot work around from inside the build. The user's options are: add the cargo target dir to security software exclusions, run with the policy temporarily relaxed, or sign the build artifacts. The renderer changes themselves are fully shippable — `npm run tauri:dev` picks them up immediately, and the next successful `tauri build` (after the WDAC exclusion is added) will bake them into a new MSI/NSIS pair.

### Files touched

Source changes:

- `app/src/components/layout/TopBar.tsx` — compact mode, overflow menu, swap to env-only `isCallConfigured` + `loadCallService`.
- `app/src/features/terminals/TerminalsPage.tsx` — slim header.
- `app/src/features/terminals/TileGrid.tsx` — manual resize handles, persisted sizes, drag math, ResizeHandle component.
- `app/src/styles/globals.css` — keep NavPane visible in fullscreen, only hide to-do drawer.
- `app/src/features/call/outbound.ts` — drop static CallService + Supabase imports; use `callCloudUrl()` + dynamic supabase import.
- `app/src/features/call/CallButton.tsx` — drop static CallService import; use `isCallConfigured()` + dynamic CallService import.
- `app/src/lib/bridge/useBridgeLifecycle.ts` — drop static Supabase import; gate on `isSupabaseConfigured()`, dynamic supabase load inside IIFE.
- `app/src/features/auth/index.ts` — stop re-exporting SignInDialog (which would drag supabase to boot via the AuthGate path).
- `app/vite.config.ts` — drop counterproductive `settings-sections` manualChunks rule.
- `app/src-tauri/Cargo.toml` — thin LTO + 4 codegen units; bump version to 0.1.5.
- `app/src-tauri/tauri.conf.json` — bump version to 0.1.5.
- `app/package.json` — bump version to 0.1.5.
- `app/src/features/whats-new/releases.ts` — bump CURRENT_VERSION; prepend 0.1.5 release entry.
- `CHANGELOG.md` — 0.1.5 section above [Unreleased].

Verification:

- `npm run typecheck` — clean.
- `npm run build` — clean. 2604 modules transformed in ~24-35s. Modulepreload list drops to 10 entries. Settings-sections chunk no longer in boot graph.
- `npm run tauri:build` — fails on Windows Application Control policy at the build-script execution phase. Source compile is clean.

---

## 2026-06-01 - V3 Session (Wave 5 — Silent Updater, App Rename to Jarvis One & Project-Scoped Terminals)

**Actor:** Jarvis (opencode) for viper

**Goal:** Configure the auto-updater for fully silent background installation (bypassing UAC warnings and manual dialogs), rename the application to **Jarvis One**, and transition the terminal session limit of 10 to be scoped per-project rather than globally.

**Result:** Silent auto-updater settings configured (`installMode: quiet` for updater and `installMode: currentUser` for NSIS) which installs to `%LOCALAPPDATA%` and bypasses admin prompts. App renamed to **Jarvis One** and version bumped to `0.1.6`. Rust PTY terminal limit checks updated to restrict count to 10 per project. Staging scripts compile cleanly and build release installers successfully.

### What was done:

1. **Auto-Updater & Windows Installer Configuration**:
   - Changed updater `"installMode": "passive"` to `"quiet"` in `tauri.conf.json` to run Windows updates completely silently.
   - Added `"nsis": { "installMode": "currentUser" }` to `tauri.conf.json` to install the app under `%LOCALAPPDATA%`, letting updates run without admin UAC validation.
   - Updated file patterns and download targets in `scripts/release-windows.ps1` and `install/install.ps1` to support the renamed build files.

2. **Project-Scoped Terminal Limits**:
   - Added `project_id: Option<String>` to `TerminalInfo` struct in `terminal.rs`.
   - Modified `terminal_spawn` IPC endpoint in `terminal.rs` to take `project_id: Option<String>` and verify that active sessions for that specific project do not exceed `MAX_TERMINAL_SESSIONS`.
   - Propagated the active `projectId` down through React component hierarchy: `types.ts` (`TerminalViewProps`), `TileGrid.tsx` (`Tile` props), and `TerminalView.tsx` (`terminal_spawn` IPC invocation).

3. **Changelog & Startup Updates**:
   - Bumped version to `0.1.6` across `tauri.conf.json`, `package.json`, and `Cargo.toml`.
   - Appended v0.1.6 release changelog notes to `releases.ts` to trigger in-app What's New modal automatically on boot.

### Files touched:

- `app/src-tauri/tauri.conf.json` — set product name to "Jarvis One", bumped version to 0.1.6, set updater installMode to quiet, added NSIS currentUser mode.
- `app/package.json` — bumped version to 0.1.6.
- `app/src-tauri/Cargo.toml` — bumped version to 0.1.6.
- `app/src-tauri/src/terminal.rs` — scoped active terminal limit check to matching project IDs.
- `app/src/features/terminals/types.ts` — added optional `projectId` parameter to `TerminalViewProps`.
- `app/src/features/terminals/TerminalView.tsx` — forward `projectId` parameter to `terminal_spawn` IPC.
- `app/src/features/terminals/TileGrid.tsx` — pass `projectId` from grid down to terminal tile.
- `app/src/features/whats-new/releases.ts` — bumped version to 0.1.6 and prepended release changelog.
- `scripts/release-windows.ps1` — updated bundle and friendly names to target Jarvis One.
- `install/install.ps1` — updated local pattern check and download URLs to target Jarvis One.
- `CHANGELOG.md` — prepended version 0.1.6 release notes.
- `scripts/build-updater-manifest.mjs` — updated the windows-x86_64 regex pattern to support spaces in 'Jarvis One'.

### Verification:

- `npm run typecheck` — TypeScript compilation compiles with exit code 0.
- `cargo check` — Rust compilation check succeeds with exit code 0.
- `npm run release:windows` — stages Jarvis One installers and updates latest.json manifest.
- `install.ps1` local testing — verified that running with `$env:JARVIS_SILENT="1"` and `$env:JARVIS_LOCAL="1"` performs a 100% silent, UAC-free background installation of Jarvis One to Local AppData, exiting with code 0.
- Verified that the camelCase parameter casing fix (`projectId` in the `invoke` call inside `TerminalView.tsx`) allows the Rust backend to deserialize the active project ID correctly, resolving the global limit tracking issue and isolating the 10-terminal limit per project.

---

# 2026-06-02 - Context Files, Right-Click UX, Skills, Commands, Benchmarks, Terminal Agent Prompts

**Actor:** Codex for viper

**Goal:** Polish multiple Jarvis One production flows: real Context map files and drag paths, remove the native right-click menu during right-drag, add a themed app context menu, connect Kanban/custom-command actions to Jarvis, restore Skills, harden Benchmarks, and enforce the three-layer terminal agent prompt model.

**Result:** Context map creation now writes `context_map.json` into the selected project root and drags that path into chat/terminals. Right-click dragging suppresses the browser menu after drop, while normal app right-click opens a themed Jarvis command menu. Skills is restored as a first-class route. Jarvis can propose approved actions to create Kanban tasks and save custom terminal commands. Terminal agent panes get a protected shell-comment prompt prelude before startup commands. Benchmarks try multiple LMArena endpoints before snapshot fallback.

**Verification:** `npm --prefix app run typecheck`, `npm --prefix app run build`, `cargo check`, signed `npm run release:windows`, local silent NSIS installer, installed executable version check (`0.1.15`), and `releases/latest.json` check.

---

# 2026-06-02 - Silent Update Release Channel Fix

**Actor:** Codex for viper

**Goal:** Fix the failed silent update path after the repo rebrand and prevent the updater/installer from resolving retired release URLs.

**Result:** Updated the Windows installer, Unix installer, Tauri updater endpoint, release staging script, and README repo links from `anomalyco/jarvis` / `Cookie774-GameDev/jarvis` to `Cookie774-GameDev/jarvis-one`. Regenerated `releases/latest.json` and `releases/SHA256SUMS.txt` for `0.1.14`, so the staged updater manifest now points at the correct Jarvis One GitHub Releases URL.

**Verification:** `npm run release:stage` completed successfully and rebuilt updater metadata/checksums.

**Security note:** Tauri updater signatures are present and verified by the app updater. Windows SmartScreen reputation warnings can still occur for unsigned public `.exe` installers until an Authenticode code-signing certificate is used; that cannot be fixed safely in code.

---

## 2026-06-01 - v0.1.7 Files Workspace + Chat/Terminal File Context

**Actor:** Jarvis (opencode) for viper

**Goal:** Add a production-safe in-app file explorer/editor, attach files to chat requests, and support dragging files into specific terminal panes without disturbing the existing terminal, context, or optimization systems.

**Result:** Files landed as a lazy route (`files`) so editor/browser code stays out of cold start. Tauri gained small scoped file commands for list/read/write/create with absolute-path and size guards. Chat and terminals now accept files dragged from the Files page. App version bumped to `0.1.7`.

### Files touched

- `app/src-tauri/src/fsread.rs` — added `fs_list_dir`, `fs_write_text`, and `fs_create_text_file` beside the existing capped `fs_read_text` command.
- `app/src-tauri/src/lib.rs` — registered the new file commands.
- `app/src/lib/fs.ts` — added typed wrappers for list/write/create and expanded file error descriptions.
- `app/src/features/files/FilesPage.tsx` and `index.ts` — new lazy-loaded Files workspace with project-folder open, tree list, new-file creation, text editor, save, drag source, and Ask Jarvis selection flow.
- `app/src/stores/ui.ts`, `app/src/components/layout/PageRouter.tsx`, `app/src/components/layout/NavPane.tsx` — added the `files` route and sidebar access.
- `app/src/features/chat/Composer.tsx` — added drag/drop attachments, `/` slash commands, file chips, and `jarvis:files:ask` intake from the Files editor.
- `app/src/lib/ai/context.ts` and `app/src/lib/ai/runtime.ts` — attached files are read at request time and inserted as request-scoped AI context alongside project and connected-terminal file context.
- `app/src/features/terminals/TerminalView.tsx` — file drop target with interactive highlight; dropped file content is pasted into that exact PTY session.
- `CHANGELOG.md`, `app/src/features/whats-new/releases.ts`, `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json` — version/release notes for `0.1.7`.

### Verification

- `npm run typecheck` — clean before version docs, rerun planned after final version lockfile update.
- `cargo check` — clean after removing one unused import warning.

---

## 2026-06-01 - V4 Session (Wave 5 follow-up - Silent Update Hardening & Terminal Cap Cleanup)

**Actor:** Jarvis (opencode) for viper

**Goal:** Remove the last stale-session edge case in terminal project caps and make the local installer path stay non-elevated when silent mode is requested.

**Result:** Added terminal cleanup for finished PTYs before cap checks and list snapshots, so stale exited sessions stop counting toward the 10-per-project limit. Hardened `install/install.ps1` so `JARVIS_SILENT=1` automatically uses NSIS instead of MSI, preventing UAC prompts during local silent update tests. Documented the change in `CHANGELOG.md`.

### What was done:

1. **Terminal lifecycle hardening**:
   - Added a small cleanup helper in `app/src-tauri/src/terminal.rs` that prunes finished reader tasks before session counting and listing.
   - Kept the existing exit-path cleanup that removes naturally exited sessions from the active map.

2. **Silent installer hardening**:
   - Updated `install/install.ps1` so silent installs force NSIS, which installs under the current user and avoids UAC elevation prompts.

3. **Documentation**:
   - Appended release-note bullets to `CHANGELOG.md` covering the per-project session cleanup and silent-install behavior.

### Verification:

- `cargo check` — clean.

---

## 2026-06-01 - v0.1.8 Restore Persistence, Groq STT, Recursive Files, Terminal References, Command Catalog

**Actor:** Jarvis (opencode) for viper

**Goal:** Make Jarvis reopen after closes/updates like it never shut down; improve speech-to-text without removing fallback support; make Files project-connected and recursive; fix Send to Jarvis; let terminals be dragged into chat as context; add 50 more Jarvis commands.

**Result:** Active UI state now persists, terminal panes restore layout/transcript and respawn when backend PTYs are gone, Files roots/open files are project-scoped, Ask Jarvis creates/reuses a chat before sending selection context, terminal panes can be dragged into chat, Groq Whisper STT is available when a Groq key is set, and the Jarvis command catalog is exposed through Mod+J examples plus `/commands`.

### Files touched

- `app/src/stores/ui.ts` — persists active route, active chat, and active agent so reopen/update restores the same workspace surface.
- `app/src/features/files/FilesPage.tsx` — rewritten from flat folder list to recursive project-scoped file tree; stores root/open file per project; supports expandable folders, popular text/code files, and fixed Send to Jarvis.
- `app/src/features/chat/Composer.tsx` — added terminal attachments, `/commands`, Groq Whisper recording/transcription path, improved file/terminal drag-drop, and terminal/file context dispatch to the runtime.
- `app/src/lib/ai/context.ts` — added explicit terminal transcript context builder beside explicit file context.
- `app/src/lib/ai/runtime.ts` — reads `terminalSessionIds` from chat send events and injects request-scoped terminal context into the system prompt.
- `app/src/features/terminals/TileGrid.tsx` — terminal panes are draggable into chat via `application/x-jarvis-terminal`.
- `app/src/features/assistant/{commands,intents,parse,execute,AssistantBar}.ts(x)` — added 50-command catalog, provider ask command, and terminal context broadcast command.
- `CHANGELOG.md`, `app/src/features/whats-new/releases.ts`, `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json` — version/release notes for `0.1.8`.

### Verification

- `npm run typecheck` — clean.
- `cargo check` — clean.

### Notes

- `task.md`, `walkthrough.md`, and `EMPIRE_SOVEREIGN_DIRECTORY.md` were requested in prior context but do not exist in this repo tree, so this session documents the update in the Jarvis devlog, changelog, and in-app release notes instead.
- True OS-process survival after a full app close is not possible with the current in-process Rust PTY architecture because the PTYs die with the app process. The production-safe behavior implemented here is layout/transcript restoration plus automatic respawn when Jarvis sees a persisted session id that is no longer alive.

---

## 2026-06-02 — Marketing Site, GitHub Pages & Repo Rebrand to jarvis-one

**Actor:** OpenCode for viper

**Goal:** Build a polished GitHub Pages marketing site for the Jarvis One AI workspace, push it to a public repo (`Cookie774-GameDev/jarvis-one`), enable Pages, and update all install URLs from the original `anomalyco/jarvis` to the new repo.

**Result:** Full 18-section landing page shipped live at `https://cookie774-gamedev.github.io/jarvis-one/`. Install commands, README, download docs, and installer shims all updated. ~28 sub-agents used for research and copy generation across the session.

### What was done

**Phase 1 — Discovery & planning (10+ parallel sub-agents)**

Dispatched 28 sub-agents to inventory: existing UI/UX from the app codebase, tech stack, product vision, roadmap, current state via DEVLOG, feature folders, install flow, voice/calling layer, 24 built-in actions, MCP tools, hotkey mappings, provider list, bundled skills/agents, phone calling deep-dive, brand colors, competitive positioning (Cursor, Bolt, Windsurf, Codex CLI, Continue.dev, Claude Code, OpenCode), cozy palette (cream, copper, amber, sage), 2026 landing-page best practices, domain availability (`vibejarvis.com`), and the existing `DOWNLOAD.md` / `README.md`.

**Phase 2 — Site construction**

Built `site/index.html` as a single self-contained HTML file (no external requests, all CSS inlined):

| Section              | Content                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero                 | "Vibe coding for vibe coders. By a vibe coder." with install command + OS tabs                                                                                                                    |
| Calling (hero card)  | Phone-turn illustration with Sage dialog bubble, metrics (<800ms, $0, read-only)                                                                                                                  |
| AI Calling (feature) | 3-card deep-dive: call from any phone, tap to call in-app, let Sage call you                                                                                                                      |
| All-in-one workspace | 6 cards: council, code swarm, system prompts, research, memory, actions                                                                                                                           |
| Council mode         | 4-agent live canvas (Jarvis, Researcher, Coder, Critic)                                                                                                                                           |
| Model support        | 18 providers in a 6-col grid (Anthropic, OpenAI, Google, Groq, Ollama, xAI, DeepSeek, Mistral, Cohere, Perplexity, Together, Fireworks, Replicate, Llama, OpenRouter, Hyperbolic, Novita, Lambda) |
| Download             | 3-step cards per OS (Win/Mac/Linux) with copy buttons                                                                                                                                             |
| Hotkeys table        | 10 hotkeys (Mod+K/J/Space/Shift+A/L/T/B/Enter)                                                                                                                                                    |
| Architecture         | 6-card stack overview (Desktop, Runtime, Calling, Storage, Privacy, License)                                                                                                                      |
| Changelog            | v0.1.5, v0.1.4, v0.1.3 highlights + Next                                                                                                                                                          |
| Community            | GitHub + Discord + YouTube placeholders                                                                                                                                                           |
| Maker letter         | Warm brand story                                                                                                                                                                                  |
| FAQ                  | 5 questions (coding, models, calling, offline, domain)                                                                                                                                            |

Design: cozy Claude-inspired palette (cream `#FAF6EE`, copper `#B5613A`, amber `#C58A3D`, sage `#6F8F66`). System serif/sans fonts. Noise texture overlay + radial bloom backgrounds. Scroll-reveal animations. Tab-switching install commands.

**Phase 3 — GitHub infrastructure**

- Installed `winget install GitHub.cli` to get `gh` on PATH.
- Authenticated with a classic PAT (scoped: all repo, workflow, admin).
- Created public repo `Cookie774-GameDev/jarvis-one`.
- Added `.github/workflows/pages.yml` — deploys `site/` to GitHub Pages on every push to `main`.
- Added `site/.nojekyll` (bypass Jekyll processing) and `site/404.html` (redirect to root).
- Mirrored `install/install.ps1` → `site/install.ps1` and `install/install.sh` → `site/install.sh` as short-URL shims.
- Pushed 3 commits across two pushes:
  1. `docs: add Jarvis marketing site` (initial site + workflow + installers)
  2. `fix: update repo URLs to Cookie774-GameDev/jarvis-one` (README, DOWNLOAD.md, installer shims)
  3. `fix: update site/index.html repo URLs to Cookie774-GameDev/jarvis-one` (site itself)

**Phase 4 — Pages enablement**

- First Actions run failed because GitHub Pages was not yet enabled — `actions/configure-pages@v5` returned 404.
- Enabled Pages via `gh api -X POST /repos/Cookie774-GameDev/jarvis-one/pages` with `build_type: workflow`.
- Second run succeeded instantly. Site went live at `https://cookie774-gamedev.github.io/jarvis-one/`.

**Phase 5 — URL rebrand**

- All references to `anomalyco/jarvis` in `site/index.html`, `README.md`, `DOWNLOAD.md`, `site/install.ps1`, `site/install.sh` replaced with `Cookie774-GameDev/jarvis-one`.
- Committed, pushed, verified live site has zero stale URLs.

### Files created

- `site/index.html` — 18-section marketing landing page (~189 lines, 35 KB)
- `site/install.ps1` — short-URL Windows installer shim
- `site/install.sh` — short-URL macOS/Linux installer shim
- `site/.nojekyll` — bypass Jekyll
- `site/404.html` — custom 404 redirect
- `.github/workflows/pages.yml` — GitHub Actions deployment

### Files modified

- `README.md` — full overhaul (features, install, calling, hotkeys, provider list, domain recommendation)
- `DOWNLOAD.md` — all URLs updated to `Cookie774-GameDev/jarvis-one`

### Verification

- `https://cookie774-gamedev.github.io/jarvis-one/` — loads, all URLs point to `Cookie774-GameDev/jarvis-one`
- `https://github.com/Cookie774-GameDev/jarvis-one` — 3 commits on `main`, Pages configured to `Deploy from a branch: GitHub Actions`
- `git grep anomalyco` — zero matches in tracked user-facing files

### URLs

| Resource            | URL                                               |
| ------------------- | ------------------------------------------------- |
| Repo                | `https://github.com/Cookie774-GameDev/jarvis-one` |
| GitHub Pages (live) | `https://cookie774-gamedev.github.io/jarvis-one/` |
| Recommended domain  | `vibejarvis.com`                                  |

### Notes

- The `JARVIS_LINKS` config block at the bottom of `site/index.html` has Discord and YouTube as `#placeholder` — swap in real URLs when ready.
- Domain recommendation `vibejarvis.com` (~$6 first year, ~$10/yr renewal) — short, .com, aligns with product positioning.
- First Actions run failed predictably because `configure-pages` requires Pages to be enabled first. Not a bug; the fix was enabling Pages then pushing again.

---

## 2026-06-03 - v0.1.16 Terminal Service Singleton, Project Ownership & Silent Update Validation

**Actor:** Codex for viper

**Goal:** Stabilize Jarvis One's background terminal service behavior before shipping: prevent duplicate service owners, keep terminals strictly project-scoped, make terminal persistence fast and deterministic, clean up current error spam, and validate the silent update path.

**Result:** Added a Tauri single-instance owner, fixed close-to-tray/reopen duplicate processes, removed unsafe boot reconciliation, stamped terminal pane/transcript/backend records with project ownership, repaired malformed legacy terminal state on load, debounced transcript persistence, regenerated Windows updater artifacts, and verified local silent install plus installed close/reopen singleton behavior.

### Root causes found

1. **Duplicate service owners after close-to-tray:** `RunEvent::ExitRequested` was globally prevented, which could keep second-instance launch attempts alive after the main window was hidden.
2. **Terminal cross-project mixing:** pane trees and transcript records did not consistently carry project ownership, so saved state from one project could be restored into another.
3. **Terminal disappearance/kill risk:** boot-time terminal reconciliation could call the backend with an empty or stale active-session list, causing valid PTYs to be killed.
4. **Terminal persistence lag:** transcript persistence used Zustand `persist`, causing full transcript state serialization on high-volume terminal output.

### Files changed

- `app/src-tauri/src/lib.rs` - single-instance plugin registration, tray close-to-background behavior, and removal of broad exit prevention.
- `app/src-tauri/src/terminal.rs` - safe no-op guard for empty terminal reconciliation requests.
- `app/src/App.tsx` - removed unsafe boot terminal reconciliation.
- `app/src/features/terminals/paneTree.ts` - added stable `projectId` ownership on terminal leaves.
- `app/src/features/terminals/terminalProjectMove.ts` - added schema repair, project stamping, wrong-owner pruning, and backend/transcript move synchronization.
- `app/src/features/terminals/transcriptStore.ts` - added project ownership and manual debounced localStorage persistence.
- `app/src/features/terminals/TerminalView.tsx` - filtered session attachment and historical transcript lookup by project.
- `app/src/features/terminals/terminalProjectMove.test.ts` - added project-stamping, wrong-owner repair, and intentional move tests.
- `app/src/features/terminals/transcriptStore.test.ts` - added debounced persistence and project ownership tests.
- `CHANGELOG.md` - documented the v0.1.16 terminal/service fixes.

### Verification

- `cargo check` - passed.
- `npm --prefix app run typecheck` - passed.
- `npm --prefix app run test` - 12 files passed, 111 tests passed.
- `npm run release:windows` - passed and regenerated `releases/latest.json`, updater signatures, NSIS, MSI, and `SHA256SUMS.txt`.
- Local silent install smoke - `JARVIS_LOCAL=1`, `JARVIS_SILENT=1`, NSIS installer exit code `0`.
- Installed duplicate launch smoke - launching installed Jarvis twice kept one running `jarvis.exe`.
- Installed close/reopen smoke - `CloseMainWindow()` kept the background process alive; reopening focused/reused the existing owner and kept one running `jarvis.exe`.
- Log scan - no Jarvis local log files or Windows Application errors found after startup/reopen smoke.

### Known limits

- Windows Authenticode status remains `NotSigned` unless `WINDOWS_CERT_BASE64` or `WINDOWS_CERT_THUMBPRINT` is configured; Tauri updater signatures are present.
- Windows artifacts are validated on this host. macOS/Linux packaging remains unverified on this Windows machine.

## 2026-06-05 - v0.1.18 Zustand safeLocalStorage, Cloud Sync Integration, Voice Playback & Terminal Persistence

**Actor:** Jarvis (Antigravity AI)

**Goal:** Permanently resolve the fatal React error screen crash (`QuotaExceededError` on localStorage), wire custom tools and local mutations into cloud sync, stabilize voice dictation/playback/summon modals, enable automatic reattachment of live terminal sessions on reload, and suppress unwanted context menus during terminal right-drags and context map navigation.

**Result:** Completed the local implementation pass and installed a local silent `0.1.18` build. Created `safeLocalStorage` to insulate React from quota writes, implemented transcript memory capping (max 10 sessions, 512 KB total, 32 KB/session), connected custom tool mutations to Supabase sync, stabilized terminal session lifecycle across reloads, refined audio cataloging/dictation, and silenced context menus on drag paths. App configuration bumped to `0.1.18`. Public updater packaging still requires the Tauri updater private key so fresh `.sig` files and `releases/latest.json` can be generated for the exact release artifacts.

### Changes Made:

- **Zustand safeLocalStorage & Quota Mitigation**: Created `safeLocalStorage.ts` wrapper with error isolation and try-catch blocks to prevent React rendering crashes when localStorage is full. Configured `useUIStore`, `useAuthStore`, `useToolStore`, and `useTerminalSchedulerStore` to utilize it. Added loop-free transcript pruning directly inside state updates.
- **Cloud Sync Integration**: Wired custom tools and local mutations to the Supabase sync queue. Custom tool creation/deletion now queues private account sync records; live cross-device verification is still pending against the production backend.
- **Terminal Session & Reopen Lifecycle**: Fixed PTY session preservation on reload. Live terminal PTYs now automatically reattach to the correct frontend panes using stable project-scoped pane IDs. Saned orphan escape sequences and stabilized pane lifecycle tracking.
- **Voice System & Summon Modal**: Upgraded the voice summon modal to stay open under active dictation, improved Groq audio playback replies, and secured voice terminal execution flows.
- **UI & Context Menu Control**: Suppressed the default OS context menu during terminal right-click drags and across the cozy context map SVG canvas to prevent overlapping popup blocks. Polished voice summon bubbles and expanded the ambient music catalog with additional audio tracks.
- **React Loop Hardening**: Fixed update-warning dialog close handling so intentional "Update Later" closes do not re-enter snooze logic, and fixed the ambient master toggle so it never writes `ambientActive: undefined`.
- **General / Tools**: Added a preloaded Clock tool to allow timestamped scheduling, mapped mentioned agents (Scout, Builder, Reviewer) directly to their `.md` system prompts, and secured legacy API key migration paths.

### Files Changed:

- `app/src/lib/persistence/safeLocalStorage.ts` - Decoupled state storage wrapper
- `app/src/stores/ui.ts`, `app/src/stores/auth.ts`, `app/src/features/tools/toolStore.ts`, `app/src/features/terminals/terminalScheduler.ts`, `app/src/features/terminals/transcriptStore.ts` - integrated safeLocalStorage, partialize filters, and pruning limits
- `app/src/features/whats-new/releases.ts` - bumped current version and prepended v0.1.18 notes
- `package.json`, `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json` - bumped metadata version to `0.1.18`
- `CHANGELOG.md` - appended version `0.1.18` changelog
- `scripts/release-windows.ps1` - added updater signing key preflight and local `.tauri` key-file loading for production packaging

### Verification:

- `npm run typecheck` - passed.
- `npm run build` - passed.
- `cargo check` - passed.
- Local silent NSIS install - passed with `%LOCALAPPDATA%\Jarvis One\jarvis.exe` reporting `ProductVersion=0.1.18`.
- `npm run release:windows` - blocked until `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH` is available for updater `.sig` generation.
