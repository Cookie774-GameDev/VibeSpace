# Changelog

All notable changes to Jarvis are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.20] - 2026-06-06

### Added

- Added Settings -> Plugins with searchable/filterable cards, connection status, setup/manage/disconnect flows, masked fields, and terminal-access toggles.
- Added a schema-validated catalog of 353 integrations with explicit implemented versus planned status.
- Added tested connectors for GitHub, Figma, Supabase, Shopify, Slack, and a deterministic local mock connector.
- Added controlled plugin capability context and approval-gated `plugin.call` actions to project AI/terminal workflows.
- Added cloud sync for non-secret plugin connection metadata.

### Security

- Plugin secrets are stored through the Tauri OS keychain bridge and are excluded from localStorage, terminal environment variables, prompts, and Supabase.
- Added a Supabase trigger that rejects credential-shaped fields in plugin connection sync payloads.
- Added scoped native HTTP permissions for implemented connector API hosts.
- Windows release packaging now validates that the updater private key's sibling `.pub` file matches the public key embedded in Tauri config before building.
- Removed local helper files that copied updater private-key material into the repository worktree.

### Release

- Generated updater-signed 0.1.20 NSIS/MSI artifacts, `latest.json`, and current-artifact SHA-256 checksums.
- The updater manifest now targets the stable hyphenated GitHub asset name so release filename normalization cannot break downloads.
- Verified a silent per-user NSIS upgrade from 0.1.19 to 0.1.20 and confirmed the relaunched executable reports version 0.1.20.
- Windows Authenticode signing remains separate from Tauri updater signing and still requires `WINDOWS_CERT_BASE64` or `WINDOWS_CERT_THUMBPRINT`.

## [0.1.19] - 2026-06-06

### Fixed

- Fixed React Error #185 (maximum update depth exceeded) crash during boot and route changes by conditionally mounting TerminalsPage only on the terminal route instead of hiding it with CSS display:none.
- Stabilized Inspector's setInspectorOpen callback with useCallback to prevent unnecessary effect re-triggers.

## [0.1.18] - 2026-06-05

### Added

- Added a preloaded Clock tool to support timestamped scheduling.
- Added comprehensive diagnostics tracking local storage utilization sizes on startup.
- Added cloud sync integration for custom tools so tool changes are queued for account sync.

### Changed

- Configured a decoupled persistence layer (`safeLocalStorage`) that catches quota exceptions to prevent React app crashes.
- Implemented loop-free terminal transcript pruning (clamped to 10 sessions, max 512 KB total, and 32 KB per session) to prevent browser quota overflow.
- Configured lightweight `partialize` logic for Zustand UI, Auth, and Tool stores.
- Upgraded the voice summon modal and summon UI to stay open and display continuous transcription.
- Expanded the ambient music catalog with additional high-fidelity audio tracks.
- Route mentioned agents (Scout, Builder, Reviewer) directly to their respective system prompts.
- Windows release packaging now fails fast when the Tauri updater private key is missing, before starting a long build.

### Fixed

- Fixed context menu popups by suppressing custom menus during terminal right-click drags and across the context map canvas surface.
- Fixed terminal session persistence by reattaching live terminal sessions and stabilizing the reopen lifecycle after app reload.
- Stabilized voice dictation recording, playback replies, and general voice terminal security.
- Fixed native HTTP localhost scopes and secured legacy API key migrations.
- Fixed update-warning dialog close handling and ambient toggle state to avoid React maximum-update-depth crashes.

## [0.1.17] - 2026-06-03

### Added

- Added hold-to-confirm Eraser button in the terminal toolbar with visual progress fill and a 3.5s auto-reset timeout.
- Added global default terminal font size range slider under Settings -> Appearance (supporting 1px to 72px sizes).
- Added inline double-click terminal tab renaming styled with a cozy input field that saves on Enter/Blur and cancels on Escape.

### Changed

- Expanded the individual terminal "T" font size cycling icon to range from 10px to 20px without layout scale clamps.
- Increased font size validation constraints to range from 1 to 100.

