-- =============================================================================
-- 0019_deepgram_launch_promo: $6k Deepgram credit launch promotion
-- =============================================================================
-- One-time per-user Deepgram cloud voice allowance drawn from a shared $6,000
-- company pool. Free users get ~1 minute; paid tiers get more. Enforced only
-- server-side via reserve_deepgram_promo / settle_deepgram_promo.
--
-- Cost basis: Deepgram Aura-1 (~$15/1M chars, ~750 chars/min) ≈ $0.01125/min.
-- =============================================================================

-- ─── Global promo pool (singleton) ───────────────────────────────────────────
create table if not exists public.deepgram_promo_pool (
  id              smallint primary key default 1 check (id = 1),
  name            text not null default 'launch_deepgram_2026',
  budget_usd      numeric not null default 6000,
  used_usd        numeric not null default 0,
  cost_per_second numeric not null default 0.0001875, -- Aura-1 ~$0.01125/min
  pause_at_usd    numeric not null default 5400,     -- 90% kill switch
  active          boolean not null default true,
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,                        -- null = until pool exhausted
  updated_at      timestamptz not null default now()
);

insert into public.deepgram_promo_pool (id)
values (1)
on conflict (id) do nothing;

alter table public.deepgram_promo_pool enable row level security;
drop policy if exists "deepgram_promo_pool_no_client" on public.deepgram_promo_pool;
create policy "deepgram_promo_pool_no_client" on public.deepgram_promo_pool
  for select using (false);

-- ─── Per-plan one-time Deepgram seconds (public display values) ─────────────
create table if not exists public.deepgram_promo_plan_limits (
  plan                    text primary key check (plan in ('free','starter','pro','ultra')),
  promo_seconds_limit     integer not null,
  promo_minutes_display   integer not null,
  updated_at              timestamptz not null default now()
);

insert into public.deepgram_promo_plan_limits
  (plan, promo_seconds_limit, promo_minutes_display)
values
  ('free',    60,    1),    -- ~1 min taste for launch
  ('starter', 1800,  30),   -- 30 min one-time Deepgram
  ('pro',     5400,  90),   -- 90 min
  ('ultra',   10800, 180)   -- 3 hr
on conflict (plan) do update
  set promo_seconds_limit   = excluded.promo_seconds_limit,
      promo_minutes_display = excluded.promo_minutes_display,
      updated_at            = now();

alter table public.deepgram_promo_plan_limits enable row level security;
drop policy if exists "deepgram_promo_plan_limits_read" on public.deepgram_promo_plan_limits;
create policy "deepgram_promo_plan_limits_read" on public.deepgram_promo_plan_limits
  for select using (auth.role() = 'authenticated');

