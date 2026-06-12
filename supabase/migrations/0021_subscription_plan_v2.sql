-- =============================================================================
-- 0021_subscription_plan_v2: new plan economics + SMS bucket + triple windows
-- =============================================================================
-- Implements the confirmed subscription plan (38% gross margin; 62% COGS split
-- 50/35/15 AI/calls/SMS):
--
--   Plan     Price  msg_budget  call_budget  sms_budget  credits  minutes  sms
--   free     $0     0           0            0           0        0        0
--   starter  $10    3.10        2.17         0.93        3100     22       93
--   pro      $50    15.50       10.85        4.65        15500    109      465
--   ultra    $100   31.00       21.70        9.30        31000    217      930
--
-- New in this migration:
--   1. subscription_plan_limits: new budgets + sms_budget_usd / sms_count.
--   2. sms_usage / sms_events / sms_rate_limits tables (RLS select-own,
--      no client writes) + reserve_sms_budget / settle_sms_budget RPCs.
--   3. Triple rate windows on ALL three buckets, enforced inside the reserve
--      RPCs under the same FOR UPDATE row lock (atomic, race-safe):
--        5-hour window cap  =  8% of monthly budget  -> window_5h_exceeded
--        weekly window cap  = 25% of monthly budget  -> window_weekly_exceeded
--        monthly cap        = 100%                   -> budget_exceeded
--      Window spend is tracked in columns on the usage row and rolled lazily.
--   4. Reset cycle: 30 days from the Stripe subscription period
--      (subscriptions.current_period_end) when available; calendar month
--      fallback for non-Stripe rows. No rollover — unused budget forfeits.
--   5. Settle clamps: refunds can never exceed what was reserved.
--   6. All RPCs revoked from public/anon/authenticated; service_role only.
-- =============================================================================

-- ─── 1. Plan limits: new budgets + SMS columns ───────────────────────────────
alter table public.subscription_plan_limits
  add column if not exists sms_budget_usd numeric not null default 0,
  add column if not exists sms_count integer not null default 0;

insert into public.subscription_plan_limits
  (plan, message_budget_usd, call_budget_usd, sms_budget_usd,
   message_credits, call_minutes, sms_count)
values
  ('free',    0,     0,     0,    0,     0,   0),
  ('starter', 3.10,  2.17,  0.93, 3100,  22,  93),
  ('pro',     15.50, 10.85, 4.65, 15500, 109, 465),
  ('ultra',   31.00, 21.70, 9.30, 31000, 217, 930)
on conflict (plan) do update
  set message_budget_usd = excluded.message_budget_usd,
      call_budget_usd    = excluded.call_budget_usd,
      sms_budget_usd     = excluded.sms_budget_usd,
      message_credits    = excluded.message_credits,
      call_minutes       = excluded.call_minutes,
      sms_count          = excluded.sms_count,
      updated_at         = now();

-- Legacy helper mirrors the shared call/voice bucket.
create or replace function public.voice_budget_for_plan(p_plan text)
returns numeric language sql immutable
set search_path = public as $$
  select case p_plan
           when 'starter' then 2.17::numeric
           when 'pro'     then 10.85::numeric
           when 'ultra'   then 21.70::numeric
           else 0::numeric end;
$$;

