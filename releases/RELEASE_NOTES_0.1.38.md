# VibeSpace 0.1.38 — Global Dictation, Jarvis Control, Subscription Polish

Consolidates work from parallel agents: system-wide speech-to-text, full Jarvis app-command awareness, subscription marketing alignment, and voice/terminal refinements.

### Features

- **Global dictation** — `Ctrl+CapsLock` toggles a floating mic; Deepgram transcribes and pastes into the focused app (clipboard restored).
- **Jarvis app control** — `voice.configure`, `workflow.run`, and settings-tab actions in the action catalogue.
- **`/skills` in chat** — slash picker with arrow-key navigation.
- **Subscription copy** — phone minutes headline + in-app cloud voice secondary on Plans, landing, README.

### Fixes

- Slash attachments (`/terminal`, `/plug`, `/contextmap`) apply correctly on send.
- Voice preview/routing and streaming session cleanup.

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### Assets

- **Windows x64 NSIS**: `VibeSpace_0.1.38_x64-setup.exe`
- **Silent updater**: `latest.json` on GitHub Releases
