# Codex Command Center Tool Integration Design

## Objective

Expose the existing standalone **Codex Command Center** Windows application as a preloaded
VibeSpace Tool. The card must report verified local state and support download, installation,
launch, cancellation, and retry without presenting an unavailable release as installed.

## Architecture

VibeSpace owns only the installation bridge and product card. The Command Center remains a
separate, lightweight Tauri application and source of truth for terminal control, schedules,
progress, and recovery.

The renderer consumes a small lifecycle adapter:

- `inspect` searches only supported per-user installation paths and VibeSpace's private
  tool-download directory.
- `download` accepts an HTTPS release artifact URL plus mandatory SHA-256, writes a `.part`
  file under the VibeSpace app-data downloads directory, emits bounded progress, verifies the
  digest, and atomically promotes the installer.
- `cancel` sets an in-memory cancellation token checked between streamed chunks.
- `install` starts only the verified installer after explicit user interaction.
- `launch` starts only a detected installed executable.

Production release metadata comes from build-time `VITE_CODEX_COMMAND_CENTER_DOWNLOAD_URL`,
`VITE_CODEX_COMMAND_CENTER_DOWNLOAD_SHA256`, and
`VITE_CODEX_COMMAND_CENTER_DOWNLOAD_VERSION`. When this authority is absent, the card reports
that the official download is not configured; it never guesses a URL or hash. Development may
use the existing locally built installer when present.

## UX

The preloaded Tools section contains a **Codex Command Center** card beside Open in Terminal.
It shows `Not installed`, `Downloading`, `Ready to install`, `Installed`, or `Unavailable`,
plus version, transferred bytes, retry/cancel, and the one safe primary action applicable to
the current state. Installation and launch are never automatic.

## Security and performance

- No arbitrary executable path or unverified artifact may be launched.
- Download URLs require HTTPS and the exact pinned SHA-256 supplied by release authority.
- Installer integrity requires an exact SHA-256.
- Files remain in VibeSpace app data; partial files are removed after cancellation/failure.
- No polling or background download runs while Tools is closed.
- No credentials, environment values, or command lines are logged.

## Verification

Unit tests cover lifecycle transitions, missing release authority, progress, cancellation,
digest mismatch, installed state, and launch availability. The VibeSpace component test covers
the preloaded card and honest actions. Rust tests cover URL, digest, and executable-path
validation. TypeScript, Rust formatting/checking, and scoped diff checks close the slice.
