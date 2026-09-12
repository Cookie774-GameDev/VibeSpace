-- Account-scoped, metadata-only desktop presence for the read-only website hub.
-- Clients can read only their own rows. All writes pass through bounded RPCs
-- that derive ownership from auth.uid() and refuse revoked devices.

create table if not exists public.desktop_presence (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  display_name text not null,
  app_version text not null,
  is_online boolean not null default true,
  last_seen_at timestamptz not null default now(),
  active_terminals jsonb not null default '[]'::jsonb,
  active_chats jsonb not null default '[]'::jsonb,
  active_agent_jobs jsonb not null default '[]'::jsonb,
  active_runtime text,
  provider_usage jsonb not null default '{}'::jsonb,
  background_task_count integer not null default 0,
  recent_sync_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id),
  constraint desktop_presence_device_id_bounded
    check (device_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  constraint desktop_presence_display_name_bounded
    check (char_length(display_name) between 1 and 80),
  constraint desktop_presence_app_version_bounded
    check (char_length(app_version) between 1 and 40),
  constraint desktop_presence_runtime_bounded
    check (active_runtime is null or char_length(active_runtime) <= 120),
  constraint desktop_presence_background_count_bounded
    check (background_task_count between 0 and 1000),
  constraint desktop_presence_terminals_bounded
    check (
      jsonb_typeof(active_terminals) = 'array'
      and jsonb_array_length(active_terminals) <= 50
      and octet_length((active_terminals::text)) <= 8192
    ),
  constraint desktop_presence_chats_bounded
    check (
      jsonb_typeof(active_chats) = 'array'
      and jsonb_array_length(active_chats) <= 50
      and octet_length((active_chats::text)) <= 8192
    ),
  constraint desktop_presence_agents_bounded
    check (
      jsonb_typeof(active_agent_jobs) = 'array'
      and jsonb_array_length(active_agent_jobs) <= 50
      and octet_length((active_agent_jobs::text)) <= 8192
    ),
  constraint desktop_presence_usage_bounded
    check (
      jsonb_typeof(provider_usage) = 'object'
      and octet_length((provider_usage::text)) <= 4096
    )
);

create index if not exists desktop_presence_user_last_seen_idx
  on public.desktop_presence (user_id, last_seen_at desc);

alter table public.desktop_presence enable row level security;
revoke all on table public.desktop_presence from anon, authenticated;
grant select on table public.desktop_presence to authenticated;
grant all on table public.desktop_presence to service_role;

drop policy if exists desktop_presence_owner_select on public.desktop_presence;
create policy desktop_presence_owner_select
  on public.desktop_presence
  for select
  to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop function if exists public.publish_desktop_presence(
  text, text, text, jsonb, jsonb, jsonb, text, jsonb, integer, timestamptz
);