-- Harden is_app_admin: anonymous callers always get false and lose EXECUTE
-- (signed-in callers remain self-only per 0020; service_role unrestricted).
create or replace function public.is_app_admin(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'anon' then
    return false;
  end if;
  if coalesce(auth.role(), '') = 'authenticated'
     and auth.uid() is distinct from p_user_id then
    return false;
  end if;
  return exists (select 1 from public.app_admins where user_id = p_user_id);
end;
$$;
revoke all on function public.is_app_admin(uuid) from public, anon;
grant execute on function public.is_app_admin(uuid) to authenticated;
grant execute on function public.is_app_admin(uuid) to service_role;

-- ─── 2. Window columns on existing usage tables ──────────────────────────────
alter table public.message_usage
  add column if not exists window_5h_start timestamptz,
  add column if not exists window_5h_used_usd numeric not null default 0,
  add column if not exists window_week_start timestamptz,
  add column if not exists window_week_used_usd numeric not null default 0;

alter table public.call_usage
  add column if not exists window_5h_start timestamptz,
  add column if not exists window_5h_used_usd numeric not null default 0,
  add column if not exists window_week_start timestamptz,
  add column if not exists window_week_used_usd numeric not null default 0;

-- ─── 3. sms_usage / sms_events / sms_rate_limits ─────────────────────────────
create table if not exists public.sms_usage (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  plan                 text not null default 'free',
  monthly_budget_usd   numeric not null default 0,
  used_usd             numeric not null default 0,
  used_count           integer not null default 0,
  reset_date           timestamptz,
  window_5h_start      timestamptz,
  window_5h_used_usd   numeric not null default 0,
  window_week_start    timestamptz,
  window_week_used_usd numeric not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
alter table public.sms_usage enable row level security;
drop policy if exists "sms_usage_select_own" on public.sms_usage;
create policy "sms_usage_select_own" on public.sms_usage
  for select using ((select auth.uid()) = user_id);
-- Defence in depth: explicit client write deny (RLS already default-denies).
drop policy if exists "sms_usage_no_client_write" on public.sms_usage;
create policy "sms_usage_no_client_write" on public.sms_usage
  for all to authenticated using (false) with check (false);

create table if not exists public.sms_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  to_last4           text,
  segments           integer,
  message_chars      integer,
  twilio_sid         text,
  estimated_cost_usd numeric,
  actual_cost_usd    numeric,
  status             text not null default 'pending',
  error_code         text,
  created_at         timestamptz not null default now()
);
alter table public.sms_events enable row level security;
drop policy if exists "sms_events_select_own" on public.sms_events;
create policy "sms_events_select_own" on public.sms_events
  for select using ((select auth.uid()) = user_id);

create table if not exists public.sms_rate_limits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  window_start  timestamptz not null,
  request_count integer not null default 0,
  total_chars   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, window_start)
);
alter table public.sms_rate_limits enable row level security;
drop policy if exists "sms_rate_limits_no_client" on public.sms_rate_limits;
create policy "sms_rate_limits_no_client" on public.sms_rate_limits
  for select using (false);

create index if not exists sms_events_user_idx on public.sms_events (user_id, created_at desc);
create index if not exists sms_rate_limits_idx on public.sms_rate_limits (user_id, window_start);

create or replace function public.sms_rate_limit_hit(
  p_user_id uuid, p_window_start timestamptz, p_chars integer, p_max_requests integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  insert into public.sms_rate_limits (user_id, window_start, request_count, total_chars)
  values (p_user_id, p_window_start, 1, greatest(coalesce(p_chars, 0), 0))
  on conflict (user_id, window_start) do update
    set request_count = public.sms_rate_limits.request_count + 1,
        total_chars = public.sms_rate_limits.total_chars + greatest(coalesce(p_chars, 0), 0),
        updated_at = now()
  returning request_count into v_count;
  return jsonb_build_object('count', v_count, 'limited', v_count > p_max_requests);
end;
$$;
revoke all on function public.sms_rate_limit_hit(uuid, timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.sms_rate_limit_hit(uuid, timestamptz, integer, integer) to service_role;

-- ─── 4. Stripe-period-aware reset date ───────────────────────────────────────
-- 30-day cycle from the active Stripe subscription when available; calendar
-- month fallback for non-Stripe rows. No rollover: reset zeroes everything.
create or replace function public.next_usage_reset_date(p_user_id uuid)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.current_period_end
       from public.subscriptions s
      where s.user_id = p_user_id
        and s.status in ('active', 'trialing')
        and s.current_period_end > now()
      order by s.current_period_end desc
      limit 1),
    date_trunc('month', now()) + interval '1 month'
  );
$$;
revoke all on function public.next_usage_reset_date(uuid) from public, anon, authenticated;
grant execute on function public.next_usage_reset_date(uuid) to service_role;

