-- =============================================================================
-- Jarvis Hosted - Postgres schema
-- =============================================================================
-- Backs the optional $5/month hosted tier. The desktop app's local-first
-- sync schema lives separately under `app/supabase/`. This file only covers:
--
--   * profiles      - per-user tier + quota
--   * api_keys      - vault-encrypted (or plain) BYOK secrets
--   * usage_log     - one row per proxied request
--   * usage_month   - aggregated view of the log
--
-- Apply via the Supabase CLI (`supabase db push`) or paste into the SQL
-- editor. All DDL is idempotent so re-running is safe.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- profiles
-- One row per auth.users entry. Created client-side on first sign-in via
-- HostedJarvis.tsx; a Stripe webhook (future) updates `tier` + `monthly_quota`.
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  email         text,
  tier          text not null default 'free'
                check (tier in ('free', 'plus', 'byok-only')),
  monthly_quota integer not null default 50,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- api_keys
-- `encrypted` should hold a Vault secret reference when Vault is available
-- on the project; otherwise it stores the raw key. See README -> "Vault note".
-- -----------------------------------------------------------------------------
create table if not exists public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,
  label       text,
  encrypted   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists api_keys_user_idx on public.api_keys (user_id);

-- -----------------------------------------------------------------------------
-- usage_log
-- One row per proxied request. Inserted by the jarvis-proxy Edge Function
-- using the service role key (bypasses RLS). Clients can only SELECT.
-- -----------------------------------------------------------------------------
create table if not exists public.usage_log (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  ts                timestamptz not null default now(),
  provider          text not null,
  model             text not null,
  prompt_tokens     integer,
  completion_tokens integer,
  cost_usd          numeric(10, 6),
  status            text not null check (status in ('ok', 'rate_limit', 'error')),
  latency_ms        integer
);
create index if not exists usage_log_user_ts_idx on public.usage_log (user_id, ts desc);

-- -----------------------------------------------------------------------------
-- usage_month (view)
-- Per-user, per-month count of successful requests. Marked
-- `security_invoker` so it inherits RLS from usage_log instead of running
-- with the view-owner's privileges.
-- -----------------------------------------------------------------------------
create or replace view public.usage_month
with (security_invoker = true)
as
select
  user_id,
  count(*) filter (where status = 'ok') as ok_count,
  date_trunc('month', ts) as month
from public.usage_log
group by user_id, month;

-- -----------------------------------------------------------------------------
-- RLS - each user only sees their own rows.
-- usage_log is read-only from the client; inserts come from the Edge
-- Function via the service role.
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.usage_log enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "own keys" on public.api_keys;
create policy "own keys" on public.api_keys
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own usage" on public.usage_log;
create policy "own usage" on public.usage_log
  for select
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- updated_at trigger for profiles (api_keys + usage_log are append-mostly).
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at_ts()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated on public.profiles;
create trigger profiles_touch_updated
  before update on public.profiles
  for each row
  when (old.updated_at is not distinct from new.updated_at)
  execute function public.touch_updated_at_ts();
