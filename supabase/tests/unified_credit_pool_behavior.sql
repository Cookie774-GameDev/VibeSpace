-- =============================================================================
-- Unified company credit pool — focused fungibility checks (migration 0030)
-- =============================================================================
-- Transactional: all work rolls back. Safe on production project.
-- Windows: 5h = 8% of pool, week = 25% (starter pool = 5.50 → 0.44 / 1.375).
-- =============================================================================

begin;

do $$
declare
  uid uuid := gen_random_uuid();
  res jsonb;
  pool numeric;
  used_after numeric;
begin
  pool := public.unified_plan_budget_usd('starter');
  if pool is distinct from 5.50 then
    raise exception 'starter pool expected 5.50 got %', pool;
  end if;
  if public.unified_plan_budget_usd('pro') is distinct from 27.50 then
    raise exception 'pro pool expected 27.50';
  end if;
  if public.unified_plan_budget_usd('ultra') is distinct from 55.00 then
    raise exception 'ultra pool expected 55.00';
  end if;
  if public.unified_plan_budget_usd('apex') is distinct from 110.00 then
    raise exception 'apex pool expected 110.00';
  end if;

  insert into auth.users (id, email)
  values (uid, 'unified-pool-' || uid::text || '@test.local');
  insert into public.profiles (id, tier) values (uid, 'starter')
    on conflict (id) do update set tier = 'starter';
  perform public.sync_message_call_usage_for_user(uid, 'starter');

  if public.unified_used_usd(uid) <> 0 then
    raise exception 'fresh user used should be 0, got %', public.unified_used_usd(uid);
  end if;

  -- Spends must fit in 5h window (≤ 0.44 for starter).
  res := public.reserve_message_budget(uid, 0.05);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'message reserve 0.05 failed: %', res;
  end if;
  res := public.reserve_call_budget(uid, 0.05);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'call reserve 0.05 failed: %', res;
  end if;
  res := public.reserve_sms_budget(uid, 0.03, 3);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'sms reserve 0.03 failed: %', res;
  end if;

  used_after := public.unified_used_usd(uid);
  if abs(used_after - 0.13) > 0.001 then
    raise exception 'unified used expected 0.13 got %', used_after;
  end if;

  -- Over 5h remaining (~0.31 left in window): should hit window or budget.
  res := public.reserve_message_budget(uid, 0.35);
  if (res->>'reason') is distinct from 'window_5h_exceeded'
     and (res->>'reason') is distinct from 'budget_exceeded' then
    raise exception 'over-window spend should fail, got %', res;
  end if;

  -- Clear windows; set used to pool - 0.05; next 0.10 must fail monthly.
  update public.message_usage
     set used_usd = 5.45,
         window_5h_start = now(), window_5h_used_usd = 0,
         window_week_start = now(), window_week_used_usd = 0
   where user_id = uid;
  update public.call_usage set used_usd = 0 where user_id = uid;
  update public.sms_usage set used_usd = 0 where user_id = uid;
  res := public.reserve_call_budget(uid, 0.10);
  if (res->>'reason') is distinct from 'budget_exceeded' then
    raise exception 'call over shared monthly should budget_exceeded, got %', res;
  end if;

  -- Small remaining still works for any service.
  res := public.reserve_sms_budget(uid, 0.04, 1);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'sms should use last 0.05 of pool: %', res;
  end if;

  -- Fungibility: past silo message_budget (2.475) still OK under pool with clear windows.
  update public.message_usage
     set used_usd = 2.50,
         window_5h_start = now(), window_5h_used_usd = 0,
         window_week_start = now(), window_week_used_usd = 0
   where user_id = uid;
  update public.call_usage set used_usd = 0 where user_id = uid;
  update public.sms_usage set used_usd = 0 where user_id = uid;
  res := public.reserve_message_budget(uid, 0.05);
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'fungible past silo message budget failed: %', res;
  end if;

  raise notice 'unified_credit_pool_behavior: ALL CHECKS PASSED';
end $$;

rollback;
