# Plan B1 — Security Hardening + Installable App

> Wave: B1 (after A0 baseline, before any feature shell work).
> Owner role: shell/platform engineer. Touches `src-tauri/`, `index.html`, CI, and one frontend store.
> Outcome: Jarvis is downloadable as MSI/NSIS/DEB/RPM/AppImage/DMG, auto-updates over a signed channel, and all V1 known security holes are closed or explicitly accepted with mitigations.

---

## 1. Security audit findings

The audit ran against the `app/` workspace at the v2 baseline. Severities follow the OWASP-style ladder: Critical = exploitable in default config; High = exploitable with realistic conditions; Medium = defense-in-depth gap; Low = hygiene.

| Severity | Finding | File:Line | Fix | Wave |
| --- | --- | --- | --- | --- |
| Critical | `csp: null` disables the WebView Content-Security-Policy entirely. Any XSS (markdown render, model output, deep link reflection) executes with full privileges, including IPC `invoke()`. | `src-tauri/tauri.conf.json:28` | Replace with the strict CSP string in §1.1. Tauri merges its IPC `ipc:` / `https://ipc.localhost` automatically when the policy is non-null. | E1 |
| High | BYOK provider API keys (Anthropic, OpenAI, Gemini, OpenRouter, etc.) are persisted in `localStorage` via `zustand-persist` under `jarvis-auth.apiKeys`. WebView storage is disk-readable and not encrypted at rest. | `src/stores/auth.ts:46-90` | Move secrets to OS keystore. New `secrets.ts` Tauri commands wrap `keyring-rs` (Win Credential Manager / macOS Keychain / Secret Service). Tauri side: `tauri-plugin-stronghold` for an encrypted file vault as a portable fallback. Web build: keep localStorage but render a "Browser mode — keys stored unencrypted" warning in Settings. | E1 |
| High | `dangerouslyAllowBrowser: true` (Anthropic SDK) ships the user's key inside the WebView. With CSP null this is a Critical too; once CSP is in place it stays a known BYOK risk. | `src/lib/providers/anthropic.ts:96` (per V1 plan) | Document risk in `docs/security.md`. Roadmap: Phase 3 introduces an HTTPS sidecar (Node runtime) that proxies provider calls so the secret never enters the WebView address space. | E2 |
| High | No `Cargo.lock` committed. Reproducible Rust builds and CI auditing both require a pinned lockfile. | `.gitignore:17` | Remove `src-tauri/Cargo.lock` from `.gitignore`, run `cargo generate-lockfile`, commit the result. | E1 |
| Medium | Capabilities use coarse `core:default` plus six other category defaults. Any future plugin gets implicit access. | `src-tauri/capabilities/default.json:6-17` | Tighten to the explicit list in §4.3. Split PiP and (future) terminal windows into their own capability files. | E2 |
| Medium | Inter + JetBrains Mono pulled from `fonts.googleapis.com` / `fonts.gstatic.com`. CDN dependency, privacy leak (Google sees every launch), CSP attack surface. | `index.html:9-14` | Self-host via `@fontsource/inter` and `@fontsource/jetbrains-mono`. Drop both `<link>` preconnects. Allows tightening `font-src` to `'self'`. | E2 |
| Medium | No SRI on any external resource. Once fonts move local this becomes a non-issue; document the rule for future externals. | `index.html` | Hard rule in `docs/security.md`: no external `<script>` or `<link rel=stylesheet>` without SHA-384 SRI hash. CI lint script greps for non-`'self'` `src=` URLs. | E3 |
| Medium | No `npm audit` / `cargo audit` in CI. Vulnerable transitive dep slips in unnoticed. | (missing) `.github/workflows/ci.yml` | Add audit jobs per §3.2. `npm audit --omit=dev --audit-level=high` blocks; `cargo audit` warns initially, blocks after the first clean baseline. | E2 |
| Medium | Tauri shell plugin grants `shell:allow-open`. Default scope allows `http`, `https`, `mailto`, `tel`. Verify no `shell:execute` ever sneaks in — a malicious deep link could otherwise call `cmd.exe`. | `src-tauri/capabilities/default.json:15` | Keep `shell:allow-open` but explicitly deny `shell:allow-execute` / `shell:allow-spawn` via comment + CI grep. Terminal subsystem (Planner C) ships its own `pty_*` commands; never use the shell plugin. | E2 |
| Low | No deep-link URL handler validation. `jarvis://...` payloads will hit the webview unchecked. | not yet implemented | Validation function in `src-tauri/src/deep_link.rs`: scheme allowlist (`jarvis://`), action allowlist (`open-task`, `open-chat`, `oauth-callback`), param charset, length cap (8192). Emit `deep-link` event only on success; log + drop otherwise. | E3 |
| Low | Webview `withGlobalTauri: false`. This is the secure default; document why so it stays. | `src-tauri/tauri.conf.json:13` | Add comment block + an entry in `docs/security.md`: leaks `__TAURI__` to userland JS, removes the IPC isolation boundary. Never re-enable. | E1 |
| Low | Updater not configured. Users would need to redownload to ship a security fix. | (missing) | Wire `tauri-plugin-updater` per §2.4. Generate minisign keypair, store private key in `JARVIS_TAURI_PRIVATE_KEY` GitHub secret, public key in `tauri.conf.json`. Manifest lives at `https://github.com/anomalyco/jarvis/releases/latest/download/latest.json`. | E2 |
| Low | `greet` and `app_version` commands accept no untrusted input today. Any future command needs explicit input validation. | `src-tauri/src/lib.rs:40-51` | Coding rule documented in `docs/security.md`: every `#[tauri::command]` taking string input must validate length, charset, and (if a path) canonicalise + verify it stays under an allowed scope. Add a `validate_path()` helper. | E3 |
| Low | Markdown renderer must not pass user content through `dangerouslySetInnerHTML` without sanitisation. | `src/components/chat/MessageBubble.tsx` (per V1 plan) | Confirm renderer uses `react-markdown` + `remark-gfm` + `rehype-sanitize` (allowlist schema). No raw HTML mode. CI grep blocks `dangerouslySetInnerHTML`. | E3 |
| Low | API keys could end up in console logs or telemetry. | global | Add a redaction helper `redact(s: string): string` that masks anything matching `sk-[A-Za-z0-9-_]{20,}` / `AIza[0-9A-Za-z-_]{35}` / `xoxb-...`. Wrap `console.error/warn` overrides in dev. CI grep blocks `console.log(.*api[Kk]ey)`. | E3 |
| Low | `.env.example` clean. `.env.local` gitignored. Confirm no other env file paths commit secrets. | `.gitignore:21-27` | Already correct. Add a CI gitleaks step (`zricethezav/gitleaks-action@v2`) for belt-and-braces. | E2 |
| Low | Single instance not enforced. Two Jarvis processes can race on the SQLite DB, deep-link routing, and global hotkey. | not yet implemented | Add `tauri-plugin-single-instance` per §4.2. Second instance focuses the existing window and forwards its argv (deep links, file opens). | E1 |
| Low | Window state not persisted. Every launch reverts to 1280×820 centred. UX nit, not security, but tracked alongside plugin updates. | not yet implemented | `tauri-plugin-window-state`. | E1 |

