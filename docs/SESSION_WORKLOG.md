# Jarvis One — Work Log (Voice / Subscription / Calling / Fixes)

Branch: `feat/voice-subscription-system`
Latest commit at time of writing: `bc97478`
Status: **NOT production-ready** — code complete and tested where possible, but
gated on external setup (DB password, completed Stripe payment, Kokoro model
artifact, macOS/Linux machines). See "Remaining / Blocked".

This document summarizes everything implemented across the session, in the
order it was built, with the commit each landed in.

---

## 1. Voice subscription system (backend)

### Database — `supabase/migrations/`
- **`0012_voice_subscription.sql`** — `voice_usage`, `voice_events`,
  `subscription_events`, `voice_rate_limits`, `api_key_settings` tables; strict
  RLS (users read only their own rows, no client writes to usage/events;
  service-role-only tables deny client reads); atomic RPCs
  `reserve_voice_seconds` / `settle_voice_seconds`, the rate-limit RPC
  `voice_rate_limit_hit`, plan→budget helpers, monthly-reset logic, and a
  `profiles.tier` → usage-seeding trigger. Quota RPCs revoked from
  `anon`/`authenticated`.
- **`0013_message_call_budgets.sql`** — `subscription_plan_limits` (seeded),
  `message_usage`/`message_events`/`message_rate_limits`,
  `call_usage`/`call_events`/`call_rate_limits`; atomic
  `reserve_message_budget`/`settle_message_budget`,
  `reserve_call_budget`/`settle_call_budget`, `get_current_plan_limits`,
  `reset_monthly_usage_if_needed`, `record_usage_event`, and plan-sync triggers.
- **`0014_unify_voice_call_budget.sql`** — cloud voice now draws from the
  **shared call/voice budget** (not a separate voice budget), fixing a
  double-count. Aligns the legacy `voice_budget_for_plan` figures.
- **`supabase/tests/rls_voice_verification.sql`** — runnable SQL that asserts
  RLS is enabled everywhere, service-role-only tables block client reads, quota
  RPCs are revoked from clients, plan→budget math is correct, and atomic
  reservations reject over-quota (voice, message, and call).

### Edge Functions — `supabase/functions/`
- `tts-speak` — secure cloud TTS: JWT auth, approved provider/preset allow-list,
  empty/oversized rejection, atomic rate-limit + budget reservation (reserves
  from the shared call/voice budget), provider call, settle, voice event,
  safe coded errors → client falls back to local/system voice.
- `get-voice-usage` — reports the shared call/voice budget as seconds remaining.
- `message-complete` — metered company AI messages (budget reserve/settle, safe
  fallback to BYOK/local).
- `get-message-usage` — friendly message credits (never raw dollars).
- `call-start` — authorizes a call against the call budget, hard duration cap,
  initiates Twilio call (when configured), records the event.
- `call-status` — Twilio status callback: verifies signature, settles real call
  duration against the budget.
- `twilio-voice-webhook` — signature-verified TwiML (greeting + time cap).
- `twilio-message-webhook` — inbound SMS: signature verify + STOP/HELP opt-out.
- `get-call-usage` — friendly call minutes.
- `create-checkout-session` — Stripe Checkout; maps `starter/pro/ultra` →
  price IDs **server-side only**; ignores any client price/amount.
- `create-customer-portal` — Stripe billing portal.
- `stripe-webhook` — raw-body signature verification, idempotent via
  `subscription_events.event_id`, server-side price→plan mapping; updates
  `profiles.tier` (which fires usage-seeding triggers); `invoice.payment_failed`
  reverts to free.
- `model-manifest` — public Kokoro manifest; returns `status: "unavailable"`
  (no placeholder checksums) until a real model asset is published.
- `_shared/voice.ts`, `_shared/budget.ts` — shared CORS, plan, cost, and Twilio
  signature helpers. Company keys live only in env/secrets — never in the client.

### Deployment status
- **Deployed live:** `model-manifest` (verified `status:unavailable`),
  `create-checkout-session`, `create-customer-portal`, `stripe-webhook`.
