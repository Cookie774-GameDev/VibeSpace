# Changelog

All notable changes to Jarvis are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.32] - 2026-06-12

### Added

- Deepgram BYOK voice engine in Settings → Voice; API keys stored in the OS keychain.
- Admin settings section and Supabase `app_admins` for unlimited cloud voice on edge functions.
- Plugin catalog capped at 112 verified connectors with two-step credential connect.
- Chat `/plug` slash command and plugin mention detection for connected integrations.
- Terminal bulk open, Claude, and OpenCode actions marked destructive (require Approve).

### Fixed

- Plugin HTTP test auth for Twilio, Stripe, Discord, Mailchimp, Deepgram, and Anthropic.

## [0.1.31] - 2026-06-11

### Security

- New `0015_protect_billing_columns` migration: clients can no longer change `profiles.tier`, `monthly_quota`, or `stripe_customer_id`; only the Stripe webhook (service role) manages billing state. Verified live: a simulated authenticated self-upgrade to `ultra` is silently reverted.
- New `0016_fix_function_search_path` and `0017_advisor_hardening` migrations: pinned `search_path` on all remaining public functions, indexed the `subscription_events.user_id` foreign key, and rebuilt the `plan_limits_read` RLS policy without per-row `auth.role()` re-evaluation. Supabase security advisors now report no unaddressed database findings.
- Google Gemini API keys now travel in the `x-goog-api-key` header instead of `?key=` URL query params (chat streaming, key validation, context tree, and the plugin connection probe), so keys can never leak into request logs.
- DevConsole fetch logging now redacts sensitive query params (`key`, `token`, `signature`, etc.) before storing URLs.
- Added a dedicated `message_rate_limit_hit` RPC and wired `message-complete` to it (and to actually enforce 429s) instead of borrowing the voice rate-limit window.
- Legacy `jarvis-proxy` edge function CORS tightened from `*` to the desktop app origin allow-list.
- Tightened `.gitignore` so `.env.production` / `.env.development` (without `.local`) can never be committed; also ignores local databases and `.tmp-*` scratch files now.

### Fixed

- Restored the canonical Windows installer `install/install.ps1`, rebranded to the `Cookie774-GameDev/VibeSpace` repository with `VibeSpace_*` asset names (legacy `Jarvis One_*` names still match for old releases).
- `Jarvis` terminal launcher scripts now check all VibeSpace and legacy Jarvis One install paths before launching or updating, instead of only the first two.
- `install/install.sh` fallback download URLs now use `VibeSpace_*` Tauri bundle names; `JARVIS_ARCH` override is now actually honored.
- `twilio-message-webhook` looked up a nonexistent `profiles.phone` column; inbound SMS users are now resolved via `phone_settings.user_phone_number`.
- Settings → About now shows the real installed app version and a current release timeline instead of a hardcoded `v0.1.20`.
- Subscription tier shown in the app now syncs from the server-managed `profiles.tier` on sign-in and session restore.

### Improved

- Ultra plan card galaxy restored to full strength: brighter nebula core, drifting conic-gradient swirl, and two counter-rotating star layers — all GPU-friendly CSS that honors `prefers-reduced-motion`.
- All plan page backdrops gained slightly richer gradients with no layout changes.
- vibespaceos.com landing page updated to v0.1.31 with live install commands and an active Download button pointing at GitHub Releases.

## [0.1.30] - 2026-06-11

### Added

- Streaming voice during AI chat replies (incremental TTS while tokens stream).
- Unified `voiceRouter` for Kokoro local neural voice and system TTS across Settings, voice panel, and runtime.
- Chat lifecycle helper — always ensures an active conversation on boot.
- Plugin activation flow, provider registry, and curated local Ollama model catalog.
- VibeSpace landing site (`landing/`) for vibespaceos.com.
- Strict Tauri Content Security Policy for the desktop WebView.

### Improved

- Debounced Zustand UI persistence to reduce localStorage writes.
- Ollama install hardening and Local Models settings polish.
- Real provider usage summary in Settings → Providers.

### Fixed

- Production builds ignore blanket `VITE_JARVIS_ADMIN` toggles; release CI clears admin env vars.
- Scrubbed personal filesystem paths from public docs and tests.

## [0.1.29] - 2026-06-11

### Fixed

- Fixed Settings → Plans card grid overlapping and clipping prices, badges, and "Current Plan" labels inside the settings modal.
- Pointed the Tauri updater manifest URL at the `VibeSpace` GitHub release channel so silent updates resolve the same artifacts as manual downloads.

