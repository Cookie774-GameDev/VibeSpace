# Download VibeSpace

Install VibeSpace like a normal desktop app. The one-line installers pull the latest GitHub Release from `Cookie774-GameDev/VibeSpace`.

| Platform | Format | One-line install |
| --- | --- | --- |
| Windows 10/11 | NSIS `.exe` or MSI | `irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 \| iex` |
| macOS 12+ | DMG | `curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh \| bash` |
| Linux | `.deb`, `.rpm`, or AppImage | `curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh \| bash` |

Current staged release: `v0.1.31`. macOS and Linux filenames can vary by Tauri target, so `install/install.sh` resolves matching release assets from GitHub before falling back to the standard VibeSpace filename patterns.

## Release Status

The one-line commands install the newest published GitHub Release. If the [Releases page] has no installer assets yet, the commands stop safely and explain that a release must be published first. Use the source-build path below for local development until production installers are uploaded.

Safe dry-run checks:

```powershell
$env:JARVIS_DRYRUN = "1"
$env:JARVIS_DOWNLOAD_DIR = "D:\Jarvis-Tests\downloads"
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```

```bash
JARVIS_DRYRUN=1 JARVIS_DOWNLOAD_DIR="$HOME/Jarvis-Tests/downloads" curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.sh | bash
```

The default one-line installers now use the user-scope path with no installer UI: Windows uses silent NSIS, macOS copies into `~/Applications`, and Linux installs an AppImage under `~/.local/bin/jarvis`. Set `JARVIS_SYSTEM=1` for system-wide macOS/Linux installs, or `$env:JARVIS_SILENT="0"` on Windows to force the interactive UI.

The installer also adds a per-user `Jarvis` terminal command. Existing desktop installs repair this command automatically when the updated app starts. Open a new terminal after installation or update, then run `Jarvis`.

Set `JARVIS_DOWNLOAD_DIR` when validating installers so all staged downloads stay in a known folder. Set `JARVIS_KEEP_DOWNLOAD=1` if you want the downloaded installer kept after a normal install for audit or checksum review.

## Direct Download

Grab installers from the [Releases page] and compare them against `SHA256SUMS.txt` before running.

[Releases page]: https://github.com/Cookie774-GameDev/VibeSpace/releases

```text
Windows:  VibeSpace_0.1.31_x64-setup.exe
Windows:  VibeSpace_0.1.31_x64_en-US.msi
Windows:  VibeSpace-0.1.31-Windows-x64.exe
Windows:  VibeSpace-0.1.31-Windows-x64.msi
macOS:    VibeSpace_0.1.31_aarch64.dmg
macOS:    VibeSpace_0.1.31_x64.dmg
Linux:    VibeSpace_0.1.31_amd64.deb
Linux:    VibeSpace-0.1.31-1.x86_64.rpm
Linux:    VibeSpace_0.1.31_amd64.AppImage
```

```powershell
Get-FileHash -Algorithm SHA256 '.\VibeSpace_0.1.31_x64-setup.exe'
```

```bash
sha256sum 'VibeSpace_0.1.31_amd64.deb'
```

## What Gets Installed

- Windows: installs per-user under `%LOCALAPPDATA%\Programs\VibeSpace\` and adds Start Menu shortcuts.
- macOS: copies `VibeSpace.app` into `~/Applications` by default, or `/Applications` when `JARVIS_SYSTEM=1`.
- Linux: installs `jarvis` into `~/.local/bin` by default via AppImage, or uses native system packages/AppImage prefixes when explicitly requested.

VibeSpace is local-first. External services are optional and only used for enabled features such as cloud sync, hosted models, Stripe billing, and Jarvis Call.

## After Installing

1. Launch from Start Menu, `/Applications/VibeSpace`, or your Linux app menu.
2. Sign in only if you need cloud sync, hosted access, Stripe billing, or Jarvis Call.
3. Add BYOK provider keys in Settings -> Providers.
4. Useful hotkeys:
   - `Ctrl/Cmd + K` command palette
   - `Ctrl/Cmd + Space` voice push-to-talk
   - `Ctrl/Cmd + Shift + A` actions palette
   - `Shift + Tab` Jarvis wake bubble

## Building From Source

```powershell
git clone https://github.com/Cookie774-GameDev/VibeSpace.git
cd VibeSpace
npm install
npm run release:windows
```

`release:windows` requires a Tauri updater key outside the repository. Set
`TAURI_SIGNING_PRIVATE_KEY_PATH` to the private key and keep its matching public
key at the same path with a `.pub` suffix. The script rejects a pair that does
not match `app/src-tauri/tauri.conf.json`.

Tauri updater signatures protect silent updates from tampering. Public Windows
distribution additionally requires Authenticode credentials through
`WINDOWS_CERT_BASE64` or `WINDOWS_CERT_THUMBPRINT` to avoid shipping an
untrusted executable.

For cross-platform builds:

```powershell
npm --prefix app run tauri:build
```

Prerequisites: Node 20+, Rust 1.78+, and the [Tauri prerequisites] for your OS.

[Tauri prerequisites]: https://tauri.app/start/prerequisites/

## Updates

Built-in auto-update uses the signed Tauri updater manifest at `releases/latest.json`. Jarvis warns before background install at 1 hour, 30 minutes, and 5 minutes, then offers Update Now, Snooze 1 Hour, or Update Later.

Manual installers replace the previous version in place and preserve user data:

- Windows: `%APPDATA%\VibeSpace`
- macOS: `~/Library/Application Support/VibeSpace`
- Linux: `~/.config/VibeSpace`

## Troubleshooting

**Windows protected your PC / Application Control blocked this file.**
Use a trusted Authenticode-signed build or endpoint allowlisting. If policy allows, click More info -> Run anyway. Always verify SHA-256 before running.

**macOS says the developer cannot be verified.**
Right-click `VibeSpace.app` in Finder -> Open -> Open. macOS remembers that trust for future launches. Production distribution should use Developer ID signing and notarization.

**Linux AppImage does not start.**
Run `chmod +x 'VibeSpace_'*.AppImage`. Some distros also need `libfuse2`.

Open an [issue] with the installer output and `jarvis --version` if problems persist.

[issue]: https://github.com/Cookie774-GameDev/VibeSpace/issues/new

## Privacy

- Chats, tasks, memories, and settings live locally by default.
- Cloud sync is opt-in.
- Telemetry is off by default.
- BYOK keys stay local unless a hosted-BYOK feature is explicitly enabled.

Architecture details live in [`docs/02-system-architecture.md`](docs/02-system-architecture.md).
