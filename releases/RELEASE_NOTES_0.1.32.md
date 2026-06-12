# VibeSpace 0.1.32 — Deepgram Voice, Verified Plugins & Chat /plug

### Added

- **Deepgram BYOK voice** — Settings → Voice → Deepgram; API key stored in OS keychain; Aura TTS for chat replies.
- **Admin section** — Settings → Admin for env/Supabase admins; unlimited cloud voice budget on edge functions.
- **112 verified plugins** — curated catalog with two-step connect (credentials + test); no placeholder entries.
- **Chat `/plug`** — attach connected plugins like `/terminal`; Jarvis recognizes plugin mentions.
- **Terminal approval** — bulk open, Claude, and OpenCode actions require Approve before execution.

### Fixed

- Plugin connection probes for Twilio, Stripe, Discord, Mailchimp, Deepgram, and Anthropic auth headers.

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### Assets

- **Windows x64 NSIS**: `VibeSpace_0.1.32_x64-setup.exe`
- **Silent updater**: `latest.json` on GitHub Releases