## [0.1.27] - 2026-06-08

### Fixed

- Fixed production build path: `tauri build` is now used instead of raw `cargo build --release`, ensuring the NSIS installer bundles frontend assets correctly.
- Fixed installed app showing `localhost refused to connect` / `ERR_CONNECTION_REFUSED` because the executable was an unbundled raw binary with no embedded dist assets.
- Fixed installer extraction so the full bundled application is installed, not just the bare executable.

### Improved

- Added launch-time guardrails in terminal launcher scripts: detect stale executables, missing bundled assets, failed updates, port conflicts, and dev-server readiness.
- Added structured launch logging: mode (production/dev), exe path, version, build timestamp, server readiness, and release version.
- Launcher now validates the install directory contains bundled resources and never opens a broken webview page.

## [0.1.26] - 2026-06-08

### Fixed

- Fixed split ANSI/OSC terminal control sequences being persisted as visible text, including raw fragments like `[0m` and `]10;rgb`.
- Fixed terminal restore sanitization for legacy corrupted transcript snapshots before they are replayed into xterm.
- Fixed PTY UTF-8 decoding so split multibyte characters are held across backend reads instead of lossy-decoded per chunk.
- Fixed the GitHub download path by preparing a newer release version than the current `v0.1.25` latest release.

### Improved

- Batched terminal output rendering and transcript capture per animation frame to keep heavy output smoother without changing the terminal UI.
- Preserved terminal transcript metadata and restore behavior while adding stronger control-sequence guardrails.

## [0.1.25] - 2026-06-07

### Added

- **Jarvis Core theme**: added an optional black/orange full-app theme based on the supplied Jarvis references while keeping Dark, Light, and System themes available.
- **Five spoken voices**: added persisted Jarvis Prime, Aurora, Atlas, Nova, and Sentinel voice profiles independent from conversational persona.
- **Spoken normal replies**: completed Jarvis replies can now speak aloud in normal typed chat, not only voice-originated sends.
- **Ollama in-app downloads**: Local Models can detect/start Ollama, pull models with live progress, auto-register installed models, and select completed pulls.
- **Local voice install handoff**: Local-only voice mode detects installed system voices and opens Windows Speech settings to install voice packs.

### Improved

- Slash command menus and option pickers now inherit app theme tokens instead of fixed purple/brown styling.
- The mini Jarvis panel is token-aware, more microphone-reactive, and scrolls the full You/Jarvis transcript.
- Provider cards show real locally recorded monthly usage totals instead of placeholder counters.
- System theme now resolves from the OS preference and has a distinct API-key input glow.

### Fixed

- Release manifest generation now skips unsigned platform archives instead of failing the whole job when signed Windows updater assets exist.
- Added regression coverage for Ollama pull progress, fully local routing, voice persistence, theme resolution, provider usage aggregation, and updater manifests.

## [0.1.24] - 2026-06-07

### Added

- **Persistent corner Jarvis panel**: saying "Hey Jarvis" now opens a compact warm-dark Jarvis card in the top-right corner instead of a blocking bottom dialog.
- **Live voice waveform**: the panel includes an amber audio waveform that reacts to microphone loudness while listening.
- **Voice conversation transcript**: the panel shows the running You/Jarvis chat transcript and keeps live partial speech visible while you talk.

### Improved

- Jarvis voice sessions now stay open until closed with the mini X button.
- Voice replies pause microphone recognition while Jarvis is speaking, then automatically resume listening.
- Rapid speech-recognition final chunks are buffered into one user request before sending to chat.
- Slash command option pickers now use the compact warm Jarvis style so they fit the app theme.

## [0.1.23] - 2026-06-07

### Added

- **Premium API key settings**: colorful surge animation expands from input, washes across screen, and retracts with sparkles when saving keys.
- **21 AI providers**: added Azure OpenAI, AWS Bedrock, Cerebras, and Hugging Face.
- **Provider usage counters**: shows input/output/cached tokens, cost, and last-used timestamp per provider.
- **Compact terminal-style slash command dropdown**: thinner 240px panel with smaller options and monospace font.
- **Purple command tokens**: confirmed slash commands display as removable purple pill tokens in the input.
- **/terminal command**: attach open terminal sessions from a picker filtered by current project.
- **/contextmap command**: attach context maps from a picker with node counts and dates.
- **Ref-based keyboard navigation**: arrow keys now properly navigate the slash command and option pickers.
- Masked key previews with show/hide toggle and copy button.
- Ambient glow effects and gradient backgrounds for provider cards.

