# Jarvis - Development Log

Append-only log of every significant development action. Each entry: timestamp, actor, summary, files touched.

---

## 2026-05-28

### Session: V1 Scaffold

**Actor:** opencode (claude-opus-4.7) for viper

**Goal:** Build V1 application scaffold per planning docs. Tauri 2 + Vite + React for Win/Mac. Supabase wiring (creds later). Logged + version-controlled. 10 parallel subagents for feature directories.

#### 17:55 - Phase 0: Repo bootstrap
- `git init` in `C:\Users\viper\projects\Jarvis`, branch `main`
- Created `.gitignore`, `LICENSE` (Apache-2.0), `.editorconfig`, `CHANGELOG.md`, `DEVLOG.md`
- Committed as `chore: initialize repo with planning docs`

#### 18:00 - Phase 1: Foundation (sequential, by main agent)
- Created monorepo-lite structure: `app/` for the desktop application
- Root `package.json` with workspaces declared (one workspace today: `app`)
- App-level configs: `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.js`
- Voltage design tokens in `app/src/styles/globals.css` (CSS variables for color/typography/spacing)
- Core types: `app/src/types/` (task, chat, agent, memory, common)
- Shared UI primitives: `app/src/components/ui/` (button, input, card, dialog, popover, badge, etc.)
- Shared lib utilities: `app/src/lib/utils.ts` (cn, hash, time formatting), `app/src/lib/hotkeys.ts`
- Zustand stores skeleton: `app/src/stores/` (ui, auth, agents)
- Entry point: `app/src/main.tsx`, `app/src/App.tsx`
- Committed as `feat(scaffold): foundation + design system + UI primitives`

#### 18:30 - Phase 2: Dispatch 10 parallel subagents
Each subagent owns a non-overlapping directory:
- A1: `app/src/lib/db/` + `app/src/lib/supabase.ts` + `app/src/lib/sync.ts` (Database & sync layer)
- A2: `app/src/components/layout/` (Three-pane shell + TopBar + NavPane + Inspector + ActivityStrip + TabStrip)
- A3: `app/src/features/chat/` (ChatThread + Composer + MessageBubble + ToolCallCard + MentionTypeahead)
- A4: `app/src/features/council/` (CouncilGrid + AgentPanel + AnimatedBeam + SynthesizeButton)
- A5: `app/src/features/tasks/` (TodoPanel + TaskCard + Smart scheduler + Notification engine + Service)
- A6: `app/src/features/voice/` (VoiceModal + Orb + GlowBorder + IntentClassifier stub)
- A7: `app/src/features/command-palette/` (CommandPalette + actions + nested pages)
- A8: `app/src/features/settings/` + `app/src/features/auth/` + `app/src/features/onboarding/`
- A9: `app/src/features/agents/` + `app/src/lib/ai/` (Agent registry + provider router + mock LLM)
- A10: `app/src-tauri/` (Cargo.toml + tauri.conf.json + main.rs + capabilities + icons)

#### Status: in progress