### 1.1 Strict CSP string

Drop into `tauri.conf.json -> app.security.csp` exactly:

```
default-src 'self'; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' ipc: https://ipc.localhost https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com https://*.supabase.co https://*.supabase.in https://www.youtube.com https://i.ytimg.com https://www.googleapis.com https://github.com https://api.github.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; media-src 'self' blob: data: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self';
```

Notes per directive:

- `default-src 'self'` — deny by default.
- `script-src 'self' https://www.youtube.com` — only our bundled scripts and the YouTube IFrame Player API. Once Player API moves to a self-hosted shim, drop the YouTube origin.
- `style-src 'self' 'unsafe-inline'` — Tailwind/Radix inject inline styles. `'unsafe-inline'` here is the smallest acceptable compromise; we do not allow remote stylesheets.
- `font-src 'self' https://fonts.gstatic.com data:` — `https://fonts.gstatic.com` stays only until §2 fonts migration completes. After E2 lands self-hosted fonts, remove gstatic and reduce to `'self' data:`.
- `connect-src` — explicit list of every backend the app talks to: Tauri IPC, Anthropic/OpenAI/Gemini/OpenRouter, Supabase, YouTube data + thumbnail, Google APIs (calendar etc.), GitHub. New providers must add their origin and document it in `docs/security.md`.
- `frame-src https://www.youtube-nocookie.com https://www.youtube.com` — PiP/embed iframes only. `youtube-nocookie` is preferred; `youtube.com` stays for fallback.
- `media-src 'self' blob: data: https:` — voice audio (blobs from MediaRecorder), images, future video clips.
- `worker-src 'self' blob:` — Vite + Pipecat workers.
- `object-src 'none'` — no Flash, no PDF embeds.
- `base-uri 'self'`, `form-action 'self'` — defence against base-tag injection and form hijacking.

