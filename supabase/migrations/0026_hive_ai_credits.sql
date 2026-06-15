-- =============================================================================
-- 0026_hive_ai_credits: Hive AI credit allocations + usage ledger
-- =============================================================================
-- Chat-only Hive hosted steps draw from the user's AI credit allocation.
-- Terminals, voice, PSTN, and SMS never use this ledger.

insert into public.subscription_plan_limits
  (plan, message_budget_usd, call_budget_usd, sms_budget_usd,
   message_credits, call_minutes, sms_count)
values
  ('apex', 62.00, 43.40, 18.60, 62000, 434, 1860)
on conflict (plan) do update
  set message_budget_usd = excluded.message_budget_usd,
      call_budget_usd = excluded.call_budget_usd,
      sms_budget_usd = excluded.sms_budget_usd,
      message_credits = excluded.message_credits,
      call_minutes = excluded.call_minutes,
      sms_count = excluded.sms_count,
      updated_at = now();

create table if not exists public.hive_plan_allocations (
  plan text primary key,
  monthly_ai_credits integer not null default 0 check (monthly_ai_credits >= 0),
  monthly_call_minutes integer not null default 0 check (monthly_call_minutes >= 0),
  monthly_sms_count integer not null default 0 check (monthly_sms_count >= 0),
  default_ai_percent integer not null default 50 check (default_ai_percent between 0 and 100),
  default_call_percent integer not null default 35 check (default_call_percent between 0 and 100),
  default_sms_percent integer not null default 15 check (default_sms_percent between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (default_ai_percent + default_call_percent + default_sms_percent = 100)
);

insert into public.hive_plan_allocations
  (plan, monthly_ai_credits, monthly_call_minutes, monthly_sms_count,
   default_ai_percent, default_call_percent, default_sms_percent)
values
  ('free', 0, 0, 0, 50, 35, 15),
  ('starter', 3100, 22, 93, 50, 35, 15),
  ('pro', 15500, 109, 465, 50, 35, 15),
  ('ultra', 31000, 217, 930, 50, 35, 15),
  ('apex', 62000, 434, 1860, 50, 35, 15)
on conflict (plan) do update
  set monthly_ai_credits = excluded.monthly_ai_credits,
      monthly_call_minutes = excluded.monthly_call_minutes,
      monthly_sms_count = excluded.monthly_sms_count,
      default_ai_percent = excluded.default_ai_percent,
      default_call_percent = excluded.default_call_percent,
      default_sms_percent = excluded.default_sms_percent,
      updated_at = now();

alter table public.hive_plan_allocations enable row level security;
drop policy if exists "hive_plan_allocations_read_all" on public.hive_plan_allocations;
create policy "hive_plan_allocations_read_all" on public.hive_plan_allocations
  for select using (true);

create table if not exists public.hive_credit_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  monthly_ai_credits integer not null default 0 check (monthly_ai_credits >= 0),
  used_ai_credits numeric not null default 0 check (used_ai_credits >= 0),
  reset_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hive_credit_usage enable row level security;
drop policy if exists "hive_credit_usage_select_own" on public.hive_credit_usage;
create policy "hive_credit_usage_select_own" on public.hive_credit_usage
  for select using ((select auth.uid()) = user_id);
drop policy if exists "hive_credit_usage_no_client_write" on public.hive_credit_usage;
create policy "hive_credit_usage_no_client_write" on public.hive_credit_usage
  for all to authenticated using (false) with check (false);

create table if not exists public.hive_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  preset text not null,
  task_type text not null default 'general',
  step_id text not null,
  provider text not null,
  model text not null,
  estimated_credits numeric not null default 0 check (estimated_credits >= 0),
  actual_credits numeric,
  status text not null default 'reserved',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

alter table public.hive_usage_events enable row level security;
drop policy if exists "hive_usage_events_select_own" on public.hive_usage_events;
create policy "hive_usage_events_select_own" on public.hive_usage_events
  for select using ((select auth.uid()) = user_id);
drop policy if exists "hive_usage_events_no_client_write" on public.hive_usage_events;
create policy "hive_usage_events_no_client_write" on public.hive_usage_events
  for all to authenticated using (false) with check (false);

create index if not exists hive_usage_events_user_idx
  on public.hive_usage_events (user_id, created_at desc);

create or replace function public.hive_plan_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.plan
       from public.subscriptions s
      where s.user_id = p_user_id
        and s.status in ('active', 'trialing')
      order by s.current_period_end desc nulls last
      limit 1),
    (select p.tier from public.profiles p where p.id = p_user_id),
    'free'
  );