create or replace function public.reset_monthly_usage_if_needed(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_next timestamptz := public.next_usage_reset_date(p_user_id);
begin
  update public.message_usage
     set used_usd = 0,
         window_5h_start = null, window_5h_used_usd = 0,
         window_week_start = null, window_week_used_usd = 0,
         reset_date = v_next, updated_at = now()
   where user_id = p_user_id and reset_date is not null and now() >= reset_date;
  update public.call_usage
     set used_usd = 0, used_seconds = 0,
         window_5h_start = null, window_5h_used_usd = 0,
         window_week_start = null, window_week_used_usd = 0,
         reset_date = v_next, updated_at = now()
   where user_id = p_user_id and reset_date is not null and now() >= reset_date;
  update public.sms_usage
     set used_usd = 0, used_count = 0,
         window_5h_start = null, window_5h_used_usd = 0,
         window_week_start = null, window_week_used_usd = 0,
         reset_date = v_next, updated_at = now()
   where user_id = p_user_id and reset_date is not null and now() >= reset_date;
end;
$$;
revoke all on function public.reset_monthly_usage_if_needed(uuid) from public, anon, authenticated;
grant execute on function public.reset_monthly_usage_if_needed(uuid) to service_role;

-- ─── 5. Tier-change sync now also seeds sms_usage ────────────────────────────
create or replace function public.sync_message_call_usage_for_user(p_user_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lim public.subscription_plan_limits%rowtype;
  v_reset timestamptz := public.next_usage_reset_date(p_user_id);
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

  insert into public.sms_usage (user_id, plan, monthly_budget_usd, used_usd, used_count, reset_date)
  values (p_user_id, coalesce(p_plan, 'free'), v_lim.sms_budget_usd, 0, 0, v_reset)
  on conflict (user_id) do update
    set plan = excluded.plan, monthly_budget_usd = excluded.monthly_budget_usd, updated_at = now();
end;
$$;
revoke all on function public.sync_message_call_usage_for_user(uuid, text) from public, anon, authenticated;
grant execute on function public.sync_message_call_usage_for_user(uuid, text) to service_role;

-- Re-seed budgets for existing rows to the new plan economics (no rollover of
-- the old numbers; used_usd is preserved so nobody gets a free reset mid-month).
update public.message_usage mu
   set monthly_budget_usd = l.message_budget_usd, updated_at = now()
  from public.subscription_plan_limits l
 where l.plan = mu.plan;
update public.call_usage cu
   set monthly_budget_usd = l.call_budget_usd, updated_at = now()
  from public.subscription_plan_limits l
 where l.plan = cu.plan;

-- Seed sms_usage for all existing profiles.
do $$
declare r record;
begin
  for r in select id, coalesce(tier, 'free') as tier from public.profiles loop
    perform public.sync_message_call_usage_for_user(r.id, r.tier);
  end loop;
end $$;

-- ─── 6. Reserve RPCs with triple-window enforcement ──────────────────────────
-- All three reserve functions share the same shape:
--   * lazy monthly reset (Stripe-period aware)
--   * SELECT ... FOR UPDATE on the user's usage row (single-row lock makes the
--     read-check-write atomic; concurrent requests serialize on the row)
--   * lazy window roll: a window restarts when its fixed span has elapsed
--   * tightest window wins: 5h (8%) checked first, then weekly (25%), then
--     the monthly budget (100%)
--   * remaining_usd in failures reports the binding window's remaining budget

create or replace function public.reserve_message_budget(p_user_id uuid, p_estimate_usd numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.message_usage%rowtype;
  v_cap_5h numeric; v_cap_week numeric;
  v_rem_5h numeric; v_rem_week numeric; v_rem_month numeric;
begin
  if p_estimate_usd is null or p_estimate_usd < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_estimate');
  end if;
  perform public.reset_monthly_usage_if_needed(p_user_id);
  select * into v_row from public.message_usage where user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_usage_row'); end if;
  if v_row.monthly_budget_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no_message_budget'); end if;

  -- Lazy window roll (fixed spans from first spend in the window).
  if v_row.window_5h_start is null or now() >= v_row.window_5h_start + interval '5 hours' then
    v_row.window_5h_start := now(); v_row.window_5h_used_usd := 0;
  end if;
  if v_row.window_week_start is null or now() >= v_row.window_week_start + interval '7 days' then
    v_row.window_week_start := now(); v_row.window_week_used_usd := 0;
  end if;

  v_cap_5h   := v_row.monthly_budget_usd * 0.08;
  v_cap_week := v_row.monthly_budget_usd * 0.25;
  v_rem_5h   := v_cap_5h - v_row.window_5h_used_usd;
  v_rem_week := v_cap_week - v_row.window_week_used_usd;
  v_rem_month := v_row.monthly_budget_usd - v_row.used_usd;

  if v_rem_5h < p_estimate_usd then
    update public.message_usage
       set window_5h_start = v_row.window_5h_start, window_5h_used_usd = v_row.window_5h_used_usd,
           window_week_start = v_row.window_week_start, window_week_used_usd = v_row.window_week_used_usd,
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'reason', 'window_5h_exceeded',
      'remaining_usd', greatest(0, v_rem_5h), 'retry_after', v_row.window_5h_start + interval '5 hours');
  end if;
  if v_rem_week < p_estimate_usd then
    update public.message_usage
       set window_5h_start = v_row.window_5h_start, window_5h_used_usd = v_row.window_5h_used_usd,
           window_week_start = v_row.window_week_start, window_week_used_usd = v_row.window_week_used_usd,
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'reason', 'window_weekly_exceeded',
      'remaining_usd', greatest(0, v_rem_week), 'retry_after', v_row.window_week_start + interval '7 days');
  end if;
  if v_rem_month < p_estimate_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget_exceeded',
      'remaining_usd', greatest(0, v_rem_month));
  end if;

  update public.message_usage
     set used_usd = used_usd + p_estimate_usd,
         window_5h_start = v_row.window_5h_start,
         window_5h_used_usd = v_row.window_5h_used_usd + p_estimate_usd,
         window_week_start = v_row.window_week_start,
         window_week_used_usd = v_row.window_week_used_usd + p_estimate_usd,
         updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'remaining_usd', v_rem_month - p_estimate_usd,
    'remaining_5h_usd', v_rem_5h - p_estimate_usd, 'remaining_week_usd', v_rem_week - p_estimate_usd);
