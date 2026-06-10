-- =============================================================================
-- 0013_message_call_budgets: messaging + calling usage metering & plan limits
-- =============================================================================
-- Extends the voice subscription system (0012) with separate MESSAGE-AI and
-- CALL/VOICE budgets, a server-authoritative plan-limits table, and atomic
-- reserve/settle RPCs. All budgets are enforced server-side; the client only
-- ever reads its own usage.
--
-- Budget model (USD/month, company-paid; never shown raw to users):
--   Free     msg $0      call/voice $0
--   Starter  msg $2.50   call/voice $2.50
--   Pro      msg $12.50  call/voice $12.50
--   Ultra    msg $25.00  call/voice $25.00
--
-- Friendly public display (credits / minutes) lives in subscription_plan_limits.
-- =============================================================================

-- ─── Plan limits (server-authoritative reference data) ───────────────────────
create table if not exists public.subscription_plan_limits (
  plan                text primary key
                      check (plan in ('free','starter','pro','ultra')),
  message_budget_usd  numeric not null default 0,
  call_budget_usd     numeric not null default 0,
  message_credits     integer not null default 0,   -- public display
  call_minutes        integer not null default 0,    -- public display
  updated_at          timestamptz not null default now()
);

insert into public.subscription_plan_limits
  (plan, message_budget_usd, call_budget_usd, message_credits, call_minutes)
values
  ('free',    0,     0,     0,     0),
  ('starter', 2.50,  2.50,  2500,  25),
  ('pro',     12.50, 12.50, 12500, 125),
  ('ultra',   25.00, 25.00, 25000, 250)
on conflict (plan) do update
  set message_budget_usd = excluded.message_budget_usd,
      call_budget_usd     = excluded.call_budget_usd,
      message_credits     = excluded.message_credits,
      call_minutes        = excluded.call_minutes,
      updated_at          = now();

alter table public.subscription_plan_limits enable row level security;
-- Reference data: any authenticated user may read it (no secrets here).
drop policy if exists "plan_limits_read" on public.subscription_plan_limits;
create policy "plan_limits_read" on public.subscription_plan_limits
  for select using (auth.role() = 'authenticated');

-- ─── message_usage / message_events / message_rate_limits ─────────────────────
create table if not exists public.message_usage (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  plan               text not null default 'free',
  monthly_budget_usd numeric not null default 0,
  used_usd           numeric not null default 0,
  reset_date         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id)
);
alter table public.message_usage enable row level security;
drop policy if exists "message_usage_select_own" on public.message_usage;
create policy "message_usage_select_own" on public.message_usage
  for select using ((select auth.uid()) = user_id);

create table if not exists public.message_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  provider           text,
  model              text,
  prompt_tokens      integer,
  completion_tokens  integer,
  estimated_cost_usd numeric,
  actual_cost_usd    numeric,
  status             text not null default 'pending',
  error_code         text,
  created_at         timestamptz not null default now()
);
alter table public.message_events enable row level security;
drop policy if exists "message_events_select_own" on public.message_events;
create policy "message_events_select_own" on public.message_events
  for select using ((select auth.uid()) = user_id);

create table if not exists public.message_rate_limits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, window_start)
);
alter table public.message_rate_limits enable row level security;
drop policy if exists "message_rate_limits_no_client" on public.message_rate_limits;
create policy "message_rate_limits_no_client" on public.message_rate_limits
  for select using (false);

-- ─── call_usage / call_events / call_rate_limits ──────────────────────────────
create table if not exists public.call_usage (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  plan               text not null default 'free',
  monthly_budget_usd numeric not null default 0,
  used_usd           numeric not null default 0,
  used_seconds       integer not null default 0,
  reset_date         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id)
);
alter table public.call_usage enable row level security;
drop policy if exists "call_usage_select_own" on public.call_usage;
create policy "call_usage_select_own" on public.call_usage
  for select using ((select auth.uid()) = user_id);

