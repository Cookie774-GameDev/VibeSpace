# VibeSpace 0.1.37 — Auth OTP, Terminal Teardown, Voice Polish

### Features

- **Email OTP signup** — 6-digit code verification in Settings → Account
- **Supabase email templates** — confirmation and magic-link codes with `{{ .Token }}`

### Fixes

- **Terminal WebGL crash** — safe teardown on pane close (`onRequestRedraw` fix)
- **Terminal escape filtering** — cleaner ConPTY restore
- **Voice routing** — preview/stop sync and streaming session cleanup

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### Assets

- **Windows x64 NSIS**: `VibeSpace_0.1.37_x64-setup.exe`
- **Silent updater**: `latest.json` on GitHub Releases
