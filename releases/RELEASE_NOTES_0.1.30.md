# VibeSpace 0.1.30 — Voice, Chat Lifecycle & Security

### Added
- **Streaming voice** — AI replies speak incrementally while tokens stream (Kokoro or system fallback).
- **Unified voice router** — one TTS path for Settings, voice panel, and chat runtime.
- **Chat lifecycle** — an active conversation is always ready on boot.
- **Plugins** — activation flow, provider registry, curated Ollama catalog.
- **Landing** — VibeSpace marketing site (`landing/`).
- **Security** — strict Tauri CSP; production builds cannot use blanket admin bypass flags.

### Improved
- Debounced UI state persistence; Ollama install hardening; real provider usage in Settings.

### Assets
- **Windows x64 NSIS installer**: `Jarvis-One-0.1.30-Windows-x64.exe`
- **Silent updater**: `latest.json` on GitHub Releases

### Install (one line)
```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.ps1 | iex
```