-- ─── Per-user promo usage (one-time; upgrading tier raises the cap) ─────────
create table if not exists public.deepgram_promo_usage (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  plan           text not null default 'free',
  seconds_limit  integer not null default 0,
  used_seconds   integer not null default 0,
  used_usd       numeric not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.deepgram_promo_usage enable row level security;
drop policy if exists "deepgram_promo_usage_select_own" on public.deepgram_promo_usage;
create policy "deepgram_promo_usage_select_own" on public.deepgram_promo_usage
  for select using ((select auth.uid()) = user_id);

-- ─── Sync promo row when profile tier changes (upgrade raises limit, keeps used) ─
create or replace function public.sync_deepgram_promo_for_user(p_user_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lim public.deepgram_promo_plan_limits%rowtype;
begin
  select * into v_lim
    from public.deepgram_promo_plan_limits
   where plan = coalesce(p_plan, 'free');
  if not found then
    select * into v_lim from public.deepgram_promo_plan_limits where plan = 'free';
  end if;

  insert into public.deepgram_promo_usage (user_id, plan, seconds_limit, used_seconds, used_usd)
  values (p_user_id, coalesce(p_plan, 'free'), v_lim.promo_seconds_limit, 0, 0)
  on conflict (user_id) do update
    set plan = excluded.plan,
        seconds_limit = greatest(deepgram_promo_usage.seconds_limit, excluded.seconds_limit),
        updated_at = now();
end;
$$;
revoke all on function public.sync_deepgram_promo_for_user(uuid, text) from public, anon, authenticated;

create or replace function public.deepgram_promo_on_profile_tier()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_deepgram_promo_for_user(new.id, coalesce(new.tier, 'free'));
  return new;
end;
$$;
revoke all on function public.deepgram_promo_on_profile_tier() from public, anon, authenticated;
drop trigger if exists profiles_sync_deepgram_promo on public.profiles;
create trigger profiles_sync_deepgram_promo
  after insert or update of tier on public.profiles
  for each row execute function public.deepgram_promo_on_profile_tier();

-- Seed existing profiles
do $$
declare r record;
begin
  for r in select id, coalesce(tier, 'free') as tier from public.profiles loop
    perform public.sync_deepgram_promo_for_user(r.id, r.tier);
  end loop;
end $$;

-- ─── Atomic reserve / settle ─────────────────────────────────────────────────
create or replace function public.reserve_deepgram_promo(
  p_user_id uuid,
  p_estimate_seconds integer,
  p_estimate_usd numeric
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pool public.deepgram_promo_pool%rowtype;
  v_row  public.deepgram_promo_usage%rowtype;
  v_remaining_secs integer;
  v_pool_remaining numeric;
begin
  if p_estimate_seconds <= 0 or p_estimate_usd <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_estimate');
  end if;

  select * into v_pool from public.deepgram_promo_pool where id = 1 for update;
  if not found or not v_pool.active then
    return jsonb_build_object('ok', false, 'reason', 'promo_inactive');
  end if;
  if v_pool.ends_at is not null and now() >= v_pool.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'promo_ended');
  end if;
  if v_pool.used_usd >= v_pool.pause_at_usd then
    return jsonb_build_object('ok', false, 'reason', 'promo_pool_paused');
  end if;
  if v_pool.used_usd + p_estimate_usd > v_pool.budget_usd then
    return jsonb_build_object('ok', false, 'reason', 'promo_pool_exhausted',
      'pool_remaining_usd', greatest(0, v_pool.budget_usd - v_pool.used_usd));
  end if;

  perform public.sync_deepgram_promo_for_user(
    p_user_id,
    (select coalesce(tier, 'free') from public.profiles where id = p_user_id)
  );

  select * into v_row from public.deepgram_promo_usage where user_id = p_user_id for update;
  if not found or v_row.seconds_limit <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_promo_allowance');
  end if;

  v_remaining_secs := v_row.seconds_limit - v_row.used_seconds;
  if v_remaining_secs < p_estimate_seconds then
    return jsonb_build_object('ok', false, 'reason', 'promo_seconds_exceeded',
      'remaining_seconds', greatest(0, v_remaining_secs));
  end if;

  v_pool_remaining := v_pool.budget_usd - v_pool.used_usd - p_estimate_usd;

  update public.deepgram_promo_usage
     set used_seconds = used_seconds + p_estimate_seconds,
         used_usd = used_usd + p_estimate_usd,
         updated_at = now()
   where user_id = p_user_id;

  update public.deepgram_promo_pool
     set used_usd = used_usd + p_estimate_usd,
         active = case when used_usd + p_estimate_usd >= pause_at_usd then false else active end,
         updated_at = now()
   where id = 1;

  return jsonb_build_object(
    'ok', true,
    'source', 'deepgram_promo',
    'remaining_seconds', v_remaining_secs - p_estimate_seconds,
    'pool_remaining_usd', v_pool_remaining
  );
end;
$$;
revoke all on function public.reserve_deepgram_promo(uuid, integer, numeric) from public, anon, authenticated;

create or replace function public.settle_deepgram_promo(
  p_user_id uuid,
  p_reserved_seconds integer,
  p_reserved_usd numeric,
  p_actual_seconds integer,
  p_actual_usd numeric
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sec_delta integer := coalesce(p_actual_seconds, 0) - coalesce(p_reserved_seconds, 0);
  v_usd_delta numeric := coalesce(p_actual_usd, 0) - coalesce(p_reserved_usd, 0);
begin
  if v_sec_delta <> 0 then
    update public.deepgram_promo_usage
       set used_seconds = greatest(0, used_seconds + v_sec_delta),
           updated_at = now()
     where user_id = p_user_id;
  end if;
  if v_usd_delta <> 0 then
    update public.deepgram_promo_usage
       set used_usd = greatest(0, used_usd + v_usd_delta),
           updated_at = now()
     where user_id = p_user_id;
    update public.deepgram_promo_pool
       set used_usd = greatest(0, used_usd + v_usd_delta),
           updated_at = now()
     where id = 1;
  end if;
end;
$$;
revoke all on function public.settle_deepgram_promo(uuid, integer, numeric, integer, numeric)
  from public, anon, authenticated;

create index if not exists deepgram_promo_usage_user_idx on public.deepgram_promo_usage (user_id);