- **Verified live:** checkout/portal require auth (401); webhook health (200),
  invalid/missing signature (400). Server-side price mapping + no client price
  override (code-verified). Invalid plan + webhook idempotency (code-verified).
- **Not deployed:** `tts-speak`, `get-voice-usage`, `message-complete`,
  `get-message-usage`, `call-*`, `twilio-*` — pending their provider secrets
  and the DB migration.

---

## 2. Voice system (frontend) — `app/src/features/voice/`
- `TtsService.ts` — speak/stop/pause/resume/testVoice/setProvider/
  setVoicePreset/getAvailableVoices/getUsage/preload/warmup; provider fallback
  chain (cloud → kokoro_local → system_tts_fallback); audio queue; phrase cache.
- `providers/` — `kokoroLocal`, `cloudTts` (openai/deepgram/elevenlabs via the
  Edge Function), `systemFallback`, plus the `VoiceProvider` interface.
- `textCleanup.ts` — markdown strip, URL→"link", code-block summarize, sentence
  chunking (200–500 chars). `voicePlans.ts` — plan/preset/usage display.
  `modelManager.ts` — OS-correct Kokoro paths + download/verify/repair contract.
  `audioPlayback.ts` — base64 audio playback with abort.
- Cloud voice wired into chat replies (in `lib/ai/runtime.ts`) only when a cloud
  provider is explicitly selected; the system-voice path is unchanged.
- **Kokoro local audio is not generating yet** — `kokoro_speak` returns
  `engine_not_available`; the app falls back to system TTS until the ONNX
  runtime + model asset are bundled. (Rust `kokoro.rs` command surface is
  implemented and compiles.)

---

## 3. Bug fixes & polish (this session)

### Terminal history persistence — `transcriptStore.ts` (commit `d5a90da`, `6f6282b`)
- Fixed history loss: an empty/missing primary transcript can no longer shadow
  a good backup on load; an empty/transient flush can no longer overwrite a
  valid saved transcript (the cause of loss when panes unmount on app close).
- Intentional clears still work: per-session clear persists the cleared entry;
  full reset wipes both storage keys.
- Added 6 durability tests. No terminal UI/speed changes.
- Also fixed a garbled truncation-marker (mojibake `…`).

### "Open in Chat" — `TabStrip.tsx` (commit `6f6282b`)
- Fixed: opening a past conversation no longer starts a new/empty chat.
- Root cause: the project-scoped tab reconciler bumped the active chat when it
  wasn't in the current project's tabs. Now it never bumps a valid existing
  chat — it aligns the active project so the selected chat stays loaded.

### Account auth + startup routing — `SignInDialog.tsx`, `App.tsx` (commit `1e5885c`)
- Added **Create account** (Supabase sign-up) alongside Sign in / Magic link.
- On startup, when cloud auth is configured but no one is signed in, the app
  opens the **Account page**; signed-in users restore their last page.

### Jarvis "J" glow — `TopBar.tsx`, `globals.css` (commit `1e5885c`)
- The breadcrumb activation button now has an always-on purple→cyan glow that
  pulses (intensifies while listening). Respects `prefers-reduced-motion`.

### Voice settings tab — `Voice.tsx` (commit `5869022`)
- Removed the separate "Cloud Voice" tab; the Voice tab now shows just the two
  free presets (Jarvis + Friday), keeping the existing card UI + preview.
  (Premium OpenAI cloud voice is a paid option to wire into preview once
  `tts-speak` is deployed.)

### Ollama 403 fix — `ollama.ts` (commit `bc97478`)
- All Ollama requests now pin `Origin: http://127.0.0.1:11434`, the standard,
  no-setup fix for the Tauri+Ollama `403 Forbidden` (packaged builds run under
  `tauri://localhost`, which some Ollama versions reject). Works out of the box
  on Windows/macOS/Linux with no `OLLAMA_ORIGINS` env var.
