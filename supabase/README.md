# Jarvis Hosted (Supabase backend)

Optional $5/month tier that runs DeepSeek through a Supabase Edge Function so
users don't have to manage their own API keys. BYOK is still supported in
parallel - the hosted tier just removes the friction.

## Layout

```
supabase/
  schema.sql                       canonical schema (mirror of 0001_init.sql)
  migrations/0001_init.sql         applied via `supabase db push`
  functions/jarvis-proxy/index.ts  Deno Edge Function
```

## One-time setup

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
   Re-running `db push` is safe; the SQL is idempotent.

4. **Set the DeepSeek key as a function secret**:
   ```sh
   supabase secrets set DEEPSEEK_API_KEY=sk-...
   ```
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
   provided automatically to functions; you do not need to set them yourself.

5. **Deploy the function**:
   ```sh
   supabase functions deploy jarvis-proxy
   ```
   Endpoint will be `https://<project-ref>.functions.supabase.co/jarvis-proxy`.

6. **Wire the desktop app**: open Jarvis -> Settings -> Hosted Jarvis and
   paste your project URL + anon key. They land in `app/.env.local` as
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Tiers

| Tier         | Monthly quota | Notes                                       |
| ------------ | ------------- | ------------------------------------------- |
| `free`       | 50            | Default for new sign-ups.                   |
| `plus`       | 1500          | $5/month. Bumped via Stripe webhook (TBD).  |
| `byok-only`  | (unmetered)   | Skips the proxy. Requests still log usage.  |

The proxy enforces quotas by counting `status = 'ok'` rows in `usage_log` for
the current calendar month. `byok-only` skips the check entirely.

## Vault note

`api_keys.encrypted` is a `text` column. If your project has Supabase Vault
enabled, store a Vault secret reference (`vault:<uuid>`) instead of the raw
key and decrypt server-side. The Edge Function does not currently read this
table - BYOK keys live on the client. The column exists so a future
"hosted BYOK" mode can lift them server-side without another migration.

## Stripe (out of scope)

The settings panel ships an "Upgrade to Plus ($5/month)" button that points
at `VITE_STRIPE_CHECKOUT_URL` if defined; otherwise it shows a "coming soon"
toast. Wire a Stripe Checkout session + webhook (`customer.subscription.*`)
to flip `profiles.tier` to `plus` and bump `monthly_quota` to 1500.

## Local testing

```sh
supabase start                                  # boot local stack
supabase functions serve jarvis-proxy --env-file ./.env
```
The function expects an `Authorization: Bearer <jwt>` header from a real
Supabase user. Generate one via `supabase.auth.signInWithPassword` against
the local `studio` instance.