end;
$$;
revoke all on function public.reserve_message_budget(uuid, numeric) from public, anon, authenticated;
grant execute on function public.reserve_message_budget(uuid, numeric) to service_role;

create or replace function public.settle_message_budget(p_user_id uuid, p_reserved numeric, p_actual numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_delta numeric := coalesce(p_actual,0) - coalesce(p_reserved,0);
begin
  -- Refunds can never exceed what was reserved on this request.
  if v_delta < 0 then v_delta := greatest(v_delta, -coalesce(p_reserved,0)); end if;
  update public.message_usage
     set used_usd = greatest(0, used_usd + v_delta),
         window_5h_used_usd = greatest(0, window_5h_used_usd + v_delta),
         window_week_used_usd = greatest(0, window_week_used_usd + v_delta),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_message_budget(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.settle_message_budget(uuid, numeric, numeric) to service_role;

create or replace function public.reserve_call_budget(p_user_id uuid, p_estimate_usd numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.call_usage%rowtype;
  v_cap_5h numeric; v_cap_week numeric;
  v_rem_5h numeric; v_rem_week numeric; v_rem_month numeric;
begin
  if p_estimate_usd is null or p_estimate_usd < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_estimate');
  end if;
  perform public.reset_monthly_usage_if_needed(p_user_id);
  select * into v_row from public.call_usage where user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_usage_row'); end if;
  if v_row.monthly_budget_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no_call_budget'); end if;

  if v_row.window_5h_start is null or now() >= v_row.window_5h_start + interval '5 hours' then
    v_row.window_5h_start := now(); v_row.window_5h_used_usd := 0;
  end if;
  if v_row.window_week_start is null or now() >= v_row.window_week_start + interval '7 days' then
    v_row.window_week_start := now(); v_row.window_week_used_usd := 0;
  end if;

  v_cap_5h   := v_row.monthly_budget_usd * 0.08;
  v_cap_week := v_row.monthly_budget_usd * 0.25;
  v_rem_5h   := v_cap_5h - v_row.window_5h_used_usd;
  v_rem_week := v_cap_week - v_row.window_week_used_usd;
  v_rem_month := v_row.monthly_budget_usd - v_row.used_usd;

  if v_rem_5h < p_estimate_usd then
    update public.call_usage
       set window_5h_start = v_row.window_5h_start, window_5h_used_usd = v_row.window_5h_used_usd,
           window_week_start = v_row.window_week_start, window_week_used_usd = v_row.window_week_used_usd,
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'reason', 'window_5h_exceeded',
      'remaining_usd', greatest(0, v_rem_5h), 'retry_after', v_row.window_5h_start + interval '5 hours');
  end if;
  if v_rem_week < p_estimate_usd then
    update public.call_usage
       set window_5h_start = v_row.window_5h_start, window_5h_used_usd = v_row.window_5h_used_usd,
           window_week_start = v_row.window_week_start, window_week_used_usd = v_row.window_week_used_usd,
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'reason', 'window_weekly_exceeded',
      'remaining_usd', greatest(0, v_rem_week), 'retry_after', v_row.window_week_start + interval '7 days');
  end if;
  if v_rem_month < p_estimate_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget_exceeded',
      'remaining_usd', greatest(0, v_rem_month));
  end if;

  update public.call_usage
     set used_usd = used_usd + p_estimate_usd,
         window_5h_start = v_row.window_5h_start,
         window_5h_used_usd = v_row.window_5h_used_usd + p_estimate_usd,
         window_week_start = v_row.window_week_start,
         window_week_used_usd = v_row.window_week_used_usd + p_estimate_usd,
         updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'remaining_usd', v_rem_month - p_estimate_usd,
    'remaining_5h_usd', v_rem_5h - p_estimate_usd, 'remaining_week_usd', v_rem_week - p_estimate_usd);
