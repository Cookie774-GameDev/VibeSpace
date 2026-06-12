# VibeSpace 0.1.36 — Branding, Terminal Polish & Startup Performance

### Features

- **VibeSpace icon suite** — regenerated favicon, taskbar, tray, and platform icons; embedded branding re-applies on show/focus
- **Install splash** — animated Nebula / Aurora / Prism themes during GitHub download (default: Aurora)
- **terminal.inspect** — drag a terminal into chat; Jarvis reads the captured transcript

### Fixes

- **Terminal pixelation** — bundled JetBrains Mono + Inter (CSP-safe); WebGL renderer at device pixel ratio
- **Terminal clear** — eraser confirm wipes xterm, PTY, and persisted scrollback
- **T-key font cycle** — wraps to Settings default size, not hardcoded 10px
- **Chat terminal attach** — correct event for inspect/summarize

### Performance

- Deferred non-critical store hydration on cold start
- Font-ready gate before xterm open (prevents overlapping glyphs in grids)

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

### Assets

- **Windows x64 NSIS**: `VibeSpace_0.1.36_x64-setup.exe`
- **Silent updater**: `latest.json` on GitHub Releases
