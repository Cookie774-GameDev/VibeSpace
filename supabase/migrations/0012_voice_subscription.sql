-- =============================================================================
-- 0012_voice_subscription: voice usage tracking, events, rate limits, BYOK
-- =============================================================================
-- Integrates with existing billing (public.profiles.tier, public.subscriptions
-- from 0004). Adds voice-specific metering tables + an atomic quota-reservation
-- RPC used only by the tts-speak Edge Function (service role).
--
-- Cost model: cloud TTS metered in seconds of generated audio.
--   COST_PER_SECOND_USD = 0.00025  (~$0.015/min, OpenAI gpt-4o-mini-tts)
--   Starter $2 -> 8000s (~2.2h)  Pro $10 -> 40000s (~11h)  Ultra $20 -> 80000s (~22h)
-- =============================================================================

create table if not exists public.voice_usage (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  plan                    text not null default 'free'
                          check (plan in ('free','starter','pro','ultra')),
  provider                text not null default 'kokoro_local',
  monthly_budget_usd      numeric not null default 0,
  monthly_seconds_limit   integer not null default 0,
  monthly_seconds_used    integer not null default 0,
  estimated_cost_used_usd numeric not null default 0,
  reset_date              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id)
);
alter table public.voice_usage enable row level security;
drop policy if exists "voice_usage_select_own" on public.voice_usage;
create policy "voice_usage_select_own" on public.voice_usage
  for select using ((select auth.uid()) = user_id);

create table if not exists public.voice_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  provider            text not null,
  voice_preset        text,
  text_chars          integer,
  estimated_seconds   integer,
  actual_seconds      integer,
  estimated_cost_usd  numeric,
  status              text not null default 'pending',
  error_code          text,
  created_at          timestamptz not null default now()
);
alter table public.voice_events enable row level security;
drop policy if exists "voice_events_select_own" on public.voice_events;
create policy "voice_events_select_own" on public.voice_events
  for select using ((select auth.uid()) = user_id);

create table if not exists public.subscription_events (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid references auth.users(id) on delete set null,
  stripe_customer_id       text,
  stripe_subscription_id   text,
  event_type               text not null,
  event_id                 text unique not null,
  processed                boolean not null default false,
  payload                  jsonb,
  created_at               timestamptz not null default now()
);
alter table public.subscription_events enable row level security;
drop policy if exists "subscription_events_no_client" on public.subscription_events;
create policy "subscription_events_no_client" on public.subscription_events
  for select using (false);

create table if not exists public.voice_rate_limits (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  window_start   timestamptz not null,
  request_count  integer not null default 0,
  total_chars    integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, window_start)
);
alter table public.voice_rate_limits enable row level security;
drop policy if exists "voice_rate_limits_no_client" on public.voice_rate_limits;
create policy "voice_rate_limits_no_client" on public.voice_rate_limits
  for select using (false);

create table if not exists public.api_key_settings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null,
  encrypted_key text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, provider)
);
alter table public.api_key_settings enable row level security;
drop policy if exists "api_key_settings_select_own" on public.api_key_settings;
create policy "api_key_settings_select_own" on public.api_key_settings
  for select using ((select auth.uid()) = user_id);
drop policy if exists "api_key_settings_insert_own" on public.api_key_settings;
create policy "api_key_settings_insert_own" on public.api_key_settings
  for insert with check ((select auth.uid()) = user_id);
drop policy if exists "api_key_settings_update_own" on public.api_key_settings;
create policy "api_key_settings_update_own" on public.api_key_settings
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "api_key_settings_delete_own" on public.api_key_settings;
create policy "api_key_settings_delete_own" on public.api_key_settings
  for delete using ((select auth.uid()) = user_id);

create or replace function public.voice_seconds_for_budget(p_budget numeric)
returns integer language sql immutable as $$
  select floor(coalesce(p_budget, 0) / 0.00025)::integer;
$$;

create or replace function public.voice_budget_for_plan(p_plan text)
returns numeric language sql immutable as $$
  select case p_plan
           when 'starter' then 2::numeric
           when 'pro'     then 10::numeric
           when 'ultra'   then 20::numeric
           else 0::numeric end;
$$;