create table if not exists public.call_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  call_sid           text,
  direction          text,
  duration_seconds   integer,
  estimated_cost_usd numeric,
  actual_cost_usd    numeric,
  status             text not null default 'pending',
  error_code         text,
  created_at         timestamptz not null default now()
);
alter table public.call_events enable row level security;
drop policy if exists "call_events_select_own" on public.call_events;
create policy "call_events_select_own" on public.call_events
  for select using ((select auth.uid()) = user_id);

create table if not exists public.call_rate_limits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, window_start)
);
alter table public.call_rate_limits enable row level security;
drop policy if exists "call_rate_limits_no_client" on public.call_rate_limits;
create policy "call_rate_limits_no_client" on public.call_rate_limits
  for select using (false);

-- ─── Plan limits accessor ─────────────────────────────────────────────────────
create or replace function public.get_current_plan_limits(p_plan text)
returns public.subscription_plan_limits
language sql stable as $$
  select * from public.subscription_plan_limits
  where plan = coalesce(p_plan, 'free');
$$;

-- ─── Seed message/call usage from plan (fired on profiles.tier change) ────────
create or replace function public.sync_message_call_usage_for_user(p_user_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lim public.subscription_plan_limits%rowtype;
  v_reset timestamptz := date_trunc('month', now()) + interval '1 month';
begin
  select * into v_lim from public.subscription_plan_limits where plan = coalesce(p_plan, 'free');
  if not found then
    select * into v_lim from public.subscription_plan_limits where plan = 'free';
  end if;

  insert into public.message_usage (user_id, plan, monthly_budget_usd, used_usd, reset_date)
  values (p_user_id, p_plan, v_lim.message_budget_usd, 0, v_reset)
  on conflict (user_id) do update
    set plan = excluded.plan, monthly_budget_usd = excluded.monthly_budget_usd, updated_at = now();

  insert into public.call_usage (user_id, plan, monthly_budget_usd, used_usd, used_seconds, reset_date)
  values (p_user_id, p_plan, v_lim.call_budget_usd, 0, 0, v_reset)
  on conflict (user_id) do update
    set plan = excluded.plan, monthly_budget_usd = excluded.monthly_budget_usd, updated_at = now();
end;
$$;
revoke all on function public.sync_message_call_usage_for_user(uuid, text) from public, anon, authenticated;

create or replace function public.message_call_usage_on_profile_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_message_call_usage_for_user(new.id, coalesce(new.tier, 'free'));
  return new;
end;
$$;
revoke all on function public.message_call_usage_on_profile_tier() from public, anon, authenticated;
drop trigger if exists profiles_sync_message_call_usage on public.profiles;
create trigger profiles_sync_message_call_usage
  after insert or update of tier on public.profiles
  for each row execute function public.message_call_usage_on_profile_tier();

-- ─── Monthly reset (lazy; called by reserve fns and on demand) ────────────────
create or replace function public.reset_monthly_usage_if_needed(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_next timestamptz := date_trunc('month', now()) + interval '1 month';
begin
  update public.message_usage
     set used_usd = 0, reset_date = v_next, updated_at = now()
   where user_id = p_user_id and reset_date is not null and now() >= reset_date;
  update public.call_usage
     set used_usd = 0, used_seconds = 0, reset_date = v_next, updated_at = now()
   where user_id = p_user_id and reset_date is not null and now() >= reset_date;
end;
$$;
revoke all on function public.reset_monthly_usage_if_needed(uuid) from public, anon, authenticated;

-- ─── Atomic message budget reserve / settle ───────────────────────────────────
create or replace function public.reserve_message_budget(p_user_id uuid, p_estimate_usd numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.message_usage%rowtype; v_remaining numeric;
begin
  perform public.reset_monthly_usage_if_needed(p_user_id);
  select * into v_row from public.message_usage where user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_usage_row'); end if;
  if v_row.monthly_budget_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no_message_budget'); end if;
  v_remaining := v_row.monthly_budget_usd - v_row.used_usd;
  if v_remaining < p_estimate_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget_exceeded', 'remaining_usd', v_remaining);
  end if;
  update public.message_usage set used_usd = used_usd + p_estimate_usd, updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'remaining_usd', v_remaining - p_estimate_usd);
end;
$$;
revoke all on function public.reserve_message_budget(uuid, numeric) from public, anon, authenticated;

create or replace function public.settle_message_budget(p_user_id uuid, p_reserved numeric, p_actual numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_delta numeric := coalesce(p_actual,0) - coalesce(p_reserved,0);
begin
  update public.message_usage set used_usd = greatest(0, used_usd + v_delta), updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_message_budget(uuid, numeric, numeric) from public, anon, authenticated;

-- ─── Atomic call budget reserve / settle (also tracks seconds) ────────────────
create or replace function public.reserve_call_budget(p_user_id uuid, p_estimate_usd numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.call_usage%rowtype; v_remaining numeric;
begin
  perform public.reset_monthly_usage_if_needed(p_user_id);
  select * into v_row from public.call_usage where user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_usage_row'); end if;
  if v_row.monthly_budget_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no_call_budget'); end if;
  v_remaining := v_row.monthly_budget_usd - v_row.used_usd;
  if v_remaining < p_estimate_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget_exceeded', 'remaining_usd', v_remaining);
  end if;
  update public.call_usage set used_usd = used_usd + p_estimate_usd, updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'remaining_usd', v_remaining - p_estimate_usd);
end;
$$;
revoke all on function public.reserve_call_budget(uuid, numeric) from public, anon, authenticated;

create or replace function public.settle_call_budget(p_user_id uuid, p_reserved numeric, p_actual numeric, p_seconds integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_delta numeric := coalesce(p_actual,0) - coalesce(p_reserved,0);
begin
  update public.call_usage
     set used_usd = greatest(0, used_usd + v_delta),
         used_seconds = used_seconds + greatest(coalesce(p_seconds,0), 0),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_call_budget(uuid, numeric, numeric, integer) from public, anon, authenticated;

-- ─── Generic event recorders (service role only) ──────────────────────────────
create or replace function public.record_usage_event(
  p_kind text, p_user_id uuid, p_payload jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'message' then
    insert into public.message_events (user_id, provider, model, prompt_tokens, completion_tokens,
                                       estimated_cost_usd, actual_cost_usd, status, error_code)
    values (p_user_id, p_payload->>'provider', p_payload->>'model',
            (p_payload->>'prompt_tokens')::int, (p_payload->>'completion_tokens')::int,
            (p_payload->>'estimated_cost_usd')::numeric, (p_payload->>'actual_cost_usd')::numeric,
            coalesce(p_payload->>'status','ok'), p_payload->>'error_code');
  elsif p_kind = 'call' then
    insert into public.call_events (user_id, call_sid, direction, duration_seconds,
                                    estimated_cost_usd, actual_cost_usd, status, error_code)
    values (p_user_id, p_payload->>'call_sid', p_payload->>'direction',
            (p_payload->>'duration_seconds')::int,
            (p_payload->>'estimated_cost_usd')::numeric, (p_payload->>'actual_cost_usd')::numeric,
            coalesce(p_payload->>'status','ok'), p_payload->>'error_code');
  end if;
end;
$$;
revoke all on function public.record_usage_event(text, uuid, jsonb) from public, anon, authenticated;

-- ─── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists message_usage_user_idx on public.message_usage (user_id);
create index if not exists message_events_user_idx on public.message_events (user_id, created_at desc);
create index if not exists call_usage_user_idx on public.call_usage (user_id);
create index if not exists call_events_user_idx on public.call_events (user_id, created_at desc);
create index if not exists message_rate_limits_idx on public.message_rate_limits (user_id, window_start);
create index if not exists call_rate_limits_idx on public.call_rate_limits (user_id, window_start);
