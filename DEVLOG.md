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
