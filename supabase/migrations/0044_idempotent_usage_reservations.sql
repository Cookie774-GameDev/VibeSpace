-- =============================================================================
-- 0032_idempotent_usage_reservations
-- Exactly-once reserve/settle operations for hosted message, call, SMS, and
-- Hive usage. Existing service RPC signatures remain available.
-- =============================================================================

create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('message', 'call', 'sms')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  reserved_usd numeric not null check (reserved_usd >= 0),
  actual_usd numeric check (actual_usd >= 0),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  actual_count integer check (actual_count >= 0),
  provider_reference text,
  status text not null default 'reserved'
    check (status in ('reserved', 'settled', 'released', 'refunded')),
  period_reset_at timestamptz,
  window_5h_start timestamptz,
  window_week_start timestamptz,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  settled_at timestamptz,
  last_transition_at timestamptz not null default now(),
  unique (user_id, kind, idempotency_key)
);

alter table public.usage_reservations
  add column if not exists period_reset_at timestamptz,
  add column if not exists window_5h_start timestamptz,
  add column if not exists window_week_start timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_transition_at timestamptz not null default now();
update public.usage_reservations
   set expires_at = coalesce(expires_at, created_at + interval '15 minutes')
 where expires_at is null;
alter table public.usage_reservations alter column expires_at set not null;
alter table public.usage_reservations
  drop constraint if exists usage_reservations_status_check;
alter table public.usage_reservations
  add constraint usage_reservations_status_check
  check (status in ('reserved', 'settled', 'released', 'refunded'));

create index if not exists usage_reservations_user_created_idx
  on public.usage_reservations (user_id, created_at desc);
create unique index if not exists usage_reservations_provider_reference_idx
  on public.usage_reservations (kind, provider_reference)
  where provider_reference is not null;
create index if not exists usage_reservations_expiry_idx
  on public.usage_reservations (user_id, status, expires_at)
  where status = 'reserved';

alter table public.usage_reservations enable row level security;
drop policy if exists usage_reservations_service_only on public.usage_reservations;
create policy usage_reservations_service_only on public.usage_reservations
  for all to service_role using (true) with check (true);
revoke all on table public.usage_reservations from public, anon, authenticated;
grant select, insert, update, delete on table public.usage_reservations to service_role;