create or replace function public.publish_desktop_presence(
  p_expected_user_id uuid,
  p_device_id text,
  p_display_name text,
  p_app_version text,
  p_active_terminals jsonb,
  p_active_chats jsonb,
  p_active_agent_jobs jsonb,
  p_active_runtime text,
  p_provider_usage jsonb,
  p_background_task_count integer,
  p_recent_sync_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_rows integer;
  v_collection jsonb;
  v_item jsonb;
  v_key text;
  v_provider record;
  v_metric record;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_expected_user_id is null or v_user_id <> p_expected_user_id then
    raise exception 'account changed' using errcode = '42501';
  end if;

  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' then
    raise exception 'invalid device metadata' using errcode = '22023';
  end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 80 then
    raise exception 'invalid device metadata' using errcode = '22023';
  end if;
  if p_app_version is null or char_length(btrim(p_app_version)) not between 1 and 40 then
    raise exception 'invalid device metadata' using errcode = '22023';
  end if;
  if p_active_runtime is not null and char_length(p_active_runtime) > 120 then
    raise exception 'invalid device metadata' using errcode = '22023';
  end if;
  if p_background_task_count is null or p_background_task_count not between 0 and 1000 then
    raise exception 'invalid device metadata' using errcode = '22023';
  end if;
  if jsonb_typeof(p_active_terminals) <> 'array'
     or jsonb_array_length(p_active_terminals) > 50
     or octet_length(p_active_terminals::text) > 8192
     or jsonb_typeof(p_active_chats) <> 'array'
     or jsonb_array_length(p_active_chats) > 50
     or octet_length(p_active_chats::text) > 8192
     or jsonb_typeof(p_active_agent_jobs) <> 'array'
     or jsonb_array_length(p_active_agent_jobs) > 50
     or octet_length(p_active_agent_jobs::text) > 8192
     or jsonb_typeof(p_provider_usage) <> 'object'
     or octet_length(p_provider_usage::text) > 4096 then
    raise exception 'invalid presence metadata' using errcode = '22023';
  end if;

  foreach v_collection in array array[
    p_active_terminals,
    p_active_chats,
    p_active_agent_jobs
  ] loop
    for v_item in select value from jsonb_array_elements(v_collection) loop
      if jsonb_typeof(v_item) <> 'object'
         or not (v_item ? 'id')
         or not (v_item ? 'name')
         or not (v_item ? 'status')
         or jsonb_typeof(v_item -> 'id') <> 'string'
         or jsonb_typeof(v_item -> 'name') <> 'string'
         or jsonb_typeof(v_item -> 'status') <> 'string'
         or char_length(v_item ->> 'id') not between 1 and 128
         or char_length(v_item ->> 'name') not between 1 and 120
         or char_length(v_item ->> 'status') not between 1 and 24
         or lower(v_item ->> 'status') not in (
           'active', 'idle', 'open', 'running', 'queued', 'blocked',
           'done', 'failed', 'stopped', 'unknown'
         ) then
        raise exception 'invalid presence item' using errcode = '22023';
      end if;

      for v_key in select jsonb_object_keys(v_item) loop
        if v_key not in ('id', 'name', 'status') then
          raise exception 'invalid presence item' using errcode = '22023';
        end if;
      end loop;
    end loop;
  end loop;

  for v_provider in select key, value from jsonb_each(p_provider_usage) loop
    if v_provider.key !~ '^[a-z0-9][a-z0-9._-]{0,39}$'
       or jsonb_typeof(v_provider.value) <> 'object' then
      raise exception 'invalid provider usage metadata' using errcode = '22023';
    end if;
    for v_metric in select key, value from jsonb_each(v_provider.value) loop
      if v_metric.key !~ '^[a-z0-9][a-z0-9._-]{0,39}$'
         or jsonb_typeof(v_metric.value) <> 'number'
         or (v_metric.value #>> '{}')::numeric not between 0 and 1000000000 then
        raise exception 'invalid provider usage metadata' using errcode = '22023';
      end if;
    end loop;
  end loop;

  insert into public.desktop_presence (
    user_id,
    device_id,
    display_name,
    app_version,
    is_online,
    last_seen_at,
    active_terminals,
    active_chats,
    active_agent_jobs,
    active_runtime,
    provider_usage,
    background_task_count,
    recent_sync_at,
    updated_at
  )
  values (
    v_user_id,
    p_device_id,
    btrim(p_display_name),
    btrim(p_app_version),
    true,
    now(),
    p_active_terminals,
    p_active_chats,
    p_active_agent_jobs,
    nullif(btrim(p_active_runtime), ''),
    p_provider_usage,
    p_background_task_count,
    p_recent_sync_at,
    now()
  )
  on conflict (user_id, device_id) do update
  set display_name = excluded.display_name,
      app_version = excluded.app_version,
      is_online = true,
      last_seen_at = excluded.last_seen_at,
      active_terminals = excluded.active_terminals,
      active_chats = excluded.active_chats,
      active_agent_jobs = excluded.active_agent_jobs,
      active_runtime = excluded.active_runtime,
      provider_usage = excluded.provider_usage,
      background_task_count = excluded.background_task_count,
      recent_sync_at = excluded.recent_sync_at,
      updated_at = now()
  where desktop_presence.revoked_at is null;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

drop function if exists public.mark_desktop_presence_offline(text);

create or replace function public.mark_desktop_presence_offline(
  p_expected_user_id uuid,
  p_device_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_rows integer;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_expected_user_id is null or v_user_id <> p_expected_user_id then
    raise exception 'account changed' using errcode = '42501';
  end if;

  update public.desktop_presence
  set is_online = false,
      updated_at = now()
  where user_id = v_user_id
    and device_id = p_device_id
    and revoked_at is null;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

drop function if exists public.revoke_desktop_device(text);

create or replace function public.revoke_desktop_device(
  p_expected_user_id uuid,
  p_device_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_rows integer;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_expected_user_id is null or v_user_id <> p_expected_user_id then
    raise exception 'account changed' using errcode = '42501';
  end if;

  update public.desktop_presence
  set is_online = false,
      revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  where user_id = v_user_id
    and device_id = p_device_id;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.publish_desktop_presence(
  uuid, text, text, text, jsonb, jsonb, jsonb, text, jsonb, integer, timestamptz
) from public, anon;
grant execute on function public.publish_desktop_presence(
  uuid, text, text, text, jsonb, jsonb, jsonb, text, jsonb, integer, timestamptz
) to authenticated;

revoke all on function public.mark_desktop_presence_offline(uuid, text) from public, anon;
grant execute on function public.mark_desktop_presence_offline(uuid, text) to authenticated;

revoke all on function public.revoke_desktop_device(uuid, text) from public, anon;
grant execute on function public.revoke_desktop_device(uuid, text) to authenticated;
