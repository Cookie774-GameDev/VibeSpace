# VibeSpace 0.1.44 — Terminals, voice turn-taking, and provider dropdowns

## Highlights

- **Terminal reliability** — scrollback isolation, route-switch stability, and agent prompt delivery to CLIs.
- **Hands-free voice** — turn end/cancel phrases; session-gated TTS; wake word only in hands-free mode.
- **Provider/model dropdowns** — registry-driven model picks with API-key gating (Settings → Hive, Providers, agents).
- **Model selection persistence** — selected model stays visible and consistent across chat and Hive.
- **Multi-agent coordination** — ledger, rules, and terminal agent architecture docs.

## Update behavior

Ship **0.1.44** via GitHub Release + `releases/channel.json` promote after CI builds Windows assets.

## Install / update

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

## Assets

- **Windows x64 NSIS**: `VibeSpace-0.1.44-Windows-x64.exe` (from CI release workflow)
- **Updater channel**: `releases/channel.json` (promoted after publish)
