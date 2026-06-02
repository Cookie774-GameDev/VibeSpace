# Download Jarvis

Get Jarvis on your machine. No "clone the repo" or "open a specific
folder" needed — just install it like any other desktop app.

| Platform           | Format                    | One-line install                                                                                                                                                       |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows 10/11**  | NSIS `.exe` or MSI        | `irm https://raw.githubusercontent.com/Cookie774-GameDev/jarvis-one/main/install/install.ps1 \| iex` |
| **macOS 12+**      | DMG                       | `curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/jarvis-one/main/install/install.sh \| bash` |
| **Linux (deb/rpm/AppImage)** | auto-detected | `curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/jarvis-one/main/install/install.sh \| bash` |

> **Heads-up.** Until the first GitHub Release is cut (`v0.1.5`), the
> one-liners above will fall back to "no public release yet". Use the
> [direct download](#direct-download) section in the meantime — same
> installers, just hand-fetched.

## Direct download

If you want a manual download (or you're behind a proxy that blocks the
script), grab the installer from the [Releases page] and run it.

[Releases page]: https://github.com/Cookie774-GameDev/jarvis-one/releases

```
Windows:  Jarvis_0.1.5_x64-setup.exe   ← recommended (small, friendly)
Windows:  Jarvis_0.1.5_x64_en-US.msi   ← for Group-Policy / IT deploys
macOS:    Jarvis_0.1.5_aarch64.dmg     ← Apple Silicon
macOS:    Jarvis_0.1.5_x64.dmg         ← Intel
Linux:    jarvis_0.1.5_amd64.deb       ← Debian/Ubuntu/Mint/Pop
Linux:    jarvis-0.1.5-1.x86_64.rpm    ← Fedora/RHEL/openSUSE
Linux:    jarvis_0.1.5_amd64.AppImage  ← any modern distro, no install
```

Each release ships with `SHA256SUMS.txt` so you can verify the file
before running it:

```powershell
# Windows
Get-FileHash -Algorithm SHA256 .\Jarvis_0.1.5_x64-setup.exe
```

```bash
# macOS / Linux
sha256sum Jarvis_0.1.5_amd64.deb
```

Compare the hash to the entry in `SHA256SUMS.txt`. If they match, the
file is the same one we built.

## What gets installed

- **Windows**: installs to `%LOCALAPPDATA%\Programs\Jarvis\` and adds a
  Start Menu shortcut. Uses Microsoft Edge WebView2 (preinstalled on
  Windows 11; auto-bootstraps on Windows 10).
- **macOS**: copies `Jarvis.app` into `/Applications/`. The DMG is
  drag-and-drop. First launch asks Gatekeeper to trust the binary — if
  you used the installer script that's already taken care of.
- **Linux**:
  - `.deb` / `.rpm` install through your package manager and add a
    desktop entry under "Productivity".
  - `.AppImage` is a single file you can put anywhere and run. The
    installer script puts it at `/usr/local/bin/jarvis` and registers a
    desktop entry pointing at it.

Every install pulls a single binary plus a few KB of icons and metadata.
No external services run on your machine — Jarvis is local-first.

## After installing

1. **Launch** — Start Menu (Windows), `/Applications/Jarvis` (macOS),
   apps menu (Linux).
2. **Sign in** (optional) — only needed for cloud sync, hosted models,
   or Jarvis Call. Free tier works fully offline with your own API keys.
3. **Add a provider key** — Settings → Providers. Free Gemini works
   without a card. Or supply your own Anthropic / OpenAI / DeepSeek /
   Groq / OpenRouter key.
4. **Hotkeys**:
   - `Ctrl/Cmd + K` — command palette
   - `Ctrl/Cmd + Space` — voice push-to-talk
   - `Ctrl/Cmd + Shift + A` — actions palette

## Building from source

If you'd rather build the installer yourself (security review, custom
fork, or your distro doesn't have a pre-built `.deb`):

```powershell
git clone https://github.com/Cookie774-GameDev/jarvis-one.git
cd jarvis
npm install
npm run release:windows         # Windows: produces releases\Jarvis-*.exe + .msi
# or
npm --prefix app run tauri:build  # any platform: writes to app\src-tauri\target\release\bundle\
```

Prerequisites: Node 20+, Rust 1.78+, and the [Tauri prerequisites] for
your OS.

[Tauri prerequisites]: https://tauri.app/start/prerequisites/

## Updates

Built-in auto-update is on the roadmap. For now, re-run the same
one-liner installer or download the new `setup.exe` / `.dmg` / `.deb`
and run it on top — installers replace the previous version in place
and preserve user data (`%APPDATA%\Jarvis` on Windows,
`~/Library/Application Support/Jarvis` on macOS,
`~/.config/Jarvis` on Linux).

## Troubleshooting

**Windows: "Windows protected your PC" dialog.**
Click "More info" → "Run anyway". Until the binary is Authenticode-signed
this dialog appears on first launch. Verifying the SHA-256 hash before
running is the cheapest way to stay safe.

**macOS: "Jarvis can't be opened because the developer cannot be verified".**
Right-click `Jarvis.app` in Finder → Open → Open. macOS remembers the
trust for future launches. The install script removes the quarantine
flag automatically.

**Linux: AppImage doesn't start.**
Make sure it's executable: `chmod +x Jarvis_*.AppImage`. On some distros
you also need `libfuse2` (`sudo apt install libfuse2`).

**Anything else.**
Open an [issue] and include the full output of:

```
jarvis --version
```

[issue]: https://github.com/Cookie774-GameDev/jarvis-one/issues/new

## Privacy

- All chats, tasks, memories, and settings live on your machine in a
  local SQLite/Dexie store.
- Cloud sync is opt-in (per-feature) and uses end-to-end-encrypted
  Supabase as the backend.
- Telemetry is **off by default**. Enable in Settings → Privacy if you
  want to send anonymous usage data.
- BYOK API keys are stored encrypted in OS keychain (DPAPI / Keychain /
  Secret Service). They never leave your machine unless you explicitly
  enable hosted-BYOK mode.

The full data-handling policy is in [`docs/02-system-architecture.md`].

[`docs/02-system-architecture.md`]: docs/02-system-architecture.md
