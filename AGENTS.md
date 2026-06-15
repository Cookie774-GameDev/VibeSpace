# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
- **VibeSpace** desktop app (`app/`) — Tauri 2 + React + Vite. The npm package is named `jarvis`; the product is VibeSpace and "Jarvis" is the in-app assistant.
- Optional cloud pieces: `phone-jarvis/cloud/` (Python FastAPI voice service) and `supabase/` (Postgres + Deno edge functions). These are **not** needed to run or test the core desktop app.

### Running the app (core dev flow)
- `npm run jarvis` (root) starts the Vite dev server on **http://localhost:5173** (web/dev mode). Standard scripts live in `package.json` / `app/package.json`; see `SETUP.md`.
- Web/dev mode runs **fully offline with no secrets**: with no provider key configured the app uses a built-in **mock LLM** and local Kokoro voice. The onboarding flow (personality → features → API keys → permissions) can be completed without any keys.
- Native features (live PTY **Terminals**, keyring, global shortcuts, local Kokoro) require the Tauri/Rust shell via `npm run tauri:dev`. In plain web mode the **Terminals** page shows a "backend unavailable" state — this is expected, not a setup failure.
- `npm run tauri:dev` / `cargo check` need system libs not installed by the update script (`libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `libssl-dev` — see `.github/workflows/ci.yml`). Install those before attempting native builds.

### Checks (mirror CI in `.github/workflows/ci.yml`)
- Typecheck: `npm run typecheck`
- Tests: `npm --prefix app run test` (vitest)
- Release-manifest test: `npm run test:release-manifest`
- Build: `npm run build`
- There is **no dedicated lint script**; typecheck + `npm run format` (Prettier) serve that role.

### Env / secrets
- Client env vars must be `VITE_`-prefixed and live in `app/.env.local` (not the root `.env.example`). They are only needed for cloud sync, billing (Stripe), and Jarvis Call — not for local UI/dev.

### Optional cloud services
- `phone-jarvis/cloud`: `pip install -r phone-jarvis/cloud/requirements.txt`, then `uvicorn main:app --reload --port 8080`. Boots and serves `/health` even with no provider/Twilio/LiveKit keys.
- `supabase`: managed via the Supabase CLI (`supabase start` / `supabase db push`); only required for account/billing/metered-voice flows.
