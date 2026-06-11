# VibeSpace 0.1.27 — Production Build Reliability & Terminal Launcher Fix

### Fixed
- **Production build path**: `tauri build` is now used instead of raw `cargo build --release`, ensuring the NSIS installer bundles frontend assets correctly. This fixes the `localhost refused to connect` / `ERR_CONNECTION_REFUSED` error that occurred when the installed executable was an unbundled raw binary.
- **Installed app**: The installer now extracts the full bundled application with embedded frontend resources instead of only the bare executable.
- **Global `Jarvis` terminal command**: Fixed the broken `$pythonCommand[0]` logic that caused a `"p" is not recognized` error. Replaced with safe Python detection (`py -3`, `python`, `python3`).
- **Boot animation path**: The `Jarvis` command now correctly points to the cyberpunk boot animation script.
- **Argument forwarding**: `Jarvis.ps1` now forwards arguments (including `--help`) to the boot script without recursion.

### Improved
- **Launch-time guardrails** in terminal launcher scripts: detect stale executables, missing bundled assets, failed updates, port conflicts, and dev-server readiness.
- **Structured launch logging**: mode (production/dev), exe path, version, build timestamp, server readiness, release version.
- **Update backup/restore**: Before updating, the launcher backs up the current `jarvis.exe`. If the update produces a broken build (< 9 MB), the previous working build is restored automatically.
- **`Jarvis --help`**: Clean help output explaining the command.

### Assets
- **Windows x64 NSIS installer**: `VibeSpace-0.1.27-Windows-x64.exe`
- SHA-256 checksums included in `SHA256SUMS.txt`

### Install (one line)
```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```
