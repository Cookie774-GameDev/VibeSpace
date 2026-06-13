-- =============================================================================
-- Deepgram launch promo behavior verification (migrations 0019 + 0023)
-- =============================================================================
-- Run against linked project after db push:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/deepgram_promo_behavior.sql
-- Creates throwaway users, restores pool state, rolls back auth rows.
--
-- Covers the finalized model (0023):
--   • pool is INACTIVE until launched (active defaults false)
--   • $1,200 ceiling / $1,000 normal hard-stop (no auto active=false flip)
--   • verified email required to claim the founder reward
--   • 7-day expiry → reserve returns promo_expired (lock-back)
--   • admin-granted users may spend the $1,000→$1,200 headroom band
-- =============================================================================

begin;

do $$
declare
  uid_free uuid := gen_random_uuid();
  uid_vip  uuid := gen_random_uuid();
  res jsonb;
  v_active boolean;
  v_used numeric;
  pool_used_before numeric;
  pool_active_before boolean;
  pool_budget_before numeric;
  pool_pause_before numeric;
begin
  select used_usd, active, budget_usd, pause_at_usd
    into pool_used_before, pool_active_before, pool_budget_before, pool_pause_before
    from public.deepgram_promo_pool where id = 1;

  -- Verified-email users (founder claim requires a confirmed email).
  insert into auth.users (id, email, email_confirmed_at)
  values
    (uid_free, 'promo-free-' || uid_free::text || '@test.local', now()),
    (uid_vip,  'promo-vip-'  || uid_vip::text  || '@test.local', now());

  insert into public.profiles (id, tier)
  values (uid_free, 'free'), (uid_vip, 'free')
  on conflict (id) do update set tier = excluded.tier;

  -- Launch the promo for the duration of the test.
  update public.deepgram_promo_pool
     set active = true, used_usd = 0, budget_usd = 1200, pause_at_usd = 1000,
         promo_phase = 'launch_1k', updated_at = now()
   where id = 1;

  -- ── Founder claim grants allowance + 7-day expiry ──────────────────────────
  res := public.claim_launch_founder_reward(uid_free);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'founder claim failed: %', res;
  end if;
  if res->>'expires_at' is null then
    raise exception 'founder claim must set expires_at';
  end if;

  -- ── In-cap reserve succeeds ────────────────────────────────────────────────
  res := public.reserve_deepgram_promo(uid_free, 30, 0.005625);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'in-cap reserve failed: %', res;
  end if;

  -- ── Per-user cap ───────────────────────────────────────────────────────────
  res := public.reserve_deepgram_promo(uid_free, 9999999, 999);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'over per-user cap should reject';
  end if;
  if res->>'reason' is distinct from 'promo_seconds_exceeded' then
    raise exception 'expected promo_seconds_exceeded, got %', res->>'reason';
  end if;

  -- ── $1,000 hard-stop blocks normal users, WITHOUT flipping active ─────────
  update public.deepgram_promo_pool set used_usd = 1000, active = true where id = 1;
  res := public.reserve_deepgram_promo(uid_free, 10, 0.01);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'reserve at $1000 hard-stop should reject for normal user';
  end if;
  if res->>'reason' is distinct from 'promo_pool_paused' then
    raise exception 'expected promo_pool_paused at $1000, got %', res->>'reason';
  end if;
  select active into v_active from public.deepgram_promo_pool where id = 1;
  if v_active is not true then
    raise exception 'active must stay true (pause is enforced inline, not via the flag)';
  end if;

  -- ── Admin-granted user may spend the $1,000→$1,200 headroom band ──────────
  -- (Simulate the grant directly; admin RPC auth is verified separately.)
  insert into public.deepgram_promo_usage (user_id, plan, seconds_limit, used_seconds, used_usd, admin_granted)
  values (uid_vip, 'free', 100000, 0, 0, true)
  on conflict (user_id) do update set seconds_limit = 100000, admin_granted = true, expires_at = null;

  res := public.reserve_deepgram_promo(uid_vip, 100, 50);  -- pushes 1000 → 1050
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'admin-granted user should spend in the headroom band: %', res;
  end if;

  -- ── Absolute $1,200 ceiling blocks everyone, even admin-granted ───────────
  update public.deepgram_promo_pool set used_usd = 1199 where id = 1;
  res := public.reserve_deepgram_promo(uid_vip, 100, 50);  -- 1199 + 50 > 1200
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'reserve crossing $1200 ceiling must reject even for admin-granted';
  end if;
  if res->>'reason' is distinct from 'promo_pool_exhausted' then
    raise exception 'expected promo_pool_exhausted at ceiling, got %', res->>'reason';
  end if;

  -- ── 7-day expiry → lock-back (promo_expired) ──────────────────────────────
  update public.deepgram_promo_pool set used_usd = 0 where id = 1;  -- pool has room
  update public.deepgram_promo_usage set expires_at = now() - interval '1 day' where user_id = uid_free;
  res := public.reserve_deepgram_promo(uid_free, 10, 0.01);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'expired wallet should reject';
  end if;
  if res->>'reason' is distinct from 'promo_expired' then
    raise exception 'expected promo_expired, got %', res->>'reason';
  end if;

  -- ── Sweeper zeroes remaining balance for expired wallets ──────────────────
  perform public.expire_promo_credits();
  select (seconds_limit - used_seconds) into v_used from public.deepgram_promo_usage where user_id = uid_free;
  if v_used > 0 then
    raise exception 'expire_promo_credits should leave no remaining balance, got %', v_used;
  end if;

  -- ── Inactive pool rejects everything ──────────────────────────────────────
  update public.deepgram_promo_pool set active = false where id = 1;
  res := public.reserve_deepgram_promo(uid_vip, 10, 0.01);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'inactive pool should reject';
  end if;
  if res->>'reason' is distinct from 'promo_inactive' then
    raise exception 'expected promo_inactive, got %', res->>'reason';
  end if;

  -- ── Restore original pool state ───────────────────────────────────────────
  update public.deepgram_promo_pool
     set used_usd = pool_used_before, active = pool_active_before,
         budget_usd = pool_budget_before, pause_at_usd = pool_pause_before,
         updated_at = now()
   where id = 1;

  raise notice 'OK: deepgram promo behavior checks passed (0023 model)';
end $$;

rollback;
