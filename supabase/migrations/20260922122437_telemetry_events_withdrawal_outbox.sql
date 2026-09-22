-- Server-owned telemetry storage and withdrawal work queue.
--
-- The browser never receives table privileges. Edge Functions authenticate the
-- user, verify current consent, and write through the service-role-only RPCs
-- below. Payload validation remains in _shared/telemetrySchema.ts.

create table if not exists public.telemetry_ingest_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  event_count smallint not null check (event_count between 1 and 32),
  accepted_event_count smallint not null default 0 check (accepted_event_count between 0 and 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (user_id, batch_id)
);

create index if not exists telemetry_ingest_batches_user_created_idx
  on public.telemetry_ingest_batches (user_id, created_at desc);
create index if not exists telemetry_ingest_batches_expiry_idx
  on public.telemetry_ingest_batches (expires_at);

create table if not exists public.telemetry_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  event_id uuid not null,
  event_name text not null check (
    event_name in (
      'token_optimization', 'context_retrieval', 'repository_ranking',
      'provider_request', 'native_capability', 'browser_goal', 'evaluation',
      'feature_open', 'tool_outcome', 'diagnostic'
    )
  ),
  schema_version smallint not null check (schema_version = 1),
  occurred_at timestamptz not null,
  app_version text not null check (length(app_version) between 5 and 64),
  platform text not null check (platform in ('windows', 'macos', 'linux', 'other')),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  outcome text not null check (outcome in ('ok', 'error', 'cancelled', 'unknown')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (user_id, event_id),
  foreign key (user_id, batch_id)
    references public.telemetry_ingest_batches (user_id, batch_id)
    on delete cascade
);

create index if not exists telemetry_events_user_created_idx
  on public.telemetry_events (user_id, created_at desc);
create index if not exists telemetry_events_expiry_idx
  on public.telemetry_events (expires_at);