After CSP lands, run `npm run tauri:dev` and watch the WebView console; resolve every CSP violation by either fixing the offending request or extending the policy with documented justification.

---

## 2. Installable app

Goal: a user with no developer toolchain can download a single file per OS, double-click, and run Jarvis. Updates flow automatically. Code-signing certificates are intentionally deferred — see §2.3.

### 2.1 Bundle targets

Replace `bundle.targets: "all"` (line 34 of `tauri.conf.json`) with an explicit allowlist. Explicit lists prevent surprise targets (e.g. snap, deb on macOS) when Tauri adds new bundlers.

```json
{
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis", "deb", "rpm", "appimage", "dmg", "app", "updater"],
    "category": "Productivity",
    "copyright": "© 2026 Jarvis",
    "shortDescription": "The AI workspace where every model, agent, voice, and task lives under one persistent memory and one always-available assistant.",
    "longDescription": "The AI workspace where every model, agent, voice, and task lives under one persistent memory and one always-available assistant.",
    "license": "Apache-2.0",
    "windows": {
      "wix": {
        "language": ["en-US"]
      },
      "nsis": {
        "installMode": "perMachine",
        "languages": ["English"],
        "displayLanguageSelector": false
      }
    },
    "macOS": {
      "minimumSystemVersion": "12.0",
      "dmg": {
        "background": "icons/dmg-background.png",
        "windowSize": { "width": 660, "height": 400 }
      }
    },
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0", "libayatana-appindicator3-1"]
      }
    }
  }
}
```

Target-by-target output:

| Target | Output | Platform | Notes |
| --- | --- | --- | --- |
| `msi` | `Jarvis_0.1.0_x64_en-US.msi` | Windows | WiX-based. Per-machine install, requires admin elevation. Best for IT-managed deploy. |
| `nsis` | `Jarvis_0.1.0_x64-setup.exe` | Windows | NSIS installer. Per-machine in our config; user-mode is also possible by switching to `currentUser`. Smaller, friendlier than MSI. We ship both. |
| `deb` | `Jarvis_0.1.0_amd64.deb` | Linux (Debian/Ubuntu) | Runtime depends on webkit2gtk-4.1 and libayatana-appindicator3. |
| `rpm` | `Jarvis-0.1.0-1.x86_64.rpm` | Linux (Fedora/RHEL) | Same runtime deps under different package names. |
| `appimage` | `Jarvis_0.1.0_amd64.AppImage` | Linux (any) | Self-contained, distro-agnostic. Default download for "I don't know my distro" users. |
| `dmg` | `Jarvis_0.1.0_aarch64.dmg` | macOS | Drag-to-Applications style. ARM64 only initially; see §3 for adding x64. |
| `app` | `Jarvis.app` | macOS | Bundle inside the DMG; also uploaded raw for CI test runs. |
| `updater` | `*.tar.gz` + `*.sig` per platform | All | Compressed bundles + minisign signatures consumed by `tauri-plugin-updater`. |

### 2.2 Icons