-- Settlement must correct the shared window leader introduced by migration
-- 0030. Call and SMS reserves increment message_usage windows, not their old
-- per-service window columns.
create or replace function public.settle_message_budget(
  p_user_id uuid,
  p_reserved numeric,
  p_actual numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric := greatest(coalesce(p_reserved, 0), 0);
  v_actual numeric := greatest(coalesce(p_actual, 0), 0);
  v_delta numeric;
begin
  v_delta := v_actual - v_reserved;
  if v_delta < 0 then
    v_delta := greatest(v_delta, -v_reserved);
  end if;
  perform 1 from public.message_usage where user_id = p_user_id for update;
  perform 1 from public.call_usage where user_id = p_user_id for update;
  perform 1 from public.sms_usage where user_id = p_user_id for update;
  update public.message_usage
     set used_usd = greatest(0, used_usd + v_delta),
         window_5h_used_usd = greatest(0, window_5h_used_usd + v_delta),
         window_week_used_usd = greatest(0, window_week_used_usd + v_delta),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_message_budget(uuid, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.settle_message_budget(uuid, numeric, numeric) to service_role;

create or replace function public.settle_call_budget(
  p_user_id uuid,
  p_reserved numeric,
  p_actual numeric,
  p_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric := greatest(coalesce(p_reserved, 0), 0);
  v_actual numeric := greatest(coalesce(p_actual, 0), 0);
  v_delta numeric;
begin
  v_delta := v_actual - v_reserved;
  if v_delta < 0 then
    v_delta := greatest(v_delta, -v_reserved);
  end if;
  perform 1 from public.message_usage where user_id = p_user_id for update;
  perform 1 from public.call_usage where user_id = p_user_id for update;
  perform 1 from public.sms_usage where user_id = p_user_id for update;
  update public.call_usage
     set used_usd = greatest(0, used_usd + v_delta),
         used_seconds = greatest(0, used_seconds + greatest(coalesce(p_seconds, 0), 0)),
         updated_at = now()
   where user_id = p_user_id;
  update public.message_usage
     set window_5h_used_usd = greatest(0, window_5h_used_usd + v_delta),
         window_week_used_usd = greatest(0, window_week_used_usd + v_delta),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_call_budget(uuid, numeric, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.settle_call_budget(uuid, numeric, numeric, integer) to service_role;

create or replace function public.settle_sms_budget(
  p_user_id uuid,
  p_reserved numeric,
  p_actual numeric,
  p_count_delta integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric := greatest(coalesce(p_reserved, 0), 0);
  v_actual numeric := greatest(coalesce(p_actual, 0), 0);
  v_delta numeric;
begin
  v_delta := v_actual - v_reserved;
  if v_delta < 0 then
    v_delta := greatest(v_delta, -v_reserved);
  end if;
  perform 1 from public.message_usage where user_id = p_user_id for update;
  perform 1 from public.call_usage where user_id = p_user_id for update;
  perform 1 from public.sms_usage where user_id = p_user_id for update;
  update public.sms_usage
     set used_usd = greatest(0, used_usd + v_delta),
         used_count = greatest(0, used_count + coalesce(p_count_delta, 0)),
         updated_at = now()
   where user_id = p_user_id;
  update public.message_usage
     set window_5h_used_usd = greatest(0, window_5h_used_usd + v_delta),
         window_week_used_usd = greatest(0, window_week_used_usd + v_delta),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_sms_budget(uuid, numeric, numeric, integer)
  from public, anon, authenticated;
grant execute on function public.settle_sms_budget(uuid, numeric, numeric, integer) to service_role;

create or replace function public.reserve_usage_budget(
  p_user_id uuid,
  p_kind text,
  p_estimate_usd numeric,
  p_idempotency_key text,
  p_count integer default 0,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.usage_reservations%rowtype;
  v_result jsonb;
  v_reservation_id uuid;
  v_count integer := greatest(coalesce(p_count, 0), 0);
  v_metadata jsonb;
  v_admin boolean := false;
  v_reserved_usd numeric := p_estimate_usd;
  v_period_reset_at timestamptz;
  v_window_5h_start timestamptz;
  v_window_week_start timestamptz;
  v_expires_at timestamptz;
  v_active_calls integer;
begin
  if p_user_id is null
     or p_kind is null or p_kind not in ('message', 'call', 'sms')
     or p_estimate_usd is null or p_estimate_usd < 0
     or p_idempotency_key is null
     or length(p_idempotency_key) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_reservation');
  end if;

  perform public.release_expired_usage_reservations_for_user(p_user_id, 50);

  if p_kind = 'call' then
    perform pg_advisory_xact_lock(
      hashtextextended(p_user_id::text || ':call-concurrency', 0)
    );
  end if;

  -- Serialize identical retries before any balance mutation.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_kind || ':' || p_idempotency_key, 0)
  );
  select * into v_existing
    from public.usage_reservations
   where user_id = p_user_id
     and kind = p_kind
     and idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing.status <> 'reserved' then
      return jsonb_build_object(
        'ok', false,
        'reason', 'reservation_finalized',
        'reservation_id', v_existing.id,
        'status', v_existing.status,
        'duplicate', true
      );
    end if;
    if v_existing.expires_at <= now() then
      return jsonb_build_object(
        'ok', false,
        'reason', 'reservation_expired',
        'reservation_id', v_existing.id,
        'duplicate', true
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'reservation_id', v_existing.id,
      'status', v_existing.status,
      'reserved_usd', v_existing.reserved_usd,
      'reserved_count', v_existing.reserved_count,
      'actual_usd', v_existing.actual_usd,
      'provider_reference', v_existing.provider_reference,
      'expires_at', v_existing.expires_at,
      'duplicate', true
    );
  end if;

  if p_kind = 'call' then
    select count(*) into v_active_calls
      from public.usage_reservations
     where user_id = p_user_id
       and kind = 'call'
       and status = 'reserved'
       and expires_at > now();
    if v_active_calls >= 2 then
      return jsonb_build_object('ok', false, 'reason', 'concurrent_call_limit');
    end if;
  end if;

  v_admin := public.is_app_admin(p_user_id);
  if v_admin then
    -- Admin usage remains audited and provider-bounded, but does not consume a
    -- paid-plan counter. Settlement stores actual cost without mutating usage.
    v_reserved_usd := 0;
    v_result := jsonb_build_object(
      'ok', true,
      'remaining_usd', null,
      'admin_unlimited', true
    );
  elsif p_kind = 'message' then
    v_result := public.reserve_message_budget(p_user_id, p_estimate_usd);
  elsif p_kind = 'call' then
    v_result := public.reserve_call_budget(p_user_id, p_estimate_usd);
  else
    v_result := public.reserve_sms_budget(p_user_id, p_estimate_usd, greatest(v_count, 1));
    v_count := greatest(v_count, 1);
  end if;
  if not coalesce((v_result->>'ok')::boolean, false) then
    return v_result;
  end if;

  if not v_admin then
    select window_5h_start, window_week_start
      into v_window_5h_start, v_window_week_start
      from public.message_usage
     where user_id = p_user_id;
    if p_kind = 'message' then
      select reset_date into v_period_reset_at
        from public.message_usage where user_id = p_user_id;
    elsif p_kind = 'call' then
      select reset_date into v_period_reset_at
        from public.call_usage where user_id = p_user_id;
    else
      select reset_date into v_period_reset_at
        from public.sms_usage where user_id = p_user_id;
    end if;
  end if;
  v_expires_at := now() + case
    when p_kind = 'call' then interval '45 minutes'
    else interval '15 minutes'
  end;

  -- Persist bounded operational metadata only; never prompts or message bodies.
  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'provider', left(p_context->>'provider', 80),
    'model', left(p_context->>'model', 120),
    'operation', left(p_context->>'operation', 80),
    'admin_unlimited', case when v_admin then true else null end
  ));
  insert into public.usage_reservations
    (user_id, kind, idempotency_key, reserved_usd, reserved_count,
     period_reset_at, window_5h_start, window_week_start, expires_at, metadata)
  values
    (p_user_id, p_kind, p_idempotency_key, v_reserved_usd, v_count,
     v_period_reset_at, v_window_5h_start, v_window_week_start, v_expires_at, v_metadata)
  returning id into v_reservation_id;

  return v_result || jsonb_build_object(
    'reservation_id', v_reservation_id,
    'status', 'reserved',
    'reserved_usd', v_reserved_usd,
    'reserved_count', v_count,
    'expires_at', v_expires_at,
    'duplicate', false
  );
end;
$$;
revoke all on function public.reserve_usage_budget(
  uuid, text, numeric, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.reserve_usage_budget(
  uuid, text, numeric, text, integer, jsonb
) to service_role;

create or replace function public.attach_usage_provider_reference(
  p_user_id uuid,
  p_reservation_id uuid,
  p_provider_reference text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_provider_reference is null
     or length(p_provider_reference) not between 4 and 255 then
    return false;
  end if;
  update public.usage_reservations
     set provider_reference = p_provider_reference
   where id = p_reservation_id
     and user_id = p_user_id
     and status = 'reserved'
     and expires_at > now()
     and (provider_reference is null or provider_reference = p_provider_reference);
  return found;
end;
$$;
revoke all on function public.attach_usage_provider_reference(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.attach_usage_provider_reference(uuid, uuid, text)
  to service_role;

create or replace function public.claim_usage_reservation(
  p_user_id uuid,
  p_reservation_id uuid,
  p_kind text,
  p_provider_reference text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or p_reservation_id is null
     or p_kind not in ('message', 'call', 'sms')
     or p_provider_reference is null
     or length(p_provider_reference) not between 4 and 255 then
    return false;
  end if;
  update public.usage_reservations
     set claimed_at = now(),
         last_transition_at = now()
   where id = p_reservation_id
     and user_id = p_user_id
     and kind = p_kind
     and provider_reference = p_provider_reference
     and status = 'reserved'
     and expires_at > now()
     and claimed_at is null;
  return found;
end;
$$;
revoke all on function public.claim_usage_reservation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_usage_reservation(uuid, uuid, text, text)
  to service_role;

create or replace function public.settle_usage_budget(
  p_user_id uuid,
  p_reservation_id uuid,
  p_actual_usd numeric,
  p_actual_count integer,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.usage_reservations%rowtype;
  v_final_status text;
  v_base_usd numeric;
  v_target_usd numeric;
  v_usd_delta numeric;
  v_base_count integer;
  v_target_count integer;
  v_count_delta integer;
  v_stored_actual_usd numeric;
  v_stored_actual_count integer;
  v_duplicate boolean;
begin
  if p_user_id is null or p_reservation_id is null
     or p_status is null
     or p_status not in ('settled', 'released', 'failed', 'canceled', 'refunded')
     or coalesce(p_actual_usd, 0) < 0
     or coalesce(p_actual_count, 0) < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_settlement');
  end if;

  select * into v_row
    from public.usage_reservations
   where id = p_reservation_id
     and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'reservation_not_found');
  end if;
  v_final_status := case
    when p_status = 'settled' then 'settled'
    when p_status = 'refunded' then 'refunded'
    else 'released'
  end;
  if (v_row.status = 'refunded' and v_final_status <> 'refunded')
     or (v_row.status = 'settled' and v_final_status = 'released') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition');
  end if;

  v_base_usd := case
    when v_row.status = 'reserved' then v_row.reserved_usd
    when v_row.status = 'settled' then coalesce(v_row.actual_usd, 0)
    else 0
  end;
  v_target_usd := case
    when v_final_status = 'settled' then coalesce(p_actual_usd, 0)
    else 0
  end;
  v_usd_delta := v_target_usd - v_base_usd;

  v_base_count := case
    when v_row.kind = 'sms' and v_row.status = 'reserved' then v_row.reserved_count
    when v_row.kind in ('call', 'sms') and v_row.status = 'settled'
      then coalesce(v_row.actual_count, 0)
    else 0
  end;
  v_target_count := case
    when v_final_status = 'settled' then coalesce(p_actual_count, 0)
    else 0
  end;
  v_count_delta := v_target_count - v_base_count;
  v_stored_actual_usd := case
    when v_final_status = 'settled' then v_target_usd
    when v_final_status = 'refunded' then coalesce(v_row.actual_usd, 0)
    else 0
  end;
  v_stored_actual_count := case
    when v_final_status = 'settled' then v_target_count
    when v_final_status = 'refunded' then coalesce(v_row.actual_count, 0)
    else 0
  end;
  v_duplicate := v_row.status = v_final_status
    and v_usd_delta = 0 and v_count_delta = 0;

  if not coalesce((v_row.metadata->>'admin_unlimited')::boolean, false) then
    -- Every reservation transition uses the same lock order as reserve RPCs.
    perform 1 from public.message_usage where user_id = p_user_id for update;
    perform 1 from public.call_usage where user_id = p_user_id for update;
    perform 1 from public.sms_usage where user_id = p_user_id for update;

    if v_row.kind = 'message' then
      update public.message_usage
         set used_usd = case
               when reset_date is not distinct from v_row.period_reset_at
                 then greatest(0, used_usd + v_usd_delta)
               else used_usd
             end,
             window_5h_used_usd = case
               when window_5h_start is not distinct from v_row.window_5h_start
                 then greatest(0, window_5h_used_usd + v_usd_delta)
               else window_5h_used_usd
             end,
             window_week_used_usd = case
               when window_week_start is not distinct from v_row.window_week_start
                 then greatest(0, window_week_used_usd + v_usd_delta)
               else window_week_used_usd
             end,
             updated_at = now()
       where user_id = p_user_id;
    elsif v_row.kind = 'call' then
      update public.call_usage
         set used_usd = case
               when reset_date is not distinct from v_row.period_reset_at
                 then greatest(0, used_usd + v_usd_delta)
               else used_usd
             end,
             used_seconds = case
               when reset_date is not distinct from v_row.period_reset_at
                 then greatest(0, used_seconds + v_count_delta)
               else used_seconds
             end,
             updated_at = now()
       where user_id = p_user_id;
      update public.message_usage
         set window_5h_used_usd = case
               when window_5h_start is not distinct from v_row.window_5h_start
                 then greatest(0, window_5h_used_usd + v_usd_delta)
               else window_5h_used_usd
             end,
             window_week_used_usd = case
               when window_week_start is not distinct from v_row.window_week_start
                 then greatest(0, window_week_used_usd + v_usd_delta)
               else window_week_used_usd
             end,
             updated_at = now()
       where user_id = p_user_id;
    else
      update public.sms_usage
         set used_usd = case
               when reset_date is not distinct from v_row.period_reset_at
                 then greatest(0, used_usd + v_usd_delta)
               else used_usd
             end,
             used_count = case
               when reset_date is not distinct from v_row.period_reset_at
                 then greatest(0, used_count + v_count_delta)
               else used_count
             end,
             updated_at = now()
       where user_id = p_user_id;
      update public.message_usage
         set window_5h_used_usd = case
               when window_5h_start is not distinct from v_row.window_5h_start
                 then greatest(0, window_5h_used_usd + v_usd_delta)
               else window_5h_used_usd
             end,
             window_week_used_usd = case
               when window_week_start is not distinct from v_row.window_week_start
                 then greatest(0, window_week_used_usd + v_usd_delta)
               else window_week_used_usd
             end,
             updated_at = now()
       where user_id = p_user_id;
    end if;
  end if;

  update public.usage_reservations
     set actual_usd = v_stored_actual_usd,
         actual_count = v_stored_actual_count,
         status = v_final_status,
         settled_at = now(),
         last_transition_at = now()
   where id = v_row.id;

  return jsonb_build_object(
    'ok', true,
    'reservation_id', v_row.id,
    'status', v_final_status,
    'duplicate', v_duplicate
  );
end;
$$;
revoke all on function public.settle_usage_budget(
  uuid, uuid, numeric, integer, text
) from public, anon, authenticated;
grant execute on function public.settle_usage_budget(
  uuid, uuid, numeric, integer, text
) to service_role;

create or replace function public.release_expired_usage_reservations_for_user(
  p_user_id uuid,
  p_limit integer default 50
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_result jsonb;
  v_count integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
begin
  if p_user_id is null then return 0; end if;
  for v_row in
    select id
      from public.usage_reservations
     where user_id = p_user_id
       and status = 'reserved'
       and expires_at <= now()
     order by expires_at
     for update skip locked
     limit v_limit
  loop
    v_result := public.settle_usage_budget(
      p_user_id, v_row.id, 0, 0, 'released'
    );
    if coalesce((v_result->>'ok')::boolean, false) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.release_expired_usage_reservations_for_user(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.release_expired_usage_reservations_for_user(uuid, integer)
  to service_role;

create or replace function public.release_expired_usage_reservations(
  p_limit integer default 200
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_result jsonb;
  v_count integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  for v_row in
    select id, user_id
      from public.usage_reservations
     where status = 'reserved' and expires_at <= now()
     order by expires_at
     for update skip locked
     limit v_limit
  loop
    v_result := public.settle_usage_budget(
      v_row.user_id, v_row.id, 0, 0, 'released'
    );
    if coalesce((v_result->>'ok')::boolean, false) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.release_expired_usage_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.release_expired_usage_reservations(integer) to service_role;

-- Deepgram launch credits remain a separate promotional wallet. This ledger
-- makes its existing bounded reserve/settle RPCs retry-safe without moving
-- promo usage into paid plan budgets.
create table if not exists public.deepgram_promo_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  reserved_seconds integer not null check (reserved_seconds >= 0),
  reserved_usd numeric not null check (reserved_usd >= 0),
  actual_seconds integer check (actual_seconds >= 0),
  actual_usd numeric check (actual_usd >= 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, idempotency_key)
);
alter table public.deepgram_promo_reservations enable row level security;
drop policy if exists deepgram_promo_reservations_service_only
  on public.deepgram_promo_reservations;
create policy deepgram_promo_reservations_service_only
  on public.deepgram_promo_reservations
  for all to service_role using (true) with check (true);
revoke all on table public.deepgram_promo_reservations from public, anon, authenticated;
grant select, insert, update, delete on table public.deepgram_promo_reservations to service_role;

create or replace function public.reserve_deepgram_promo_idempotent(
  p_user_id uuid,
  p_estimate_seconds integer,
  p_estimate_usd numeric,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.deepgram_promo_reservations%rowtype;
  v_result jsonb;
  v_id uuid;
begin
  if p_user_id is null
     or coalesce(p_estimate_seconds, -1) < 0
     or coalesce(p_estimate_usd, -1) < 0
     or p_idempotency_key is null
     or length(p_idempotency_key) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_reservation');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':deepgram-promo:' || p_idempotency_key, 0)
  );
  select * into v_existing
    from public.deepgram_promo_reservations
   where user_id = p_user_id and idempotency_key = p_idempotency_key
   for update;
  if found then
    return jsonb_build_object(
      'ok', true,
      'reservation_id', v_existing.id,
      'status', v_existing.status,
      'duplicate', true
    );
  end if;

  v_result := public.reserve_deepgram_promo(
    p_user_id, p_estimate_seconds, p_estimate_usd
  );
  if not coalesce((v_result->>'ok')::boolean, false) then
    return v_result;
  end if;
  insert into public.deepgram_promo_reservations
    (user_id, idempotency_key, reserved_seconds, reserved_usd)
  values
    (p_user_id, p_idempotency_key, p_estimate_seconds, p_estimate_usd)
  returning id into v_id;
  return v_result || jsonb_build_object(
    'reservation_id', v_id, 'status', 'reserved', 'duplicate', false
  );
end;
$$;
revoke all on function public.reserve_deepgram_promo_idempotent(
  uuid, integer, numeric, text
) from public, anon, authenticated;
grant execute on function public.reserve_deepgram_promo_idempotent(
  uuid, integer, numeric, text
) to service_role;

create or replace function public.settle_deepgram_promo_idempotent(
  p_user_id uuid,
  p_reservation_id uuid,
  p_actual_seconds integer,
  p_actual_usd numeric,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.deepgram_promo_reservations%rowtype;
  v_seconds integer;
  v_usd numeric;
  v_status text;
begin
  if p_status is null or p_status not in ('settled', 'released', 'failed', 'canceled')
     or coalesce(p_actual_seconds, 0) < 0
     or coalesce(p_actual_usd, 0) < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_settlement');
  end if;
  select * into v_row
    from public.deepgram_promo_reservations
   where id = p_reservation_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'reservation_not_found');
  end if;
  if v_row.status <> 'reserved' then
    return jsonb_build_object('ok', true, 'status', v_row.status, 'duplicate', true);
  end if;

  v_status := case when p_status = 'settled' then 'settled' else 'released' end;
  v_seconds := case when v_status = 'settled' then coalesce(p_actual_seconds, 0) else 0 end;
  v_usd := case when v_status = 'settled' then coalesce(p_actual_usd, 0) else 0 end;
  perform public.settle_deepgram_promo(
    p_user_id,
    v_row.reserved_seconds,
    v_row.reserved_usd,
    v_seconds,
    v_usd
  );
  update public.deepgram_promo_reservations
     set actual_seconds = v_seconds,
         actual_usd = v_usd,
         status = v_status,
         settled_at = now()
   where id = v_row.id;
  return jsonb_build_object('ok', true, 'status', v_status, 'duplicate', false);
end;
$$;
revoke all on function public.settle_deepgram_promo_idempotent(
  uuid, uuid, integer, numeric, text
) from public, anon, authenticated;
grant execute on function public.settle_deepgram_promo_idempotent(
  uuid, uuid, integer, numeric, text
) to service_role;

-- Hive reservations gain an optional idempotency key without changing the RPC.
alter table public.hive_usage_events
  add column if not exists idempotency_key text;
create unique index if not exists hive_usage_events_user_idempotency_idx
  on public.hive_usage_events (user_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.reserve_ai_credits(
  p_user_id uuid,
  p_estimated_credits numeric,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.hive_credit_usage%rowtype;
  v_existing public.hive_usage_events%rowtype;
  v_event_id uuid;
  v_remaining numeric;
  v_preset text := coalesce(p_context->>'preset', 'unknown');
  v_task text := coalesce(p_context->>'task_type', 'general');
  v_step text := coalesce(p_context->>'step_id', 'step');
  v_provider text := coalesce(p_context->>'provider', 'unknown');
  v_model text := coalesce(p_context->>'model', 'unknown');
  v_idempotency_key text := nullif(p_context->>'idempotency_key', '');
begin
  if p_user_id is null or p_estimated_credits is null or p_estimated_credits <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_estimate');
  end if;
  if v_idempotency_key is null
     or length(v_idempotency_key) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_idempotency_key');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':hive:' || v_idempotency_key, 0)
  );
  select * into v_existing
    from public.hive_usage_events
   where user_id = p_user_id
     and idempotency_key = v_idempotency_key
   for update;
  if found then
    if v_existing.status <> 'reserved' then
      return jsonb_build_object(
        'ok', false,
        'reason', 'reservation_finalized',
        'event_id', v_existing.id,
        'status', v_existing.status,
        'duplicate', true
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'event_id', v_existing.id,
      'reserved_credits', v_existing.estimated_credits,
      'status', v_existing.status,
      'duplicate', true
    );
  end if;

  perform public.sync_hive_credit_usage_for_user(p_user_id, null);
  select * into v_usage
    from public.hive_credit_usage
   where user_id = p_user_id
   for update;

  if v_usage.reset_date is not null and now() >= v_usage.reset_date then
    update public.hive_credit_usage
       set used_ai_credits = 0,
           reset_date = public.next_usage_reset_date(p_user_id),
           updated_at = now()
     where user_id = p_user_id
     returning * into v_usage;
  end if;

  v_remaining := greatest(v_usage.monthly_ai_credits - v_usage.used_ai_credits, 0);
  if v_remaining < p_estimated_credits then
    return jsonb_build_object(
      'ok', false,
      'reason', 'ai_credits_exhausted',
      'remaining_credits', v_remaining
    );
  end if;

  update public.hive_credit_usage
     set used_ai_credits = used_ai_credits + p_estimated_credits,
         updated_at = now()
   where user_id = p_user_id;

  insert into public.hive_usage_events
    (user_id, preset, task_type, step_id, provider, model,
     estimated_credits, metadata, idempotency_key)
  values
    (p_user_id, v_preset, v_task, v_step, v_provider, v_model,
     p_estimated_credits, coalesce(p_context, '{}'::jsonb) - 'idempotency_key', v_idempotency_key)
  returning id into v_event_id;

  return jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'reserved_credits', p_estimated_credits,
    'remaining_credits', v_remaining - p_estimated_credits,
    'duplicate', false
  );
end;
$$;
revoke all on function public.reserve_ai_credits(uuid, numeric, jsonb)
  from public, anon, authenticated;
grant execute on function public.reserve_ai_credits(uuid, numeric, jsonb) to service_role;

create or replace function public.settle_ai_credits(
  p_user_id uuid,
  p_event_id uuid,
  p_reserved_credits numeric,
  p_actual_credits numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.hive_usage_events%rowtype;
  v_reserved numeric;
  v_actual numeric := greatest(coalesce(p_actual_credits, 0), 0);
begin
  select * into v_event
    from public.hive_usage_events
   where id = p_event_id
     and user_id = p_user_id
   for update;
  if not found or v_event.status <> 'reserved' then
    return;
  end if;

  -- The trusted reservation row is authoritative; caller-supplied reserved
  -- amounts are retained in the signature only for backward compatibility.
  v_reserved := greatest(coalesce(v_event.estimated_credits, 0), 0);
  update public.hive_usage_events
     set actual_credits = v_actual,
         status = 'settled',
         settled_at = now()
   where id = v_event.id;
  update public.hive_credit_usage
     set used_ai_credits = greatest(used_ai_credits + (v_actual - v_reserved), 0),
         updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.settle_ai_credits(uuid, uuid, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.settle_ai_credits(uuid, uuid, numeric, numeric) to service_role;
