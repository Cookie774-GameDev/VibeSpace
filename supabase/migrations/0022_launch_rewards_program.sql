-- =============================================================================
-- 0022_launch_rewards_program
-- =============================================================================
-- Phase 1 ($1k pool, launch_1k):
--   • ONLY first 200 signups: $5 Deepgram credit (calls + Jarvis voice + STT).
--   • All other Spark users: $0 company credit (BYOK / unlimited local Kokoro).
--
-- Phase 2 ($5k pool, scale_5k) — flip promo_phase on deepgram_promo_pool:
--   • NEW Spark promo: $2 Deepgram credit for first 1,000 free users only.
--   • MAIN boost: paid subscription launch credits jump (Orbit / Nova / Singularity).
--   • Founders keep their original $5.
--
--   update deepgram_promo_pool
--      set budget_usd = 5000, pause_at_usd = 4500, promo_phase = 'scale_5k', updated_at = now()
--    where id = 1;
-- =============================================================================

alter table public.deepgram_promo_pool
  add column if not exists promo_phase text not null default 'launch_1k'
    check (promo_phase in ('launch_1k', 'scale_5k'));

alter table public.deepgram_promo_plan_limits
  add column if not exists promo_seconds_phase2 integer,
  add column if not exists promo_minutes_display_phase2 integer,
  add column if not exists promo_usd_display numeric;

-- Spark: $0 in phase 1; $2 (10,667 s) only via limited phase-2 promo table
update public.deepgram_promo_plan_limits
   set promo_seconds_limit          = 0,
       promo_minutes_display        = 0,
       promo_usd_display            = 0,
       promo_seconds_phase2         = 10667,
       promo_minutes_display_phase2 = 120,
       updated_at                   = now()
 where plan = 'free';

-- Paid: modest phase 1 + BIG phase 2 when pool hits $5k
update public.deepgram_promo_plan_limits
   set promo_usd_display            = 0.34,
       promo_seconds_phase2         = 10800,
       promo_minutes_display_phase2 = 180,
       updated_at                   = now()
 where plan = 'starter';

update public.deepgram_promo_plan_limits
   set promo_usd_display            = 1.01,
       promo_seconds_phase2         = 32400,
       promo_minutes_display_phase2 = 540,
       updated_at                   = now()
 where plan = 'pro';

update public.deepgram_promo_plan_limits
   set promo_usd_display            = 2.03,
       promo_seconds_phase2         = 54000,
       promo_minutes_display_phase2 = 900,
       updated_at                   = now()
 where plan = 'ultra';

-- First 200 only: $5 Deepgram ≈ 26,667 s
create table if not exists public.launch_founder_rewards (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  welcome_usd    numeric not null default 5.00,
  seconds_limit  integer not null default 26667,
  claimed_at     timestamptz not null default now()
);

create index if not exists launch_founder_rewards_claimed_idx
  on public.launch_founder_rewards (claimed_at);

alter table public.launch_founder_rewards enable row level security;
drop policy if exists launch_founder_rewards_select_own on public.launch_founder_rewards;
create policy launch_founder_rewards_select_own on public.launch_founder_rewards
  for select using ((select auth.uid()) = user_id);

-- Phase 2 only: first 1,000 Spark users get $2 Deepgram
create table if not exists public.launch_spark_promo_rewards (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  welcome_usd    numeric not null default 2.00,
  seconds_limit  integer not null default 10667,
  claimed_at     timestamptz not null default now()
);

create index if not exists launch_spark_promo_rewards_claimed_idx
  on public.launch_spark_promo_rewards (claimed_at);

alter table public.launch_spark_promo_rewards enable row level security;
drop policy if exists launch_spark_promo_rewards_select_own on public.launch_spark_promo_rewards;
create policy launch_spark_promo_rewards_select_own on public.launch_spark_promo_rewards
  for select using ((select auth.uid()) = user_id);

create or replace function public.deepgram_promo_seconds_for_plan(p_plan text)
returns integer
language sql
stable
set search_path = public
as $$
  select case
           when coalesce(p_plan, 'free') = 'free' then 0
           when coalesce((select promo_phase from public.deepgram_promo_pool where id = 1), 'launch_1k') = 'scale_5k'
             then coalesce(l.promo_seconds_phase2, l.promo_seconds_limit)
           else l.promo_seconds_limit
         end
    from public.deepgram_promo_plan_limits l
   where l.plan = coalesce(p_plan, 'free');