Tauri 2 wants the following under `src-tauri/icons/`:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png` (256×256)
- `icon.icns` (macOS, multi-resolution)
- `icon.ico` (Windows, multi-resolution)
- `Square30x30Logo.png`
- `Square44x44Logo.png`
- `Square71x71Logo.png`
- `Square89x89Logo.png`
- `Square107x107Logo.png`
- `Square142x142Logo.png`
- `Square150x150Logo.png`
- `Square284x284Logo.png`
- `Square310x310Logo.png`
- `StoreLogo.png` (50×50)

Source of truth: `src-tauri/icons/icon.svg` (already present). Generation pipeline:

1. Export `icon.svg` to a 1024×1024 PNG using `npx svg-to-png ./src-tauri/icons/icon.svg ./src-tauri/icons/icon-source.png --width 1024 --height 1024`. Keep `icon-source.png` checked in so future regenerations are deterministic.
2. Run `npx @tauri-apps/cli icon ./src-tauri/icons/icon-source.png -o ./src-tauri/icons`. The Tauri CLI emits all required formats including `.ico` and `.icns`.
3. Inspect outputs visually — alpha channel, edge antialiasing, ICO embedded sizes (`magick identify icon.ico` should report 16, 24, 32, 48, 64, 128, 256).

Add an npm script in `app/package.json`:

```json
"scripts": {
  "icons:generate": "tauri icon ./src-tauri/icons/icon-source.png -o ./src-tauri/icons"
}
```

Document in `docs/branding.md` that any logo change must:

1. Update `icon.svg`.
2. Re-export `icon-source.png`.
3. Run `npm run icons:generate`.
4. Commit all generated files together (one logical change).

DMG background (`icons/dmg-background.png`, 660×400, with arrow → Applications) ships in the same commit.

### 2.3 Code signing

**V2 ships unsigned.** This is a deliberate choice to keep the download path free; signing adds $99–$400/yr in certs and a multi-week procurement loop.

User-visible warnings to document in `docs/install.md`:

- **Windows SmartScreen.** First launch prompts "Windows protected your PC". User clicks **More info** → **Run anyway**. After a few hundred installs Microsoft's reputation system stops flagging us; until then every minor version resets the counter.
- **macOS Gatekeeper.** First launch prompts "Jarvis can't be opened because the developer cannot be verified". User must right-click `Jarvis.app` in Finder → **Open** → confirm. The OS remembers this exception per binary, so updates that ship with the same bundle id mostly inherit the trust unless quarantine flags reapply.
- **Linux.** No prompt; `.deb`/`.rpm` install through `sudo apt install ./Jarvis_*.deb`, AppImage needs `chmod +x`. Document both.

Phase 3+ adds:

- **macOS.** Apple Developer ID Application certificate ($99/yr) + notarytool submission. Wires into CI by adding `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` GitHub secrets and uncommenting the `tauri-action` `appleSign*` inputs in `release.yml`.
- **Windows.** Authenticode EV cert (~$300–$400/yr) via DigiCert/Sectigo. Stored in HSM/USB token. CI signs the `.msi` and the `.exe` after build using `signtool.exe` (action: `azure/trusted-signing-action` or self-hosted runner with the token attached).

The plan flags the deferral, lists the fields, and the upgrade is a config diff plus secrets — no architectural change.

### 2.4 Updater

`tauri-plugin-updater` ships diffless full-bundle updates over HTTPS, signed with a minisign keypair.

Setup steps (one-time, before first release):

```powershell
# 1. Generate keypair.
npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\jarvis.key"

# 2. Capture the printed PUBLIC key — it goes in tauri.conf.json.

# 3. Upload PRIVATE key contents + password to GitHub Actions secrets:
#       JARVIS_TAURI_PRIVATE_KEY          (file contents, base64-encoded)
#       JARVIS_TAURI_PRIVATE_KEY_PASSWORD (passphrase from generation step)
```

`tauri.conf.json` plugin block:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/anomalyco/jarvis/releases/latest/download/latest.json"
    ],
    "dialog": false,
    "pubkey": "REPLACE_WITH_PUBLIC_KEY_FROM_STEP_2"
  }
}
```

`dialog: false` so the renderer drives the upgrade UX (we want a polished in-app banner, not the default native dialog).

Manifest schema (`latest.json` published in each GitHub release):

```json
{
  "version": "0.1.1",
  "notes": "Bug fixes; tightened CSP.",
  "pub_date": "2026-06-01T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/anomalyco/jarvis/releases/download/v0.1.1/Jarvis_0.1.1_x64-setup.nsis.zip"
    },
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://github.com/anomalyco/jarvis/releases/download/v0.1.1/Jarvis_0.1.1_aarch64.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "...",
      "url": "https://github.com/anomalyco/jarvis/releases/download/v0.1.1/Jarvis_0.1.1_amd64.AppImage.tar.gz"
    }
  }
}
```

CI step in `release.yml` (see §3.1) writes `latest.json` automatically using the artefacts the build produces.

In-app UX (Settings → About):

- Current version (from `app_version` Tauri command).
- "Check for updates" button → calls `await check()` from `@tauri-apps/plugin-updater`.
- If update available, banner: version, release notes (markdown-rendered with the same sanitised pipeline), "Download & install" button.
- Channel toggle: `stable` / `beta`. Stable points at `latest.json`; beta points at `latest-beta.json` published from the `beta` branch. Wave E5 wires the channel switch.

Failure modes:

- Network down → silent log, retry next launch.
- Signature mismatch → block install, surface error toast, log to telemetry (anonymous).
- Older version published as `latest` (rollback) → updater treats it as no-op (will not downgrade).

### 2.5 Bundle metadata