end;
$$;
revoke all on function public.reserve_call_budget(uuid, numeric) from public, anon, authenticated;
grant execute on function public.reserve_call_budget(uuid, numeric) to service_role;

create or replace function public.settle_call_budget(p_user_id uuid, p_reserved numeric, p_actual numeric, p_seconds integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_delta numeric := coalesce(p_actual,0) - coalesce(p_reserved,0);
begin
  if v_delta < 0 then v_delta := greatest(v_delta, -coalesce(p_reserved,0)); end if;
  update public.call_usage
     set used_usd = greatest(0, used_usd + v_delta),
         window_5h_used_usd = greatest(0, window_5h_used_usd + v_delta),
         window_week_used_usd = greatest(0, window_week_used_usd + v_delta),
         used_seconds = used_seconds + greatest(coalesce(p_seconds,0), 0),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_call_budget(uuid, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.settle_call_budget(uuid, numeric, numeric, integer) to service_role;

create or replace function public.reserve_sms_budget(p_user_id uuid, p_estimate_usd numeric, p_count integer default 1)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.sms_usage%rowtype;
  v_cap_5h numeric; v_cap_week numeric;
  v_rem_5h numeric; v_rem_week numeric; v_rem_month numeric;
begin
  if p_estimate_usd is null or p_estimate_usd < 0 or coalesce(p_count, 0) < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_estimate');
  end if;
  perform public.reset_monthly_usage_if_needed(p_user_id);
  select * into v_row from public.sms_usage where user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_usage_row'); end if;
  if v_row.monthly_budget_usd <= 0 then return jsonb_build_object('ok', false, 'reason', 'no_sms_budget'); end if;

  if v_row.window_5h_start is null or now() >= v_row.window_5h_start + interval '5 hours' then
    v_row.window_5h_start := now(); v_row.window_5h_used_usd := 0;
  end if;
  if v_row.window_week_start is null or now() >= v_row.window_week_start + interval '7 days' then
    v_row.window_week_start := now(); v_row.window_week_used_usd := 0;
  end if;

  v_cap_5h   := v_row.monthly_budget_usd * 0.08;
  v_cap_week := v_row.monthly_budget_usd * 0.25;
  v_rem_5h   := v_cap_5h - v_row.window_5h_used_usd;
  v_rem_week := v_cap_week - v_row.window_week_used_usd;
  v_rem_month := v_row.monthly_budget_usd - v_row.used_usd;

  if v_rem_5h < p_estimate_usd then
    update public.sms_usage
       set window_5h_start = v_row.window_5h_start, window_5h_used_usd = v_row.window_5h_used_usd,
           window_week_start = v_row.window_week_start, window_week_used_usd = v_row.window_week_used_usd,
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'reason', 'window_5h_exceeded',
      'remaining_usd', greatest(0, v_rem_5h), 'retry_after', v_row.window_5h_start + interval '5 hours');
  end if;
  if v_rem_week < p_estimate_usd then
    update public.sms_usage
       set window_5h_start = v_row.window_5h_start, window_5h_used_usd = v_row.window_5h_used_usd,
           window_week_start = v_row.window_week_start, window_week_used_usd = v_row.window_week_used_usd,
           updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'reason', 'window_weekly_exceeded',
      'remaining_usd', greatest(0, v_rem_week), 'retry_after', v_row.window_week_start + interval '7 days');
  end if;
  if v_rem_month < p_estimate_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget_exceeded',
      'remaining_usd', greatest(0, v_rem_month));
  end if;

  update public.sms_usage
     set used_usd = used_usd + p_estimate_usd,
         used_count = used_count + greatest(coalesce(p_count, 1), 0),
         window_5h_start = v_row.window_5h_start,
         window_5h_used_usd = v_row.window_5h_used_usd + p_estimate_usd,
         window_week_start = v_row.window_week_start,
         window_week_used_usd = v_row.window_week_used_usd + p_estimate_usd,
         updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'remaining_usd', v_rem_month - p_estimate_usd,
    'remaining_5h_usd', v_rem_5h - p_estimate_usd, 'remaining_week_usd', v_rem_week - p_estimate_usd);