- Note: on the dev machine the daemon currently allows the WebView origin, so
  the exact 403 wasn't reproducible there — terminal `ollama pull` works but the
  in-app pull 403s, which is consistent with the Tauri HTTP path forwarding the
  WebView origin. Needs verification in the rebuilt app.

### Website — `site/landing.html` (commit `90214da`)
- Polished, interactive, single-file marketing site matching the app theme
  (purple→cyan J glow, ambient orbs, cursor glow, scroll-reveal, typing terminal
  demo, features, 21+ providers, voice/calling, Free/Starter/Pro/Ultra pricing,
  hotkeys, install CTA). Does not touch the existing GitHub-Pages `index.html`.

---

## 4. Business model (server-enforced)
- Free $0 · Starter $10 · Pro $50 · Ultra $100 / month.
- Per-plan budgets (USD, internal): message + shared call/voice.
  Starter $2.50/$2.50, Pro $12.50/$12.50, Ultra $25/$25.
- Public display (never raw dollars): Starter 2,500 msg credits + 25 call min;
  Pro 12,500 + 125; Ultra 25,000 + 250. Local voice always free & unlimited.
- Enforced server-side with atomic reservations; the frontend only displays
  server-returned usage.

---

## 5. Tests / build status
- Frontend unit tests: **282 passing** (vitest), incl. new voice, plan, budget,
  persistence, and Ollama tests.
- `tsc --noEmit`: clean. Frontend production build: clean.
- Rust: `cargo check` + `cargo build --release` clean (jarvis.exe builds).
- Secret scan: clean (no hardcoded secret values; only env reads).
- `npm audit`: 0 high/critical (2 moderate, not force-upgraded).

---

## 6. Remaining / Blocked (need YOUR action — no code can resolve these)
1. **DB migration push** — needs the database password:
   ```powershell
   $env:SUPABASE_DB_PASSWORD="YOUR_DATABASE_PASSWORD"
   npx supabase db push
   psql $env:SUPABASE_DB_URL -f supabase/tests/rls_voice_verification.sql
   ```
2. **Cloud voice/messaging/calling secrets** (then deploy those functions):
   `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `TWILIO_*`.
3. **Real Stripe checkout E2E** — click Upgrade in the signed-in app
   (auto-mint of a test user is blocked: signups disabled + admin createUser
   403). Then confirm webhook events are 200 in the Stripe dashboard.
4. **Kokoro real audio** — publish the ONNX model asset + wire a runtime; today
   it falls back to system voice.
5. **macOS/Linux** — build/test on those OSes (only Windows verified here).
6. **GitHub release publish** — the `gh` CLI token is expired; run
   `gh auth login` (or `gh auth refresh`) then `gh release create v0.1.28 …`.
7. **Performance/crash** — needs a repro (which action lags/crashes the app).

See also: `docs/voice-subscription-system.md`, `docs/supabase-setup.md`,
`docs/stripe-setup.md`, `docs/twilio-calling-setup.md`,
`docs/security-production-checklist.md`.

---

## 7. Commit history (this session, newest first)
- `bc97478` — Ollama: pin loopback Origin to avoid WebView-origin 403s
- `5869022` — Voice settings: surface only the two free presets (Jarvis + Friday)
- `90214da` — Add polished interactive landing site (`site/landing.html`)
- `1e5885c` — Account sign-up, startup routing to Account, Jarvis "J" glow
- `6f6282b` — Fix Open in Chat; honest 0.1.28 changelog; persistence tests
- `d5a90da` — Harden terminal persistence; remove Cloud Voice tab
- `f3f8abb` — Atomic rate-limit RPC; cloud voice in chat replies
- `7db6f44` — Messaging + calling budget system, edge functions, docs
- `bf5821d` — Unify cloud voice into shared call/voice budget; honest manifest
- `1265994` — Wire Kokoro Tauri commands (+ concurrent local-model work)
- `76d0bcf` — Production-readiness pass (Kokoro module, RLS SQL, docs)
- `e8cbd14` — Initial voice subscription system (migration + 6 edge functions + frontend)
