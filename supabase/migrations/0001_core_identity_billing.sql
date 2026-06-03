-- =============================================================================
-- 0001_core_identity_billing: profiles, api_keys, usage_log
-- =============================================================================
-- Per-user identity, BYOK API keys, and per-request usage tracking.
-- Tier values match the frontend's PlanId in app/src/lib/entitlements.ts;
-- the legacy 'byok-only' value is preserved so the existing jarvis-proxy
-- edge function (which checks `tier !== 'byok-only'`) keeps functioning.
-- All DDL is idempotent.

create extension if not exists "pgcrypto";

-- profiles ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  display_name        text,
  email               text,
  tier                text not null default 'free'
                      check (tier in ('free','starter','pro','ultra','byok-only')),
  monthly_quota       integer not null default 50,
  stripe_customer_id  text unique,
  persona_preset      text not null default 'jarvis'
                      check (persona_preset in ('jarvis','athena','edge','watson','hal','sage','custom')),
  default_provider    text not null default 'google',
  telemetry_opt_in    boolean not null default false,
  offline_mode        boolean not null default false,
  default_local_model text not null default 'llama3.2',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- api_keys ---------------------------------------------------------------------
-- BYOK provider keys. `encrypted` should hold a Vault secret reference
-- (vault:<uuid>) when the project has Supabase Vault enabled, otherwise
-- the raw key. The Edge Function does not currently read this table -
-- BYOK keys live on the client until "hosted BYOK" mode ships.
create table if not exists public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,
  label       text,
  encrypted   text not null,
  last_used_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, provider, label)
);
create index if not exists api_keys_user_idx on public.api_keys (user_id);

-- usage_log --------------------------------------------------------------------
-- One row per proxied request. Inserted by the jarvis-proxy edge function
-- using the service role key (bypasses RLS). Clients can only SELECT.
create table if not exists public.usage_log (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  ts                timestamptz not null default now(),
  provider          text not null,
  model             text not null,
  prompt_tokens     integer,
  completion_tokens integer,
  cost_usd          numeric(12, 6),
  status            text not null check (status in ('ok','rate_limit','error')),
  latency_ms        integer
);
create index if not exists usage_log_user_ts_idx on public.usage_log (user_id, ts desc);

-- usage_month view -------------------------------------------------------------
create or replace view public.usage_month
with (security_invoker = true)
as
select
  user_id,
  count(*) filter (where status = 'ok') as ok_count,
  date_trunc('month', ts) as month
from public.usage_log
group by user_id, month;

-- RLS --------------------------------------------------------------------------
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

-- updated_at trigger -----------------------------------------------------------
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