Confirm/update in `tauri.conf.json`:

```json
{
  "productName": "Jarvis",
  "version": "0.1.0",
  "identifier": "ai.jarvis.app",
  "bundle": {
    "category": "Productivity",
    "copyright": "© 2026 Jarvis",
    "shortDescription": "The AI workspace where every model, agent, voice, and task lives under one persistent memory and one always-available assistant.",
    "longDescription": "The AI workspace where every model, agent, voice, and task lives under one persistent memory and one always-available assistant.",
    "license": "Apache-2.0"
  }
}
```

`identifier` (`ai.jarvis.app`) is the reverse-DNS bundle id used by macOS, Windows AppUserModelID, and the Tauri data directory. Do not change after first release — uninstallers/upgraders key off it.

`version` stays in sync with `Cargo.toml` and `package.json`. CI (§3.1) verifies all three match before publishing a release.

---

## 3. CI release workflow

Two workflows. `ci.yml` runs on every PR + push, blocks merge on failure. `release.yml` runs on tag push (`v*`), builds the matrix, signs, publishes a GitHub Release.

### 3.1 `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  version-check:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - name: Verify version triple matches tag
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG=$(jq -r .version app/package.json)
          CARGO=$(grep -E '^version' app/src-tauri/Cargo.toml | head -1 | cut -d '"' -f2)
          CONF=$(jq -r .version app/src-tauri/tauri.conf.json)
          echo "tag=$TAG pkg=$PKG cargo=$CARGO conf=$CONF"
          if [ "$TAG" != "$PKG" ] || [ "$TAG" != "$CARGO" ] || [ "$TAG" != "$CONF" ]; then
            echo "::error::version mismatch"
            exit 1
          fi

  build:
    needs: version-check
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            rust-target: x86_64-pc-windows-msvc
            artifact-glob: |
              app/src-tauri/target/release/bundle/msi/*.msi
              app/src-tauri/target/release/bundle/nsis/*.exe
              app/src-tauri/target/release/bundle/msi/*.msi.zip
              app/src-tauri/target/release/bundle/msi/*.msi.zip.sig
              app/src-tauri/target/release/bundle/nsis/*.nsis.zip
              app/src-tauri/target/release/bundle/nsis/*.nsis.zip.sig
          - os: macos-latest
            rust-target: aarch64-apple-darwin
            artifact-glob: |
              app/src-tauri/target/release/bundle/dmg/*.dmg
              app/src-tauri/target/release/bundle/macos/*.app.tar.gz
              app/src-tauri/target/release/bundle/macos/*.app.tar.gz.sig
          - os: ubuntu-22.04
            rust-target: x86_64-unknown-linux-gnu
            artifact-glob: |
              app/src-tauri/target/release/bundle/deb/*.deb
              app/src-tauri/target/release/bundle/rpm/*.rpm
              app/src-tauri/target/release/bundle/appimage/*.AppImage
              app/src-tauri/target/release/bundle/appimage/*.AppImage.tar.gz
              app/src-tauri/target/release/bundle/appimage/*.AppImage.tar.gz.sig

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Linux system deps
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            libssl-dev \
            patchelf \
            file

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: app/package-lock.json

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.rust-target }}

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: app/src-tauri -> target

      - name: Install JS deps
        working-directory: app
        run: npm ci

      - name: Typecheck
        working-directory: app
        run: npm run typecheck

      - name: Build (signed)
        working-directory: app
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.JARVIS_TAURI_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.JARVIS_TAURI_PRIVATE_KEY_PASSWORD }}
        run: npm run tauri:build -- --target ${{ matrix.rust-target }}

      - uses: actions/upload-artifact@v4
        with:
          name: jarvis-${{ matrix.os }}
          path: ${{ matrix.artifact-glob }}
          if-no-files-found: error

  publish:
    needs: build
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          path: dist

      - name: Build updater manifest
        run: |
          node scripts/build-updater-manifest.mjs \
            --version "${GITHUB_REF_NAME#v}" \
            --indir dist \
            --outfile latest.json

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          name: Jarvis ${{ github.ref_name }}
          generate_release_notes: true
          files: |
            dist/**/*
            latest.json