create table if not exists public.telemetry_withdrawal_outbox (
  user_id uuid primary key references auth.users(id) on delete cascade,
  request_revision uuid not null default gen_random_uuid(),
  state text not null default 'pending' check (state in ('pending', 'reconciled', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text check (last_error is null or length(last_error) <= 512),
  requested_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telemetry_withdrawal_outbox_pending_idx
  on public.telemetry_withdrawal_outbox (state, next_attempt_at);

alter table public.telemetry_ingest_batches enable row level security;
alter table public.telemetry_events enable row level security;
alter table public.telemetry_withdrawal_outbox enable row level security;
revoke all on table public.telemetry_ingest_batches from anon, authenticated;
revoke all on table public.telemetry_events from anon, authenticated;
revoke all on table public.telemetry_withdrawal_outbox from anon, authenticated;

create or replace function public.ingest_telemetry_batch(
  p_user_id uuid,
  p_batch_id uuid,
  p_events jsonb,
  p_policy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_accepted jsonb;
  v_profile public.profiles;
  v_used integer;
  v_new integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_batch_id is null or p_events is null
     or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 32 then
    raise exception 'invalid telemetry batch' using errcode = '22023';
  end if;

  -- Serialize concurrent uploads with the same profile row that consent updates
  -- lock. Consent, rate admission, deduplication and storage share one transaction.
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found or v_profile.telemetry_opt_in is distinct from true
     or nullif(trim(p_policy_version), '') is null
     or v_profile.telemetry_policy_version is distinct from p_policy_version
     or cardinality(v_profile.telemetry_data_classes) is distinct from 3
     or not coalesce(v_profile.telemetry_data_classes @>
       array['product_usage', 'diagnostics', 'tool_outcomes']::text[], false) then
    return jsonb_build_object('status', 'consent_required');
  end if;

  select count(*) into v_used from public.telemetry_events
   where user_id = p_user_id and created_at >= now() - interval '1 minute';
  select count(distinct raw.value ->> 'eventId') into v_new
    from jsonb_array_elements(p_events) as raw(value)
   where not exists (
     select 1 from public.telemetry_events existing
      where existing.user_id = p_user_id
        and existing.event_id = (raw.value ->> 'eventId')::uuid
   );
  if v_used + v_new > 256 then
    return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', 60);
  end if;

  insert into public.telemetry_ingest_batches (user_id, batch_id, event_count)
  values (p_user_id, p_batch_id, jsonb_array_length(p_events))
  on conflict (user_id, batch_id) do nothing
  returning id into v_batch_id;

  if v_batch_id is not null then
    insert into public.telemetry_events (
      user_id, batch_id, event_id, event_name, schema_version,
      occurred_at, app_version, platform, metrics, outcome
    )
    select
      p_user_id,
      p_batch_id,
      item."eventId",
      item."eventName",
      item."schemaVersion",
      to_timestamp(item."occurredAt" / 1000.0),
      item."appVersion",
      item.platform,
      item.metrics,
      item.outcome
    from jsonb_array_elements(p_events) as raw(value)
    cross join lateral jsonb_to_record(raw.value) as item(
      "eventId" uuid,
      "eventName" text,
      "schemaVersion" smallint,
      "occurredAt" bigint,
      "appVersion" text,
      platform text,
      metrics jsonb,
      outcome text
    )
    on conflict (user_id, event_id) do nothing;
  end if;

  -- Return every requested ID already stored for this account. This makes a
  -- retry stable even when another batch stored one of the event IDs first.
  select coalesce(
    jsonb_agg(raw.value ->> 'eventId' order by raw.value ->> 'eventId'),
    '[]'::jsonb
  )
    into v_accepted
    from jsonb_array_elements(p_events) as raw(value)
   where exists (
     select 1
       from public.telemetry_events event_row
      where event_row.user_id = p_user_id
        and event_row.event_id = (raw.value ->> 'eventId')::uuid
   );

  update public.telemetry_ingest_batches
     set accepted_event_count = jsonb_array_length(v_accepted)
   where user_id = p_user_id and batch_id = p_batch_id;

  return jsonb_build_object(
    'status', case when v_batch_id is null then 'duplicate' else 'accepted' end,
    'acceptedEventIds', v_accepted,
    'rateLimitRemaining', greatest(0, 256 - v_used - v_new)
  );
end;
$$;

revoke all on function public.ingest_telemetry_batch(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.ingest_telemetry_batch(uuid, uuid, jsonb, text)
  to service_role;

create or replace function public.enqueue_telemetry_withdrawal(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.telemetry_withdrawal_outbox;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;

  insert into public.telemetry_withdrawal_outbox (user_id)
  values (p_user_id)
  on conflict (user_id) do update
    set state = 'pending',
        request_revision = gen_random_uuid(),
        attempt_count = 0,
        last_error = null,
        requested_at = now(),
        next_attempt_at = now(),
        reconciled_at = null,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'status', v_row.state,
    'requestRevision', v_row.request_revision,
    'attemptCount', v_row.attempt_count,
    'requestedAt', v_row.requested_at,
    'nextAttemptAt', v_row.next_attempt_at,
    'reconciledAt', v_row.reconciled_at
  );
end;
$$;

revoke all on function public.enqueue_telemetry_withdrawal(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_telemetry_withdrawal(uuid)
  to service_role;

create or replace function public.cancel_telemetry_withdrawal(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.telemetry_withdrawal_outbox;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;

  update public.telemetry_withdrawal_outbox
     set request_revision = gen_random_uuid(),
         state = 'reconciled',
         last_error = null,
         next_attempt_at = now(),
         reconciled_at = now(),
         updated_at = now()
   where user_id = p_user_id
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'not_requested');
  end if;

  return jsonb_build_object(
    'status', v_row.state,
    'requestRevision', v_row.request_revision
  );
end;
$$;

revoke all on function public.cancel_telemetry_withdrawal(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_telemetry_withdrawal(uuid)
  to service_role;

create or replace function public.set_telemetry_reward_consent_atomic(
  p_user_id uuid,
  p_enabled boolean,
  p_policy_version text,
  p_data_classes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state jsonb;
  v_row public.telemetry_withdrawal_outbox;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- The existing consent function updates profiles and writes the audit row;
  -- this wrapper keeps the outbox mutation in the same database transaction.
  v_state := public.set_telemetry_reward_consent(
    p_user_id,
    p_enabled,
    p_policy_version,
    p_data_classes
  );

  if p_enabled then
    update public.telemetry_withdrawal_outbox
       set request_revision = gen_random_uuid(),
           state = 'reconciled',
           last_error = null,
           next_attempt_at = now(),
           reconciled_at = now(),
           updated_at = now()
     where user_id = p_user_id;
    return v_state || jsonb_build_object('withdrawal', jsonb_build_object('status', 'not_requested'));
  end if;

  insert into public.telemetry_withdrawal_outbox (user_id)
  values (p_user_id)
  on conflict (user_id) do update
    set request_revision = gen_random_uuid(),
        state = 'pending',
        attempt_count = 0,
        last_error = null,
        requested_at = now(),
        next_attempt_at = now(),
        reconciled_at = null,
        updated_at = now()
  returning * into v_row;

  return v_state || jsonb_build_object(
    'withdrawal', jsonb_build_object(
      'status', v_row.state,
      'requestRevision', v_row.request_revision,
      'attemptCount', v_row.attempt_count,
      'requestedAt', v_row.requested_at,
      'nextAttemptAt', v_row.next_attempt_at
    )
  );
end;
$$;

revoke all on function public.set_telemetry_reward_consent_atomic(uuid, boolean, text, text[])
  from public, anon, authenticated;
grant execute on function public.set_telemetry_reward_consent_atomic(uuid, boolean, text, text[])
  to service_role;

create or replace function public.record_telemetry_withdrawal_attempt(
  p_user_id uuid,
  p_request_revision uuid,
  p_state text,
  p_error_code text,
  p_reconciled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.telemetry_withdrawal_outbox;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_request_revision is null
     or p_state not in ('pending', 'reconciled', 'failed') then
    raise exception 'invalid withdrawal state' using errcode = '22023';
  end if;

  update public.telemetry_withdrawal_outbox
     set state = p_state,
         attempt_count = attempt_count + 1,
         last_error = case when p_state = 'failed' then left(nullif(trim(p_error_code), ''), 512) else null end,
         next_attempt_at = case
           when p_state = 'reconciled' then now()
           else now() + interval '5 minutes'
         end,
         reconciled_at = case when p_reconciled then now() else null end,
         updated_at = now()
   where user_id = p_user_id
     and request_revision = p_request_revision
   returning * into v_row;
  if not found then
    raise exception 'withdrawal outbox row not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'status', v_row.state,
    'requestRevision', v_row.request_revision,
    'attemptCount', v_row.attempt_count,
    'lastError', v_row.last_error,
    'nextAttemptAt', v_row.next_attempt_at,
    'reconciledAt', v_row.reconciled_at
  );
end;
$$;

revoke all on function public.record_telemetry_withdrawal_attempt(uuid, uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_telemetry_withdrawal_attempt(uuid, uuid, text, text, boolean)
  to service_role;

create or replace function public.purge_expired_telemetry()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  delete from public.telemetry_events where expires_at <= now();
  get diagnostics v_deleted = row_count;
  delete from public.telemetry_ingest_batches where expires_at <= now();
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_telemetry()
  from public, anon, authenticated;
grant execute on function public.purge_expired_telemetry()
  to service_role;

-- Retention is enforced by the database rather than by an online client.
-- Supabase Cron creates the `cron` schema when pg_cron is enabled. The job
-- supplies the service-role JWT claim only inside its database-owned session;
-- no credential or user data is stored in the schedule.
create extension if not exists pg_cron;

do $telemetry_retention_schedule$
begin
  if not exists (
    select 1
      from cron.job
     where jobname = 'vibespace-telemetry-retention'
  ) then
    perform cron.schedule(
      'vibespace-telemetry-retention',
      '15 * * * *',
      $cron_command$
        select set_config('request.jwt.claims', '{"role":"service_role"}', true);
        select public.purge_expired_telemetry();
      $cron_command$
    );
  end if;
end;
$telemetry_retention_schedule$;
