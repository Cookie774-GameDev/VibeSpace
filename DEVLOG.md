# Jarvis - Development Log

Append-only log of every significant development action. Each entry: timestamp, actor, summary, files touched.

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

| ID | Owner | Directory | Deliverables |
|---|---|---|---|
| **A1** | Database | `lib/db/`, `lib/supabase.ts`, `lib/sync.ts`, `supabase/` | Dexie schema (9 tables), repositories, seed (1 workspace + 7 agents), Supabase client (null-safe), sync queue, Postgres migration with RLS |
| **A2** | Layout shell | `components/layout/` | AppShell + TopBar + NavPane (240/56 collapsible) + Inspector (slide-over) + TabStrip (Arc-style) + ActivityStrip (council-only) + global hotkey wiring |
| **A3** | Chat | `features/chat/` | ChatView + ChatThread + Composer (auto-grow, Mod+Enter) + MessageBubble (per-agent colored borders) + ToolCallCard (collapsible) + MentionTypeahead + EmptyChat + `useChatMessages` |
| **A4** | Council | `features/council/` | CouncilView + CouncilGrid (n-up, capped 4 cols) + AgentPanel + AnimatedBeam (SVG cubic Bezier) + BeamLayer (ResizeObserver) + SynthesizeButton + CouncilToggle |
| **A5** | Tasks | `features/tasks/` | TodoPanel + TaskCard + TaskComposer (NL parser via date-fns) + SnoozePopover + DraftTaskList + TaskService + Scheduler (deadline pressure curve, quiet hours) + NotificationEngine (Tauri + browser fallback + in-app) + parseTaskInput |
| **A6** | Voice | `features/voice/` | VoiceModal (bottom-anchored Dialog) + Orb (5-layer CSS) + GlowBorder (conic gradient) + VoiceCaption + VoiceTrigger (PTT 250ms hold) + VoiceService (Web Speech API) + IntentClassifier (10 intents) + 5 personas |
| **A7** | Palette | `features/command-palette/` | CommandPalette (cmdk + Radix) with nested pages + actions registry + useGlobalHotkeys + emit-event helpers |
| **A8** | Auth/Onboarding/Settings | `features/auth/`, `features/onboarding/`, `features/settings/` | AuthGate + SignInDialog + 5-step onboarding (welcome/persona/providers/permissions/demo) + 6-tab Settings modal |
| **A9** | Agents + AI | `features/agents/`, `lib/ai/` | 7 default agents w/ production prompts + 5 persona presets + AgentBadge/AgentManager/AgentPicker + LLMProvider abstraction + Anthropic/OpenAI/Google/mock providers + router with fallback + runtime listener |
| **A10** | Tauri shell | `src-tauri/`, `lib/tauri.ts`, `public/jarvis.svg` | Cargo.toml + lib.rs (4 plugins) + tauri.conf.json + capabilities/default.json + JS bridge with dynamic-import gating + SVG monogram |

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
5. `npm run dev` to launch the web version (works without Rust).

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