```

`scripts/build-updater-manifest.mjs` (~40 lines) walks the `dist/` tree, matches each `*.sig` file to its bundle, and emits the manifest schema from §2.4. Place under repo root `scripts/`.

### 3.2 `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  lint-typecheck:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: app/package-lock.json
      - working-directory: app
        run: |
          npm ci
          npm run typecheck

  build-no-bundle:
    needs: lint-typecheck
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-22.04, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Install Linux system deps
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            libssl-dev
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: app/package-lock.json
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: app/src-tauri -> target
      - working-directory: app
        run: |
          npm ci
          npm run build
          cargo build --manifest-path src-tauri/Cargo.toml --release

  npm-audit:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - working-directory: app
        run: |
          npm ci
          npm audit --omit=dev --audit-level=high

  cargo-audit:
    runs-on: ubuntu-22.04
    continue-on-error: true   # warn-only until baseline clean
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo install cargo-audit --locked
      - run: cargo audit --file app/src-tauri/Cargo.lock

  gitleaks:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: zricethezav/gitleaks-action@v2
        env:
          GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}
```

Once `cargo audit` reports zero advisories on `main`, flip `continue-on-error: false`.

---

## 4. Plugin & capability updates

### 4.1 `Cargo.toml` additions

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-notification = "2"
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
tauri-plugin-os = "2"

# B1 additions
tauri-plugin-single-instance = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-window-state = "2"
tauri-plugin-store = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-fs = "2"
tauri-plugin-updater = "2"
tauri-plugin-stronghold = "2"

# Native keychain bridge for Stronghold-incapable scenarios.
keyring = "3"

# Reserved for Planner C terminal subsystem; keeping the dep here so its
# capabilities file references a real crate.
portable-pty = "0.8"

serde = { version = "1", features = ["derive"] }
serde_json = "1"
url = "2"
once_cell = "1"
```

Keep both Stronghold and `keyring` because they cover different threat models:

- **Stronghold** — encrypted file under `appDataDir/stronghold.hold`, IOTA's hardened store. Works the same on every OS, ideal for sync-to-cloud-backup workflows. Requires user passphrase or a derived secret.
- **`keyring-rs`** — native OS vault (Win Credential Manager, macOS Keychain, GNOME Keyring / KWallet via Secret Service). No passphrase, system unlocks with login. Loses portability but gains UX.

Default flow: write to `keyring`, fall back to Stronghold if the OS vault is unavailable (headless Linux, locked Keychain, etc.). Read from `keyring` first, then Stronghold.

### 4.2 Updated `lib.rs`

Replace the file with the version below. New behaviour:

1. Single-instance handler focuses the existing main window and forwards argv (deep links, file opens).
2. Deep-link plugin parses `jarvis://...`, validates the scheme + action allowlist, and emits a typed `deep-link://received` event to the WebView.
3. Plugins registered in dependency order (single-instance must come before deep-link).
4. Hot keys, store, fs, updater, stronghold initialised but **no scopes baked in here** — scopes belong in capability files.

