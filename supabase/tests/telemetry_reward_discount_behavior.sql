begin;

select plan(8);

select has_column('public', 'profiles', 'telemetry_policy_version');
select has_column('public', 'profiles', 'telemetry_data_classes');
select has_table('public', 'telemetry_consent_audit');
select has_table('public', 'family_discount_entitlements');
select has_function(
  'public',
  'set_telemetry_reward_consent',
  array['uuid', 'boolean', 'text', 'text[]']
);
select is(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.telemetry_consent_audit'::regclass
  ),
  true,
  'telemetry audit uses RLS'
);
select is(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.family_discount_entitlements'::regclass
  ),
  true,
  'family discount entitlement uses RLS'
);
select is(
  has_table_privilege('authenticated', 'public.family_discount_entitlements', 'UPDATE'),
  false,
  'authenticated users cannot mutate authoritative family discounts'
);

select * from finish();
rollback;
