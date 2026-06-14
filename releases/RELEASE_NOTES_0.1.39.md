# VibeSpace 0.1.39 — Rollback Channel, AI Routing, Installer Fix

## Highlights

- **Rollback-safe updates** — `releases/channel.json` on `main` controls which version all clients install. Run `scripts/rollback-update.ps1 -Version 0.1.38 -Push` to roll everyone back.
- **AI routing** — Ollama fallbacks, agent provider options, improved runtime and router tests.
- **Plugins** — Context injection and UI polish.
- **Install fix** — `irm … | iex` works again (PowerShell `$ESC[…]` parser bug fixed).

## Install / update

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

## Rollback (maintainers)

```powershell
.\scripts\rollback-update.ps1 -Version 0.1.38 -Push
```

## Assets

- **Windows x64 NSIS**: `VibeSpace-0.1.39-Windows-x64.exe`
- **Updater channel**: `releases/channel.json` (primary)
- **Archived manifests**: `releases/manifests/v0.1.39.json`
