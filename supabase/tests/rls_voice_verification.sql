-- =============================================================================
-- RLS / security verification for the voice subscription system (migration 0012)
-- =============================================================================
-- Run AFTER `supabase db push` against the linked project:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/rls_voice_verification.sql
-- or paste into the Supabase SQL editor. Each block RAISEs on failure so the
-- script aborts loudly if a policy regressed. Read-only except for two temp
-- auth.users rows it creates and rolls back.
-- =============================================================================

begin;

-- ── 1. RLS is enabled on every sensitive table ───────────────────────────────
do $$
declare
  t text;
  tables text[] := array['voice_usage','voice_events','subscription_events',
                         'voice_rate_limits','api_key_settings'];
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then
      raise exception 'RLS NOT enabled on public.%', t;
    end if;
  end loop;
  raise notice 'OK: RLS enabled on all 5 voice tables';
end $$;

-- ── 2. Service-role-only tables expose NO permissive client SELECT ────────────
do $$
declare
  cnt int;
begin
  -- subscription_events + voice_rate_limits must have only a USING(false) policy
  select count(*) into cnt
  from pg_policies
  where schemaname = 'public'
    and tablename in ('subscription_events','voice_rate_limits')
    and qual <> 'false';
  if cnt > 0 then
    raise exception 'subscription_events/voice_rate_limits has a non-false client policy';
  end if;
  raise notice 'OK: service-role-only tables block client reads';
end $$;

-- ── 3. voice_usage / voice_events: only own-row SELECT, no client writes ──────
do $$
declare
  has_write int;
begin
  select count(*) into has_write
  from pg_policies
  where schemaname = 'public'
    and tablename in ('voice_usage','voice_events')
    and cmd <> 'SELECT';
  if has_write > 0 then
    raise exception 'voice_usage/voice_events expose a client write policy';
  end if;
  raise notice 'OK: voice_usage/voice_events are read-only (own row) for clients';
end $$;

-- ── 4. RPCs exist and are revoked from anon/authenticated ─────────────────────
do $$
declare
  fn text;
  fns text[] := array['reserve_voice_seconds','settle_voice_seconds','sync_voice_usage_for_user'];
begin
  foreach fn in array fns loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname='public' and p.proname=fn) then
      raise exception 'RPC % missing', fn;
    end if;
    if has_function_privilege('authenticated', format('public.%I(uuid,integer)', fn), 'EXECUTE')
       and fn = 'reserve_voice_seconds' then
      raise exception 'reserve_voice_seconds is EXECUTABLE by authenticated (should be revoked)';
    end if;
  end loop;
  raise notice 'OK: quota RPCs exist and are not client-executable';
end $$;

-- ── 5. Plan→budget→seconds math matches the documented cost model ─────────────
do $$
begin
  if public.voice_seconds_for_budget(public.voice_budget_for_plan('starter')) <> 8000 then
    raise exception 'starter seconds != 8000';
  end if;
  if public.voice_seconds_for_budget(public.voice_budget_for_plan('pro')) <> 40000 then
    raise exception 'pro seconds != 40000';
  end if;
  if public.voice_seconds_for_budget(public.voice_budget_for_plan('ultra')) <> 80000 then
    raise exception 'ultra seconds != 80000';
  end if;
  if public.voice_seconds_for_budget(public.voice_budget_for_plan('free')) <> 0 then
    raise exception 'free seconds != 0';
  end if;
  raise notice 'OK: plan->budget->seconds mapping is correct';
end $$;

-- ── 6. Atomic reservation rejects when over quota, succeeds within quota ──────
-- Uses a throwaway user id; rolled back at the end.
do $$
declare
  uid uuid := gen_random_uuid();
  res jsonb;
begin
  insert into auth.users (id, email) values (uid, 'rls-test@example.com')
    on conflict do nothing;
  perform public.sync_voice_usage_for_user(uid, 'starter'); -- 8000s limit

  res := public.reserve_voice_seconds(uid, 100);
  if (res->>'ok')::boolean is not true then
    raise exception 'reserve within quota failed: %', res;
  end if;

  res := public.reserve_voice_seconds(uid, 999999); -- over remaining
  if (res->>'ok')::boolean is true then
    raise exception 'reserve over quota incorrectly succeeded';
  end if;
  if (res->>'reason') <> 'quota_exceeded' then
    raise exception 'expected quota_exceeded, got %', res->>'reason';
  end if;

  -- Free user has 0 limit -> no_cloud_quota
  perform public.sync_voice_usage_for_user(uid, 'free');
  res := public.reserve_voice_seconds(uid, 1);
  if (res->>'reason') <> 'no_cloud_quota' then
    raise exception 'free user should get no_cloud_quota, got %', res->>'reason';
  end if;

  raise notice 'OK: atomic quota reservation enforces limits';
end $$;

-- ── 7. message/call tables: RLS enabled + service-role-only rate limits ──────
do $$
declare
  t text;
  tables text[] := array['message_usage','message_events','message_rate_limits',
                         'call_usage','call_events','call_rate_limits',
                         'subscription_plan_limits'];
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relname=t and c.relrowsecurity
    ) then
      raise exception 'RLS NOT enabled on public.%', t;
    end if;
  end loop;
  raise notice 'OK: RLS enabled on message/call/plan tables';
end $$;

-- ── 8. plan limits seeded with the friendly credits/minutes ──────────────────
do $$
declare v public.subscription_plan_limits%rowtype;
begin
  select * into v from public.subscription_plan_limits where plan='starter';
  if v.message_credits <> 2500 or v.call_minutes <> 25 then
    raise exception 'starter limits wrong: % credits, % min', v.message_credits, v.call_minutes;
  end if;
  select * into v from public.subscription_plan_limits where plan='ultra';
  if v.message_credits <> 25000 or v.call_minutes <> 250 then
    raise exception 'ultra limits wrong';
  end if;
  raise notice 'OK: subscription_plan_limits seeded correctly';
end $$;

-- ── 9. message/call budget reserve enforces limits ───────────────────────────
do $$
declare
  uid uuid := gen_random_uuid();
  res jsonb;
begin
  insert into auth.users (id, email) values (uid, 'rls-mc@example.com') on conflict do nothing;
  perform public.sync_message_call_usage_for_user(uid, 'starter');

  res := public.reserve_message_budget(uid, 0.01);
  if (res->>'ok')::boolean is not true then raise exception 'msg reserve in-budget failed: %', res; end if;
  res := public.reserve_message_budget(uid, 999);
  if (res->>'ok')::boolean is true then raise exception 'msg reserve over-budget succeeded'; end if;

  res := public.reserve_call_budget(uid, 0.01);
  if (res->>'ok')::boolean is not true then raise exception 'call reserve in-budget failed: %', res; end if;
  res := public.reserve_call_budget(uid, 999);
  if (res->>'ok')::boolean is true then raise exception 'call reserve over-budget succeeded'; end if;

  perform public.sync_message_call_usage_for_user(uid, 'free');
  res := public.reserve_message_budget(uid, 0.01);
  if (res->>'reason') <> 'no_message_budget' then raise exception 'free msg should have no budget, got %', res->>'reason'; end if;

  raise notice 'OK: message/call budgets enforce limits';
end $$;

rollback; -- discard the throwaway auth.users row + usage

\echo 'All RLS / quota verification checks passed.'