```rust
//! Jarvis desktop shell – Tauri 2 Rust core.
//!
//! See `docs/02-system-architecture.md §2.1` for the architecture diagram
//! (WebView + Node sidecar + Python voice sidecar over a Tauri IPC core).

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const DEEP_LINK_SCHEMES: &[&str] = &["jarvis"];
const DEEP_LINK_ACTIONS: &[&str] = &[
    "open-task",
    "open-chat",
    "open-doc",
    "oauth-callback",
];
const DEEP_LINK_MAX_LEN: usize = 8192;

#[derive(Clone, Serialize)]
struct DeepLinkPayload {
    action: String,
    params: serde_json::Value,
    raw: String,
}

#[tauri::command]
fn greet(name: &str) -> Result<String, String> {
    if name.len() > 200 {
        return Err("name too long".into());
    }
    Ok(format!("Hello {name}, this is Jarvis."))
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Validate + parse one deep-link URL. Returns `None` if the link is invalid;
/// callers should silently drop invalid links.
fn parse_deep_link(raw: &str) -> Option<DeepLinkPayload> {
    if raw.len() > DEEP_LINK_MAX_LEN {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !DEEP_LINK_SCHEMES.contains(&url.scheme()) {
        return None;
    }
    let action = url.host_str().unwrap_or("").to_string();
    if !DEEP_LINK_ACTIONS.contains(&action.as_str()) {
        return None;
    }
    let mut params = serde_json::Map::new();
    for (k, v) in url.query_pairs() {
        if k.len() > 64 || v.len() > 1024 {
            return None;
        }
        params.insert(k.into_owned(), serde_json::Value::String(v.into_owned()));
    }
    Some(DeepLinkPayload {
        action,
        params: serde_json::Value::Object(params),
        raw: raw.to_string(),
    })
}

fn forward_deep_links(app: &AppHandle, args: &[String]) {
    for arg in args {
        if let Some(payload) = parse_deep_link(arg) {
            let _ = app.emit("deep-link://received", payload);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must register first so it can intercept startup.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            forward_deep_links(app, &argv);
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_stronghold::Builder::new(|password| {
            // The frontend sends a user passphrase via the store; we hash it
            // with Argon2id (in a follow-up wave) before reaching here.
            // For now: pass-through, with a length check.
            assert!(password.len() >= 8, "stronghold password too short");
            password.as_bytes().to_vec()
        }).build())
        .setup(|app| {
            // Register the custom URL scheme on first launch (no-op if already registered).
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("jarvis")?;
            }

            // Handle cold-start deep links (process started by `jarvis://...`).
            let argv: Vec<String> = std::env::args().collect();
            forward_deep_links(&app.handle(), &argv);

            // Hot deep links (already-running app receives a new URL).
            let handle = app.handle().clone();
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(payload) = parse_deep_link(url.as_str()) {
                            let _ = handle.emit("deep-link://received", payload);
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

The frontend listens for `deep-link://received` and routes to the matching screen. The validator stays in Rust because the WebView is the trust boundary; we never want a malformed URL surfacing to JS.

### 4.3 Updated `capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Jarvis main window capability set",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:default",
    "core:webview:default",
    "core:webview:allow-create-webview-window",
    "core:app:default",
    "core:path:default",
    "core:image:default",
    "notification:default",
    "dialog:default",
    "shell:allow-open",
    "os:default",
    "fs:default",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:scope-appdata",
    "fs:scope-download",
    "store:default",
    "global-shortcut:default",
    "updater:default",
    "deep-link:default",
    "window-state:default",
    "stronghold:default"
  ]
}
```

`fs:scope-appdata` and `fs:scope-download` constrain reads/writes to `$APPDATA/ai.jarvis.app/**` and the platform Downloads folder. No `fs:scope-home`, no `fs:scope-resource`. Document this in `docs/security.md`.

`shell:allow-open` (and only `allow-open`) lets us launch the OS browser for outbound URLs. We never grant `shell:allow-execute` or `shell:allow-spawn`. CI grep step:

```bash
! grep -r 'shell:allow-execute\|shell:allow-spawn' app/src-tauri/capabilities
```

### 4.4 New `capabilities/pip-media.json`

The picture-in-picture player runs in a secondary webview (`pip`) and must not have file system or shell access — it embeds YouTube and our own media controls only.

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "pip-media",
  "description": "Jarvis PiP media window — webview embeds only, no filesystem or shell.",
  "windows": ["pip"],
  "permissions": [
    "core:event:default",
    "core:window:default",
    "core:webview:default",
    "core:app:default"
  ]
}
```

Notes:

- No `core:default` — that bundle includes path APIs we don't want here.
- No `fs:*`, no `shell:*`, no `dialog:*`, no `store:*`, no `global-shortcut:*`.
- Window label `pip` matches the JS-side call `WebviewWindow.create('pip', { ... })`. Mismatched labels silently get **no** permissions.

### 4.5 New `capabilities/terminal.json` (placeholder for Planner C)

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "terminal",
  "description": "Jarvis terminal window. PLACEHOLDER — Planner C (terminal subsystem) will populate the pty_* command allowlist, scope home/cwd, and add output streaming events. Until then this capability is empty and the window is not creatable.",
  "windows": ["terminal"],
  "permissions": [
    "core:event:default",
    "core:window:default",
    "core:webview:default",
    "core:app:default"
  ]
}
```

Marker comments in the description so Planner C knows exactly what to fill in: `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill` invokers plus their allowed shell binaries and cwd scopes.

---

## 5. Permissions / capabilities recap

Every permission we grant, with rationale and which feature waves rely on it.

| Permission | What it allows | Why we grant it | Used by |
| --- | --- | --- | --- |
| `core:default` | Bundle: app/window/webview/event/path/menu/tray/image defaults. | Tauri sane defaults. | Everything. |
| `core:event:default` | Listen + emit IPC events. | Required by deep-link, updater, sidecars. | Most features. |
| `core:window:default` | `getCurrent`, minimise, maximise, hide. | Standard window controls. | Title bar, hotkeys. |
| `core:webview:default` | Read webview position/size, scale factor. | Layout calculations. | PiP positioning. |
| `core:webview:allow-create-webview-window` | `WebviewWindow.create()`. | Spawn PiP, terminal, settings windows. | PiP, terminal (E5+). |
| `core:app:default` | App version, name, exit. | Settings → About, exit menu item. | Settings. |
| `core:path:default` | Resolve `appData`, `download`, `home`, etc. | Compute the Jarvis data dir for storage. | Storage layer. |
| `core:image:default` | Decode/encode images. | Avatar rendering, screenshot tool (E7). | Avatars. |
| `notification:default` | Native OS banners. | Reminders, errors, voice activation cues. | Notifications. |
| `dialog:default` | `open()`, `save()`, `message()`. | File pickers (import/export), confirmation dialogs. | Settings, import. |
| `shell:allow-open` | `shell.open(url)`. **No execute, no spawn.** | Open external URLs in OS browser (provider docs, GitHub). | About, links. |
| `os:default` | Platform/arch/locale detection. | Conditional UI (mod key glyph), provider routing. | Hotkeys, UI. |
| `fs:default` | Read/write file metadata bundle. | Storage layer + log export. | Storage. |
| `fs:allow-read-text-file` / `fs:allow-write-text-file` | Plain-text file IO. | JSON snapshots, log exports. | Storage, debugging. |
| `fs:scope-appdata` | Restrict FS to `$APPDATA/ai.jarvis.app/**`. | Defence-in-depth: even if a path traversal slips through, the kernel-enforced scope blocks it. | Storage. |
| `fs:scope-download` | Allow writes to OS Downloads folder. | Export → .json/.md → Downloads. | Export feature. |
| `store:default` | Scoped JSON KV via `tauri-plugin-store`. | Settings persistence (theme, channel, telemetry opt-in). | Settings. |
| `global-shortcut:default` | Register OS-wide hotkeys. | Cmd-Space style activation. | Hotkeys (E5+). |
| `updater:default` | Check + install updates. | §2.4. | Update flow. |
| `deep-link:default` | Receive `jarvis://` URLs. | OAuth callback, share-to-Jarvis. | Auth, routing. |
| `window-state:default` | Persist window size/position. | UX nicety. | All windows. |
| `stronghold:default` | Encrypted vault read/write. | Secrets fallback when keyring unavailable. | API key store. |

**Explicitly NOT granted** (and we keep them denied via CI grep):

- `shell:allow-execute`, `shell:allow-spawn` — arbitrary command execution. Terminal subsystem (Planner C) ships its own narrowly-scoped `pty_*` commands instead.
- `fs:scope-home`, `fs:scope-resource` — too broad. We never need full home access.
- `http:default` — every backend goes through provider SDKs (which use the WebView's fetch + CSP `connect-src`) or sidecars; the Tauri `http` plugin is redundant and bypasses CSP.
- `process:default` — relaunch/exit not needed yet; revisit when we ship a tray-quit menu.

CI guard (`ci.yml` extension once stable):

```yaml
  capability-lint:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - run: |
          BAD='shell:allow-execute|shell:allow-spawn|fs:scope-home|fs:scope-resource|http:default|process:default'
          if grep -rE "($BAD)" app/src-tauri/capabilities; then
            echo "::error::denied permission found in capabilities"
            exit 1
          fi
```

---

## 6. Wave sequencing & exit criteria

| Wave | Deliverable | Exit criterion |
| --- | --- | --- |
| E1 | CSP, single-instance, window-state, secrets store, lockfile commit. | App launches; `localStorage.jarvis-auth.apiKeys` is empty after migration; CSP violations log clean for 30 minutes of mixed use. |
| E2 | Self-hosted fonts, tightened capabilities, npm/cargo audit, gitleaks. | `index.html` has zero external `<link>` to fonts.googleapis.com; CI green on `npm audit --audit-level=high`. |
| E3 | Deep-link validation, render-sanitise, redaction helper, capability-lint job. | `parse_deep_link` rejects the fuzz-test corpus (100+ malformed inputs); rehype-sanitize allowlist documented. |
| E4 | Updater wired end-to-end, in-app banner, stronghold + keyring fallback ladder. | Tagged dummy `v0.0.1-test` release on a private repo upgrades a running 0.0.0 build with one click. |
| E5 | Code-signing path documented + secrets reserved (no certs purchased). | `release.yml` has commented `appleSign*` block and a one-page playbook in `docs/release.md`. |

Anything past E5 (real signing, beta channel, telemetry SLO) belongs in a follow-up plan.