end;
$$;
revoke all on function public.reserve_sms_budget(uuid, numeric, integer) from public, anon, authenticated;
grant execute on function public.reserve_sms_budget(uuid, numeric, integer) to service_role;

create or replace function public.settle_sms_budget(
  p_user_id uuid, p_reserved numeric, p_actual numeric, p_count_delta integer default 0
)
returns void language plpgsql security definer set search_path = public as $$
declare v_delta numeric := coalesce(p_actual,0) - coalesce(p_reserved,0);
begin
  if v_delta < 0 then v_delta := greatest(v_delta, -coalesce(p_reserved,0)); end if;
  update public.sms_usage
     set used_usd = greatest(0, used_usd + v_delta),
         used_count = greatest(0, used_count + coalesce(p_count_delta, 0)),
         window_5h_used_usd = greatest(0, window_5h_used_usd + v_delta),
         window_week_used_usd = greatest(0, window_week_used_usd + v_delta),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_sms_budget(uuid, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.settle_sms_budget(uuid, numeric, numeric, integer) to service_role;

-- ─── 7. record_usage_event: add the 'sms' kind ───────────────────────────────
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
  elsif p_kind = 'sms' then
    insert into public.sms_events (user_id, to_last4, segments, message_chars, twilio_sid,
                                   estimated_cost_usd, actual_cost_usd, status, error_code)
    values (p_user_id, p_payload->>'to_last4',
            (p_payload->>'segments')::int, (p_payload->>'message_chars')::int,
            p_payload->>'twilio_sid',
            (p_payload->>'estimated_cost_usd')::numeric, (p_payload->>'actual_cost_usd')::numeric,
            coalesce(p_payload->>'status','ok'), p_payload->>'error_code');
  end if;
end;
$$;
revoke all on function public.record_usage_event(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_usage_event(text, uuid, jsonb) to service_role;
