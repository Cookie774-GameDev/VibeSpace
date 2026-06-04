# Jarvis

> **Vibe coding for vibe coders. Built by a vibe coder.**

Jarvis is a cozy, local-first, all-in-one AI workspace for builders who context-switch all day. It brings **AI calling**, agent councils, coding terminals, specific agents and system prompts, research, memory, tasks, actions, tools, and every model provider into one desktop app.

The goal is simple: stop juggling seven AI apps and ship from one calm workspace.

## Links

| Destination | Link |
| --- | --- |
| Website | `https://Cookie774-GameDev.github.io/Jarivs-One/` |
| GitHub | `https://github.com/Cookie774-GameDev/Jarivs-One` |
| Releases | `https://github.com/Cookie774-GameDev/Jarivs-One/releases` |
| Issues | `https://github.com/Cookie774-GameDev/Jarivs-One/issues` |
| YouTube | `#youtube-placeholder` |
| Discord | `#discord-placeholder` |

Replace the YouTube and Discord placeholders in `site/index.html` when the final links are ready.

## Install Jarvis

These commands resolve the newest published GitHub Release, install Jarvis One, and auto-launch it. If no published release assets exist yet, the installer stops safely and prints the release requirement instead of installing a stale build.

### Windows 10/11

1. Open PowerShell.
2. Run:

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.ps1 | iex
```

3. Jarvis auto-launches after install. You can also reopen it from the Start Menu.

### macOS 12+

1. Open Terminal.
2. Run:

```bash
curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.sh | bash
```

3. Jarvis auto-launches after install. You can also reopen it from `/Applications`.

### Linux

1. Open your terminal.
2. Run:

```bash
curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.sh | bash
```

3. Jarvis auto-launches after install. You can also reopen it from your app menu. The installer auto-detects `.deb`, `.rpm`, or AppImage.

See [`DOWNLOAD.md`](DOWNLOAD.md) for dry-run checks, direct release filenames, checksum verification, and troubleshooting.

## The Headline Feature: Calling

Jarvis is not only a desktop window. It is an AI you can talk to.

**Calling pitch:** a phone number you can call. The AI picks up. It can read your workspace through a local bridge.

### Calling paths

| Path | What it does | Status |
| --- | --- | --- |
| Path A: PSTN inbound | Dial a real Twilio number from any phone and talk to Sage/Jarvis | Backend endpoints exist; Twilio provisioning required |
| Path A outbound | Sage can call you for build failures, deadline alerts, or manual triggers | API exists; trigger callsites still being wired |
| Path C: in-app call | Tap the green call button and talk through LiveKit WebRTC | Shipping path |

### Calling stack

- Twilio Programmable Voice and Media Streams for phone calls.
- LiveKit for in-app WebRTC voice.
- Pipecat for the voice pipeline.
- FastAPI backend.
- Supabase JWT/RLS for auth and per-user settings.
- Local bridge over WebSocket for file and tool access.
- BYOK provider keys for Groq, Anthropic, Cartesia, Deepgram, and others.

Production setup details live in [`docs/09-jarvis-calling-account-release.md`](docs/09-jarvis-calling-account-release.md).

### Calling privacy

- Read-only tools by default.
- File reads happen through the local laptop bridge.
- Write/edit/delete actions require confirmation.
- PIN and caller allowlist are part of the phone flow.
- Audit logging is designed for 30-day retention by default.

## Feature Inventory

Jarvis currently includes or is actively wiring these surfaces:

- **AI calling:** in-app voice call, Twilio phone-call backend, outbound call API, bridge lifecycle, phone settings.
- **Council mode:** multiple agents in parallel with visible panels and synthesis flow.
- **Agents:** Jarvis supervisor, Coder, Researcher, Writer, Critic, Memory Keeper, Action Extractor, Scout, Builder, Reviewer.
- **Voice personas:** Jarvis, Athena, Edge, Watson, HAL, Sage-style calling voice.
- **Coding terminals:** real PTY terminals, tile grids, manual resize handles, terminal swarm presets.
- **Scout / Builder / Reviewer roles:** scoped research, implementation, and quality-gate workflow.
- **Chat:** multi-thread chat, composer, message rendering, action approval cards.
- **Actions:** built-in Approve/Cancel actions across navigation, settings, theme, voice, terminal, clock, chat, wellness, and host actions.
- **Custom tools:** local tool templates, import/export, run-in-place workflows.
- **Clock tool:** preloaded local timers/alarms with Jarvis actions, notifications, and sound.
- **Command palette:** global command center on `Mod+K`.
- **Actions palette:** `Mod+Shift+A` for actionable commands.
- **Quick launcher:** pinned apps and links.
- **Live to-do:** task panel, notifications, scheduler concepts, voice/task integration.
- **Schedule:** events, reminders, and scheduled surfaces.
- **Kanban:** drag-and-drop project board.
- **Benchmarks:** LMArena snapshot/fallback benchmark page.
- **History:** replayable session history.
- **Skills:** markdown/system-prompt skill system designed for marketplace expansion.
- **Settings:** providers, local models, hotkeys, plans, phone/call configuration, privacy controls.
- **Local models:** Ollama adapter, offline mode, model scanning from `/api/tags`.
- **Auth/model access gate:** blocks the workspace until a real Gemini key or offline mode is configured.
- **Wellness:** 20-20-20 break overlay.
- **Dev console:** debug panel for development and diagnostics.
- **What's new:** changelog/onboarding surface.

## Model Support

Jarvis is BYOK-first. Five providers are live today, and additional provider keys already persist in settings for future adapters.

### Live Today

| Provider | Why it matters |
| --- | --- |
| Anthropic | Claude for deep reasoning, coding, and excellent writing tone |
| OpenAI | GPT family for general-purpose intelligence |
| Google Gemini | generous free-tier path; default setup path |
| Groq | ultra-fast open model inference and Whisper options |
| Ollama | local/offline open-source models with no key and no internet |

### Wired / Expanding

- xAI / Grok
- DeepSeek
- Mistral
- Cohere
- Perplexity
- OpenRouter
- Together
- Fireworks
- Replicate
- Hyperbolic
- Novita
- Lambda
- Mock provider for deterministic local development

## Hotkeys

| Hotkey | Action |
| --- | --- |
| `Mod+K` | Command palette |
| `Mod+,` | Settings |
| `Mod+J` | Jarvis assistant bar |
| `Mod+Space` | Voice push-to-talk |
| `Mod+Shift+A` | Actions palette |
| `Mod+Shift+L` | Quick launcher |
| `Mod+Shift+S` | Schedule modal |
| `Mod+Shift+T` | To-do drawer |
| `Mod+Shift+D` / `F12` | Dev Console |
| `Mod+B` | Toggle nav pane |
| `Mod+\` | Toggle inspector |
| `Mod+Enter` | Send message |
| `Mod+Shift+Enter` | Broadcast to council |
| `Mod+Shift+M` | Composer mic / STT |
| `Mod+Shift+F` | Chat fullscreen |
| `Mod+1..9` | Switch tabs |

## Built-In Actions

Jarvis can propose safe, inspectable actions in chat. You approve or cancel before execution.

- Navigation: chat, terminal, kanban, skills, benchmarks, history, tools.
- Settings: open settings, providers, plans.
- Theme: dark, light, toggle.
- Voice: open voice modal.
- Terminal: open terminal, open swarm, start Claude Code, start OpenCode, run shell command.
- Chat: fullscreen.
- Wellness: start/end 20-20-20 break.
- Host: open URL, open launcher.

## Tech Stack

| Layer | Stack |
| --- | --- |
| Desktop | Tauri 2, Rust, React, TypeScript, Vite |
| UI | cozy paper theme, warm copper accents, keyboard-first shell |
| Runtime | AI router, provider adapters, MCP-lite tools, PTY terminal bridge |
| Calling | Twilio, LiveKit, Pipecat, FastAPI, Supabase |
| Storage | local-first app state, IndexedDB/Dexie patterns, Supabase optional sync |
| Local AI | Ollama adapter and offline mode |
| License | Apache 2.0 core |

## Website

The GitHub Pages site lives in [`site/`](site/). It is a self-contained warm/cozy landing page built for GitHub Pages.

It includes:

- Vibe-coding hero copy.
- Calling-first product section.
- Model support wall.
- Full feature grid.
- Download instructions for Windows, macOS, and Linux.
- Hotkeys, stack, changelog, community placeholders, and maker letter.
- Recommended domain from domain research: `vibejarvis.com`.

Deployment is handled by [`.github/workflows/pages.yml`](.github/workflows/pages.yml), which publishes `site/` to GitHub Pages.

## Local Development

```powershell
cd C:\Users\viper\projects\Jarvis
npm install
npm run jarvis
```

For desktop/Tauri development:

```powershell
npm run tauri:dev
```

For release builds:

```powershell
npm run tauri:build
```

See [`SETUP.md`](SETUP.md) for prerequisites and troubleshooting.

## Status

Jarvis is early access and shipping fast.

Recently shipped:

- `v0.1.5`: manual terminal tile resizing, compact top bar, lazy call/auth bundle loading, release-link memory improvements.
- `v0.1.4`: model-access gate, real Ollama adapter, Local Models tab, offline mode.
- `v0.1.3`: 24-action approval system, custom tools, wellness break, actions palette, pricing ladder.

Still being hardened:

- Stripe billing and hosted plans.
- Full MCP server transport with auth/RBAC.
- Phone-call confirmation state machine and audit viewer.
- Provider adapters for every wired provider.
- Mobile, browser extension, marketplace, watch companion.

## Domain Recommendation

Domain research recommended:

1. `vibejarvis.com` — best fit, short, .com, cheap first year.
2. `shipjarvis.com` — good shipping/velocity framing.
3. `jarvkit.com` — short toolkit framing.
4. `jarvflow.com` — flow-state framing.

Top pick: **`vibejarvis.com`**.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
