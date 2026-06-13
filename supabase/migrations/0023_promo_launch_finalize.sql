-- =============================================================================
-- 0023_promo_launch_finalize: production launch-promo finalization
-- =============================================================================
-- Locks in the launch economics the founder signed off on. Supersedes the
-- budget/active config from 0019/0020 and the claim/reserve logic from 0022.
--
-- WHAT THIS MIGRATION GUARANTEES
-- ------------------------------------------------------------------------------
-- 1. POOL = $1,200 ceiling, $1,000 operational hard-stop, $200 reward headroom.
--      • budget_usd   = 1200  → absolute spend ceiling (reserve hard-rejects above)
--      • pause_at_usd = 1000  → normal promo claims/spend stop here
--      • 1000 → 1200 band     → spendable ONLY by admin-rewarded ("top") users
-- 2. INACTIVE UNTIL LAUNCH. active = false on deploy. Nothing is given out until
--    the founder runs select public.admin_set_promo('launch_1k', true);
-- 3. 7-DAY EXPIRY + LOCK-BACK. Founder $5 and Spark $2 credits expire 7 days
--    after they are claimed; reserve_deepgram_promo refuses expired wallets and
--    expire_promo_credits() sweeps remaining balance back to zero (cloud voice /
--    Jarvis Call / STT lock back to BYOK + local Kokoro).
-- 4. ADMIN REWARDS. admin_grant_promo_credit(email, usd, days) lets the founder
--    top up any user by email, audited in admin_credit_grants. Drawn from the
--    $200 headroom (band 1000→1200), never above the $1,200 ceiling.
-- 5. ABUSE HARDENING. One claim per user (PK), verified email required, founder
--    slot cap (200) and Spark slot cap (1,000) re-checked under a pool row lock
--    to prevent race-condition over-grants, all claim/grant RPCs are
--    SECURITY DEFINER + revoked from anon/authenticated.
--
-- Cost basis: Deepgram Aura-1 ≈ $0.0001875/sec ($0.01125/min). $5 ≈ 26,667 s.
-- =============================================================================

-- ─── 1. Pool: $1,200 ceiling / $1,000 stop / inactive until launch ───────────
update public.deepgram_promo_pool
   set budget_usd   = 1200,   -- absolute company liability ceiling
       pause_at_usd = 1000,   -- normal promo hard-stop ($200 headroom remains)
       active       = false,  -- stays OFF until the founder launches the promo
       promo_phase  = 'launch_1k',
       updated_at   = now()
 where id = 1;

alter table public.deepgram_promo_pool
  alter column budget_usd set default 1200,
  alter column pause_at_usd set default 1000,
  alter column active set default false;

-- ─── 2. Per-user wallet: expiry + admin-reward flag ──────────────────────────
alter table public.deepgram_promo_usage
  add column if not exists expires_at    timestamptz,          -- null = no expiry (paid launch bonus)
  add column if not exists admin_granted boolean not null default false; -- true = may spend $1,000→$1,200 headroom

create index if not exists deepgram_promo_usage_expires_idx
  on public.deepgram_promo_usage (expires_at)
  where expires_at is not null;

-- ─── 3. Reward ledgers: expiry stamp ─────────────────────────────────────────
alter table public.launch_founder_rewards
  add column if not exists expires_at timestamptz;

alter table public.launch_spark_promo_rewards
  add column if not exists expires_at timestamptz;

-- ─── 4. Admin reward audit log ───────────────────────────────────────────────
create table if not exists public.admin_credit_grants (
  id              bigint generated always as identity primary key,
  admin_user_id   uuid references auth.users(id) on delete set null,
  target_user_id  uuid not null references auth.users(id) on delete cascade,
  target_email    text not null,
  usd             numeric not null,
  seconds_added   integer not null,
  expires_at      timestamptz,
  note            text,
  created_at      timestamptz not null default now()
);

create index if not exists admin_credit_grants_target_idx
  on public.admin_credit_grants (target_user_id, created_at desc);

alter table public.admin_credit_grants enable row level security;
drop policy if exists admin_credit_grants_service on public.admin_credit_grants;
create policy admin_credit_grants_service on public.admin_credit_grants
  for all to service_role using (true) with check (true);

