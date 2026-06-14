# VibeSpace on Supabase

Postgres + auth + edge functions backing the VibeSpace desktop app (formerly VibeSpace).

## Layout

```
supabase/
  migrations/                          run sequentially via `supabase db push`
    0001_core_identity_billing.sql     profiles, api_keys, usage_log, view
    0002_phone_jarvis.sql              phone_settings, outbound_pending, call_audit, RPCs
    0003_workspace_app_entities.sql    workspaces, projects, agents, chats, messages,
                                       tasks, reminders, memories, events,
                                       integrations, quick_links, terminal_sessions
    0004_billing_stripe.sql            subscriptions, stripe_events, tier sync trigger
    0005_models_catalog.sql            public model catalog + seed
    0006_signup_trigger.sql            auto-create profile on auth.users insert
    0007_security_hardening.sql        advisor fixes (search_path, RPC revokes)
    0008_revoke_anon_rpc.sql           tighten set_phone_pin
    0009_perf_rls_initplan_and_indexes.sql  RLS perf rewrites + FK covering indexes
    0010_app_sync_records.sql          generic desktop sync_queue document table
    0011_plugin_connections.sql        rejects secrets in plugin sync metadata
  functions/
    jarvis-proxy/                      hosted DeepSeek proxy edge function
  schema-phone-jarvis.sql              legacy single-file schema (kept for reference)
```

The `0001_init.sql` file from earlier scaffolding has been replaced by the
numbered migration set above. To bootstrap a fresh project, run the migrations
in order — they are idempotent, so re-running is safe.

## Desktop app env (maintainers)

Point `app/.env.local` at your Supabase project (Dashboard → Settings → General → Reference ID):

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key from Supabase → Project Settings → API>
VITE_ENABLE_CLOUD_SYNC=true
```

Do not commit real project refs or keys to git.

Apply migrations through `0011_plugin_connections.sql` before enabling
plugin metadata sync in production:

```sh
supabase migration list
```

## Email signup verification (6-digit OTP)

The desktop app signs users up with **email + password**, then verifies via a
**6-digit code** (`verifyOtp` with `type: 'signup'`). Magic-link-only sign-in
uses `signInWithOtp` + `type: 'email'`.

**Hosted project checklist** (Supabase Dashboard → Authentication):

1. **Providers → Email** — enable email signups; turn on **Confirm email**.
2. **Email templates** — set **Confirm signup** and **Magic link** bodies to
   include `{{ .Token }}` (not only `{{ .ConfirmationURL }}`), e.g. the HTML in
   `supabase/templates/confirmation.html` and `magic_link.html`.
3. **SMTP** — configure custom SMTP (Settings → Authentication → SMTP) so
   messages deliver reliably in production. Without SMTP, emails may not arrive.

Local `supabase start` uses Inbucket (`http://127.0.0.1:54324`) and the
templates in `supabase/templates/`. `config.toml` sets `otp_length = 6` and
`enable_confirmations = true`.

## One-time setup (new project)

