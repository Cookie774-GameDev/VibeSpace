# VibeSpace 0.1.29 — Plans Layout Fix

### Fixed
- **Settings → Plans**: Plan cards no longer overlap or clip text when all four tiers are shown inside the settings modal.
- **Plan headers**: Prices and badges ("Current Plan", "Popular", "Ultimate") stay fully visible instead of truncating at card edges.
- **Silent updater**: Release manifest URL now targets the `Jarivs-One` GitHub release channel that hosts signed Windows installers.

### Assets
- **Windows x64 NSIS installer**: `VibeSpace-0.1.29-Windows-x64.exe`
- SHA-256 checksums included in `SHA256SUMS.txt`

### Install (one line)
```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.ps1 | iex
```
