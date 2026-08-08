# VibeSpace on Supabase

Supabase provides the authenticated cloud boundary for VibeSpace profiles,
Access, subscriptions, shared credits, hosted AI/voice usage, calling,
messaging, wallpapers, and optional account sync. The desktop app remains
local-first.

## Deployment safety

Do not deploy from this directory until the target has been proven to be the
intended VibeSpace project. The expected connected alias is
`jarvis-one-app-supabase`; an alias alone is not proof. Before every mutation:

1. authenticate the Supabase CLI;
2. inspect the linked project reference and organization;
3. compare them with the owner-approved VibeSpace target;
4. stop if the identity is missing, ambiguous, or names AccessRevamp or another
   product;
5. use an isolated test project and Stripe test mode first.

Never run production migrations, deploy functions, create live Stripe objects,
or change live billing from an unverified session.

## Layout and schema authority

```text
supabase/
  migrations/   ordered database migrations
  functions/    Edge Functions and shared server-only modules
  templates/    authentication email templates
  tests/        migration, RLS, billing, webhook, and function contracts
  config.toml   local stack and Edge Function JWT policy
```

The current ordered migration set runs from
`0001_core_identity_billing.sql` through
`0040_telemetry_reward_discount.sql`. Migration number `0025` is intentionally
unused; do not renumber later migrations to fill the gap. Always apply the
complete committed migration set in filename order with `supabase db push`.
Do not manually cherry-pick only the early migrations and do not assume an
arbitrary migration can be safely rerun outside the migration ledger.

Major schema phases are:

| Range         | Authority                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `0001`–`0011` | identity, initial billing, app entities, catalog, signup, RLS hardening, sync, plugin metadata             |
| `0012`–`0024` | voice/message/call budgets, billing protection, admin authority, Deepgram promotion, rewards hardening     |
| `0026`–`0030` | Hive credits, Supernova (`apex`), client-admin revocation, provider budgets, unified credit reservation    |
| `0031`–`0035` | wallpapers and server-authoritative Access, reconciliation, lease freshness, checkout attempts             |
| `0036`–`0040` | owner-approved billing/calling, profile owner policies, advisor hardening, contact reads, telemetry reward |

## Local development

The local stack requires the Supabase CLI and its supported container runtime:

```powershell
supabase start
supabase db reset
supabase migration list
```

`db reset` applies the committed migrations and `seed.sql` to the disposable
local database. It must not be pointed at a hosted production project.

Serve an authenticated function locally with:

```powershell
supabase functions serve message-complete --env-file .\.env
```

Local auth mail is available in Inbucket at `http://127.0.0.1:54324`.
`config.toml` uses six-digit email OTPs and requires email confirmation.

## Desktop build configuration

Official builds receive only the public Supabase URL and publishable key:

```dotenv
VITE_SUPABASE_URL=https://<verified-vibespace-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-key>
VITE_ENABLE_CLOUD_SYNC=true
```

Do not put the service-role key, Stripe secret key, webhook signing secret,
provider company keys, telephony credentials, or lease-signing private JWK in
any `VITE_*` value. See the repository root `.env.example` for the complete
public/server variable split.

## Owner-approved billing contract

The canonical runtime catalog is
`functions/_shared/billingCatalog.ts`; migration `0036` installs the matching
credit authority. Internal plan IDs are retained for compatibility, while the
customer-facing package names and economics are:

| Plan ID   | Package     | Access | Add-on | Total/month | Shared credits | Provider value |
| --------- | ----------- | -----: | -----: | ----------: | -------------: | -------------: |
| `free`    | Spark       |    $20 |     $0 |         $20 |          1,000 |          $1.00 |
| `starter` | Orbit       |    $20 |    $10 |         $30 |          5,500 |          $5.50 |
| `pro`     | Nova        |    $20 |    $50 |         $70 |         27,500 |         $27.50 |
| `ultra`   | Singularity |    $20 |   $100 |        $120 |         55,000 |         $55.00 |
| `apex`    | Supernova   |    $20 |   $200 |        $220 |        110,000 |        $110.00 |

One shared credit represents `$0.001` of company-paid provider usage. The
database reserves credits conservatively before provider work and settles
against actual cost. BYOK calls do not consume the company-paid pool.

Stripe checkout is server-created and account-bound:

- Spark uses the recurring Access price only.
- Paid packages use the Access price plus exactly one selected add-on price on
  one subscription/invoice.
- Add-on price IDs map to exactly one internal plan.
- Webhook events are signature-verified, idempotent, and reconciled to the
  authenticated Supabase account.
- The optional telemetry reward is exactly 10% off when the current explicit
  consent contract is satisfied. It fails closed and does not create an
  additional stackable discount.

