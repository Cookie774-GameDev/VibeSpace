-- =============================================================================
-- Deepgram launch promo behavior verification (migration 0019)
-- =============================================================================
-- Run against linked project after db push:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/deepgram_promo_behavior.sql
-- Creates throwaway users, restores pool state, rolls back auth rows.
-- =============================================================================

begin;

do $$
declare
  uid_free uuid := gen_random_uuid();
  uid_paid uuid := gen_random_uuid();
  res jsonb;
  v_active boolean;
  v_used numeric;
  pool_used_before numeric;
  pool_active_before boolean;
begin
  select used_usd, active into pool_used_before, pool_active_before
    from public.deepgram_promo_pool where id = 1;

  insert into auth.users (id, email)
  values
    (uid_free, 'promo-free-' || uid_free::text || '@test.local'),
    (uid_paid, 'promo-paid-' || uid_paid::text || '@test.local');

  insert into public.profiles (id, tier)
  values (uid_free, 'free'), (uid_paid, 'starter')
  on conflict (id) do update set tier = excluded.tier;

  perform public.sync_deepgram_promo_for_user(uid_free, 'free');
  perform public.sync_deepgram_promo_for_user(uid_paid, 'starter');
  perform public.sync_message_call_usage_for_user(uid_paid, 'starter');

  -- In-cap reserve
  res := public.reserve_deepgram_promo(uid_free, 30, 0.005625);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'in-cap reserve failed: %', res;
  end if;

  -- Per-user cap
  res := public.reserve_deepgram_promo(uid_free, 9999, 999);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'over per-user cap should reject';
  end if;
  if res->>'reason' is distinct from 'promo_seconds_exceeded' then
    raise exception 'expected promo_seconds_exceeded, got %', res->>'reason';
  end if;

  -- 90% kill switch: reserve crossing $900 flips active=false
  update public.deepgram_promo_pool
     set used_usd = 899, active = true, updated_at = now()
   where id = 1;

  res := public.reserve_deepgram_promo(uid_paid, 10, 2.0);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'kill-switch crossing reserve failed: %', res;
  end if;

  select active, used_usd into v_active, v_used from public.deepgram_promo_pool where id = 1;
  if v_active is not false then
    raise exception 'active should be false after kill switch';
  end if;
  if v_used < 900 then
    raise exception 'used_usd should be >= 900 after kill switch, got %', v_used;
  end if;

  -- Post-kill reject
  res := public.reserve_deepgram_promo(uid_paid, 10, 0.01);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'post-kill reserve should fail';
  end if;
  if res->>'reason' not in ('promo_inactive', 'promo_pool_paused') then
    raise exception 'unexpected post-kill reason: %', res->>'reason';
  end if;

  -- Exact pause_at with active still true (settlement drift)
  update public.deepgram_promo_pool set used_usd = 900, active = true where id = 1;
  res := public.reserve_deepgram_promo(uid_paid, 10, 0.01);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'exact pause_at should reject';
  end if;
  if res->>'reason' is distinct from 'promo_pool_paused' then
    raise exception 'expected promo_pool_paused at exact threshold, got %', res->>'reason';
  end if;

  -- Paid fallback to call budget when promo dead
  res := public.reserve_call_budget(uid_paid, 0.01);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'paid call budget should work after promo pause: %', res;
  end if;

  -- Free users have no call budget
  res := public.reserve_call_budget(uid_free, 0.01);
  if coalesce((res->>'ok')::boolean, false) is true then
    raise exception 'free call budget should reject';
  end if;
  if res->>'reason' is distinct from 'no_call_budget' then
    raise exception 'expected no_call_budget for free, got %', res->>'reason';
  end if;

  update public.deepgram_promo_pool
     set used_usd = pool_used_before, active = pool_active_before, updated_at = now()
   where id = 1;

  raise notice 'OK: deepgram promo behavior checks passed';
end $$;

rollback;
