# VibeSpace 0.1.41 — Agent fixes (Vibe Hive rolled back)

## Highlights

- **Rollback** — v0.1.40 accidentally shipped Vibe Hive / VibeBench before ready. This release removes that code and restores the updater channel to agent-only fixes.
- **Model picker** — keyboard-navigable typeahead for choosing provider + model in chat.
- **Providers** — OpenRouter, DeepSeek, Mistral, Together, xAI routing improvements.
- **Terminals** — geometry, restore session, escape handling, transcript store, agent prompt delivery fixes.

## Install / update

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

## Assets

- **Windows x64 NSIS**: `VibeSpace-0.1.41-Windows-x64.exe`
- **Updater channel**: `releases/channel.json`