### Improved

- Slash command dropdown reduced from 420px to 240px for a cleaner terminal aesthetic.
- Option picker shows available terminals and context maps dynamically.
- API key input focus triggers a warm pulsing rainbow border animation.
- Connected providers display a glowing "Connected" badge with micro-animations.
- Provider list shows connection count summary at the top.
- macOS installer CI uses stable `macos-13` runner instead of `macos-15-intel`.
- Installer shows detailed error messages with available assets when downloads fail.
- README redesigned with polished layout, badges, tables, and collapsible sections.

### Fixed

- Arrow key navigation now works correctly in slash command and option picker dropdowns.
- `Jarvis ultra`, `Jarvis claude`, `Jarvis codex`, and `Jarvis opencode` now forward trailing CLI arguments.
- The in-app What's New data now includes both `0.1.21` and `0.1.22` entries with correct version labels.

## [0.1.22] - 2026-06-07

### Added

- Added the missing startup What's New entry so every shipped update presents its update log once after launch.
- Rebuilt the `Jarvis` terminal command as an interactive coding command center.
- Added `Jarvis ultra`, `Jarvis code`, `Jarvis claude`, `Jarvis codex`, `Jarvis opencode`, `Jarvis app`, and `Jarvis help`.

### Improved

- Ultra Code automatically chooses the strongest installed coding CLI in the current working directory.
- Terminal launchers now preserve command-line arguments instead of discarding them.

## [0.1.21] - 2026-06-07

### Added

- Added a persistent provider/model picker; `/model` now opens it or accepts a provider and model directly.
- Added automatic Windows file-path detection so referenced files are included in AI context.
- Added a five-track hosted ambient playlist ready for public Cloudflare R2 URLs, with sequential repeat playback.

### Fixed

- Built-in Jarvis agents now honor the selected provider and model.
- Real provider failures are surfaced instead of silently returning unrelated canned mock responses.
- Mock mode clearly identifies itself and no longer pretends to analyze unavailable context.
- Reminder channels, completion notifications, and desktop notification permission handling now behave correctly.

### Release

- Built and updater-signed Windows NSIS/MSI artifacts for the silent `0.1.21` update.

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

### Fixed

- Reminder delivery now respects each reminder's `banner` and `in_app` channels instead of always sending both surfaces.
- Ordinary task edits no longer emit a false "Task done" notification; actual completion now emits it and closes scheduled reminders.
- Notification permission checks now use the Tauri notification plugin on desktop, including the onboarding permission step.

### Release

- Generated updater-signed 0.1.20 NSIS/MSI artifacts, `latest.json`, and current-artifact SHA-256 checksums.
- The updater manifest now targets the stable hyphenated GitHub asset name so release filename normalization cannot break downloads.
- Verified a silent per-user NSIS upgrade from 0.1.19 to 0.1.20 and confirmed the relaunched executable reports version 0.1.20.
- Fixed the cross-platform GitHub Release workflow by adding the `tauri` npm script expected by `tauri-action`, switching dependency installation to `npm ci`, and adding an explicit updater-key secret preflight.
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
- GitHub CI now treats Vitest as required, and the release workflow references the `VibeSpace` repo, VibeSpace release names, and Tauri updater signing secrets.
- Windows Authenticode signing now has a Tauri `signCommand` hook through `scripts/sign-windows.ps1`, so certificate signing happens before updater `.sig` generation when signing env vars are configured.

### Fixed

- Removed system prompt/project Context printing from terminals.
- Removed false terminal completion notifications triggered by exit, reload, or hydration.
- Hidden native xterm scrollbars while preserving mouse wheel and touchpad scrolling.
- Jarvis Call entitlement gating now applies from every top-bar entry point while active calls can always hang up.
- Centralized duplicate global hotkey handlers so toggles like nav, voice, palette, and settings do not fire twice.
- `install/install.ps1` now reports Windows Application Control/SmartScreen policy blocks with concrete Authenticode signing guidance.
- Settings About and What's New now match version `0.1.15` and point at the `Cookie774-GameDev/VibeSpace` release channel.

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

- Official brand name upgraded to **VibeSpace** across `tauri.conf.json`, `package.json`, and `Cargo.toml`.
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