$$;
revoke all on function public.hive_plan_for_user(uuid) from public, anon, authenticated;
grant execute on function public.hive_plan_for_user(uuid) to service_role;

create or replace function public.sync_hive_credit_usage_for_user(p_user_id uuid, p_plan text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text := coalesce(p_plan, public.hive_plan_for_user(p_user_id), 'free');
  v_alloc public.hive_plan_allocations%rowtype;
  v_reset timestamptz := public.next_usage_reset_date(p_user_id);
begin
  select * into v_alloc from public.hive_plan_allocations where plan = v_plan;
  if not found then
    select * into v_alloc from public.hive_plan_allocations where plan = 'free';
    v_plan := 'free';
  end if;

  insert into public.hive_credit_usage
    (user_id, plan, monthly_ai_credits, used_ai_credits, reset_date)
  values
    (p_user_id, v_plan, v_alloc.monthly_ai_credits, 0, v_reset)
  on conflict (user_id) do update
    set plan = excluded.plan,
        monthly_ai_credits = excluded.monthly_ai_credits,
        reset_date = coalesce(public.hive_credit_usage.reset_date, excluded.reset_date),
        updated_at = now();
end;
$$;
revoke all on function public.sync_hive_credit_usage_for_user(uuid, text) from public, anon, authenticated;
grant execute on function public.sync_hive_credit_usage_for_user(uuid, text) to service_role;

create or replace function public.reserve_ai_credits(
  p_user_id uuid,
  p_estimated_credits numeric,
  p_context jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.hive_credit_usage%rowtype;
  v_event_id uuid;
  v_remaining numeric;
  v_preset text := coalesce(p_context->>'preset', 'unknown');
  v_task text := coalesce(p_context->>'task_type', 'general');
  v_step text := coalesce(p_context->>'step_id', 'step');
  v_provider text := coalesce(p_context->>'provider', 'unknown');
  v_model text := coalesce(p_context->>'model', 'unknown');
begin
  if p_estimated_credits is null or p_estimated_credits <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_estimate');
  end if;

  perform public.sync_hive_credit_usage_for_user(p_user_id, null);

  select * into v_usage
    from public.hive_credit_usage
   where user_id = p_user_id
   for update;

  if v_usage.reset_date is not null and now() >= v_usage.reset_date then
    update public.hive_credit_usage
       set used_ai_credits = 0,
           reset_date = public.next_usage_reset_date(p_user_id),
           updated_at = now()
     where user_id = p_user_id
     returning * into v_usage;
  end if;

  v_remaining := greatest(v_usage.monthly_ai_credits - v_usage.used_ai_credits, 0);
  if v_remaining < p_estimated_credits then
    return jsonb_build_object(
      'ok', false,
      'reason', 'ai_credits_exhausted',
      'remaining_credits', v_remaining
    );
  end if;

  update public.hive_credit_usage
     set used_ai_credits = used_ai_credits + p_estimated_credits,
         updated_at = now()
   where user_id = p_user_id;

  insert into public.hive_usage_events
    (user_id, preset, task_type, step_id, provider, model, estimated_credits, metadata)
  values
    (p_user_id, v_preset, v_task, v_step, v_provider, v_model, p_estimated_credits, p_context)
  returning id into v_event_id;

  return jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'reserved_credits', p_estimated_credits,
    'remaining_credits', v_remaining - p_estimated_credits
  );
end;
$$;
revoke all on function public.reserve_ai_credits(uuid, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_ai_credits(uuid, numeric, jsonb) to service_role;

create or replace function public.settle_ai_credits(
  p_user_id uuid,
  p_event_id uuid,
  p_reserved_credits numeric,
  p_actual_credits numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric := greatest(coalesce(p_reserved_credits, 0), 0);
  v_actual numeric := greatest(coalesce(p_actual_credits, 0), 0);
  v_delta numeric := v_actual - v_reserved;
begin
  update public.hive_usage_events
     set actual_credits = v_actual,
         status = 'settled',
         settled_at = now()
   where id = p_event_id and user_id = p_user_id;

  update public.hive_credit_usage
     set used_ai_credits = greatest(used_ai_credits + v_delta, 0),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_ai_credits(uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.settle_ai_credits(uuid, uuid, numeric, numeric) to service_role;