$$;

revoke all on function public.deepgram_promo_seconds_for_plan(text) from public, anon, authenticated;

create or replace function public.claim_launch_founder_reward(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_founder_seconds constant integer := 26667;
begin
  if exists (select 1 from public.launch_founder_rewards where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;

  select count(*)::integer into v_count from public.launch_founder_rewards;
  if v_count >= 200 then
    return jsonb_build_object('ok', false, 'reason', 'founder_slots_exhausted');
  end if;

  insert into public.launch_founder_rewards (user_id, welcome_usd, seconds_limit)
  values (p_user_id, 5.00, v_founder_seconds);

  insert into public.deepgram_promo_usage (user_id, plan, seconds_limit, used_seconds, used_usd)
  values (p_user_id, 'free', v_founder_seconds, 0, 0)
  on conflict (user_id) do update
    set seconds_limit = greatest(deepgram_promo_usage.seconds_limit, v_founder_seconds),
        updated_at = now();

  return jsonb_build_object('ok', true, 'welcome_usd', 5, 'bonus_seconds', v_founder_seconds, 'slot', v_count + 1);
end;
$$;

revoke all on function public.claim_launch_founder_reward(uuid) from public, anon, authenticated;

-- Phase 2 ($5k pool): first 1,000 Spark users get $2 Deepgram (not before scale_5k).
create or replace function public.claim_launch_spark_promo(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phase text;
  v_count integer;
  v_spark_seconds constant integer := 10667;
begin
  select promo_phase into v_phase from public.deepgram_promo_pool where id = 1;
  if coalesce(v_phase, 'launch_1k') <> 'scale_5k' then
    return jsonb_build_object('ok', false, 'reason', 'spark_promo_not_active');
  end if;

  if exists (select 1 from public.launch_founder_rewards where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'founder_already_has_credit');
  end if;

  if exists (select 1 from public.launch_spark_promo_rewards where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;

  select count(*)::integer into v_count from public.launch_spark_promo_rewards;
  if v_count >= 1000 then
    return jsonb_build_object('ok', false, 'reason', 'spark_promo_slots_exhausted');
  end if;

  insert into public.launch_spark_promo_rewards (user_id, welcome_usd, seconds_limit)
  values (p_user_id, 2.00, v_spark_seconds);

  insert into public.deepgram_promo_usage (user_id, plan, seconds_limit, used_seconds, used_usd)
  values (p_user_id, 'free', v_spark_seconds, 0, 0)
  on conflict (user_id) do update
    set seconds_limit = greatest(deepgram_promo_usage.seconds_limit, v_spark_seconds),
        updated_at = now();

  return jsonb_build_object('ok', true, 'welcome_usd', 2, 'bonus_seconds', v_spark_seconds, 'slot', v_count + 1);
end;
$$;

revoke all on function public.claim_launch_spark_promo(uuid) from public, anon, authenticated;

create or replace function public.sync_deepgram_promo_for_user(p_user_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_seconds integer := 0;
  v_founder integer;
  v_spark integer;
begin
  select seconds_limit into v_founder
    from public.launch_founder_rewards where user_id = p_user_id;

  if v_founder is not null then
    v_seconds := v_founder;
  elsif coalesce(p_plan, 'free') <> 'free' then
    v_seconds := coalesce(public.deepgram_promo_seconds_for_plan(p_plan), 0);
  else
    select seconds_limit into v_spark
      from public.launch_spark_promo_rewards where user_id = p_user_id;
    v_seconds := coalesce(v_spark, 0);
  end if;

  insert into public.deepgram_promo_usage (user_id, plan, seconds_limit, used_seconds, used_usd)
  values (p_user_id, coalesce(p_plan, 'free'), v_seconds, 0, 0)
  on conflict (user_id) do update
    set plan = excluded.plan,
        seconds_limit = greatest(deepgram_promo_usage.seconds_limit, excluded.seconds_limit),
        updated_at = now();
end;
$$;

revoke all on function public.sync_deepgram_promo_for_user(uuid, text) from public, anon, authenticated;
