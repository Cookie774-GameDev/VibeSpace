<p align="center">
  <img src="site/images/vibespace-logo.png" alt="VibeSpace Logo" width="120" height="120" />
</p>

<h1 align="center">VibeSpace</h1>

<p align="center">
  <strong>The AI workspace for every model, agent, voice & task</strong>
</p>

<p align="center">
  <a href="https://github.com/Cookie774-GameDev/VibeSpace/releases"><img src="https://img.shields.io/github/v/release/Cookie774-GameDev/VibeSpace?style=flat-square&color=7c3aed&label=Latest" alt="Latest Release"></a>
  <a href="https://github.com/Cookie774-GameDev/VibeSpace/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/Cookie774-GameDev/VibeSpace"><img src="https://img.shields.io/github/stars/Cookie774-GameDev/VibeSpace?style=flat-square&color=f59e0b" alt="Stars"></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platforms">
</p>

<p align="center">
  <a href="#-quick-install">Install</a> •
  <a href="#-features">Features</a> •
  <a href="#-model-support">Models</a> •
  <a href="#%EF%B8%8F-calling">Calling</a> •
  <a href="#-documentation">Docs</a>
</p>

---

## What is VibeSpace?

VibeSpace is a **cozy, local-first, all-in-one AI workspace** for builders who context-switch all day. It brings AI calling, agent councils, coding terminals, memory, tasks, and **21 model providers** into one desktop app.

> **Vibe coding for vibe coders. Built by a vibe coder.**

Stop juggling seven AI apps. Ship from one calm workspace.

---

## Quick Install

### Windows

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh | bash
```

<details>
<summary>What happens when you run the installer?</summary>

1. Downloads the latest release from GitHub
2. Installs to the appropriate location (user-scope by default)
3. Creates desktop/menu entries
4. Auto-launches VibeSpace

Run `Jarvis` in a new terminal to launch with the animated intro.

</details>

See [DOWNLOAD.md](DOWNLOAD.md) for manual downloads, checksums, and troubleshooting.

---

## Features

<table>
<tr>
<td width="50%">

### Core Experience

- **AI Chat** — Multi-thread conversations with any model
- **Agent Council** — Multiple agents working in parallel
- **Voice Calling** — Talk to your AI via phone or in-app
- **Coding Terminals** — Real PTY shells with tile grids
- **Actions** — Approve/cancel safe, inspectable commands

</td>
<td width="50%">

### Productivity

- **Tasks & Kanban** — Visual project management
- **Schedule** — Events, reminders, and deadlines
- **Memory** — Context that persists across sessions
- **Skills** — Loadable system prompts and behaviors
- **Quick Launcher** — Pinned apps and links

</td>
</tr>
<tr>
<td>

### AI Providers (21+)

- OpenAI, Anthropic, Google Gemini
- Groq, Cerebras, Fireworks (fast inference)
- OpenRouter, Replicate, Hugging Face (gateways)
- Azure OpenAI, AWS Bedrock (enterprise)
- Ollama for fully offline local models

</td>
<td>

### Developer Tools

- **Command Palette** — `Mod+K` for everything
- **Inspector** — Debug panel for diagnostics
- **Terminal Swarm** — Multi-terminal workflows
- **Custom Tools** — Import/export local templates
- **Offline Mode** — Work without internet

</td>
</tr>
</table>

---

## Model Support

VibeSpace is **BYOK-first** (Bring Your Own Key). Your keys stay on your device.

| Category | Providers |
|----------|-----------|
| **Major Cloud** | Anthropic · OpenAI · Google Gemini |
| **Fast Inference** | Groq · Cerebras · Fireworks · Together AI · DeepSeek · Mistral · Cohere · Perplexity · xAI |
| **Gateways** | OpenRouter · Replicate · Hugging Face |
| **Enterprise** | Azure OpenAI · AWS Bedrock |
| **Local** | Ollama (offline, no key needed) |

<details>
<summary>Free-tier quick start</summary>

The easiest path is a **Google Gemini API key** — no credit card required:

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create a key (30 seconds)
3. Paste it in Settings → Providers

That's it. You're ready to chat.

</details>

---

## Calling

VibeSpace isn't just a desktop window — **it's an AI you can talk to**.

| Method | Description | Status |
|--------|-------------|--------|
| **In-app call** | Tap the green call button, talk via WebRTC | Shipping |
| **Phone inbound** | Dial a Twilio number from any phone | Backend ready |
| **Phone outbound** | VibeSpace calls you for alerts/deadlines | API ready |

**Stack:** Twilio · LiveKit · Pipecat · FastAPI · Supabase

<details>
<summary>Privacy & security</summary>

- Read-only tools by default
- File reads happen through local bridge only
- Write/edit/delete requires confirmation
- PIN and caller allowlist for phone flow
- 30-day audit log retention

</details>

---

## Hotkeys

| Shortcut | Action |
|----------|--------|
| `Mod+K` | Command palette |
| `Mod+J` | VibeSpace assistant |
| `Mod+,` | Settings |
| `Mod+Space` | Voice push-to-talk |
| `Mod+Enter` | Send message |
| `Mod+B` | Toggle nav pane |
| `Mod+\` | Toggle inspector |
| `Mod+Shift+A` | Actions palette |
| `Mod+Shift+L` | Quick launcher |
| `Mod+Shift+T` | To-do drawer |

<details>
<summary>All hotkeys</summary>

| Shortcut | Action |
|----------|--------|
| `Mod+Shift+S` | Schedule modal |
| `Mod+Shift+D` / `F12` | Dev Console |
| `Mod+Shift+Enter` | Broadcast to council |
| `Mod+Shift+M` | Composer mic/STT |
| `Mod+Shift+F` | Chat fullscreen |
| `Mod+1..9` | Switch tabs |

</details>

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Desktop** | Tauri 2 · Rust · React · TypeScript · Vite |
| **UI** | Cozy paper theme · Warm copper accents · Keyboard-first |
| **AI** | 21 providers · MCP tools · Local Ollama |
| **Voice** | Twilio · LiveKit · Pipecat · FastAPI |
| **Storage** | Local-first · IndexedDB · Optional Supabase sync |

---

## Development

```bash
# Clone and install
git clone https://github.com/Cookie774-GameDev/VibeSpace.git
cd VibeSpace
npm install

# Run development server
npm run tauri:dev

# Build for release
npm run tauri:build
```

See [SETUP.md](SETUP.md) for prerequisites and environment setup.

---

## Documentation

| Document | Description |
|----------|-------------|
| [SETUP.md](SETUP.md) | Development environment setup |
| [DOWNLOAD.md](DOWNLOAD.md) | Manual downloads and checksums |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [COMPLETE_ARCHITECTURE.md](COMPLETE_ARCHITECTURE.md) | System architecture |
| [docs/](docs/) | Feature documentation |

---

## Links

| | |
|---|---|
| **Website** | [vibespaceos.com](https://vibespaceos.com) |
| **Releases** | [GitHub Releases](https://github.com/Cookie774-GameDev/VibeSpace/releases) |
| **Issues** | [GitHub Issues](https://github.com/Cookie774-GameDev/VibeSpace/issues) |

---

## License

[Apache 2.0](LICENSE) — Use it, modify it, ship it.

---

<p align="center">
  <sub>Built with 🧡 for vibe coders everywhere</sub>
</p>
