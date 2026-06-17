# VibeSpace — Agent Testing Guide

> **Single source of truth for AI-agent-driven QA.**  
> **Repo:** `C:\Users\viper\VibeSpace`  
> **Product version:** **0.1.42** (June 2026)  
> **Upstream:** [github.com/Cookie774-GameDev/VibeSpace](https://github.com/Cookie774-GameDev/VibeSpace)  
> **Multi-agent coordination:** [`docs/AGENT_COORDINATION.md`](AGENT_COORDINATION.md) — read before any code change; update after commits (see `.cursor/rules/agent-coordination.mdc`).  
> **Do not commit secrets.** Never paste `.env`, API keys, or service-role credentials into tests or docs.

**Naming:** **VibeSpace** is the product. **Jarvis** is the built-in voice assistant, command bar, and calling layer *inside* VibeSpace — not the product name. Internal npm scripts may still use `jarvis` (e.g. `npm run jarvis`).

---

## 1. Overview

| Item | Value |
|------|-------|
| **Product** | VibeSpace — AI workspace (terminals, chat, voice, tasks, agents) |
| **Built-in assistant** | Jarvis — voice presets, Mod+J command bar, PSTN calling |
| **Version** | **0.1.42** |
| **License** | Apache 2.0 |
| **Platforms** | Windows 10 1809+, macOS 12+, Linux desktop (64-bit); Tauri 2 + Vite web dev |
| **Repo** | https://github.com/Cookie774-GameDev/VibeSpace |
| **Website** | https://vibespaceos.com |
| **Live demo** | https://cookie774-gamedev.github.io/VibeSpace/ |
| **Releases** | https://github.com/Cookie774-GameDev/VibeSpace/releases/latest |
| **Issues** | https://github.com/Cookie774-GameDev/VibeSpace/issues |

**What it is:** A desktop-first AI workspace with live PTY terminal grids, multi-agent chat and council mode, local Kokoro + cloud Deepgram voice, PSTN Jarvis Call, kanban/schedule/tasks, plugin integrations, and Stripe subscription billing — with persistent local memory (IndexedDB via Dexie).

---

## 2. Install & Run (for testers)

### 2.1 Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** | ≥ 20 (`engines` in root `package.json`) |
| **npm** | `npm install` at repo root (workspace: `app/`) |
| **Rust** | Required for Tauri desktop only; see `SETUP.md` |
| **Tauri OS deps** | Win: VS C++ Build Tools + WebView2; macOS: Xcode CLT; Linux: webkit2gtk |
| **Supabase** | Official installers embed cloud config; source builds need `app/.env.local` |
| **BYOK keys** | Optional; mock provider works without keys |

### 2.2 Web dev (no Rust)

```bash
cd C:\Users\viper\VibeSpace
npm install
npm run jarvis
# → http://localhost:5173
```

Maintainers: copy `.env.example` → `app/.env.local` and fill `VITE_*` placeholders only.

### 2.3 Desktop (Tauri)

```bash
npm run tauri:dev     # Kokoro TTS feature enabled on build
npm run tauri:build   # produces installers under app/src-tauri/target/release/bundle/
```

### 2.4 One-line installers

| OS | Command |
|----|---------|
| **Windows** | `irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 \| iex` |
| **macOS / Linux** | `curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh \| bash` |

**Raw URLs:**

- https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1
- https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh

Manual downloads and checksums: `DOWNLOAD.md`.

### 2.5 Env var names (no values — see `.env.example`)

| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Cloud auth + edge functions |
| `VITE_*_API_KEY` | BYOK (or Settings → Providers) |
| `VITE_STRIPE_CHECKOUT_*` | Per-tier Stripe checkout URLs |
| `VITE_PHONE_JARVIS_CLOUD_URL` | phone-jarvis cloud origin |
| `VITE_JARVIS_ADMIN*` | Local admin entitlement builds |
| `VITE_ENABLE_VOICE` / `COUNCIL` / `CLOUD_SYNC` | Feature flags |

---

## 3. App Shell & Navigation

### 3.1 Layout

| Region | File | Role |
|--------|------|------|
| TopBar | `components/layout/TopBar.tsx` | Palette, voice, call, settings, route switcher |
| NavPane | `components/layout/NavPane.tsx` | Projects, chats, agents, context, files |
| PageRouter | `components/layout/PageRouter.tsx` | Lazy route canvas |
| Inspector | `components/layout/Inspector.tsx` | Context, files, terminals sidebar |
| TabStrip | `components/layout/TabStrip.tsx` | Chat tabs |

State: `app/src/stores/ui.ts`.

### 3.2 Routes

| Route | Label | Code path |
|-------|-------|-----------|
| `chat` | Chat | `features/chat/ChatView` (default on reload) |
| `terminal` | Terminals | `features/terminals/TerminalsPage` |
| `kanban` | Kanban | `features/kanban` |
| `schedule` | Schedule | `features/schedule` |
| `agents` | Agents | `features/agents/AgentManager` |
| `agent-detail` | Agent detail | `features/agents/AgentDetail` |
| `project-detail` | Project | `features/projects/ProjectDetail` |
| `context` | Context maps | `features/context/ContextPage` |
| `skills` | Skills | `features/skills` |
| `benchmarks` | Benchmarks | `features/benchmarks` |
| `history` | History | `features/history` |
| `tools` | Custom tools | `features/tools/ToolsPage` |
| `files` | Files | `features/files` |
| `account` | Account | `features/account/AccountPage` |

**Entry:** TopBar route popover, NavPane sections, slash commands in composer, Jarvis Assistant (Mod+J), actions palette (Mod+Shift+A).

**Note:** `route` is transient — reload returns to `chat`.

**Chat modes** (`chatMode`): `chat` | `council` | `doc` | `code` — switch via Mod+K → Switch mode.

### 3.3 Keyboard shortcuts (`app/src/lib/hotkeys.ts`)

| Shortcut | Action |
|----------|--------|
| `Mod+K` | Command palette |
| `Mod+B` | Toggle nav pane |
| `Mod+\` | Toggle inspector |
| `Mod+T` | New chat / tab |
| `Mod+W` | Close tab |
| `Mod+Enter` | Send message |
| `Mod+Shift+Enter` | Broadcast (council) |
| `Mod+Space` | Push-to-talk |
| `Mod+,` | Settings |
| `Escape` | Close modal / exit council |
| `Mod+Shift+F` | Fullscreen workspace |
| `Mod+Shift+.` | Toggle ambient mode |
| `Ctrl+CapsLock` | Composer STT + global dictation (desktop) |
| `Mod+Shift+S` | Schedule |
| `Mod+Shift+L` | Quick launcher |
| `Mod+J` | Jarvis Assistant |
| `Shift+Tab` | Chat: toggle auto-approve; else open Assistant |
| `Mod+Shift+A` | Actions palette |
| `Mod+Shift+D` / `F12` | Dev console |
| `Mod+Shift+1…9` | Launcher link hotkeys (user-configured) |

Full table: **Settings → Hotkeys**.

### 3.4 Command palette (`Mod+K`)

**Path:** `app/src/features/command-palette/`

| Page | Contents |
|------|----------|
| `root` | Create, Switch (agent/mode/theme), Browse (chats/tasks), App actions |
| `theme` | Light / dark / system |
| `switch-agent` | Registered agents |
| `switch-mode` | chat / council / doc / code |
| `recent-chats` | Last 20 chats |
| `tasks` | Open tasks |

### 3.5 Settings modal (`Mod+,`)

**Path:** `app/src/features/settings/SettingsModal.tsx`

| Tab | Section |
|-----|---------|
| Account | `sections/Account.tsx` |
| Plans | `sections/Plans.tsx` |
| Providers | `sections/Providers.tsx` |
| Plugins | `features/plugins/Plugins.tsx` |
| Local Models | `sections/LocalModels.tsx` |
| Appearance | `sections/Appearance.tsx` |
| Voice | `sections/Voice.tsx` |
| Phone & Voice | `sections/PhoneVoice.tsx` |
| Ambient | `sections/Ambient.tsx` |
| Notifications | `sections/Notifications.tsx` |
| Accessibility | `sections/Accessibility.tsx` (composer STT toggle) |
| Hotkeys | `sections/Hotkeys.tsx` |
| Jarvis Actions | `sections/JarvisActions.tsx` |
| About | `sections/About.tsx` (+ updater) |
| Admin | `sections/Admin.tsx` (admin builds only) |

### 3.6 Overlays (not routes)

| Overlay | Trigger | Path |
|---------|---------|------|
| Actions palette | Mod+Shift+A | `lib/actions/`, actions palette host in `App.tsx` |
| Launcher | Mod+Shift+L | `features/launcher/` |
| Jarvis Assistant | Mod+J | `features/assistant/` |
| Voice modal | TopBar mic | `features/voice/` |
| Call UI | TopBar phone | `features/call/` |
| What's New | Version bump / megaphone | `features/whats-new/` |
| Ambient takeover | Idle threshold | `features/ambient/` |
| Wellness break | Action `wellness.eyeBreak` | `lib/actions/registry.ts` |
| Global dictation | Ctrl+CapsLock (Tauri) | `features/global-dictation/` |
| Onboarding | First launch | `features/onboarding/` |

---

## 4. Feature Matrix

> For each row: go to **Location**, run **How to test**, verify **Expected behavior**. Check **Dependencies** first.

### 4.1 Chat, composer & council

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Chat / Composer** | Route `chat` | `features/chat/Composer.tsx` | Type; Mod+Enter send | Streaming reply; IndexedDB persist | Provider key or mock |
| **Chat modes** | Mod+K → Switch mode | `stores/ui.ts` `chatMode` | Switch chat/council/doc/code | Mode updates UI | `VITE_ENABLE_COUNCIL` |
| **Model picker** | Composer | `lib/ai/models.ts` | Select model | Options per configured providers | BYOK or hosted plan |
| **Slash commands** | Composer `/` | `SlashCommandTypeahead` | `/terminal`, `/plug`, `/skills`, `/contextmap` | Typeahead + navigation or insert | Per command |
| **Council** | Mode `council` | `features/council/CouncilView.tsx` | 2+ agents; Mod+Shift+Enter broadcast | Multi-panel grid + beams | Multiple agents |
| **Stack timeline** | Chat (when stacks enabled) | `features/chat/StackTimeline.tsx` if present | Send multi-step prompt | Step progress UI | Hive/BYOK per release |
| **Tab strip** | Below TopBar | `TabStrip.tsx` | Multiple chats; Mod+W | Tab switch/close | — |
| **Inline actions** | Chat messages | `lib/actions/runner.ts` | Jarvis proposes action | Approve/Cancel cards | — |
| **Auto-approve** | Shift+Tab in chat | `stores/auth.ts` | Toggle | Skips approve prompts | — |

### 4.2 Terminals

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **PTY grid** | Route `terminal` | `TerminalsPage`, `TileGrid.tsx` | Spawn up to 10 panes/project | Live resizable grid | **Tauri** for real PTY |
| **Persistence** | Leave and return | `terminalLiveCache`, `restoreSession.ts` | `echo test`; switch route | Output preserved | Desktop recommended |
| **Fullscreen pane** | Pane focus | `TileGrid.tsx` | Focus pane; Esc | Edge-to-edge single pane | — |
| **Font scaling** | Pane toolbar | `TerminalView.tsx` | Cycle font size | Per-pane scaling | — |
| **Hold-to-clear** | Pane toolbar | `terminalClearRegistry` | Press-hold clear | No accidental clear | — |
| **Agent CLIs** | New pane | `agentContext.ts`, `agentPromptDelivery.ts` | OpenCode/Claude/Codex pane | CLI runs; briefing → `AGENTS.md` | CLI on PATH |
| **Pane toolbar** | Pane header | `PaneToolbar` | Split, close, agent, clear | Toolbar works | — |
| **Shutdown flush** | Quit / tray | `lib/persistence/workspaceFlush.ts` | Hide tray; exit | Sessions flushed | Tauri |

### 4.3 Agents

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Agent manager** | Route `agents` | `features/agents/AgentManager.tsx` | CRUD agents | Cards with model/persona | — |
| **Agent detail** | Route `agent-detail` | `AgentDetail.tsx` | Click agent in nav | Editor opens | — |
| **Switch agent** | Mod+K | `stores/agents.ts` | Pick agent | Composer targets agent | — |

### 4.4 Voice (Jarvis module)

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Jarvis / Friday presets** | Settings → Voice | `features/voice/voiceRouter.ts` | Preview | Local TTS speaks | Kokoro download |
| **Kokoro local TTS** | Settings → Voice | `voice/modelManager.ts` | Download model; preview | Unlimited on all plans | Tauri `--features kokoro` |
| **Deepgram cloud TTS** | Settings → Voice | `providers/deepgramSpeak.ts`, `tts-speak` edge | Cloud engine + sign-in | Uses promo/subscription bucket | Auth + promo or BYOK |
| **Personas** | Settings → Voice | `features/voice/store.ts` | Change persona | Style changes | — |
| **Wake word** | Settings → Voice | `WakeWordHost.tsx`, `wakeWord.ts` | Enable; say wake phrase | Listening UI triggers | Mic; foreground app |
| **Push-to-talk** | Mod+Space | `VoiceTrigger.tsx` | Hold; speak | Transcript routed | Mic |
| **Streaming voice** | Voice modal | `streamingVoice.ts` | Hands-free question | STT → LLM → TTS | Provider + engine |
| **Foreground gate** | Background | `useAppForeground.ts` | Minimize app | Voice/wake off when hidden | — |

### 4.5 Composer STT & dictation

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Composer STT** | Composer mic; Ctrl+CapsLock | `Accessibility.tsx` toggle; composer pipeline | Enable in Settings → Accessibility; dictate | Text in composer | Deepgram or Web Speech |
| **Global dictation** | Ctrl+CapsLock (desktop) | `global-dictation/GlobalDictationOverlay.tsx` | Dictate; release | Text pasted to focused app via `dictation_paste_text` | Tauri; Deepgram session |

### 4.6 Call / Jarvis Call (PSTN)

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Call UI** | TopBar phone | `features/call/CallService.ts` | Start call | State: idle→ringing→active | Orbit+ plan or admin |
| **Outbound** | Scheduler/errors | `features/call/outbound.ts` | Trigger outbound | PSTN call placed | `call-start` + Twilio |
| **SMS** | Server | `supabase/functions/sms-send` | Send SMS if UI exposed | Message sent | Twilio secrets |
| **Usage** | Settings → Phone & Voice | `get-call-usage`, `get-voice-usage` | View meters | Minutes remaining | Signed in |

**Jarvis Call = real PSTN** (Twilio + phone-jarvis Pipecat). In-app voice ≠ phone call.

### 4.7 Plugins

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Catalog** | Settings → Plugins | `features/plugins/Plugins.tsx`, `catalog.ts` | Browse; connect | OAuth/API key flow | Per-plugin creds |
| **Runtime** | Chat `/plug` or @mention | `plugins/runtime.ts`, `activation.ts` | Mention connected plugin | Context injected | Connected plugin |
| **Connection test** | Plugins UI | `testPluginConnection` | Test button | Success/fail toast | Valid creds |

### 4.8 Billing / subscriptions

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Plans** | Settings → Plans | `sections/Plans.tsx`, `lib/entitlements.ts` | View tiers | Spark / Orbit / Nova / Singularity cards | — |
| **Checkout** | Plans → Upgrade | `create-checkout-session` | Click upgrade | Stripe Checkout | `VITE_STRIPE_CHECKOUT_*` |
| **Portal** | Account | `create-customer-portal` | Manage billing | Stripe portal | Active customer |
| **Webhook sync** | Server | `stripe-webhook` | Complete test purchase | `profiles.tier` updates | Stripe test mode |
| **Launch promo** | Plans | `claim-launch-promo` | Claim promo | Deepgram credit applied | Eligible account |
| **Hosted chat** | Chat (no BYOK) | `message-complete` | Send on paid plan | Credits decrement | JWT + paid tier |

**Plans (display names):** Spark (free) → Orbit ($10) → Nova ($50) → Singularity ($100). See `docs/SUBSCRIPTION_PLANS_REFERENCE.md`.

### 4.9 Auth / account

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Sign in** | Settings → Account | `stores/auth.ts` | Magic link / OAuth | Session persists | `VITE_SUPABASE_*` |
| **Tier sync** | Account | `AccountPage.tsx` | Sign in | Plan badge matches server | — |
| **Admin override** | Admin tab | `lib/admin.ts` | Admin env emails | Ultra entitlements | Maintainer build |
| **Model gating** | Chat | `RequireModelAccess.tsx` | Free + hosted model | Upgrade prompt | — |

### 4.10 Local models / Ollama

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Ollama** | Settings → Local Models | `lib/ai/providers/ollama.ts` | `ollama serve`; pull model | Models in picker | Local Ollama |
| **Kokoro weights** | Settings → Voice | `modelManager.ts` | Download | Progress + preview | Disk; Tauri |

### 4.11 AI providers (BYOK)

**Wired in chat router** (`lib/ai/models.ts` `REAL_CHAT_PROVIDERS`): `google`, `groq`, `openai`, `anthropic`, `ollama`, `local`, `mock`. DeepSeek appears in model options.

**Type union** (`types/common.ts` `ProviderId`) also includes: `xai`, `openrouter`, `deepseek`, `mistral`, `together`, `cohere`, `perplexity`, `fireworks`, `replicate`, `hyperbolic`, `novita`, `lambda`, `azure`, `cerebras`, `huggingface`, `bedrock` — verify UI wiring per release.

| Provider | Implementation |
|----------|----------------|
| google | `lib/ai/providers/google.ts` |
| groq | `lib/ai/providers/groq.ts` |
| openai | `lib/ai/providers/openai.ts` |
| anthropic | `lib/ai/providers/anthropic.ts` |
| ollama | `lib/ai/providers/ollama.ts` |
| mock | `lib/ai/providers/mock.ts` |

**Router:** `lib/ai/router.ts` · **Runtime:** `lib/ai/runtime.ts`

### 4.12 Updates / auto-updater

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Check updates** | Settings → About | `lib/updates.ts` | Click check | Version info | Tauri build |
| **Auto-install** | About toggle | `AUTO_UPDATE_KEY` | Enable/disable | Silent background update | Signed release channel |

### 4.13 Tasks / Kanban / Schedule

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Kanban** | Route `kanban` | `features/kanban/` | Create/drag cards | Board persists | — |
| **Schedule** | Route `schedule`; Mod+Shift+S | `features/schedule/` | Add item | Calendar view | — |
| **Tasks (palette)** | Mod+K → tasks | `features/tasks/` | Create task | Listed in palette | — |
| **Notifications** | Settings → Notifications | `lib/notifications.ts` | Enable done notifications | Toast on completion | Desktop for native |

### 4.14 Context maps & files

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Context tree** | Route `context` | `features/context/tree.ts` | Add nodes | Tree feeds prompts | — |
| **Files** | Route `files` | `features/files/` | Browse tree | FS view | Tauri for full FS |
| **Inspector links** | Mod+\ | `Inspector.tsx` | Open context/files | Navigates to route | — |

### 4.15 Launcher & ambient

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Launcher** | Mod+Shift+L | `features/launcher/` | Add tile; open | URL/app opens | — |
| **Link hotkeys** | Mod+Shift+1…9 | `App.tsx` `useLinkHotkeys` | Press assigned combo | Opens pinned link | User config |
| **Ambient idle** | Auto after threshold | `features/ambient/useIdleDetection.ts` | Idle 5 min | Takeover screen | Settings → Ambient on |
| **Manual ambient** | Mod+Shift+. | `ui.ts` | Toggle | Immediate ambient | Master switch on |
| **Wellness 20-20-20** | Mod+Shift+A → eye break | `wellness.eyeBreak` action | Run action | ~20s full-screen overlay | — |

### 4.16 Jarvis Assistant & actions

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Assistant** | Mod+J | `features/assistant/` | "open schedule", "open terminals" | Regex → actions (no remote AI) | — |
| **Actions palette** | Mod+Shift+A | actions palette in `App.tsx` | Search "terminal" | Runs registered action | — |
| **Custom tools** | Route `tools` | `features/tools/` | Wrap action as tool | Appears in palette | — |
| **MCP builtins** | Agent tools | `lib/mcp/builtins.ts` | Invoke tool | Results in chat | Tauri for some |

### 4.17 Landing site

| Feature | Location | Code path | How to test | Expected | Dependencies |
|---------|----------|-----------|-------------|----------|--------------|
| **Marketing** | vibespaceos.com | `landing/`, `site/` | Open in browser | Install CTAs | GitHub Pages (`pages.yml`) |
| **Demo** | cookie774-gamedev.github.io/VibeSpace | `site/landing.html` | Static page | Links to releases | — |

---

## 5. Backend & Cloud Systems

### 5.1 Supabase

**Docs:** `docs/supabase-setup.md` · **Migrations:** `supabase/migrations/` · **RLS tests:** `supabase/tests/rls_voice_verification.sql`

| Edge function | Auth | Path | Purpose |
|---------------|------|------|---------|
| `tts-speak` | JWT | `supabase/functions/tts-speak/` | Cloud TTS; voice/call budget |
| `get-voice-usage` | JWT | `supabase/functions/get-voice-usage/` | Voice bucket read |
| `message-complete` | JWT | `supabase/functions/message-complete/` | Hosted AI chat |
| `get-message-usage` | JWT | `supabase/functions/get-message-usage/` | Message credits |
| `call-start` | JWT | `supabase/functions/call-start/` | Authorize outbound call |
| `get-call-usage` | JWT | `supabase/functions/get-call-usage/` | Call minutes |
| `call-status` | Twilio sig | `supabase/functions/call-status/` | Settle call duration |
| `twilio-voice-webhook` | Twilio sig | `supabase/functions/twilio-voice-webhook/` | TwiML + time cap |
| `twilio-message-webhook` | Twilio sig | `supabase/functions/twilio-message-webhook/` | Inbound SMS + STOP |
| `sms-send` | JWT | `supabase/functions/sms-send/` | Outbound SMS |
| `create-checkout-session` | JWT | `supabase/functions/create-checkout-session/` | Stripe checkout |
| `create-customer-portal` | JWT | `supabase/functions/create-customer-portal/` | Billing portal |
| `stripe-webhook` | Stripe sig | `supabase/functions/stripe-webhook/` | Tier sync |
| `claim-launch-promo` | JWT | `supabase/functions/claim-launch-promo/` | Deepgram launch promo |
| `model-manifest` | public | `supabase/functions/model-manifest/` | Kokoro manifest CDN |
| `jarvis-proxy` | JWT | `supabase/functions/jarvis-proxy/` | Hosted DeepSeek proxy |

### 5.2 Stripe

**Doc:** `docs/stripe-setup.md` · **Client:** `lib/billing/stripe.ts` · **Plans:** `docs/SUBSCRIPTION_PLANS_REFERENCE.md`

### 5.3 phone-jarvis / Twilio

| Component | Path |
|-----------|------|
| Cloud service | `phone-jarvis/cloud/` (`main.py`, `livekit_handler.py`, `bridge.py`) |
| Architecture | `phone-jarvis/docs/02-architecture.md` |
| Laptop bridge | `phone-jarvis/docs/04-laptop-bridge.md` |
| Twilio setup | `docs/twilio-calling-setup.md` |
| Call flow | `phone-jarvis/docs/03-call-flow.md` |

Topology: Phone ↔ Twilio Media Streams ↔ Cloud (Pipecat) ↔ optional Laptop bridge (tool execution).

---

## 6. External Links & URLs

| Resource | URL |
|----------|-----|
| Website | https://vibespaceos.com |
| GitHub | https://github.com/Cookie774-GameDev/VibeSpace |
| Latest release | https://github.com/Cookie774-GameDev/VibeSpace/releases/latest |
| GitHub Pages demo | https://cookie774-gamedev.github.io/VibeSpace/ |
| Windows install (raw) | https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 |
| Unix install (raw) | https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh |

### Docs index (`docs/`)

| File | Topic |
|------|-------|
| `01-product-vision.md` | Product vision |
| `02-system-architecture.md` | Architecture |
| `03-multi-agent-orchestration.md` | Agents / council |
| `04-voice-jarvis-layer.md` | Voice design |
| `05-ui-ux-design.md` | UI + hotkeys spec |
| `06-todo-scheduler-notifications.md` | Tasks / scheduler |
| `08-tech-stack-decisions.md` | Stack choices |
| `09-jarvis-calling-account-release.md` | Call + release gates |
| `10-voice-subscription-system.md` | Voice billing |
| `SUBSCRIPTION_PLANS_REFERENCE.md` | Plans / promos |
| `supabase-setup.md` | Backend setup |
| `stripe-setup.md` | Stripe |
| `twilio-calling-setup.md` | Twilio |
| `security-production-checklist.md` | Prod checklist |

**phone-jarvis:** `phone-jarvis/docs/01`–`08`.

---

## 7. Test Commands (CI parity)

Run from **repo root** (`C:\Users\viper\VibeSpace`):

| Command | Checks |
|---------|--------|
| `npm install` | Workspace dependencies |
| `npm run typecheck` | `tsc --noEmit` in `app/` |
| `npm run build` | `tsc -b && vite build` |
| `npm --prefix app run test` | Vitest (~79 test files) |
| `npm run test:release-manifest` | Updater manifest tests |
| `cd app/src-tauri && cargo check --release` | Rust/Tauri compile |
| `deno check supabase/functions/**/index.ts` | Edge functions (optional; needs Deno) |

**CI:** `.github/workflows/ci.yml` — typecheck, build, vitest, release-manifest, `cargo check` on Ubuntu.

| Script | Purpose |
|--------|---------|
| `npm run jarvis` / `dev` | Vite dev → localhost:5173 |
| `npm run preview` | Preview production build |
| `npm run tauri:dev` | Desktop dev |
| `npm run tauri:build` | Desktop release bundle |
| `npm run format` | Prettier |
| `npm run release:windows` | Windows release pipeline |

---

## 8. Known Issues / Test Blockers

| Issue | Status / workaround |
|-------|---------------------|
| **Windows `install.ps1` parser** | Fixed 0.1.39+ (`${ESC}` escaping). If `irm \| iex` fails, download from GitHub Releases. |
| **Web vs desktop** | Real PTY, Kokoro, global dictation, tray, updater need **Tauri desktop**. |
| **No provider keys** | **Mock** LLM — UI QA only. |
| **Cloud without sign-in** | Hosted chat, cloud TTS, calls, checkout need **Supabase auth**. |
| **Jarvis Call** | Requires **Orbit+** (or admin) + server Twilio/phone-jarvis. |
| **Stripe URLs blank** | Plans show disabled upgrade until checkout env configured. |
| **SmartScreen** | Unsigned local builds may be blocked — see `docs/09-jarvis-calling-account-release.md`. |
| **IndexedDB stale** | DevTools → Application → Clear site data after schema changes. |
| **Route transient** | Reload → `chat` (by design). |
| **Council routing** | Council tied to `chatMode` in `App.tsx`; PageRouter routes surface only. |

### Features requiring API keys

| Feature | Credential |
|---------|------------|
| BYOK chat | Provider keys in Settings |
| Ollama | Local `ollama serve` |
| Cloud voice / STT | BYOK Deepgram or launch promo / subscription |
| Hosted chat | Sign-in + paid tier |
| Jarvis Call | Paid tier + Twilio (server) |
| Plugins | Per-plugin OAuth/API |

### Features requiring signed-in account

Hosted inference, cloud TTS billing, call/SMS, Stripe portal, launch promo, usage meters.

---

## 9. File Map for Agents

```
VibeSpace/
├── app/                         # Vite + React SPA
│   ├── src/
│   │   ├── App.tsx              # Shell, hotkeys, overlay hosts
│   │   ├── components/layout/   # TopBar, NavPane, PageRouter, Inspector
│   │   ├── features/            # Feature slices
│   │   │   ├── chat/            # Composer, council hook-in
│   │   │   ├── terminals/       # PTY grid
│   │   │   ├── voice/           # Kokoro, wake word, streaming
│   │   │   ├── call/            # PSTN Jarvis Call
│   │   │   ├── agents/ council/
│   │   │   ├── plugins/         # Plugin catalog + runtime
│   │   │   ├── settings/        # Settings modal
│   │   │   ├── kanban/ schedule/ tasks/
│   │   │   ├── context/ files/ tools/
│   │   │   ├── launcher/ ambient/
│   │   │   ├── assistant/       # Mod+J
│   │   │   ├── command-palette/ # Mod+K
│   │   │   └── global-dictation/
│   │   ├── lib/
│   │   │   ├── ai/              # Router, runtime, providers
│   │   │   ├── actions/         # Action registry + runner
│   │   │   ├── billing/ entitlements.ts hotkeys.ts updates.ts
│   │   └── stores/              # ui, auth, agents, projects
│   └── src-tauri/               # Rust: PTY, Kokoro, dictation, updater
├── supabase/functions/          # Edge functions (Deno)
├── supabase/migrations/         # Postgres schema
├── phone-jarvis/                # PSTN voice cloud
├── install/                     # install.ps1, install.sh
├── landing/ site/               # Marketing / GitHub Pages
├── docs/                        # Architecture + this guide
├── scripts/                     # Release tooling
└── .github/workflows/           # ci.yml, release.yml, pages.yml
```

### Quick grep targets

| Goal | Search |
|------|--------|
| Add route | `Route` in `stores/ui.ts` + `PageRouter.tsx` + `TopBar.tsx` |
| Add settings tab | `SettingsTab` in `settingsPrefetch.ts` + `SettingsModal.tsx` |
| Add action | `lib/actions/registry.ts` |
| Add provider | `lib/ai/providers/` + `models.ts` |
| Add edge function | `supabase/functions/<name>/index.ts` |

---

## 10. Suggested QA Flows

### Smoke (15 min, web)

1. `npm run jarvis` → http://localhost:5173  
2. Mod+K → new chat → send (mock provider)  
3. Mod+, → Account, Providers, Voice, Hotkeys  
4. TopBar route popover → terminal, kanban, schedule  
5. `npm run typecheck && npm --prefix app run test`

### Desktop (30 min)

1. `npm run tauri:dev`  
2. Two terminal panes; verify persistence across route change  
3. Settings → Voice → Kokoro download → preview Jarvis  
4. Mod+J → "open schedule"  
5. Settings → About → check for updates  

### Cloud (test account required)

1. Sign in → Account  
2. Settings → Plans → usage meters  
3. Hosted chat on paid test user  
4. Optional: claim launch promo; cloud TTS preview  

---

*VibeSpace v0.1.42 — maintain this guide alongside `CHANGELOG.md` each release.*