-- ─── 5. Admin authorization helper ───────────────────────────────────────────
-- True for the service role (agent / edge functions) or a registered app admin
-- acting on their own session. Never true for anon.
create or replace function public.is_promo_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return true;
  end if;
  if coalesce(auth.role(), '') = 'anon' then
    return false;
  end if;
  return public.is_app_admin(auth.uid());
end;
$$;

revoke all on function public.is_promo_admin() from public, anon;
grant execute on function public.is_promo_admin() to authenticated, service_role;

-- ─── 6. Founder $5 claim — pool-aware, verified-email, race-safe, 7-day expiry ─
create or replace function public.claim_launch_founder_reward(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.deepgram_promo_pool%rowtype;
  v_count integer;
  v_verified boolean;
  v_founder_seconds constant integer := 26667; -- $5 @ $0.0001875/s
  v_expires timestamptz := now() + interval '7 days';
begin
  -- Serialize founder claims on the pool row so the 200-slot cap is race-safe.
  select * into v_pool from public.deepgram_promo_pool where id = 1 for update;
  if not found or not v_pool.active then
    return jsonb_build_object('ok', false, 'reason', 'promo_inactive');
  end if;
  if v_pool.promo_phase is distinct from 'launch_1k'
     and v_pool.promo_phase is distinct from 'scale_5k' then
    return jsonb_build_object('ok', false, 'reason', 'promo_inactive');
  end if;
  if v_pool.used_usd >= v_pool.pause_at_usd then
    return jsonb_build_object('ok', false, 'reason', 'promo_pool_paused');
  end if;

  if exists (select 1 from public.launch_founder_rewards where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;

  -- Verified email required (anti-abuse: no card, but real inbox).
  select (email_confirmed_at is not null) into v_verified
    from auth.users where id = p_user_id;
  if not coalesce(v_verified, false) then
    return jsonb_build_object('ok', false, 'reason', 'email_unverified');
  end if;

  select count(*)::integer into v_count from public.launch_founder_rewards;
  if v_count >= 200 then
    return jsonb_build_object('ok', false, 'reason', 'founder_slots_exhausted');
  end if;

  insert into public.launch_founder_rewards (user_id, welcome_usd, seconds_limit, expires_at)
  values (p_user_id, 5.00, v_founder_seconds, v_expires);

  insert into public.deepgram_promo_usage
    (user_id, plan, seconds_limit, used_seconds, used_usd, expires_at)
  values (p_user_id, 'free', v_founder_seconds, 0, 0, v_expires)
  on conflict (user_id) do update
    set seconds_limit = greatest(deepgram_promo_usage.seconds_limit, v_founder_seconds),
        expires_at    = v_expires,
        updated_at    = now();

  return jsonb_build_object(
    'ok', true, 'reward', 'founder', 'welcome_usd', 5,
    'bonus_seconds', v_founder_seconds, 'slot', v_count + 1,
    'expires_at', v_expires
  );
end;
$$;

revoke all on function public.claim_launch_founder_reward(uuid) from public, anon, authenticated;
-- Explicit (not relying on Supabase default privileges): the claim-launch-promo
-- edge function calls this with the service role.
grant execute on function public.claim_launch_founder_reward(uuid) to service_role;

-- ─── 7. Spark $2 claim (phase 2 only) — same guards + 7-day expiry ───────────
create or replace function public.claim_launch_spark_promo(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.deepgram_promo_pool%rowtype;
  v_count integer;
  v_verified boolean;
  v_spark_seconds constant integer := 10667; -- $2 @ $0.0001875/s
  v_expires timestamptz := now() + interval '7 days';
begin
  select * into v_pool from public.deepgram_promo_pool where id = 1 for update;
  if not found or not v_pool.active then
    return jsonb_build_object('ok', false, 'reason', 'promo_inactive');
  end if;
  if coalesce(v_pool.promo_phase, 'launch_1k') <> 'scale_5k' then
    return jsonb_build_object('ok', false, 'reason', 'spark_promo_not_active');
  end if;
  if v_pool.used_usd >= v_pool.pause_at_usd then
    return jsonb_build_object('ok', false, 'reason', 'promo_pool_paused');
  end if;

  if exists (select 1 from public.launch_founder_rewards where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'founder_already_has_credit');
  end if;
  if exists (select 1 from public.launch_spark_promo_rewards where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;

  select (email_confirmed_at is not null) into v_verified
    from auth.users where id = p_user_id;
  if not coalesce(v_verified, false) then
    return jsonb_build_object('ok', false, 'reason', 'email_unverified');
  end if;

  select count(*)::integer into v_count from public.launch_spark_promo_rewards;
  if v_count >= 1000 then
    return jsonb_build_object('ok', false, 'reason', 'spark_promo_slots_exhausted');
  end if;

  insert into public.launch_spark_promo_rewards (user_id, welcome_usd, seconds_limit, expires_at)
  values (p_user_id, 2.00, v_spark_seconds, v_expires);

  insert into public.deepgram_promo_usage
    (user_id, plan, seconds_limit, used_seconds, used_usd, expires_at)
  values (p_user_id, 'free', v_spark_seconds, 0, 0, v_expires)
  on conflict (user_id) do update
    set seconds_limit = greatest(deepgram_promo_usage.seconds_limit, v_spark_seconds),
        expires_at    = v_expires,
        updated_at    = now();

  return jsonb_build_object(
    'ok', true, 'reward', 'spark', 'welcome_usd', 2,
    'bonus_seconds', v_spark_seconds, 'slot', v_count + 1,
    'expires_at', v_expires
  );
end;
$$;

revoke all on function public.claim_launch_spark_promo(uuid) from public, anon, authenticated;
grant execute on function public.claim_launch_spark_promo(uuid) to service_role;

-- ─── 8. reserve_deepgram_promo: expiry check + admin reward headroom ─────────
-- Behaviour change vs 0019: the pause threshold ($1,000) no longer flips the
-- `active` flag — it is checked inline so admin-rewarded users can keep spending
-- in the $1,000→$1,200 headroom band. `active` is now a pure manual on/off
-- switch (pre-launch / admin pause). Absolute ceiling ($1,200) blocks everyone.
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

  perform public.sync_deepgram_promo_for_user(
    p_user_id,
    (select coalesce(tier, 'free') from public.profiles where id = p_user_id)
  );

  select * into v_row from public.deepgram_promo_usage where user_id = p_user_id for update;
  if not found or v_row.seconds_limit <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_promo_allowance');
  end if;

  -- 7-day lock-back: expired wallets fall through to BYOK / local Kokoro.
  if v_row.expires_at is not null and now() >= v_row.expires_at then
    return jsonb_build_object('ok', false, 'reason', 'promo_expired');
  end if;

  -- Normal users stop at the $1,000 pause line; admin-rewarded users may spend
  -- the $1,000→$1,200 headroom band.
  if v_pool.used_usd >= v_pool.pause_at_usd and not coalesce(v_row.admin_granted, false) then
    return jsonb_build_object('ok', false, 'reason', 'promo_pool_paused');
  end if;

  -- Absolute ceiling — nobody crosses $1,200.
  if v_pool.used_usd + p_estimate_usd > v_pool.budget_usd then
    return jsonb_build_object('ok', false, 'reason', 'promo_pool_exhausted',
      'pool_remaining_usd', greatest(0, v_pool.budget_usd - v_pool.used_usd));
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
grant execute on function public.reserve_deepgram_promo(uuid, integer, numeric) to service_role;

-- ─── 9. Admin: reward a top user by email (drawn from $200 headroom) ─────────
create or replace function public.admin_grant_promo_credit(
  p_email text,
  p_usd numeric,
  p_days integer default 7,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.deepgram_promo_pool%rowtype;
  v_target uuid;
  v_seconds integer;
  v_expires timestamptz;
begin
  if not public.is_promo_admin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if p_usd is null or p_usd <= 0 or p_usd > 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); -- single grant cap = $200 headroom
  end if;
  -- Clamp the expiry window: 0/null = no expiry; otherwise 1..3650 days.
  if p_days is not null and p_days > 0 then
    p_days := least(greatest(p_days, 1), 3650);
  end if;

  select id into v_target from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_target is null then
    return jsonb_build_object('ok', false, 'reason', 'user_not_found', 'email', p_email);
  end if;

  select * into v_pool from public.deepgram_promo_pool where id = 1 for update;
  v_seconds := ceil(p_usd / coalesce(nullif(v_pool.cost_per_second, 0), 0.0001875))::integer;
  v_expires := case when coalesce(p_days, 0) > 0 then now() + make_interval(days => p_days) else null end;

  insert into public.deepgram_promo_usage
    (user_id, plan, seconds_limit, used_seconds, used_usd, expires_at, admin_granted)
  values (
    v_target,
    coalesce((select tier from public.profiles where id = v_target), 'free'),
    v_seconds, 0, 0, v_expires, true
  )
  on conflict (user_id) do update
    set seconds_limit = deepgram_promo_usage.seconds_limit + v_seconds,
        admin_granted = true,
        expires_at    = case
                          when v_expires is null then deepgram_promo_usage.expires_at
                          else greatest(coalesce(deepgram_promo_usage.expires_at, v_expires), v_expires)
                        end,
        updated_at    = now();

  insert into public.admin_credit_grants
    (admin_user_id, target_user_id, target_email, usd, seconds_added, expires_at, note)
  values (auth.uid(), v_target, lower(trim(p_email)), p_usd, v_seconds, v_expires, p_note);

  return jsonb_build_object(
    'ok', true, 'email', lower(trim(p_email)), 'user_id', v_target,
    'usd', p_usd, 'seconds_added', v_seconds, 'expires_at', v_expires
  );
end;
$$;

revoke all on function public.admin_grant_promo_credit(text, numeric, integer, text) from public, anon;
grant execute on function public.admin_grant_promo_credit(text, numeric, integer, text)
  to authenticated, service_role;

-- ─── 10. Admin: launch / pause / phase-flip the promo ────────────────────────
-- Phase 1 (launch_1k): $1,200 ceiling / $1,000 stop.
-- Phase 2 (scale_5k):  $5,000 ceiling / $4,500 stop.
create or replace function public.admin_set_promo(p_phase text, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget numeric;
  v_pause  numeric;
begin
  if not public.is_promo_admin() then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  if p_phase not in ('launch_1k', 'scale_5k') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phase');
  end if;

  if p_phase = 'launch_1k' then
    v_budget := 1200; v_pause := 1000;
  else
    v_budget := 5000; v_pause := 4500;
  end if;

  update public.deepgram_promo_pool
     set promo_phase  = p_phase,
         budget_usd   = v_budget,
         pause_at_usd = v_pause,
         active       = p_active,
         updated_at   = now()
   where id = 1;

  return jsonb_build_object('ok', true, 'phase', p_phase, 'active', p_active,
                            'budget_usd', v_budget, 'pause_at_usd', v_pause);
end;
$$;

revoke all on function public.admin_set_promo(text, boolean) from public, anon;
grant execute on function public.admin_set_promo(text, boolean) to authenticated, service_role;

-- ─── 11. Expiry sweeper (lock-back) — safe to run on a schedule ──────────────
-- Zeroes remaining balance for expired wallets so cloud features lock back even
-- if the user never triggers a reserve. Pair with pg_cron if available:
--   select cron.schedule('expire-promo', '*/30 * * * *', $$select public.expire_promo_credits()$$);
create or replace function public.expire_promo_credits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with swept as (
    update public.deepgram_promo_usage
       set seconds_limit = used_seconds, -- no remaining balance → lock-back
           updated_at = now()
     where expires_at is not null
       and now() >= expires_at
       and seconds_limit > used_seconds
    returning user_id
  )
  select count(*)::integer into v_count from swept;
  return v_count;
end;
$$;

revoke all on function public.expire_promo_credits() from public, anon, authenticated;
grant execute on function public.expire_promo_credits() to service_role;

-- ─── 12. Backfill expiry for any wallet already claimed (defensive) ──────────
-- If 0022 claims ran before this migration, stamp a 7-day clock from claim time.
update public.launch_founder_rewards
   set expires_at = claimed_at + interval '7 days'
 where expires_at is null;

update public.launch_spark_promo_rewards
   set expires_at = claimed_at + interval '7 days'
 where expires_at is null;

update public.deepgram_promo_usage u
   set expires_at = r.expires_at
  from public.launch_founder_rewards r
 where u.user_id = r.user_id and u.expires_at is null;

update public.deepgram_promo_usage u
   set expires_at = r.expires_at
  from public.launch_spark_promo_rewards r
 where u.user_id = r.user_id and u.expires_at is null;