1. **Init** (only if this directory wasn't created by `supabase init`):

   ```sh
   supabase init
   ```

2. **Link** to your Supabase project:

   ```sh
   supabase link --project-ref <your-project-ref>
   ```

3. **Apply the schema**:

   ```sh
   supabase db push
   ```

4. **Set the DeepSeek key as a function secret**:

   ```sh
   supabase secrets set DEEPSEEK_API_KEY=sk-...
   ```

   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
   provided automatically; you do not need to set them yourself.

5. **Deploy the function**:

   ```sh
   supabase functions deploy jarvis-proxy
   ```

   Endpoint will be `https://<project-ref>.functions.supabase.co/jarvis-proxy`.

6. **Wire the desktop app**: copy the project URL + publishable key into
   `app/.env.local`:
   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=sb_publishable_...
   ```

## Tiers

The canonical tier model lives in `app/src/lib/entitlements.ts`. The
database `profiles.tier` constraint allows all of these values:

| Tier        | Monthly quota | Notes                                                |
| ----------- | ------------- | ---------------------------------------------------- |
| `free`      | 50            | Default for new sign-ups. BYOK only.                 |
| `starter`   | 1500          | $5/mo. Hosted Gemini Flash + voice.                  |
| `pro`       | 5000          | $20/mo. Adds Claude Sonnet, GPT-4o, Gemini Pro.      |
| `ultra`     | 25000         | $100/mo. Adds Claude Opus and o-class reasoning.     |
| `byok-only` | (unmetered)   | Skips the proxy. Requests still log usage.           |
| `plus`      | (legacy)      | Pre-V2 value kept so old rows don't fail validation. |

`subscriptions_sync_profile` triggers on insert/update of
`public.subscriptions` and rewrites `profiles.tier` + `monthly_quota` to
match the active row, so the Stripe webhook only needs to upsert into
`subscriptions`.

## Tables (high-level)

- **identity & billing** — `profiles`, `api_keys`, `usage_log`,
  `usage_month` (view), `subscriptions`, `stripe_events`
- **phone-jarvis** — `phone_settings`, `outbound_pending`, `call_audit`
- **app domain** — `workspaces`, `projects`, `agents`, `chats`, `messages`,
  `tasks`, `reminders`, `memories`, `events`, `integrations`,
  `quick_links`, `terminal_sessions`
- **desktop sync** — `app_sync_records` stores local-first Dexie mutations
  from the desktop `sync_queue` as per-user JSON documents
- **catalog** — `models_catalog` (public read; service-role write)

Every user-owned table has RLS with a single policy: `auth.uid() = user_id`
(or `= id` for `profiles`). The check is wrapped as `(select auth.uid())`
so the planner caches it once per query.

## Functions

- `set_phone_pin(p_user_id, p_pin)` — hash a 4-8 digit PIN with PBKDF2-SHA256
  and write `phone_settings.pin_salt` + `pin_hash`. Authenticated users only;
  the body checks `auth.uid() = p_user_id` and raises `'forbidden'` otherwise.
- `pbkdf2_sha256(...)` — pure plpgsql implementation, byte-for-byte
  compatible with Python's `hashlib.pbkdf2_hmac('sha256', ...)`.
- `prune_outbound_pending()` — deletes rows older than 1 hour. Schedule via
  `pg_cron`.
- `prune_call_audit(p_days = 30)` — deletes rows older than `p_days`.
  Schedule via `pg_cron`.

The `handle_new_user` and `sync_profile_tier_from_subscription` trigger
functions have `EXECUTE` revoked from `anon`/`authenticated` so they can't
be called as REST RPCs.

## Vault note

`api_keys.encrypted` is a `text` column. If your project has Supabase Vault
enabled, store a Vault secret reference (`vault:<uuid>`) and decrypt
server-side. The Edge Function does not currently read this table — BYOK
keys live on the client. The column exists so a future "hosted BYOK" mode
can lift them server-side without another migration.

## Stripe (out of scope here)

The settings panel ships an "Upgrade" button that points at the
`VITE_STRIPE_CHECKOUT_*` env vars when defined; otherwise it shows a
"coming soon" toast. Wire a Stripe Checkout session + webhook
(`customer.subscription.*`) to upsert into `public.subscriptions`. The
`subscriptions_sync_profile` trigger handles the rest.

## Local testing

```sh
supabase start                                  # boot local stack
supabase db push                                # apply migrations to local
supabase functions serve jarvis-proxy --env-file ./.env
```

The function expects `Authorization: Bearer <jwt>` from a real Supabase
user. Generate one via `supabase.auth.signInWithPassword` against the local
`studio` instance.

## Regenerating TypeScript types

```sh
supabase gen types typescript --linked > app/src/lib/supabase/generated.ts
```

Then update the hand-written aliases in `app/src/lib/supabase/types.ts` if
the schema changed in a way that affects the convenience exports
(`Profile`, `ChatRow`, etc.).
