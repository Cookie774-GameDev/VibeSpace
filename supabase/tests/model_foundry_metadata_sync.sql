-- Model Foundry metadata-sync boundary verification (migrations 0042+0043).
-- Run against a database with the migrations applied:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/model_foundry_metadata_sync.sql

begin;

do $$
declare
  uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (uid, 'foundry-metadata-' || uid::text || '@test.local');
  insert into public.profiles (id, tier) values (uid, 'starter');

  insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
  values (
    uid,
    'model_foundry_metadata',
    'project-safe',
    'update',
    '{"schemaVersion":1,"localProjectId":"project-safe","updatedAt":"2026-07-14T00:00:00Z","baseModel":null,"dataset":null,"jobs":[],"modelVersions":[],"evaluations":[],"championVersionId":null,"promotionHistory":[]}'::jsonb
  );

  begin
    insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
    values (uid, 'model_foundry_metadata', 'project-prompt', 'update', '{"schemaVersion":1,"prompt":"private source text"}'::jsonb);
    raise exception 'Foundry prompt payload was accepted';
  exception when others then
    if position('unapproved metadata field' in sqlerrm) = 0
       and position('prohibited private material' in sqlerrm) = 0 then
      raise;
    end if;
  end;

  begin
    insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
    values (uid, 'model_foundry_metadata', 'project-secret', 'update', '{"schemaVersion":1,"jobs":[{"id":"job-1","token":"sk_abcdefghijklmnopqrstuvwxyz"}]}'::jsonb);
    raise exception 'Foundry credential payload was accepted';
  exception when others then
    if position('prohibited private material' in sqlerrm) = 0 then
      raise;
    end if;
  end;

  begin
    insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
    values (uid, 'model_foundry_metadata', 'project-delete', 'delete', '{"schemaVersion":1}'::jsonb);
    raise exception 'Foundry deletion payload was accepted';
  exception when others then
    if position('deletion records must not include a payload' in sqlerrm) = 0 then
      raise;
    end if;
  end;

  update public.profiles set tier = 'free' where id = uid;
  begin
    insert into public.app_sync_records (user_id, table_name, row_id, op, payload)
    values (uid, 'model_foundry_metadata', 'project-unentitled', 'update', '{"schemaVersion":1}'::jsonb);
    raise exception 'Foundry metadata sync was accepted without an entitlement';
  exception when others then
    if position('requires an active cloud-sync entitlement' in sqlerrm) = 0 then
      raise;
    end if;
  end;

  raise notice 'Model Foundry metadata sync boundary: ALL CHECKS PASSED';
end $$;

rollback;
