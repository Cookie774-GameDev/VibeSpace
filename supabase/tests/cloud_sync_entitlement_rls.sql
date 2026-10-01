-- Focused verification for migration 0033. Transactional and rollback-only.
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'sync-free@test.local'),
  ('22222222-2222-4222-8222-222222222222', 'sync-paid@test.local'),
  ('33333333-3333-4333-8333-333333333333', 'sync-admin@test.local');
insert into public.profiles (id, tier) values
  ('11111111-1111-4111-8111-111111111111', 'free'),
  ('22222222-2222-4222-8222-222222222222', 'starter'),
  ('33333333-3333-4333-8333-333333333333', 'free')
on conflict (id) do update set tier=excluded.tier;
insert into public.app_admins (user_id, note) values
  ('33333333-3333-4333-8333-333333333333', 'rollback test admin');
insert into public.app_sync_records (user_id, table_name, row_id, op, payload) values
  ('11111111-1111-4111-8111-111111111111', 'settings', 'free-row', 'insert', '{}'),
  ('22222222-2222-4222-8222-222222222222', 'settings', 'paid-row', 'insert', '{}'),
  ('33333333-3333-4333-8333-333333333333', 'settings', 'admin-row', 'insert', '{}')
on conflict (user_id, table_name, row_id) do nothing;

do $$
declare
  free_uid uuid := '11111111-1111-4111-8111-111111111111';
  paid_uid uuid := '22222222-2222-4222-8222-222222222222';
  admin_uid uuid := '33333333-3333-4333-8333-333333333333';
  own jsonb;
begin
  perform set_config('request.jwt.claim.sub', free_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  if public.can_use_cloud_sync() then
    raise exception 'free user was granted cloud sync';
  end if;

  perform set_config('request.jwt.claim.sub', paid_uid::text, true);
  if not public.can_use_cloud_sync() then
    raise exception 'paid user was denied cloud sync';
  end if;
  select to_jsonb(e) into own from public.get_my_entitlements() e;
  if own->>'user_id' is distinct from paid_uid::text
     or own->>'plan' is distinct from 'starter'
     or coalesce((own->>'cloud_sync_allowed')::boolean, false) is not true then
    raise exception 'own entitlement response is incorrect: %', own;
  end if;

  perform set_config('request.jwt.claim.sub', admin_uid::text, true);
  select to_jsonb(e) into own from public.get_my_entitlements() e;
  if own->>'user_id' is distinct from admin_uid::text
     or own->>'plan' is distinct from 'free'
     or coalesce((own->>'is_admin')::boolean, false) is not true
     or coalesce((own->>'cloud_sync_allowed')::boolean, false) is not true then
    raise exception 'admin own entitlement response is incorrect: %', own;
  end if;

  if has_function_privilege('anon', 'public.get_my_entitlements()', 'execute') then
    raise exception 'anonymous caller can fetch entitlements';
  end if;
  if not has_function_privilege('authenticated', 'public.get_my_entitlements()', 'execute') then
    raise exception 'authenticated caller cannot fetch own entitlements';
  end if;
  if has_table_privilege('authenticated', 'public.subscription_plan_limits', 'select') then
    raise exception 'raw provider budget table remains client-readable';
  end if;
  if has_table_privilege('authenticated', 'public.app_admins', 'select') then
    raise exception 'raw admin table remains client-readable';
  end if;
  if not has_table_privilege('service_role', 'public.app_sync_records', 'select') then
    raise exception 'service role lost sync table access';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

do $$
begin
  if (select count(*) from public.app_sync_records) <> 1
     or not exists (
       select 1 from public.app_sync_records
        where user_id = '22222222-2222-4222-8222-222222222222'
     ) then
    raise exception 'paid caller did not receive exactly its own sync records';
  end if;
  begin
    insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
    values ('11111111-1111-4111-8111-111111111111', 'settings', 'tampered', 'insert', '{}');
    raise exception 'cross-user sync insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$
begin
  if exists (select 1 from public.app_sync_records) then
    raise exception 'free caller retained cloud sync record access';
  end if;
  begin
    insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
    values ('11111111-1111-4111-8111-111111111111', 'settings', 'free-denied', 'insert', '{}');
    raise exception 'free caller unexpectedly wrote cloud sync data';
  exception
    when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
do $$
begin
  if (select count(*) from public.app_sync_records) <> 1
     or not exists (
       select 1 from public.app_sync_records
        where user_id = '33333333-3333-4333-8333-333333333333'
     ) then
    raise exception 'admin caller did not receive exactly its own sync records';
  end if;
  insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
  values ('33333333-3333-4333-8333-333333333333', 'settings', 'admin-write', 'insert', '{}');
end $$;
reset role;

rollback;
