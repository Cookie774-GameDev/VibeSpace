# VibeSpace 0.1.42 — Hive, Ultra tiers, and agent fixes

## Highlights

- **Hive re-shipped** — Fast / Balanced / Quality / High multi-model chat pipelines with collapsible step timeline.
- **Slash overrides** — `/hive quality code …` and `/stack` aliases per message.
- **Settings → Hive** — preset picker and custom step editor.
- **Ultra + Supernova** — expanded subscription tiers with AI credit bucket (migration `0026`).
- **Hosted Hive** — `stack-complete` edge function for subscribed users without BYOK keys.
- **Voice + terminals** — voiceRouter unification, streaming voice fixes, terminal prompt delivery.

## Update behavior

This release updates the production channel to **0.1.42**. It is **not** a forced update — clients on **0.1.41** discover the new build on the normal Tauri updater check at app open.

## Install / update

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

## Assets

- **Windows x64 NSIS**: `VibeSpace-0.1.42-Windows-x64.exe`
- **Updater channel**: `releases/channel.json`
