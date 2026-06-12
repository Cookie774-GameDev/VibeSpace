# Supabase Setup

Project ref: `tipeobvisjqvpbzcpckh`

## 1. Link the CLI

```powershell
npx supabase link --project-ref tipeobvisjqvpbzcpckh
```

## 2. Push migrations (requires the DB password)

The migration history can't be read or pushed without the database password.

```powershell
$env:SUPABASE_DB_PASSWORD="<your database password>"   # Settings → Database
npx supabase migration list
npx supabase db push --debug
```

Migrations applied:
- `0001`–`0011` — existing core/identity/billing/workspace/models.
- `0012_voice_subscription.sql` — voice usage/events/rate-limits/BYOK + atomic
  `reserve_voice_seconds` / `settle_voice_seconds` / `voice_rate_limit_hit`.
- `0013_message_call_budgets.sql` — `subscription_plan_limits`, message + call
  usage/events/rate-limits, `reserve_message_budget` / `settle_message_budget`,
  `reserve_call_budget` / `settle_call_budget`, `get_current_plan_limits`,
  `reset_monthly_usage_if_needed`, `record_usage_event`, and the
  `profiles.tier` → usage sync triggers.
- `0019_deepgram_launch_promo.sql` — $1k Deepgram launch pool, per-plan one-time
  promo seconds, `reserve_deepgram_promo` / `settle_deepgram_promo`.
- `0020_security_voice_promo_hardening.sql` — $1k pool bump (from $6k on live),
  promo settlement caps, admin self-check, client write deny on promo tables.

To add $5k more credit later (pool → $6k):

```sql
update public.deepgram_promo_pool
   set budget_usd = 6000, pause_at_usd = 5400, active = true, updated_at = now()
 where id = 1;
```

## API keys — where each secret lives

| Secret | Where to set | Used by |
|--------|----------------|---------|
| `VITE_SUPABASE_URL` | `app/.env.local` | Desktop app (client) |
| `VITE_SUPABASE_ANON_KEY` | `app/.env.local` | Desktop app auth |
| `OPENAI_API_KEY` | Supabase → Edge Functions → Secrets | `tts-speak`, `message-complete` |
| `DEEPGRAM_API_KEY` | Supabase secrets | `tts-speak` (company cloud TTS) |
| `ELEVENLABS_API_KEY` | Supabase secrets | `tts-speak` |
| `STRIPE_SECRET_KEY` | Supabase secrets | checkout + webhook |
| `STRIPE_WEBHOOK_SECRET` | Supabase secrets | `stripe-webhook` |
| `STRIPE_*_PRICE_ID` (×3) | Supabase secrets | checkout + webhook tier mapping |
| `TWILIO_*` | Supabase secrets | `call-start`, Twilio webhooks |
| `APP_BASE_URL` | Supabase secrets | Stripe redirects, Twilio callbacks |
| Deepgram BYOK | Settings → Voice (OS keychain) | Local `deepgram_tts` bypasses promo |

User BYOK keys (OpenAI, Anthropic, etc.) go in **Settings → Providers** and never
touch Supabase. Company-paid cloud voice always flows through `tts-speak` with
JWT + server-side quota.

## 3. Verify RLS + quota logic

```powershell
psql $env:SUPABASE_DB_URL -f supabase/tests/rls_voice_verification.sql
```

This asserts: RLS enabled on every sensitive table, service-role-only tables
block client reads, usage/events are read-only-own for clients, the quota RPCs
are revoked from `anon`/`authenticated`, plan→budget math is correct, and the
atomic reservation rejects over-quota requests.

## 4. Set secrets

See `docs/stripe-setup.md` and `docs/twilio-calling-setup.md`. Check with:

```powershell
npx supabase secrets list   # shows names + digests only, never values
```

## 5. Deploy Edge Functions

```powershell
# Auth-protected (default JWT verification):
npx supabase functions deploy tts-speak get-voice-usage get-message-usage `
  get-call-usage message-complete call-start create-checkout-session create-customer-portal
# Public / externally-signed (skip Supabase JWT):
npx supabase functions deploy model-manifest --no-verify-jwt
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy twilio-voice-webhook --no-verify-jwt
npx supabase functions deploy twilio-message-webhook --no-verify-jwt
npx supabase functions deploy call-status --no-verify-jwt
```

`model-manifest` is already deployed and returns valid JSON.

## Security model

- RLS on all user tables; users read only their own rows.
- Users cannot change plan/quota/usage; only the service role (Edge Functions)
  writes those. Plan changes flow exclusively from the Stripe webhook.
- Quota is reserved atomically (`SELECT ... FOR UPDATE`) so parallel requests
  can't exceed budget.
- Company API keys live only in Supabase secrets, never in the client.
