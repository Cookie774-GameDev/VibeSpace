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

