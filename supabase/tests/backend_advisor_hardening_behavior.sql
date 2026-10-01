begin;

do $$
declare
  v_security_definer boolean;
  v_duplicate_select_policies integer;
  v_table text;
  v_role text;
begin
  select p.prosecdef
    into v_security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'set_phone_pin'
    and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_pin text';

  if v_security_definer is distinct from false then
    raise exception 'set_phone_pin must be SECURITY INVOKER';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'admin_credit_grants'
      and indexname = 'admin_credit_grants_admin_idx'
  ) then
    raise exception 'admin_credit_grants_admin_idx is missing';
  end if;

  select count(*)
    into v_duplicate_select_policies
  from pg_policies
  where schemaname = 'public'
    and tablename in (
      'deepgram_promo_pool',
      'deepgram_promo_usage',
      'hive_credit_usage',
      'hive_usage_events',
      'sms_usage'
    )
    and cmd in ('ALL', 'SELECT');

  if v_duplicate_select_policies <> 5 then
    raise exception
      'expected one effective SELECT policy per protected table, got %',
      v_duplicate_select_policies;
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'deepgram_promo_plan_limits'
      and policyname = 'deepgram_promo_plan_limits_read'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and qual = 'true'
  ) then
    raise exception
      'deepgram_promo_plan_limits_read must be an authenticated role-scoped policy';
  end if;

  foreach v_table in array array[
    'deepgram_promo_pool',
    'deepgram_promo_usage',
    'hive_credit_usage',
    'hive_usage_events',
    'sms_usage'
  ]
  loop
    foreach v_role in array array['anon', 'authenticated']
    loop
      if exists (
        select 1
        from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = v_table
          and grantee = v_role
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      ) then
        raise exception '% unexpectedly has client write access to %', v_role, v_table;
      end if;
    end loop;
  end loop;
end
$$;

rollback;
