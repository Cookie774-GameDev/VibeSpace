# Trust on Windows (free steps)

VibeSpace is open source. Windows and antivirus tools often warn on **new, unsigned** desktop apps even when the build is clean. These steps improve credibility **without changing the app UI or features**.

## What users can do (free)

1. **Download only from official links**
   - [GitHub Releases](https://github.com/Cookie774-GameDev/VibeSpace/releases)
   - [vibespaceos.com](https://vibespaceos.com/)
   - One-line installer: `install/install.ps1` on the `main` branch

2. **Verify the file hash before running**
   - Each release ships `SHA256SUMS.txt` on the GitHub release page.
   - PowerShell:

     ```powershell
     Get-FileHash -Algorithm SHA256 '.\VibeSpace_0.1.44_x64-setup.exe'
     ```

   - Compare the output to the line in `SHA256SUMS.txt` for that filename.

3. **Inspect the source**
   - Full repo: https://github.com/Cookie774-GameDev/VibeSpace
   - CI builds releases in `.github/workflows/release.yml` (public logs).

4. **If SmartScreen appears**
   - Click **More info** → **Run anyway** only after verifying the hash.
   - This is normal for new indie apps until Windows builds reputation.

5. **Corporate / strict AV (Bitdefender, etc.)**
   - IT can allowlist the installer path or publisher once verified.
   - Share the GitHub release URL and SHA-256 hash with your admin.

## What maintainers can do (free)

| Action | Cost | Effect |
| --- | --- | --- |
| Publish releases only from GitHub Actions | $0 | Reproducible, public build trail |
| Attach `SHA256SUMS.txt` to every release | $0 | Users can verify integrity |
| Sign updater artifacts (Tauri `.sig`) | $0 | Tamper-proof in-app updates |
| Set `publisher` / `copyright` in `tauri.conf.json` | $0 | Shows **VibeSpace** in Add/Remove Programs |
| Submit each release to [VirusTotal](https://www.virustotal.com/) | $0 | Public “clean scan” link to share |
| File false-positive reports with AV vendors | $0 | Reduces bogus blocks over time |
| Keep `SECURITY.md` and issue tracker public | $0 | Standard open-source trust signal |

## What still needs a paid cert (later)

**Authenticode code signing** (~$200–500/year) is the step that makes Windows show a **verified publisher** on the installer. It does not change VibeSpace features — only how Windows labels the `.exe`.

Updater signing (`jarvis-plain.key`) and Windows code signing are **different keys**:

- **Updater `.sig`** → in-app auto-update trust
- **Authenticode** → “Unknown publisher” / SmartScreen on first install

## VirusTotal workflow (maintainers)

After each Windows release is published:

1. Download `VibeSpace-<version>-Windows-x64.exe` from the release page.
2. Upload at https://www.virustotal.com/
3. When clean, paste the analysis link in the release notes or website download page.

No app code changes required.
