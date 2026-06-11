# AGENTS.md

## Cursor Cloud specific instructions

Jarvis One is a local-first AI workspace: React + Vite frontend in `app/`, optional Tauri 2 desktop shell in `app/src-tauri/`, optional Python voice backend in `phone-jarvis/cloud/`.

### Primary dev path (web UI)

From repo root:

```bash
npm run jarvis          # http://localhost:5173
npm run typecheck
npm run build
npm --prefix app run test
npm run test:release-manifest
```

See `SETUP.md` for maintainer env vars (`app/.env.local` from `.env.example`). Core UI works without Supabase, API keys, or Ollama when using the built-in mock provider.

### Onboarding / mock provider gotcha

Fresh browser sessions show onboarding and a model-access gate. For cloud-agent UI demos without external services:

- Choose **"Skip for now (use mock replies until I connect a model)"**
- Do **not** choose **"Run fully offline instead"** unless Ollama is installed and running on `http://localhost:11434`

If the wrong path was picked, clear site data for `localhost:5173` in browser devtools and redo onboarding.

### Optional services

| Service | When needed | How to run |
|---------|-------------|------------|
| Vite dev server | Always for web dev | `npm run jarvis` |
| Tauri desktop | PTY terminals, native APIs | `npm run tauri:dev` (see below) |
| Ollama | Offline local models | Install separately; `ollama serve` |
| Supabase | Cloud auth/sync/billing | Remote project + `app/.env.local`, or `supabase start` |
| phone-jarvis cloud | Jarvis Call voice | `cd phone-jarvis/cloud && pip install -r requirements.txt && uvicorn main:app --reload --port 8080` |

### Tauri / Rust (optional)

CI runs `cargo check --release` in `app/src-tauri` on Ubuntu with WebKit GTK packages. On this VM, ensure the active toolchain is current stable before checking:

```bash
rustup default stable
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev
cd app/src-tauri && cargo check --release
```

First `tauri:dev` compiles Rust deps and needs a display/WebView (not required for web-only work).

### Known test caveat

`app/src/features/terminals/transcriptStore.test.ts` ("prefixes a truncation marker after trimming") may fail in some environments while the rest of the Vitest suite passes. Treat as pre-existing unless you are changing transcript storage.

### Lint / format

There is no dedicated ESLint script. CI validates via `npm run typecheck`, `npm run build`, and Vitest. Prettier is available via `npm run format` but is not enforced in CI.
