-- Functional regression coverage for Account Center profile persistence.
-- Run against a disposable/local database after migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/profile_display_name_rls_behavior.sql

begin;

-- Reproduce the upgrade hazard: permissive policies combine with OR semantics,
-- so a migration that only adds owner policies would leave these broad legacy
-- paths active. Re-run 0037 and prove it replaces rather than augments them.
create policy profile_legacy_broad_select_fixture
  on public.profiles
  for select
  to authenticated
  using (true);

create policy profile_legacy_broad_update_fixture
  on public.profiles
  for update
  to authenticated
  using (true)
  with check (true);

\ir ../migrations/0037_profiles_display_name_security.sql

do $$
declare
  uid_a uuid := gen_random_uuid();
  uid_b uuid := gen_random_uuid();
  v_name text;
  v_tier text;
  v_seen integer;
  v_before timestamptz;
  v_after timestamptz;
  v_anon_blocked boolean := false;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (uid_a, 'profile-a-' || uid_a::text || '@test.local',
      jsonb_build_object('display_name', 'Seeded A')),
    (uid_b, 'profile-b-' || uid_b::text || '@test.local', '{}'::jsonb);

  select display_name into v_name from public.profiles where id = uid_a;
  if v_name is distinct from 'Seeded A' then
    raise exception 'signup trigger did not seed display_name: %', v_name;
  end if;

  update public.profiles
     set updated_at = now() - interval '1 minute'
   where id = uid_a;
  select updated_at into v_before from public.profiles where id = uid_a;

  perform set_config('request.jwt.claim.sub', uid_a::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', uid_a::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);

  update public.profiles
     set display_name = 'Account Center A'
   where id = uid_a;
  if not found then
    raise exception 'owner display_name update affected no row';
  end if;

  select display_name, tier, updated_at
    into v_name, v_tier, v_after
    from public.profiles
   where id = uid_a;
  if v_name is distinct from 'Account Center A' then
    raise exception 'owner display_name update did not persist: %', v_name;
  end if;
  if v_tier is distinct from 'free' then
    raise exception 'profile tier changed unexpectedly: %', v_tier;
  end if;
  if v_after <= v_before then
    raise exception 'profiles_touch_updated did not advance updated_at';
  end if;

  update public.profiles
     set display_name = 'Cross-account write'
   where id = uid_b;
  if found then
    raise exception 'cross-account display_name update was not denied';
  end if;

  select count(*) into v_seen from public.profiles where id = uid_b;
  if v_seen <> 0 then
    raise exception 'cross-account profile select exposed % rows', v_seen;
  end if;

  begin
    update public.profiles set tier = 'ultra' where id = uid_a;
  exception
    when insufficient_privilege then null;
  end;
  select tier into v_tier from public.profiles where id = uid_a;
  if v_tier is distinct from 'free' then
    raise exception 'authenticated user escalated tier to %', v_tier;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'anon')::text,
    true
  );
  perform set_config('role', 'anon', true);
  begin
    update public.profiles set display_name = 'Anonymous write' where id = uid_a;
  exception
    when insufficient_privilege then v_anon_blocked := true;
  end;
  if not v_anon_blocked then
    raise exception 'anonymous profile update did not fail with insufficient privilege';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'OK: owner profile update/select, billing lock, signup, timestamp, cross-account and anon isolation';
end $$;

rollback;