create or replace function public.sync_voice_usage_for_user(p_user_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_budget numeric := public.voice_budget_for_plan(p_plan);
  v_limit  integer := public.voice_seconds_for_budget(v_budget);
begin
  insert into public.voice_usage (user_id, plan, monthly_budget_usd, monthly_seconds_limit,
                                  monthly_seconds_used, reset_date)
  values (p_user_id, p_plan, v_budget, v_limit, 0, date_trunc('month', now()) + interval '1 month')
  on conflict (user_id) do update
    set plan = excluded.plan,
        monthly_budget_usd = excluded.monthly_budget_usd,
        monthly_seconds_limit = excluded.monthly_seconds_limit,
        updated_at = now();
end;
$$;
revoke all on function public.sync_voice_usage_for_user(uuid, text) from public, anon, authenticated;

create or replace function public.voice_usage_on_profile_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_voice_usage_for_user(new.id, coalesce(new.tier, 'free'));
  return new;
end;
$$;
revoke all on function public.voice_usage_on_profile_tier() from public, anon, authenticated;
drop trigger if exists profiles_sync_voice_usage on public.profiles;
create trigger profiles_sync_voice_usage
  after insert or update of tier on public.profiles
  for each row execute function public.voice_usage_on_profile_tier();

create or replace function public.reserve_voice_seconds(p_user_id uuid, p_estimate_secs integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row       public.voice_usage%rowtype;
  v_remaining integer;
begin
  select * into v_row from public.voice_usage where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_usage_row');
  end if;
  if v_row.reset_date is not null and now() >= v_row.reset_date then
    update public.voice_usage
       set monthly_seconds_used = 0, estimated_cost_used_usd = 0,
           reset_date = date_trunc('month', now()) + interval '1 month', updated_at = now()
     where user_id = p_user_id returning * into v_row;
  end if;
  v_remaining := v_row.monthly_seconds_limit - v_row.monthly_seconds_used;
  if v_row.monthly_seconds_limit <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_cloud_quota');
  end if;
  if v_remaining < p_estimate_secs then
    return jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'remaining', v_remaining);
  end if;
  update public.voice_usage
     set monthly_seconds_used = monthly_seconds_used + p_estimate_secs,
         estimated_cost_used_usd = estimated_cost_used_usd + (p_estimate_secs * 0.00025),
         updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'remaining', greatest(0, v_remaining - p_estimate_secs));
end;
$$;
revoke all on function public.reserve_voice_seconds(uuid, integer) from public, anon, authenticated;

create or replace function public.settle_voice_seconds(p_user_id uuid, p_reserved integer, p_actual integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_delta integer := coalesce(p_actual, 0) - coalesce(p_reserved, 0);
begin
  update public.voice_usage
     set monthly_seconds_used = greatest(0, monthly_seconds_used + v_delta),
         estimated_cost_used_usd = greatest(0, estimated_cost_used_usd + (v_delta * 0.00025)),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_voice_seconds(uuid, integer, integer) from public, anon, authenticated;

-- Atomic rate-limit increment for a sliding window (service role only).
-- Upserts the per-user/window counter and reports whether the limit is exceeded.
create or replace function public.voice_rate_limit_hit(
  p_user_id uuid, p_window_start timestamptz, p_chars integer, p_max_requests integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  insert into public.voice_rate_limits (user_id, window_start, request_count, total_chars)
  values (p_user_id, p_window_start, 1, greatest(coalesce(p_chars, 0), 0))
  on conflict (user_id, window_start) do update
    set request_count = public.voice_rate_limits.request_count + 1,
        total_chars = public.voice_rate_limits.total_chars + greatest(coalesce(p_chars, 0), 0),
        updated_at = now()
  returning request_count into v_count;
  return jsonb_build_object('count', v_count, 'limited', v_count > p_max_requests);
end;
$$;
revoke all on function public.voice_rate_limit_hit(uuid, timestamptz, integer, integer) from public, anon, authenticated;

create index if not exists voice_usage_user_id_idx on public.voice_usage (user_id);
create index if not exists voice_events_user_id_idx on public.voice_events (user_id);
create index if not exists voice_events_created_at_idx on public.voice_events (created_at desc);
create index if not exists subscription_events_event_id_idx on public.subscription_events (event_id);
create index if not exists voice_rate_limits_user_window_idx on public.voice_rate_limits (user_id, window_start);
