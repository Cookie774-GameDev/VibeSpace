-- =============================================================================
-- Hive AI credits behavior verification (migration 0026)
-- =============================================================================
-- Run against linked project after db push:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/hive_ai_credits_behavior.sql
-- =============================================================================

begin;

do $$
declare
  uid_apex uuid := gen_random_uuid();
  uid_free uuid := gen_random_uuid();
  res jsonb;
  event_id uuid;
  used numeric;
begin
  if (select monthly_ai_credits from public.hive_plan_allocations where plan = 'apex') <> 62000 then
    raise exception 'apex should include 62000 AI credits';
  end if;

  insert into auth.users (id, email)
  values
    (uid_apex, 'hive-apex-' || uid_apex::text || '@test.local'),
    (uid_free, 'hive-free-' || uid_free::text || '@test.local');

  insert into public.profiles (id, tier)
  values (uid_apex, 'apex'), (uid_free, 'free')
  on conflict (id) do update set tier = excluded.tier;

  perform public.sync_hive_credit_usage_for_user(uid_apex, 'apex');
  perform public.sync_hive_credit_usage_for_user(uid_free, 'free');

  res := public.reserve_ai_credits(
    uid_apex,
    125,
    jsonb_build_object(
      'preset', 'quality',
      'task_type', 'code',
      'step_id', 'review',
      'provider', 'openai',
      'model', 'gpt-5.5-codex'
    )
  );
  if coalesce((res->>'ok')::boolean, false) is not true then
    raise exception 'apex reserve should succeed: %', res;
  end if;
  event_id := (res->>'event_id')::uuid;

  perform public.settle_ai_credits(uid_apex, event_id, 125, 100);
  select used_ai_credits into used from public.hive_credit_usage where user_id = uid_apex;
  if used <> 100 then
    raise exception 'settle should refund to actual 100 credits, got %', used;
  end if;

  res := public.reserve_ai_credits(uid_free, 1, '{}'::jsonb);
  if (res->>'reason') is distinct from 'ai_credits_exhausted' then
    raise exception 'free reserve expected ai_credits_exhausted, got %', res;
  end if;

  if has_function_privilege('authenticated', 'public.reserve_ai_credits(uuid, numeric, jsonb)', 'execute') then
    raise exception 'authenticated must not execute reserve_ai_credits';
  end if;
  if has_function_privilege('anon', 'public.settle_ai_credits(uuid, uuid, numeric, numeric)', 'execute') then
    raise exception 'anon must not execute settle_ai_credits';
  end if;
  if not has_function_privilege('service_role', 'public.reserve_ai_credits(uuid, numeric, jsonb)', 'execute') then
    raise exception 'service_role must execute reserve_ai_credits';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'hive_credit_usage'
       and policyname = 'hive_credit_usage_select_own'
  ) then
    raise exception 'hive_credit_usage select-own policy missing';
  end if;

  raise notice 'hive AI credits behavior: ALL CHECKS PASSED';
end $$;

rollback;