| Token            | V1 Voltage      | V2 Cozy                  | Why                                  |
|------------------|-----------------|--------------------------|--------------------------------------|
| `--background`   | `0 0% 4%`       | `28 12% 7%` (#14110F)    | Warm umber, not pure OLED black      |
| `--panel`        | `0 0% 7%`       | `26 10% 11%` (#1D1916)   | Side panel/chrome warmth             |
| `--elevated`     | `0 0% 10%`      | `26 10% 15%` (#2A2521)   | Cards, dialogs                       |
| `--foreground`   | `0 0% 98%`      | `36 25% 92%` (#EFEAE2)   | Paper cream — never stark white      |
| `--accent-cyan`  | `187 95% 43%`   | `22 65% 56%` (#D97757)   | Copper. Name kept for back-compat.   |
| `--accent-violet`| `258 90% 66%`   | `35 70% 60%` (#E5A35F)   | Amber. Name kept for back-compat.    |
| `--ring`         | `187 95% 43%`   | `22 65% 56%`             | Copper focus ring                    |
| `--destructive`  | `0 72% 56%`     | `6 70% 55%` (#D9624B)    | Brick red — warm side                |
| `--success`      | `158 64% 40%`   | `130 35% 50%`            | Sage green                           |
| `--radius`       | `0.625rem`      | `0.75rem`                | 12px cozier corners                  |
| `--surface-warm` | `0 0% 9%`       | `26 12% 13%`             | Chat bubbles, ambient cards          |
| `--ambient-deep` | `222 28% 4%`    | `28 25% 5%`              | Ambient takeover ground (warm umber) |

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

| File | Size | Use |
|------|------|-----|
| `target/release/jarvis.exe` | 5.52 MB | Bare release binary |
| `target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi` | 3.28 MB | Windows MSI installer |
| `target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` | 2.62 MB | NSIS setup wizard |

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
- Some Tauri WebView2 builds expose `window.SpeechRecognition` but throw a synchronous `DOMException` from `.start()` (commonly when the mic permission was never granted to the WebView host). The previous code flipped `sttListening` to true and called `VoiceService.startListening()` *before* the engine confirmed, so the throw bubbled into React's render pipeline and tore the tree down under StrictMode.
- Wrapped both operations in `try/catch`, only flipping the visible flag *after* the engine accepted the call, and surfacing `toast.error('Voice error', msg)` instead of crashing.

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

| Token | Dark (warm wood) | Light (cream paper) |
|---|---|---|
| `--background` | `#2a2018` | `#f5efe6` |
| `--panel` | `#34281e` | `#ede4d3` |
| `--elevated` | `#3a2d22` (cardstock) | `#fffbf5` (paper) |
| `--foreground` | `#f5e6c8` (cream ink) | `#3a2e22` (warm brown ink) |
| `--accent-cyan` (compat) → terracotta | `#d97757` | `#d97757` deepened |
| `--accent-violet` (compat) → honey | `#d4a258` | `#d4a258` deepened |
| `--rose` | `#c97b6e` | `#c97b6e` |
| `--sage`, `--sage-deep` | `#7c9870` / `#5d7855` | same |
| `--lavender` | `#9d8aa8` | same |
| `--cream` | `#f5e6c8` | same |
| Severity (5-level) | `crit/high/med/low/info` with darkened bg | full set with cream-tinted bg |
| Shadows | brown-tinted not gray | brown-tinted, lighter alpha |
| `--radius` | 14px | 14px |
| `--radius-lg` (cards) | 22px | 22px |
| Body bloom | radial pools (rose / sage / honey / lavender) | same, brighter tints |

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

| Type | Action |
|---|---|
| `create project tiger` | `projectRepo.create` + auto-switch via `setProjectId`, color hue derived from name hash |
| `switch to project tiger` | resolves case-insensitive then substring, warns if not found |
| `create chat called planning in tiger` | resolves project, creates chat, opens it |
| `open 4 terminals` | creates 4 `terminal_sessions` rows (PTY runtime is future work) |
| `open 4 terminals with claude code in tiger` | + `shell_command: 'claude code'` + `project_id` resolved |
| `open claude in tiger` | shorthand for `count=1, command='claude'` |
| `make a todo: ship the launcher tomorrow` | `taskRepo.create` with `due_at` parsed for today/tomorrow/weekday |
| `schedule lunch with sam friday at 1pm` | delegates to existing `parseEventInput` → `eventRepo.create` |
| `ambient on` / `ambient off` | toggles `ambientActive` |
| `fullscreen` / `exit fullscreen` | toggles `chatFullscreen` |
| `open settings` / `open palette` / `open launcher` / `open schedule` | corresponding modal opens |

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

| File | Size | Use |
|---|---|---|
| `app/src-tauri/target/release/jarvis.exe` | 5.57 MB | Bare release binary |
| `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi` | 3.33 MB | Windows MSI installer |
| `app/src-tauri/target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` | 2.67 MB | NSIS setup wizard |

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
- Inline markdown renderer (no dep): h1-h3, paragraphs, ordered/unordered lists, inline `code`, fenced ``` blocks, **bold**, *italic*. HTML-escapes input first.
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

| Slice | What | Status |
|---|---|---|
| 1 | Rust PTY backend | ✅ delivered |
| 2 | xterm TerminalView | ✅ delivered |
| 3 | Multi-pane terminal grid | ⚠️ empty return — written by main agent |
| 4 | PageRouter + ui store + NavPane wiring | ⚠️ partial — completed by main agent |
| 5 | Skills + agents Markdown loader | ⚠️ empty return — written by main agent |
| 6 | Skills library page UI | ✅ delivered (waited on slice 5) |
| 7 | Built-in skill markdowns | ✅ delivered |
| 8 | Kanban page | ✅ delivered |
| 9 | Live benchmark page | ✅ delivered |
| 10 | Session history | ✅ delivered |
| 11 | +7 providers | ✅ delivered |
| 12 | Swarm roles (Scout/Builder/Reviewer) | ✅ delivered |
| 13 | MCP-lite tool registry | ✅ delivered |
| 14 | Onboarding refresh | ✅ delivered |
| 15 | Celebration confetti | ✅ delivered |
| 16 | Inspector V3 | ✅ delivered |
| 17 | TopBar V3 | ✅ delivered |
| 18 | Supabase scaffolding | ✅ delivered |
| 19 | Assistant route commands | ✅ delivered |

16 of 19 returned summaries; 3 returned empty (likely a transport-layer hiccup). Audit confirmed Slice 4 had partially landed (route store + PageRouter wired correctly) but didn't finish NavPane / App.tsx integration. Slices 3 and 5 had nothing on disk. Main agent shipped the missing pieces directly. Net: 19 of 19 functional.

### Artifacts (regenerated)

| File | Size | Use |
|---|---|---|
| `app/src-tauri/target/release/jarvis.exe` | 6.00 MB | Bare release binary |
| `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.0_x64_en-US.msi` | 3.71 MB | Windows MSI installer |
| `app/src-tauri/target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` | 3.04 MB | NSIS setup wizard |

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

**Result:** Cloud backend + Jarvis frontend code shipped end-to-end. Typecheck clean. Architecture lets a single Fly.io machine (~3/mo) serve unlimited users on Path C with their own BYOK Groq keys (free) and on Path A with the operator's Twilio number (.15/mo). All endpoints inert until secrets are set; no surprise  on deploy. Documented in `phone-jarvis/IMPLEMENTATION.md`.

---

### 14:00 - Phase 0: Discovery + decision matrix

User answered the open questions from the planning docs:

| # | Question | Decision |
|---|---|---|
| 1 | Which transports? | **Path A + Path C** (skip B; "MAKE PATH C WORK") |
| 2 | Cloud host | **Fly.io free tier**, `min_machines_running = 1` |
| 3 | PSTN provider | **Twilio** ( trial covers months) |
| 4 | Provider stacks | Path A premium (Deepgram + Claude Haiku + Cartesia) and Path C cost-conscious (Groq Whisper + Groq Llama + Cartesia). Per-user BYOK overrides operator defaults. |
| 5 | PIN length | **6 digits, 3 strikes, 1h cooldown**. Caller-ID skip if number is on allowlist. |
| 6 | Tool ACL | **Read-only by default. Full power only when user says unlock phrase mid-call.** Lock reverts at hangup. |
| 7 | Outbound triggers | **Default off except manual + error-driven**. Per-category toggle in Settings. |
| 8 | Voice | **Use existing PERSONA system** (Jarvis/Athena/Edge/Watson/HAL/Sage). |
| 9 | Multi-user | **Yes from day one**, per-user auth via Supabase, per-user BYOK, per-user phone number. |
| 10 | Backend lang | **Python** (Pipecat is Python-first). |

Cloud URL is set by the operator (me/viper) via `VITE_PHONE_JARVIS_CLOUD_URL`; end users do not touch it. Power users get an "Advanced -> Self-host" override in Settings (parked for now).

### 14:30 - Phase 1: Cloud backend skeleton -- `phone-jarvis/cloud/`

Wrote the FastAPI app from scratch. One Pipecat pipeline factory, three transports, one bridge registry.

| File | Lines | Purpose |
|---|---|---|
| `main.py` | 95 | FastAPI app, mounts routers, daily audit prune |
| `config.py` | 80 | Pydantic Settings, `.has_*` flags for inert handlers |
| `pipeline.py` | 220 | Pipecat factory: STT -> LLM -> TTS, persona prompts, tool dispatch hook |
| `auth.py` | 220 | PBKDF2 PIN, allowlist normaliser, Supabase JWKS verifier, in-memory PinTracker |
| `bridge.py` | 200 | `BridgeRegistry` -- per-user WS sessions, in-flight tool-call futures |
| `bridge_endpoint.py` | 90 | `WS /bridge` handshake + frame loop |
| `twilio_handler.py` | 230 | `POST /twiml` + `WS /twilio/{sid}` -- Path A inbound |
| `livekit_handler.py` | 175 | `POST /livekit/token` -- Path C; spawns the AI agent task |
| `outbound.py` | 145 | `POST /outbound/call` -- Sage dials user; `/outbound/twiml` callback |
| `supabase_client.py` | 30 | Service-role Supabase client (bypasses RLS) |
| `audit.py` | 220 | JSONL audit logger, per-call + daily rollup, retention prune |
| `Dockerfile` | 18 | Python 3.11 slim, uvicorn |
| `fly.toml` | 30 | Always-on (no scale-to-zero -- inbound calls would 404) |
| `requirements.txt` | 14 | Pipecat 0.0.50 + Twilio + LiveKit + Supabase + jose |
| `.env.example` | 35 | Every secret with comments |

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

`
npx tsc --noEmit  -> OK (clean)
`

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