The approved lookup keys are:

```text
vibespace_access_monthly_v1
vibespace_orbit_addon_monthly_v1
vibespace_nova_addon_monthly_v1
vibespace_singularity_addon_monthly_v1
vibespace_supernova_addon_monthly_v1
```

No static `buy.stripe.com` link is authoritative for account entitlements.

## Edge Functions

`config.toml` is the JWT-policy authority. User-initiated functions require a
valid Supabase JWT. Provider callbacks disable gateway JWT verification where
the function verifies the provider signature itself; intentionally public
read-only routes document their own boundary.

Authenticated/account-bound functions include:

- `create-access-checkout`, `create-access-portal`, `access-lease`
- `create-checkout-session`, `create-customer-portal`
- `telemetry-consent`, `claim-launch-promo`
- `message-complete`, `stack-complete`, `tts-speak`
- `call-start`, `third-party-call`, `sms-send`
- `get-message-usage`, `get-call-usage`, `get-voice-usage`
- `github-context`

Gateway-JWT-disabled public/provider routes include:

- `stripe-webhook`
- `telnyx-call-webhook`
- `call-status`
- `twilio-voice-webhook`
- `twilio-message-webhook`
- `model-manifest`

The callback routes validate their provider signatures. `model-manifest` is an
intentional bounded public read and does not accept a provider callback.

Additional deployed modules include `jarvis-proxy` and the wallpaper catalog,
download, and redemption functions. Confirm each function's committed
authentication boundary before deployment; never infer it from the folder
name.

Deploy only to the verified isolated target:

```powershell
supabase db push
supabase functions deploy <function-name>
```

Functions receiving Stripe or telephony callbacks must retain the exact
`verify_jwt = false` entries in `config.toml`; their own signature checks are
the security boundary. Do not copy that setting to authenticated functions.

## Server-only secrets

Set secrets through the verified Supabase project, never in client code:

```powershell
supabase secrets set NAME="value"
```

The full names and descriptions live in `.env.example`. Load-bearing groups
include:

- Stripe keys, webhook secret, Access/add-on price IDs, and telemetry coupon
  policy;
- exact `APP_VERSION`, Access grace policy, and offline lease signer;
- Supabase service-role key;
- company-paid OpenAI, Deepgram, and ElevenLabs keys;
- Twilio credentials and public callback base URL;
- model-manifest/release locations.

Do not paste secret values into documentation, logs, screenshots, issue
comments, or renderer-visible state.

## Authentication and RLS

The app signs up with email/password and verifies with a six-digit signup OTP.
Magic-link-only sign-in uses the email OTP flow. Hosted environments must
enable email confirmation, install the templates under `templates/`, and
configure reliable SMTP.

User-owned rows are protected by owner-bound RLS. Migrations `0037` and `0038`
replace profile policies with the canonical authenticated owner select/update
pair and restrict profile updates to `display_name`. Billing, Access,
entitlement, reward, and provider-event mutations are server-authoritative.
Never treat a client-visible email, local flag, or plan label as authorization.

Before hosted closure, prove negative cases with two real test accounts:

- cross-account profile, subscription, usage, lease, contact, and call access
  is denied;
- expired, revoked, wrong-account, wrong-version, replayed, and rolled-back
  Access evidence fails closed;
- duplicate checkout/webhook/provider events remain idempotent;
- invalid signatures and missing configuration create no billing/provider side
  effects.

## Verification

Run the committed contract tests before any hosted mutation. The Node-based
tests under `supabase/tests` validate migration text and Edge Function
contracts without external access. SQL behavior scripts require a disposable
Postgres/Supabase instance.

After deployment to the verified test target, exercise the real lifecycle:

1. sign up and verify two isolated accounts;
2. apply every committed migration;
3. deploy the required functions with their committed JWT policy;
4. create Stripe test products/prices and configure test webhooks;
5. verify checkout, portal, webhook retries, upgrades, downgrades,
   cancellation, grace, expiry, revocation, credits, and telemetry reward;
6. verify RLS and account isolation;
7. record the exact project, Stripe mode, migration state, function versions,
   test evidence, and rollback result.

If project identity, credentials, or required authority are unavailable, record
the exact item as `BLOCKED_EXTERNAL` or `REQUIRES_APPROVAL` and continue local
work. Never substitute an unrelated project.

## Regenerating TypeScript types

After an intentional schema change on the verified project:

```powershell
supabase gen types typescript --linked > app/src/lib/supabase/generated.ts
```

Review the diff and update the hand-written aliases in
`app/src/lib/supabase/types.ts` only when the schema boundary requires it.