### Fixed

- Fixed random desktop UI freezes/deadlocks by offloading Rust-side PTY write, flush, and resize operations onto a separate spawn_blocking thread pool.

## [0.1.16] - 2026-06-03

### Fixed

- Fixed update loop crash (React Error #185) in `UpdateWarningHost.tsx` by merging dual Dialog components.
- Fixed terminal blanking out on startup in `TerminalView.tsx` by filtering ConPTY reset/clear and alternate buffer escape codes, and increasing the bypass window to 3 seconds.
- Fixed terminal navigation lag by keeping the `TerminalsPage` permanently mounted in the background.
- Fixed terminal transcript loss on app reload/reboot by mapping historical transcripts using the stable `paneId` of terminal slots.
- Fixed duplicate Jarvis instances after close-to-tray/reopen by allowing second-instance launch attempts to exit instead of globally preventing all app exits.
- Fixed terminal project cross-wiring by stamping pane trees, transcripts, backend move metadata, and restored sessions with stable project ownership.
- Fixed malformed legacy terminal state repair so wrong-project panes are dropped rather than loaded into the active project.
- Fixed terminal persistence lag by replacing per-output Zustand persistence writes with manual debounced transcript flushes.

### Added

- Added Tauri System Tray Run-in-Background support so closing the Jarvis window hides it to the tray, keeping background terminal processes running continuously.
- Added a Tauri single-instance guard so reopening Jarvis focuses the existing service owner instead of spawning a conflicting owner.

## [0.1.15] - 2026-06-02

### Added

- Account page reachable from the top-left J avatar, showing sign-in state, plan, billing, saved API key count, usage summary, and Jarvis Call status.
- Admin entitlement helpers for owner/admin builds via `VITE_JARVIS_ADMIN`, admin emails, or local admin ids.
- Live `/usage` summary support for OpenAI organization usage/cost endpoints and OpenRouter key usage/limit endpoints when the linked key has access, plus local monthly totals for all providers.
- Wake-word host for "Hey Jarvis" / "Okay Jarvis", a visible wake bubble, and `Shift+Tab` to open Jarvis quickly from the keyboard.
- Multi-step custom workflow tools that chain built-in actions, plus an AI-callable `custom.createWorkflowTool` action so Jarvis can create complex tools for later reuse.
- Silent-update warning host with 1-hour, 30-minute, and 5-minute warnings, plus Update Later and snooze actions.
- Jarvis Call setup/admin/release guide in `docs/09-jarvis-calling-account-release.md`.

### Changed

- Terminal panes stay mounted through fullscreen changes, avoid rerunning startup commands on reattach or same-project moves, and restore typed draft input after respawn.
- Terminal transcript persistence is debounced to reduce UI stalls during high-volume output.
- File and Context drops paste/attach real paths instead of writing executable terminal wrapper commands.
- Plans page icons are vertically centered and the page background now reflects the active or admin-effective tier.
- Ambient audio retries playback after user gestures so browser audio policy does not leave the soundscape muted.
- Windows release staging rebuilds `0.1.15` updater-signed NSIS/MSI artifacts and refreshes `releases/latest.json` plus `SHA256SUMS.txt`.
- GitHub CI now treats Vitest as required, and the release workflow references the `Jarivs-One` repo, Jarvis One release names, and Tauri updater signing secrets.
- Windows Authenticode signing now has a Tauri `signCommand` hook through `scripts/sign-windows.ps1`, so certificate signing happens before updater `.sig` generation when signing env vars are configured.

### Fixed

- Removed system prompt/project Context printing from terminals.
- Removed false terminal completion notifications triggered by exit, reload, or hydration.
- Hidden native xterm scrollbars while preserving mouse wheel and touchpad scrolling.
- Jarvis Call entitlement gating now applies from every top-bar entry point while active calls can always hang up.
- Centralized duplicate global hotkey handlers so toggles like nav, voice, palette, and settings do not fire twice.
- `install/install.ps1` now reports Windows Application Control/SmartScreen policy blocks with concrete Authenticode signing guidance.
- Settings About and What's New now match version `0.1.15` and point at the `Cookie774-GameDev/Jarivs-One` release channel.

### Known

- OpenAI live usage requires an API key with organization usage/cost endpoint access; OpenRouter live usage uses the current-key usage endpoint. Other providers still show local usage totals until their hosted usage APIs are wired.
- Windows SmartScreen reputation cannot be solved purely in app code; production distribution still requires trusted Authenticode signing and reputation.

## [0.1.14] - 2026-06-02

### Added

- Multiple active Context maps per project with Active and Deleted labels plus a five-active-map limit.
- Done-notification controls for Jarvis, terminals, tasks, Context maps, and skills.
- Slash command autocomplete with fuzzy matching for app commands.

### Changed

- Context maps render more spread out with clearer fallback summaries for file nodes.
- File drags into chat and terminals attach or paste paths instead of dumping file contents into terminals.
- AI prompts can include a user-controlled completion cue for clearer agent done states.

### Fixed

- Context sidebar labels open the Context page while chevrons only expand or collapse maps.
- File selections from Context or terminal connected files open the right page with the file preselected.
- Terminal project switching avoids stale tree caching, pane morphing, and blank old-project terminal views.

## [0.1.13] - 2026-06-02

### Added

- `Ctrl+Caps Lock` speech-to-text toggle for focused chat composers and terminal panes.
- Assistant commands for creating self-made local commands, running saved commands, and executing multi-step `then` plans.

### Changed

- Same-project terminal drops now swap pane positions instead of shifting the grid.
- Terminal drag feedback now hides the dragged tile, uses a clear white drop outline, and supports `Escape` cancellation.
- Right-sidebar Jarvis chat now uses compact rendering and stays project-scoped without navigating the main canvas.

### Fixed

- Speech-to-text now stops after 30 seconds without voice activity, including the Groq recorder path.
- Terminal xterm hosts fill their full pane width without the stray left sliver.
- Terminal and Context drop events are scoped to the chat surface that received the drop.

## [0.1.12] - 2026-06-02

### Added

- Interactive cozy Context Map with circular nodes, string links, left-click inspection, right-click panning, wheel zoom, and a Center Map recovery button.
- Context Map creation animation with a white flash into the generated map after creation completes.
- Provider picker for Context Map generation using only saved Google, Groq, OpenAI, or Anthropic API keys, with local fallback still available.
- Context Map assistant commands for creating/generating the map and recentering it.
- File metadata on Context nodes, including size, created date, modified date, model, children, tags, and summaries.

### Changed

- Context is now presented as a map-first workspace while retaining draggable Context nodes for chat and terminals.
- Context generation stores richer node metadata and carries it through dragged Context payloads.

### Fixed

- Sidebar Context branches and project file folders now expand only from their dropdown arrow instead of toggling when the label is clicked.

## [0.1.11] - 2026-06-02

### Added

- Context workspace with a `Make Skill Tree` flow that scans project files and uses Gemini when a Google API key is configured.
- Project-scoped Context trees stored locally and injected into every AI request as a compact project map.
- Drag Context nodes into chat or terminals to attach request-specific Context with a copper power-up effect.
- Recursive project file browser in the left sidebar with draggable file paths.
- Native folder/file picker support for Files, Context, and connected-terminal file path inputs in the desktop app.

### Changed

- Replaced the user-facing Skills route/sidebar entry with Context while keeping legacy `/skills` and `open skills` as Context aliases.
- Files button now opens the full Files page/editor/Jarvis ask flow while the sidebar file tree stays lightweight.
- Natural-language commands, slash commands, route tools, action registry, breadcrumbs, onboarding, and entitlement copy now route to Context.

### Fixed

- Terminal Context drops paste shell-commented context blocks so they do not accidentally execute as commands.

## [0.1.10] - 2026-06-02

### Added

- Right-click terminal dragging with a lightweight floating preview and drop highlighting.
- Drop terminals into Jarvis chat to attach their live terminal transcript context.
- Drop terminals onto projects to move the live PTY into that project's terminal workspace.
- Backend `terminal_move` command so cross-project terminal moves preserve the child process while updating project metadata.
- Word-number terminal scheduling such as `message this terminal in five hours`.

### Changed

- Terminal pane drops now insert/reorder panes so occupied spots shift out of the way instead of only swapping.
- Project terminal move helpers stay lazy-loaded from navigation to avoid cold-start bloat.

### Fixed

- Fixed duplicate drop handling between chat/composer and terminal/project drop targets.

## [0.1.9] - 2026-06-01

### Added

- Durable scheduled terminal messages from chat-attached terminals; requests such as `send this terminal hello in 5 hours` persist and re-arm after restart.
- Stable terminal reference payloads with pane id, session id, command, project, and agent metadata.
- Settings -> About current-update summary for each shipped update.

### Changed

- Groq speech-to-text now records WAV audio with Web Audio and uploads `jarvis-dictation.wav` to Whisper, preserving Web Speech fallback when Groq is not configured.
- Terminal transcript records now include stable pane ids so restored/respawned terminals remain referenceable after session ids change.

### Fixed

- Fixed Groq STT `400 invalid media file` failures caused by fragile WebM recorder output.
- Fixed terminal references in chat not reliably reaching AI context after drag/drop or terminal respawn.
- Fixed scheduled terminal actions being lost on close/reopen by replacing one-off timers with a persisted scheduler.
- Fixed terminal session limits by adding a backend `deleted` tag so closed PTYs do not count towards the 10-pane per-project limits.
- Fixed Jarvis Inspector sidebar "New chat" creation to stay on the current page (e.g. Terminals page) instead of redirecting to the Chat canvas.
- Fixed Inspector sidebar layout by ensuring inactive tab styling doesn't push active content to the bottom.
- Updated Terminals page Reset button behavior: normal click now resets track sizing/layout positions only, while holding for 2 seconds with a cozy filling animation triggers confirmation to reset all terminal sessions.

## [0.1.8] - 2026-06-01

### Added

- Workspace restore: active route, active chat, active project, file roots, open files, terminal pane trees, and terminal transcripts persist across app closes and updates.
- Groq Whisper speech-to-text path using `whisper-large-v3-turbo` when a Groq API key is configured, while preserving Web Speech fallback.
- Project-scoped recursive Files tree with expandable folders and popular text/code file support.
- Fixed Files "Send to Jarvis" flow to create/use an active chat before sending selected code.
- Drag terminal panes into chat as terminal references; Jarvis receives the terminal transcript as request context.
- 50-command Jarvis command catalog and `/commands` slash command.
- Deterministic assistant commands for `ask <provider> to ...` and `give all terminals all context`.

### Changed

- Files roots are stored per project instead of as one global folder.
- Chat attachments now support both files and terminal references.

### Fixed

- Terminal session counts now ignore exited PTYs and stay capped at 10 per project rather than leaking across stale sessions.
- Silent installer flow now forces NSIS for `JARVIS_SILENT=1` installs so local update tests do not trigger UAC elevation.

## [0.1.7] - 2026-06-01

### Added

- Lazy-loaded Files workspace for browsing absolute project folders, creating text files, editing text/code files, and saving through scoped Tauri file commands.
- Drag files from the Files workspace into terminal panes to paste file contents into that exact PTY with an interactive copper drop highlight.
- Chat file attachments via drag/drop or `/attach`; attached files are included in the AI request alongside project context and connected terminal files.
- Files editor "Ask Jarvis" flow for selected code snippets.
- Chat slash commands: `/usage`, `/model`, `/files`, `/terminals`, `/kanban`, `/skills`, `/history`, `/tools`, `/agents`, `/schedule`, `/attach`, `/clearfiles`, and `/help`.

### Changed

- Version bumped to `0.1.7` across the renderer and Tauri shell.

## [0.1.6] - 2026-06-01

### Added

- Scoped PTY terminal sessions to projects. Up to 10 terminals can be spawned per project. Switching projects swaps the entire grid context out and maintains separate terminal lists.
- Ambient Soundscape System: generative Web Audio API soundscapes (Warm Hearth, Deep Ocean, Starlight, Forest Rain) playing during idle/ambient mode with track preview and volume sliders in Settings -> Ambient.
- Premium Subscriptions Page: Redesigned plans page with Spark, Orbit, Nova, and Singularity tiers, featuring moving cosmic backgrounds, golden flows, and orbiting dashed rings.

### Changed

- Official brand name upgraded to **Jarvis One** across `tauri.conf.json`, `package.json`, and `Cargo.toml`.
- Fully automatic silent background updates: configured installer for silent background installations (`installMode: quiet`).
- Windows UAC admin prompt bypass: configured NSIS installer with `installMode: currentUser` to install in `%LOCALAPPDATA%` to bypass administrator elevation requests.

## [0.1.5] - 2026-05-31

### Added

- Manual resize handles between every terminal tile in Tiles mode (drag to redistribute, double-click to reset). Sizes persist per layout shape across reloads.
- Compact top bar (28px) on the Terminals page and in chat fullscreen, with low-frequency buttons funnelled into a `...` overflow menu.

### Changed

- Terminals page header collapsed into a single 32px toolbar (the big hero title row is gone, regaining ~80px of vertical room for terminals).
- Side rail now stays visible in fullscreen workspace mode; only the to-do drawer collapses. Use `Mod+B` to hide the rail manually for distraction-free.
- Cargo release profile relaxed to thin LTO + 4 codegen units (was full LTO + 1 unit) so Tauri release links in ~1/3 the peak memory.
- Tile inner padding tightened (p-3 → p-2) and chrome strip thinned (h-9 → h-7).

### Fixed

- TopBar, outbound triggers, the bridge lifecycle hook, the call button, and the auth barrel no longer drag LiveKit (~504KB) and Supabase (~210KB) onto the initial-load graph. They're lazy now and only download on first use.
- Dropped a counterproductive `settings-sections` manualChunks rule in `vite.config.ts` that was forcing Rollup to relocate shared symbols into the named chunk and back-import them at boot, preloading PhoneVoice's LiveKit + Supabase transitive deps for every cold load.
- Boot modulepreload list reduced from 13 chunks to 10. Cold-load payload dropped about 227 kB gzipped.

## [Unreleased]

### Added

- Initial planning and research documentation (8 design docs, 5 research reports, 1 implementation plan)
- V1 application scaffold (Vite + React + TypeScript + Tailwind + shadcn-style UI)
- Tauri 2 desktop wrapper configuration (Windows + Mac + Linux capable)
- Voltage design system: OLED-black + cyan-violet accent gradient, Geist typography, Lucide icons
- Three-pane shell layout (collapsible nav, fluid main canvas, slide-over inspector, tray-style to-do drawer)
- Chat thread + composer UI with mention-routing typeahead
- Council mode UI: n-up agent panels, animated beams, synthesize button
- Live to-do system: TaskCard, TodoPanel, smart scheduler, in-app reminder engine, browser notifications
- Voice modal with CSS-only ambient orb + Apple-Intelligence-style glow border + push-to-talk hotkey
- Command palette (cmdk) with global Cmd+K + nested pages + agent switching
- Settings page with BYOK inputs (OpenAI / Anthropic / Google), theme, keyboard alphabet, telemetry toggle
- Onboarding flow (5 steps: welcome -> persona -> providers -> permissions -> demo)
- Local-first persistence via Dexie (IndexedDB) for chats, tasks, agents, settings
- Supabase client wiring (creds plugged in via .env.local) for cloud sync, auth, push relay
- Agent registry: Jarvis (supervisor), Researcher, Coder, Writer, Critic, Memory Keeper, Action Extractor
- Mock LLM provider for offline development without API keys
- Hotkey alphabet: Cmd+K palette, Cmd+B nav, Cmd+\\ inspector, Cmd+Space voice, Cmd+T new chat, Cmd+1..9 tabs
