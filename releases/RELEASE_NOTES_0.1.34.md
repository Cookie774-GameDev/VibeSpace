# VibeSpace 0.1.34 — Deepgram Launch Promo & Voice Security

### Features

- **Deepgram launch promo** — one-time cloud voice bonus per plan from a **$1,000 FCFS pool**:
  - Free: 1 min | Starter: 30 min | Pro: 90 min | Ultra: 3 hr
- **Auto-shutdown** at 90% pool spend ($900); promo off → normal billing resumes
- **Settings → Cloud Voice** shows promo remaining; Deepgram auto-selected when promo available

### Security

- Fail-closed rate limits on `tts-speak` and `message-complete`
- Free tier blocked from subscription budget after promo exhaustion
- Promo settlement caps, admin enumeration fix, RPC hardening

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### Assets

- **Windows x64 NSIS**: `VibeSpace_0.1.34_x64-setup.exe`
- **Silent updater**: `latest.json` on GitHub Releases
