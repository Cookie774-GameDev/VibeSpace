# Releases

This directory stages installers built locally before they get uploaded to GitHub Releases. Binaries and generated release metadata are gitignored; only `README.md` and per-version `RELEASE_NOTES*.md` files are tracked.

## Layout

```text
releases/
  README.md                         this file (tracked)
  .gitignore                        binary blocklist (tracked)
  SHA256SUMS.txt                    generated hashes (gitignored)
  latest.json                       Tauri updater manifest (gitignored)
  Jarvis One_0.1.17_x64-setup.exe   Tauri NSIS installer name (gitignored)
  Jarvis One_0.1.17_x64_en-US.msi   Tauri MSI installer name (gitignored)
  Jarvis-One-0.1.17-Windows-x64.exe friendly NSIS copy (gitignored)
  Jarvis-One-0.1.17-Windows-x64.msi friendly MSI copy (gitignored)
```

## Building Windows Installers

From the repo root:

```powershell
npm run release:windows
```

That runs `scripts/release-windows.ps1`, which:

1. Runs `npm run tauri:build`.
2. Copies Tauri bundle outputs into `releases/`.
3. Builds `releases/latest.json` for `tauri-plugin-updater`.
4. Computes SHA-256 hashes into `releases/SHA256SUMS.txt`.
5. Prints the staged file paths and sizes.

If you already have a fresh build and only need to re-stage:

```powershell
npm run release:stage
```

## Publishing To GitHub Releases

The canonical remote is `Cookie774-GameDev/Jarivs-One`.

```powershell
# 1. Tag the release.
git tag v0.1.17
git push origin v0.1.17

# 2. Upload binaries via gh CLI when publishing manually.
gh release create v0.1.17 `
  releases\Jarvis*0.1.17* `
  releases\latest.json `
  releases\SHA256SUMS.txt `
  --title "Jarvis One 0.1.17" `
  --notes-file releases\RELEASE_NOTES_0.1.17.md
```

After publishing, end users can install with one line:

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.sh | bash
```

## Filename Rules

- **Tauri names** like `Jarvis One_<version>_x64-setup.exe` are what the installers and updater resolve first.
- **Friendly names** like `Jarvis-One-<version>-Windows-x64.exe` are for direct-download pages and humans.

Keep both names when staging Windows releases so one-line installers, direct downloads, and silent updates all keep working.

Do not commit `latest.json` or `SHA256SUMS.txt`; they are regenerated for the exact signed artifacts uploaded to a GitHub Release. A stale manifest can make silent updates fail signature validation.
