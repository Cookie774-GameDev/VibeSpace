-- Model Foundry sync is intentionally metadata-only. Keep that boundary on
-- the server because app_sync_records is a generic, client-writable channel.

create or replace function public.reject_sensitive_model_foundry_metadata()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  payload_text text;
begin
  if new.table_name <> 'model_foundry_metadata' then
    return new;
  end if;

  if new.op = 'delete' then
    if new.payload is not null then
      raise exception 'Model Foundry deletion records must not include a payload';
    end if;
    return new;
  end if;

  if not exists (
    select 1 from public.profiles
    where id = new.user_id
      and tier in ('starter', 'pro', 'ultra', 'apex')
  ) then
    raise exception 'Model Foundry metadata sync requires an active cloud-sync entitlement';
  end if;

  if new.payload is null or jsonb_typeof(new.payload) <> 'object' then
    raise exception 'Model Foundry sync requires a metadata object';
  end if;

  if pg_column_size(new.payload) > 102400 then
    raise exception 'Model Foundry metadata payload exceeds its 100 KiB limit';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(new.payload) as key_name(value)
    where value not in (
      'schemaVersion', 'localProjectId', 'updatedAt', 'baseModel', 'dataset',
      'jobs', 'modelVersions', 'evaluations', 'championVersionId', 'promotionHistory'
    )
  ) then
    raise exception 'Model Foundry sync payload contains an unapproved metadata field';
  end if;

  payload_text := new.payload::text;
  if payload_text ~* '"(examples?|prompt|completion|hidden|path|logs?|weights?|adapter(_files?)?|token|secret|api[_-]?key|password|credential)s?"[[:space:]]*:'
     or payload_text ~* '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
     or payload_text ~* '\msk-[A-Za-z0-9_-]{20,}\M'
     or payload_text ~* '\mgh[pousr]_[A-Za-z0-9]{20,}\M'
  then
    raise exception 'Model Foundry sync payload contains prohibited private material';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_sensitive_model_foundry_metadata on public.app_sync_records;
create trigger reject_sensitive_model_foundry_metadata
before insert or update on public.app_sync_records
for each row execute function public.reject_sensitive_model_foundry_metadata();
