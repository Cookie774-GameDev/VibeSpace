# Security / Production Checklist

Status of the subscription/voice/calling/messaging system. ✅ done, ⏳ blocked
on your secrets/artifacts, ⚠️ follow-up.

## Secrets & key handling
- ✅ No company API keys in frontend/Tauri/client code (secret scan clean).
- ✅ Company keys read only from Supabase secrets inside Edge Functions.
- ✅ `.env` / `supabase/.temp` gitignored; no secrets committed.
- ✅ Service-role key used only server-side.
- ⏳ Set: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_*_PRICE_ID`,
  `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `TWILIO_*`,
  `APP_BASE_URL`.

## Database / RLS
- ✅ RLS enabled on all user-sensitive tables (voice/message/call usage+events,
  rate limits, subscription_events, api_key_settings).
- ✅ Users read only their own rows; cannot write usage/events/plan/quota.
- ✅ Service-role-only tables (`*_rate_limits`, `subscription_events`) deny
  client reads.
- ✅ Quota RPCs revoked from `anon`/`authenticated`.
- ✅ Atomic reservation (`SELECT ... FOR UPDATE`) prevents parallel-request
  budget bypass for voice, message, and call.
- ⏳ Push + live-verify on the database (needs `SUPABASE_DB_PASSWORD`); run
  `supabase/tests/rls_voice_verification.sql`.

## Payments (Stripe)
- ✅ Raw-body webhook signature verification.
- ✅ Idempotent via unique `event_id`.
- ✅ Server-side price→plan mapping; frontend price/plan never trusted.
- ✅ Benefits granted only after Stripe confirmation; failed invoice → free.
- ⏳ End-to-end test-mode verification (needs keys + products).

## Calling / messaging (Twilio)
- ✅ `X-Twilio-Signature` HMAC-SHA1 verification on all webhooks.
- ✅ Auth + subscription + budget checks before a call; hard duration cap.
- ✅ SMS STOP/HELP opt-out handling.
- ✅ Auth token server-side only, never logged.
- ⏳ Live call/SMS verification (needs Twilio creds).
- ⚠️ In-call media agent (STT→LLM→TTS) is a greeting+cap stub.

## Voice
- ✅ Cloud TTS only via `tts-speak`: auth, approved provider/preset allow-list,
  empty/oversized rejection, rate limit, atomic quota, safe coded errors.
- ✅ Fallback chain cloud → Kokoro → system TTS; free users can't use company
  cloud TTS.
- ✅ Kokoro Rust command surface compiles into the app; real download/checksum/
  resume/repair. `kokoro_speak` returns `engine_not_available` → system fallback.
- ⏳ Real Kokoro audio needs an ONNX runtime + published model asset.

## App / Tauri
- ✅ Production frontend build + Rust release build (`jarvis.exe`) succeed.
- ✅ Terminal/launcher/wake-command/chat untouched; terminal encoding bug fixed.
- ⚠️ Interactive GUI smoke test not automatable here — launch manually to verify.
- ⚠️ Cross-platform: Windows verified; macOS/Linux not executed (no machines).

## Dependencies
- ✅ `npm audit`: 0 high/critical (2 moderate, not force-upgraded).

## Not production-ready until
1. `db push` applied (DB password).
2. All provider/Stripe/Twilio secrets set.
3. Stripe test checkout + webhook verified.
4. Real Kokoro model artifact published & runtime wired (today: graceful
   system-TTS fallback).
5. macOS/Linux build/test.
