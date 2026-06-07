-- Desktop app migration mirror. Plugin credentials never sync.
create or replace function public.reject_plugin_connection_secrets()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.table_name = 'plugin_connections'
     and new.payload is not null
     and new.payload::text ~* '"(token|key|secret|password|credentials)"[[:space:]]*:'
  then
    raise exception 'plugin connection payloads may not contain secrets';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_plugin_connection_secrets on public.app_sync_records;
create trigger reject_plugin_connection_secrets
before insert or update on public.app_sync_records
for each row execute function public.reject_plugin_connection_secrets();
