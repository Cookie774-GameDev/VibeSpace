# Voice Subscription System

Secure, metered cloud TTS + free local Kokoro voice for VibeSpace.

## Overview

VibeSpace has two independent voice systems. The voice provider is independent
of the chat provider — e.g. you can chat with Gemini and have the reply read by
OpenAI TTS, or chat with Claude and use local Kokoro.

| System | Engine | Cost | Auth | Quota |
|--------|--------|------|------|-------|
| **Local** | Kokoro-82M (`bm_daniel`/`bf_emma`) | Free | none | unlimited |
| **Cloud** | OpenAI / Deepgram / ElevenLabs | Paid plan | Supabase JWT | metered |

If cloud voice fails, times out, or quota is exhausted, the app **automatically
falls back to local Kokoro**, then to the system TTS voice.

## Architecture

```
Chat reply text
   └─ TtsService.speak()
        ├─ cleanTextForSpeech()  (strip markdown, URLs→"link", summarize code)
        ├─ chunkText()           (200–500 char sentence chunks)
        └─ queue → provider chain with fallback:
             requested → kokoro_local → system_tts_fallback
```

Providers (`app/src/features/voice/providers/`):

- `kokoro_local` — Tauri command `kokoro_speak` (Rust ONNX, off the UI thread)
- `openai_tts` / `deepgram_tts` / `elevenlabs_tts` — POST to the `tts-speak`
  Edge Function with the user JWT; **never** hold a company key
- `system_tts_fallback` — browser/OS `SpeechSynthesis`

## Plans & cost model

Cloud TTS is metered in **seconds of generated audio**. The shared constant is:

```
COST_PER_SECOND_USD = 0.00025   (~$0.015/min, OpenAI gpt-4o-mini-tts)
```

| Plan | Price | Cloud budget | Cloud seconds | ~Hours |
|------|-------|--------------|---------------|--------|
| Free | $0 | $0 | 0 | local only |
| Starter | $10/mo | $2 | 8,000 | ~2.2 h |
| Pro | $50/mo | $10 | 40,000 | ~11 h |
| Ultra | $100/mo | $20 | 80,000 | ~22 h |

Plan benefits are determined **server-side only** (Stripe price ID → plan).
Local Kokoro is unlimited on every plan.

## Database (migration `0012_voice_subscription.sql`)

Tables (all RLS-enabled):

- `voice_usage` — per-user quota + usage. SELECT own row only; no client writes.
- `voice_events` — per-TTS-call audit. SELECT own only; no client writes.
- `subscription_events` — Stripe idempotency log. Service role only.
- `voice_rate_limits` — sliding-window rate limiting. Service role only.
- `api_key_settings` — optional BYOK keys. Full CRUD on own rows only.

RPCs (service role only, `revoke`d from `anon`/`authenticated`):

- `reserve_voice_seconds(user, secs)` — locks the row, checks remaining,
  reserves atomically. Prevents parallel-request quota bypass. Lazily resets
  usage when the billing period elapses.
- `settle_voice_seconds(user, reserved, actual)` — reconciles after generation.
- `sync_voice_usage_for_user(user, plan)` — seeds budget/limit from plan;
  fired automatically by a trigger on `profiles.tier` change.

## Edge Functions (`supabase/functions/`)

| Function | Auth | Purpose |
|----------|------|---------|
| `tts-speak` | JWT | Validate → rate-limit → reserve quota → call provider → settle |
| `get-voice-usage` | JWT | Returns the caller's quota/usage |
| `create-checkout-session` | JWT | Stripe Checkout (plan→price server-side) |
| `create-customer-portal` | JWT | Stripe billing portal |
| `stripe-webhook` | Stripe sig | Verifies raw-body signature, idempotent, maps price→plan |
| `model-manifest` | public | Kokoro download metadata (no secrets) |

## Required Supabase secrets

Set these before deploying (they are **never** committed or shipped to the app):

