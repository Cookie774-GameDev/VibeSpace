-- =============================================================================
-- 0002_phone_jarvis: phone_settings, outbound_pending, call_audit + RPCs
-- =============================================================================
-- Per-user phone & voice settings, outbound call tracking, and call audit.
-- The pbkdf2_sha256 helper and set_phone_pin RPC match the Python cloud's
-- hashlib.pbkdf2_hmac('sha256', ...) byte-for-byte.

create extension if not exists "pgcrypto";

-- phone_settings ---------------------------------------------------------------
create table if not exists public.phone_settings (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  user_phone_number    text,
  twilio_phone_number  text unique,
  persona              text not null default 'sage'
                       check (persona in ('jarvis','athena','edge','watson','hal','sage')),
  pin_length           integer not null default 6 check (pin_length between 4 and 8),
  pin_salt             text,
  pin_hash             text,
  caller_allowlist     text[] not null default '{}',
  byok_provider_keys   jsonb not null default '{}'::jsonb,
  outbound_triggers    jsonb not null default
                       '{"manual": true, "error": true, "schedule": false, "todo_due": false}'::jsonb,
  unlock_phrase        text not null default 'unlock shell',
  cost_cap_per_call    numeric(10, 4) not null default 5.00,
  cost_cap_per_month   numeric(10, 2) not null default 50.00,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists phone_settings_twilio_idx
  on public.phone_settings (twilio_phone_number);

-- outbound_pending -------------------------------------------------------------
create table if not exists public.outbound_pending (
  call_sid     text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  reason       text not null,
  context      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists outbound_pending_user_idx on public.outbound_pending (user_id);

-- call_audit -------------------------------------------------------------------
create table if not exists public.call_audit (
  call_id            text primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  transport          text not null check (transport in ('twilio','livekit')),
  caller_number      text,
  persona            text not null default 'sage',
  started_at         timestamptz not null,
  ended_at           timestamptz,
  end_reason         text,
  duration_ms        integer not null default 0,
  turn_count         integer not null default 0,
  tool_call_count    integer not null default 0,
  pin_attempts       integer not null default 0,
  pin_passed         boolean not null default false,
  cost_estimate_usd  numeric(10, 4) not null default 0
);
create index if not exists call_audit_user_started_idx
  on public.call_audit (user_id, started_at desc);

-- RLS --------------------------------------------------------------------------
alter table public.phone_settings enable row level security;
alter table public.outbound_pending enable row level security;
alter table public.call_audit enable row level security;

drop policy if exists "own phone settings" on public.phone_settings;
create policy "own phone settings" on public.phone_settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own outbound pending" on public.outbound_pending;
create policy "own outbound pending" on public.outbound_pending
  for select
  using (auth.uid() = user_id);

drop policy if exists "own call audit" on public.call_audit;
create policy "own call audit" on public.call_audit
  for select
  using (auth.uid() = user_id);

-- Helpers ----------------------------------------------------------------------
create or replace function public.touch_phone_settings_updated()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists phone_settings_touch_updated on public.phone_settings;
create trigger phone_settings_touch_updated
  before update on public.phone_settings
  for each row
  execute function public.touch_phone_settings_updated();

-- pbkdf2-sha256 (matches Python's hashlib.pbkdf2_hmac('sha256', ...)) -----------
create or replace function public.pbkdf2_sha256(
  password    bytea,
  salt        bytea,
  iterations  integer,
  dklen       integer
)
returns bytea
language plpgsql
immutable
set search_path = public
as $$
declare
  block_count integer;
  result      bytea := ''::bytea;
  block_idx   integer;
  u           bytea;
  t           bytea;
  i           integer;
  n           integer;
  xored_hex   text;
begin
  if iterations < 1 then
    raise exception 'iterations must be positive';
  end if;
  block_count := ceil(dklen::numeric / 32);

  for block_idx in 1..block_count loop
    u := hmac(salt || decode(lpad(to_hex(block_idx), 8, '0'), 'hex'), password, 'sha256');
    t := u;
    for i in 2..iterations loop
      u := hmac(u, password, 'sha256');
      xored_hex := '';
      for n in 0..(length(t) - 1) loop
        xored_hex := xored_hex
          || lpad(to_hex(get_byte(t, n) # get_byte(u, n)), 2, '0');
      end loop;
      t := decode(xored_hex, 'hex');
    end loop;
    result := result || t;
  end loop;

  return substring(result from 1 for dklen);
end;
$$;

-- set_phone_pin RPC ------------------------------------------------------------
create or replace function public.set_phone_pin(
  p_user_id uuid,
  p_pin     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_salt   bytea;
  v_hash   bytea;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'forbidden';
  end if;
  if p_pin is null or p_pin !~ '^\d{4,8}$' then
    raise exception 'pin must be 4-8 digits';
  end if;

  v_salt := gen_random_bytes(16);
  v_hash := public.pbkdf2_sha256(p_pin::bytea, v_salt, 100000, 32);

  insert into public.phone_settings (user_id, pin_salt, pin_hash, pin_length)
  values (p_user_id, encode(v_salt, 'hex'), encode(v_hash, 'hex'), length(p_pin))
  on conflict (user_id) do update
    set pin_salt = excluded.pin_salt,
        pin_hash = excluded.pin_hash,
        pin_length = excluded.pin_length,
        updated_at = now();
end;
$$;

revoke all on function public.set_phone_pin(uuid, text) from public;
grant execute on function public.set_phone_pin(uuid, text) to authenticated;

-- Cron-friendly cleanup helpers ------------------------------------------------
create or replace function public.prune_outbound_pending()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.outbound_pending
   where created_at < now() - interval '1 hour';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.prune_call_audit(p_days integer default 30)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.call_audit
   where started_at < now() - (p_days || ' days')::interval;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
