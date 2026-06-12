# VibeSpace 0.1.35 — Subscription v2, Terminal Fixes & Interactive Site

### Features

- **Subscription plan v2** — DeepSeek V4 Flash chat, SMS sending, triple usage windows (5-hour / weekly / monthly)
- **Spark / Orbit / Nova / Singularity** tiers with 30-day Stripe cycles, no credit rollover
- **Settings → Cloud Voice** — unified usage meters for credits, minutes, and texts
- **System voice engine** — cloud icon with BYOK for OpenAI/Deepgram; included usage for subscribers

### Fixes

- **Terminal persistence** — scrollback restores correctly; viewport pins to bottom after reload
- **Agent prompts** — spawned CLIs receive agent + system prompts via `AGENTS.md` and `JARVIS_*` env vars
- **ConPTY restore** — cursor-home/CUP sequences filtered during scrollback replay

### Website

- **vibespaceos.com** — interactive app demo (chat with Jarvis, terminal panes, voice panel)
- Liquid-glass theme, real tier names, README screenshots

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### Assets

- **Windows x64 NSIS**: `VibeSpace_0.1.35_x64-setup.exe`
- **Silent updater**: `latest.json` on GitHub Releases
