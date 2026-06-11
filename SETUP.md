# Jarvis - Setup Guide

How to run Jarvis V1 on your machine.

## Quick start (web only - no Rust required)

This runs the full UI in your browser. All core features work locally. Official installers include Jarvis Cloud config; source builds need maintainer env values only for cloud sync, billing, and Jarvis Call.

```powershell
# 1. Install Node 20+ if you don't have it
node --version  # should be >= 20

# 2. Install deps
cd path\to\Jarvis\app
npm install

# 3. Optional for source maintainers: copy env template and fill in app backend + AI keys
copy ..\.env.example .env.local
# End users of official releases do not need their own Supabase project.

# 4. Run
npm run jarvis
# Open http://localhost:5173
```

## Native desktop build (Tauri - Win/Mac)

The desktop binary requires Rust. Without Rust, the web version above is fully functional.

### 1. Install Rust

**Windows:**
1. Go to https://rustup.rs and download `rustup-init.exe`
2. Run it - choose "1) Proceed with installation" (default)
3. Restart your terminal so `cargo` is on PATH
4. Verify: `cargo --version` should print `cargo 1.78.0` or newer

**Mac:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo --version
```

### 2. Install Tauri prerequisites

**Windows:**
- Microsoft Visual Studio C++ Build Tools (download from https://visualstudio.microsoft.com/visual-cpp-build-tools/, select "Desktop development with C++")
- WebView2 (preinstalled on Windows 11; for Win10 download from https://developer.microsoft.com/microsoft-edge/webview2/)

**Mac:**
- Xcode Command Line Tools: `xcode-select --install`

### 3. Run Tauri dev

```powershell
cd path\to\Jarvis\app
npm run tauri:dev
```

First run downloads the Tauri Rust dependencies (~5-10 min on a fresh machine). Subsequent runs are fast.

### 4. Build a signed installer

```powershell
npm run tauri:build
```

Produces:
- **Windows:** `app/src-tauri/target/release/bundle/msi/*.msi` and `.exe` portable
- **Mac:** `app/src-tauri/target/release/bundle/dmg/*.dmg` and `.app`

For code-signing, Jarvis Call, account/admin setup, and production release gates, see `docs/09-jarvis-calling-account-release.md`.

## Jarvis Cloud app backend

Official VibeSpace installers are built with the app's Supabase project and call backend already configured. End users should not create or connect their own Supabase project.

Source maintainers or fork builders can wire a separate backend for development:

1. Create or select the app Supabase project.
2. In Project Settings -> API, copy:
   - **Project URL** -> `VITE_SUPABASE_URL`
   - **anon public** key -> `VITE_SUPABASE_ANON_KEY`
3. Paste into `app/.env.local`.
4. Run the database migrations from the repo root with `supabase db push` if you have the Supabase CLI, or apply the SQL files in `supabase/migrations/` from oldest to newest in the Supabase SQL editor.
5. Restart `npm run jarvis`.

## AI Provider keys (BYOK)

Three options:

1. **In-app:** Settings -> Providers -> paste your key. Stored in IndexedDB locally.
2. **Env file:** add to `app/.env.local` (see `.env.example`).
3. **Mock provider:** with no keys configured, Jarvis uses the built-in mock LLM that returns canned responses. Useful for UI development.

## Mobile (future)

Tauri 2 supports mobile (iOS + Android). Once V1 desktop is stable, mobile path is:
1. `npm install @tauri-apps/cli@latest` (already current)
2. `npx tauri ios init` / `npx tauri android init`
3. `npm run tauri ios dev` / `npm run tauri android dev`
4. Mobile push via APNs/FCM through Supabase Edge Functions (see `docs/02-system-architecture.md`).

## Troubleshooting

- **Vite can't find env vars:** they must be prefixed `VITE_` and live in `app/.env.local` (not the root `.env.example`).
- **Tauri build fails on Windows:** ensure Visual Studio C++ Build Tools are installed (above).
- **"command not found: tauri":** run `npm run tauri:dev` (not bare `tauri`); we use the local CLI from `@tauri-apps/cli`.
- **Database errors after schema change:** clear IndexedDB in DevTools -> Application -> Storage -> Clear site data.
