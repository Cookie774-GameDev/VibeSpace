# VibeSpace 0.1.5

First release that bundles the full Supabase backend.

## Highlights

- **Cloud sync ready.** New Supabase schema (`supabase/migrations/00*.sql`)
  defines 22 tables for chats, messages, tasks, reminders, memories,
  agents, calendar events, integrations, quick links, terminal sessions,
  phone settings, billing, and the BYOK key vault. Every user-owned
  table is RLS-locked to its owner; the planner caches `auth.uid()` once
  per query (init-plan optimisation).
- **Auth → profile pipeline.** New `auth.users` rows trigger a
  `public.profiles` insert automatically (`handle_new_user` SECURITY
  DEFINER). No client-side bootstrap needed.
- **Stripe-ready billing.** `subscriptions` and `stripe_events` tables
  plus a `sync_profile_tier_from_subscription` trigger that mirrors the
  active plan into `profiles.tier` + `profiles.monthly_quota`. Webhook
  function still TODO.
- **Models catalog.** `public.models_catalog` seeded with 17 known models
  across Google, Anthropic, OpenAI, DeepSeek, Groq, xAI, Mistral, Cohere,
  Ollama, and the dev mock. The frontend picker can hydrate from this
  table instead of hardcoded lists.
- **Phone-Jarvis schema.** `phone_settings`, `outbound_pending`, and
  `call_audit` tables. PIN verification uses a pure-plpgsql PBKDF2-SHA256
  helper that's byte-for-byte compatible with the Python cloud's
  `hashlib.pbkdf2_hmac`.
- **Typed Supabase client.** `app/src/lib/supabase/types.ts` regenerated
  to match the new schema; legacy `'plus'` and `'byok-only'` tier values
  remain valid so existing UI keeps working.
- **`npm run jarvis`.** Convenience alias that runs Vite with `--host`
  + `--open`, so you can boot the dev server without remembering flags.
- **Release pipeline.** `npm run release:windows` builds, stages, and
  checksums Windows installers under `releases/`.

## Database migrations applied

```
0001_core_identity_billing            profiles, api_keys, usage_log + view
0002_phone_jarvis                     phone_settings, outbound_pending, call_audit, RPCs
0003_workspace_app_entities           workspaces, projects, agents, chats, messages,
                                      tasks, reminders, memories, events,
                                      integrations, quick_links, terminal_sessions
0004_billing_stripe                   subscriptions, stripe_events, tier-sync trigger
0005_models_catalog                   public model catalog + 17-row seed
0006_signup_trigger                   auto-create profile on auth.users insert
0007_security_hardening               advisor fixes (search_path, RPC revokes)
0008_revoke_anon_rpc                  tighten set_phone_pin
0009_perf_rls_initplan_and_indexes    RLS perf rewrites + FK covering indexes
```

## Known gaps (will land in 0.1.6)

- `jarvis-proxy` edge function still hardcodes DeepSeek; needs a router
  for the four-tier hosted model.
- Stripe webhook function not yet shipped; schema is ready for it.
- Hosted-BYOK mode (server-side reading of `api_keys.encrypted`) still
  client-only.

## Verify your download

The SHA-256 of the staged installers is in `releases/SHA256SUMS.txt`
sitting next to the binaries. Compare before running:

```powershell
Get-FileHash -Algorithm SHA256 .\Jarvis_0.1.5_x64-setup.exe
```

```bash
sha256sum Jarvis_0.1.5_amd64.deb
```

## Install

See [DOWNLOAD.md](../DOWNLOAD.md) for one-line install commands per
platform and the manual fallback.

## Upgrading from 0.1.4

Existing installs upgrade in place — user data lives in the OS app-data
folder and is preserved. The Supabase migrations are idempotent; if you
run a private project, apply them with:

```sh
supabase db push
```

No action is required if you only used the local-first features.
