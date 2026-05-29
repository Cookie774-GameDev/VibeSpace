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