```bash
npx supabase secrets set STRIPE_SECRET_KEY=<stripe-secret-key>
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
npx supabase secrets set STRIPE_STARTER_PRICE_ID=price_...
npx supabase secrets set STRIPE_PRO_PRICE_ID=price_...
npx supabase secrets set STRIPE_ULTRA_PRICE_ID=price_...
npx supabase secrets set OPENAI_API_KEY=sk-...
npx supabase secrets set DEEPGRAM_API_KEY=...
npx supabase secrets set ELEVENLABS_API_KEY=...
npx supabase secrets set APP_BASE_URL=https://vibespaceos.com
# Optional: MODEL_MANIFEST_URL or GITHUB_MODEL_RELEASE_URL for Kokoro assets
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided
by the Supabase runtime automatically.

## Deploy

```bash
# Push DB migration (requires DB password)
$env:SUPABASE_DB_PASSWORD="..."   # PowerShell
npx supabase db push

# Deploy functions
npx supabase functions deploy tts-speak
npx supabase functions deploy get-voice-usage
npx supabase functions deploy create-checkout-session
npx supabase functions deploy create-customer-portal
npx supabase functions deploy model-manifest
# stripe-webhook must skip JWT verification (Stripe signs it instead):
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

Then add the `stripe-webhook` URL to the Stripe dashboard with these events:
`checkout.session.completed`, `customer.subscription.created/updated/deleted`,
`invoice.payment_succeeded`, `invoice.payment_failed`.

## Kokoro local model

ModelManager (`app/src/features/voice/modelManager.ts`) resolves the OS path:

- Windows: `%APPDATA%/VibeSpace/models/kokoro/`
- macOS: `~/Library/Application Support/VibeSpace/models/kokoro/`
- Linux: `~/.local/share/VibeSpace/models/kokoro/`

It fetches the public manifest from `model-manifest`, downloads with progress,
verifies SHA-256 checksums, resumes partial downloads, and repairs corrupt
files. The heavy work runs in Rust (`src-tauri/src/kokoro.rs`, Tauri commands
`kokoro_*`) so the UI never freezes.

**Rust module status:** `kokoro.rs` is implemented and compiles (`cargo check`
clean). It does real path resolution, download-with-progress (`kokoro:progress`
events), SHA-256 verification, resume, and repair. `kokoro_speak` currently
returns a structured `engine_not_available` error and `kokoro_status` reports
`ready=false`, because the ONNX inference runtime + model weights are **not
bundled yet** — so the app falls back to system TTS automatically. To make local
audio actually play: wire an ONNX runtime (e.g. the `ort` crate) into
`kokoro_speak`, and publish the Kokoro release asset with real checksums.

**Wiring note:** at the time of writing, `src-tauri/lib.rs` and `Cargo.toml` had
concurrent uncommitted changes from a separate local-model (Ollama) feature, so
the Kokoro registration was kept out of the voice commit to avoid entangling
that work. To activate `kokoro.rs`, ensure these lines are present (already
applied in the working tree and verified with `cargo check`):

```rust
// lib.rs
mod kokoro;
// ...in invoke_handler:
kokoro::kokoro_model_path, kokoro::kokoro_check_installed,
kokoro::kokoro_verify_checksums, kokoro::kokoro_status, kokoro::kokoro_warmup,
kokoro::kokoro_download, kokoro::kokoro_resume_download, kokoro::kokoro_repair,
kokoro::kokoro_delete_corrupt, kokoro::kokoro_speak, kokoro::kokoro_stop,
```

```toml
# Cargo.toml [dependencies]
sha2 = "0.10"
```

## Testing

```bash
cd app
npx vitest run src/features/voice/   # 51 voice unit tests
npx tsc --noEmit                      # typecheck
```

Covered: text cleanup, chunking, plan/cost mapping, provider fallback chain,
queue/stop, OS path resolution, usage copy.

## Troubleshooting voice

- **No sound, free user** — local model still downloading; system TTS is used
  meanwhile. Settings → Cloud Voice → "Download / Repair Local Voice Model".
- **"switched to local Kokoro voice"** — cloud quota exhausted or provider down;
  expected fallback behavior.
- **Cloud voice never engages** — confirm you're signed in and on a paid plan,
  and that the Edge Function secrets are set.
