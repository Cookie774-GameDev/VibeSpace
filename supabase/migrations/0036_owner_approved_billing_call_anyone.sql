-- =============================================================================
-- 0036_owner_approved_billing_call_anyone
-- Canonical Access + add-on economics, exact shared credits, contacts, and
-- server-authoritative third-party call approval/reservation/settlement.
-- =============================================================================

-- The service columns remain analytics dimensions only. Migrations 0030+ make
-- their sum one fungible pool for every reserve operation.
insert into public.subscription_plan_limits
  (plan, message_budget_usd, call_budget_usd, sms_budget_usd,
   message_credits, call_minutes, sms_count, updated_at)
values
  ('free',    0.4500,  0.4250,  0.1250,   1000, 0, 0, now()),
  ('starter', 2.4750,  2.3375,  0.6875,   5500, 0, 0, now()),
  ('pro',    12.3750, 11.6875,  3.4375,  27500, 0, 0, now()),
  ('ultra',  24.7500, 23.3750,  6.8750,  55000, 0, 0, now()),
  ('apex',   49.5000, 46.7500, 13.7500, 110000, 0, 0, now())
on conflict (plan) do update
set message_budget_usd = excluded.message_budget_usd,
    call_budget_usd = excluded.call_budget_usd,
    sms_budget_usd = excluded.sms_budget_usd,
    message_credits = excluded.message_credits,
    call_minutes = excluded.call_minutes,
    sms_count = excluded.sms_count,
    updated_at = now();

create or replace function public.plan_monthly_credits(p_plan text)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select case coalesce(p_plan, 'free')
    when 'free' then 1000::bigint
    when 'starter' then 5500::bigint
    when 'pro' then 27500::bigint
    when 'ultra' then 55000::bigint
    when 'apex' then 110000::bigint
    else 0::bigint
  end;
$$;
revoke all on function public.plan_monthly_credits(text) from public, anon, authenticated;
grant execute on function public.plan_monthly_credits(text) to service_role;

create or replace function public.get_unified_credit_balance(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_budget numeric;
  v_used numeric;
  v_total bigint;
  v_used_credits bigint;
begin
  if auth.uid() is not null and auth.uid() is distinct from p_user_id then
    raise exception 'forbidden';
  end if;
  select coalesce(tier, 'free') into v_plan from public.profiles where id = p_user_id;
  if not found then raise exception 'profile_not_found'; end if;
  v_budget := coalesce(public.unified_plan_budget_usd(v_plan), 0);
  v_used := greatest(0, coalesce(public.unified_used_usd(p_user_id), 0));
  v_total := public.plan_monthly_credits(v_plan);
  v_used_credits := least(v_total, ceil(v_used * 1000)::bigint);
  return jsonb_build_object(
    'plan', v_plan,
    'total_credits', v_total,
    'used_credits', v_used_credits,
    'available_credits', greatest(0, v_total - v_used_credits),
    'provider_budget_usd', v_budget
  );
end;
$$;
revoke all on function public.get_unified_credit_balance(uuid) from public, anon;
grant execute on function public.get_unified_credit_balance(uuid) to authenticated, service_role;

-- Reconcile existing usage rows without resetting spend mid-cycle.
update public.message_usage u
set monthly_budget_usd = l.message_budget_usd, updated_at = now()
from public.subscription_plan_limits l where l.plan = u.plan;
update public.call_usage u
set monthly_budget_usd = l.call_budget_usd, updated_at = now()
from public.subscription_plan_limits l where l.plan = u.plan;
update public.sms_usage u
set monthly_budget_usd = l.sms_budget_usd, updated_at = now()
from public.subscription_plan_limits l where l.plan = u.plan;

create table if not exists public.jarvis_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 160),
  organization_name text check (organization_name is null or char_length(organization_name) <= 160),
  phone_number_e164 text not null check (phone_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  destination_type text not null default 'saved_contact'
    check (destination_type in ('saved_contact', 'business')),
  relationship text check (relationship is null or char_length(relationship) <= 120),
  notes text check (notes is null or char_length(notes) <= 2000),
  timezone text check (timezone is null or char_length(timezone) <= 80),
  consent_status text not null default 'unknown'
    check (consent_status in ('unknown', 'user_asserted', 'recipient_confirmed', 'revoked')),
  allow_ai_calls boolean not null default false,
  allow_ai_messages boolean not null default false,
  business_name text check (business_name is null or char_length(business_name) <= 160),
  business_category text check (business_category is null or char_length(business_category) <= 120),
  business_address text check (business_address is null or char_length(business_address) <= 500),
  business_hours jsonb,
  source text check (source is null or char_length(source) <= 80),
  source_reference text check (source_reference is null or char_length(source_reference) <= 500),
  blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, phone_number_e164)
);
create index if not exists jarvis_contacts_user_name_idx
  on public.jarvis_contacts (user_id, lower(display_name));

create table if not exists public.blocked_call_destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_number_e164 text not null check (phone_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  unique (user_id, phone_number_e164)
);

create table if not exists public.recipient_opt_outs (
  id uuid primary key default gen_random_uuid(),
  phone_number_e164 text not null check (phone_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  scope text not null default 'all_vibespace'
    check (scope in ('all_vibespace', 'account')),
  user_id uuid references auth.users(id) on delete cascade,
  source text not null check (source in ('recipient_request', 'sms_stop', 'operator', 'provider')),
  provider_event_id text,
  created_at timestamptz not null default now(),
  check (
    (scope = 'all_vibespace' and user_id is null)
    or (scope = 'account' and user_id is not null)
  )
);
create unique index if not exists recipient_opt_outs_global_phone_idx
  on public.recipient_opt_outs(phone_number_e164) where scope='all_vibespace';
create unique index if not exists recipient_opt_outs_account_phone_idx
  on public.recipient_opt_outs(user_id,phone_number_e164) where scope='account';

create table if not exists public.outbound_call_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.jarvis_contacts(id) on delete set null,
  destination_type text not null
    check (destination_type in ('saved_contact', 'business', 'one_time_number')),
  destination_phone_e164 text not null check (destination_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  destination_display_name text not null check (char_length(destination_display_name) between 1 and 160),
  goal text not null check (goal in (
    'business_information', 'reservation_request', 'appointment_availability',
    'quote_request', 'availability_check', 'relay_message',
    'custom_information_request'
  )),
  purpose text not null check (char_length(purpose) between 3 and 600),
  user_instructions text not null default '' check (char_length(user_instructions) <= 2000),
  approved_script text not null check (char_length(approved_script) between 3 and 2000),
  opening_disclosure text not null check (
    char_length(opening_disclosure) between 10 and 600
    and opening_disclosure ~* '(AI|artificial intelligence)'
    and opening_disclosure ~* 'VibeSPACE'
  ),
  allowed_actions text[] not null default '{}',
  maximum_duration_seconds integer not null check (maximum_duration_seconds between 30 and 1800),
  maximum_credit_reservation bigint not null check (maximum_credit_reservation between 1 and 500000),
  reserved_credits bigint not null default 0 check (reserved_credits >= 0),
  settled_credits bigint not null default 0 check (settled_credits >= 0),
  status text not null default 'awaiting_user_approval' check (status in (
    'draft', 'awaiting_user_approval', 'approved', 'credits_reserved', 'queued',
    'dialing', 'ringing', 'in_progress', 'awaiting_live_approval', 'completed',
    'failed', 'cancelled', 'blocked'
  )),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 160),
  approval_fingerprint text check (approval_fingerprint is null or approval_fingerprint ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz,
  provider_call_id text,
  provider_status text,
  provider_status_updated_at timestamptz,
  pending_action_summary text check (
    pending_action_summary is null or char_length(pending_action_summary) <= 1000
  ),
  pending_action_requested_at timestamptz,
  pending_action_decision text check (
    pending_action_decision is null or pending_action_decision in ('approved','declined')
  ),
  pending_action_decided_at timestamptz,
  transcript_status text not null default 'disabled'
    check (transcript_status in ('disabled', 'active', 'redacted', 'retained', 'deleted')),
  result_summary text check (result_summary is null or char_length(result_summary) <= 4000),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 500),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (provider_call_id)
);
create index if not exists outbound_call_jobs_user_created_idx
  on public.outbound_call_jobs (user_id, created_at desc);
create index if not exists outbound_call_jobs_status_idx
  on public.outbound_call_jobs (status, updated_at);

create table if not exists public.outbound_call_approvals (
  id uuid primary key default gen_random_uuid(),
  call_job_id uuid not null references public.outbound_call_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  approval_fingerprint text not null check (approval_fingerprint ~ '^[a-f0-9]{64}$'),
  approved_destination_phone_e164 text not null,
  approved_purpose text not null,
  approved_script text not null,
  approved_opening_disclosure text not null,
  approved_allowed_actions text[] not null default '{}',
  approved_maximum_duration_seconds integer not null,
  approved_maximum_credit_reservation bigint not null,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default now()
);
create unique index if not exists outbound_call_approvals_current_idx
  on public.outbound_call_approvals (call_job_id) where invalidated_at is null;

create table if not exists public.outbound_call_provider_events (
  provider_event_id text primary key,
  call_job_id uuid references public.outbound_call_jobs(id) on delete set null,
  provider_call_id text,
  event_type text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$')
);

create table if not exists public.call_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  destination_phone_e164 text not null,
  window_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz not null default now(),
  primary key (user_id, destination_phone_e164, window_start)
);

create table if not exists public.call_abuse_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  call_job_id uuid references public.outbound_call_jobs(id) on delete set null,
  category text not null,
  decision text not null check (decision in ('blocked', 'rate_limited', 'review')),
  created_at timestamptz not null default now()
);

alter table public.jarvis_contacts enable row level security;
alter table public.blocked_call_destinations enable row level security;
alter table public.recipient_opt_outs enable row level security;
alter table public.outbound_call_jobs enable row level security;
alter table public.outbound_call_approvals enable row level security;
alter table public.outbound_call_provider_events enable row level security;
alter table public.call_rate_limits enable row level security;
alter table public.call_abuse_events enable row level security;

drop policy if exists jarvis_contacts_select_own on public.jarvis_contacts;
create policy jarvis_contacts_select_own on public.jarvis_contacts
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists blocked_call_destinations_select_own on public.blocked_call_destinations;
create policy blocked_call_destinations_select_own on public.blocked_call_destinations
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists outbound_call_jobs_select_own on public.outbound_call_jobs;
create policy outbound_call_jobs_select_own on public.outbound_call_jobs
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists outbound_call_approvals_select_own on public.outbound_call_approvals;
create policy outbound_call_approvals_select_own on public.outbound_call_approvals
  for select to authenticated using ((select auth.uid()) = user_id);

-- No direct browser writes. Contacts and blocks flow through bounded RPCs;
-- all job/provider/settlement state remains service-authoritative.
revoke all on public.jarvis_contacts, public.blocked_call_destinations,
  public.recipient_opt_outs, public.outbound_call_jobs,
  public.outbound_call_approvals, public.outbound_call_provider_events,
  public.call_rate_limits, public.call_abuse_events
from anon, authenticated;
grant select on public.jarvis_contacts, public.blocked_call_destinations,
  public.outbound_call_jobs, public.outbound_call_approvals
to authenticated;
grant all on public.jarvis_contacts, public.blocked_call_destinations,
  public.recipient_opt_outs, public.outbound_call_jobs,
  public.outbound_call_approvals, public.outbound_call_provider_events,
  public.call_rate_limits, public.call_abuse_events
to service_role;

create or replace function public.normalize_vibespace_e164(p_phone text)
returns text
language plpgsql
immutable
security invoker
set search_path = public
as $$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_result text;
begin
  if v_digits in ('000','08','110','112','118','119','911','999') then return null; end if;
  if coalesce(p_phone, '') like '+%' then v_result := '+' || v_digits;
  elsif char_length(v_digits) = 10 then v_result := '+1' || v_digits;
  elsif char_length(v_digits) = 11 and v_digits like '1%' then v_result := '+' || v_digits;
  else return null;
  end if;
  if v_result !~ '^\+[1-9][0-9]{7,14}$' then return null; end if;
  return v_result;
end;
$$;
revoke all on function public.normalize_vibespace_e164(text) from public, anon, authenticated;
grant execute on function public.normalize_vibespace_e164(text) to service_role;

create or replace function public.upsert_jarvis_contact(
  p_user_id uuid,
  p_contact_id uuid,
  p_display_name text,
  p_phone text,
  p_destination_type text,
  p_allow_ai_calls boolean,
  p_allow_ai_messages boolean,
  p_consent_status text,
  p_optional jsonb default '{}'::jsonb
) returns public.jarvis_contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := public.normalize_vibespace_e164(p_phone);
  v_row public.jarvis_contacts;
begin
  if auth.uid() is null or auth.uid() is distinct from p_user_id then raise exception 'forbidden'; end if;
  if v_phone is null then raise exception 'invalid_phone_number'; end if;
  if p_destination_type not in ('saved_contact','business') then raise exception 'invalid_destination_type'; end if;
  if p_consent_status not in ('unknown','user_asserted','recipient_confirmed','revoked') then
    raise exception 'invalid_consent_status';
  end if;
  insert into public.jarvis_contacts (
    id, user_id, display_name, phone_number_e164, destination_type,
    allow_ai_calls, allow_ai_messages, consent_status, organization_name,
    relationship, notes, timezone, business_name, business_category,
    business_address, business_hours, source, source_reference, updated_at
  ) values (
    coalesce(p_contact_id, gen_random_uuid()), p_user_id, trim(p_display_name),
    v_phone, p_destination_type, coalesce(p_allow_ai_calls,false),
    coalesce(p_allow_ai_messages,false), p_consent_status,
    nullif(trim(p_optional->>'organization_name'),''),
    nullif(trim(p_optional->>'relationship'),''),
    nullif(trim(p_optional->>'notes'),''),
    nullif(trim(p_optional->>'timezone'),''),
    nullif(trim(p_optional->>'business_name'),''),
    nullif(trim(p_optional->>'business_category'),''),
    nullif(trim(p_optional->>'business_address'),''),
    p_optional->'business_hours',
    nullif(trim(p_optional->>'source'),''),
    nullif(trim(p_optional->>'source_reference'),''),
    now()
  )
  on conflict (user_id, phone_number_e164) do update set
    display_name = excluded.display_name,
    destination_type = excluded.destination_type,
    allow_ai_calls = excluded.allow_ai_calls,
    allow_ai_messages = excluded.allow_ai_messages,
    consent_status = excluded.consent_status,
    organization_name = excluded.organization_name,
    relationship = excluded.relationship,
    notes = excluded.notes,
    timezone = excluded.timezone,
    business_name = excluded.business_name,
    business_category = excluded.business_category,
    business_address = excluded.business_address,
    business_hours = excluded.business_hours,
    source = excluded.source,
    source_reference = excluded.source_reference,
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.upsert_jarvis_contact(uuid,uuid,text,text,text,boolean,boolean,text,jsonb)
  from public, anon;
grant execute on function public.upsert_jarvis_contact(uuid,uuid,text,text,text,boolean,boolean,text,jsonb)
  to authenticated;

create or replace function public.prepare_outbound_call_job(
  p_user_id uuid,
  p_contact_id uuid,
  p_destination_type text,
  p_destination_phone text,
  p_destination_display_name text,
  p_goal text,
  p_purpose text,
  p_user_instructions text,
  p_approved_script text,
  p_opening_disclosure text,
  p_allowed_actions text[],
  p_maximum_duration_seconds integer,
  p_maximum_credit_reservation bigint,
  p_idempotency_key text
) returns public.outbound_call_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := public.normalize_vibespace_e164(p_destination_phone);
  v_contact public.jarvis_contacts;
  v_job public.outbound_call_jobs;
begin
  if v_phone is null then raise exception 'prohibited_destination'; end if;
  if p_destination_type not in ('saved_contact','business','one_time_number') then
    raise exception 'invalid_destination_type';
  end if;
  if p_contact_id is not null then
    select * into v_contact from public.jarvis_contacts
      where id = p_contact_id and user_id = p_user_id and blocked_at is null;
    if not found then raise exception 'contact_not_found'; end if;
    if v_contact.phone_number_e164 is distinct from v_phone then raise exception 'contact_phone_mismatch'; end if;
    if not v_contact.allow_ai_calls or v_contact.consent_status = 'revoked' then
      raise exception 'contact_call_not_allowed';
    end if;
  end if;
  if exists (
    select 1 from public.blocked_call_destinations
    where user_id = p_user_id and phone_number_e164 = v_phone
  ) or exists (
    select 1 from public.recipient_opt_outs
    where phone_number_e164 = v_phone and (scope = 'all_vibespace' or user_id = p_user_id)
  ) then
    raise exception 'recipient_blocked';
  end if;
  insert into public.outbound_call_jobs (
    user_id, contact_id, destination_type, destination_phone_e164,
    destination_display_name, goal, purpose, user_instructions, approved_script,
    opening_disclosure, allowed_actions, maximum_duration_seconds,
    maximum_credit_reservation, idempotency_key
  ) values (
    p_user_id, p_contact_id, p_destination_type, v_phone,
    trim(p_destination_display_name), p_goal, trim(p_purpose),
    coalesce(trim(p_user_instructions),''), trim(p_approved_script),
    trim(p_opening_disclosure), coalesce(p_allowed_actions,'{}'),
    p_maximum_duration_seconds, p_maximum_credit_reservation, p_idempotency_key
  )
  on conflict (user_id, idempotency_key) do update
    set updated_at = public.outbound_call_jobs.updated_at
  returning * into v_job;
  return v_job;
end;
$$;
revoke all on function public.prepare_outbound_call_job(uuid,uuid,text,text,text,text,text,text,text,text,text[],integer,bigint,text)
  from public, anon, authenticated;
grant execute on function public.prepare_outbound_call_job(uuid,uuid,text,text,text,text,text,text,text,text,text[],integer,bigint,text)
  to service_role;

create or replace function public.approve_outbound_call_job(
  p_user_id uuid, p_job_id uuid, p_fingerprint text
) returns public.outbound_call_jobs
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.outbound_call_jobs;
begin
  select * into v_job from public.outbound_call_jobs
    where id = p_job_id and user_id = p_user_id for update;
  if not found then raise exception 'call_job_not_found'; end if;
  if v_job.status <> 'awaiting_user_approval' then raise exception 'call_job_not_approvable'; end if;
  if p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'invalid_fingerprint'; end if;
  update public.outbound_call_approvals
    set invalidated_at = now(), invalidation_reason = 'superseded'
    where call_job_id = p_job_id and invalidated_at is null;
  insert into public.outbound_call_approvals (
    call_job_id, user_id, approval_fingerprint,
    approved_destination_phone_e164, approved_purpose, approved_script,
    approved_opening_disclosure, approved_allowed_actions,
    approved_maximum_duration_seconds, approved_maximum_credit_reservation
  ) values (
    v_job.id, v_job.user_id, p_fingerprint,
    v_job.destination_phone_e164, v_job.purpose, v_job.approved_script,
    v_job.opening_disclosure, v_job.allowed_actions,
    v_job.maximum_duration_seconds, v_job.maximum_credit_reservation
  );
  update public.outbound_call_jobs set
    status = 'approved', approval_fingerprint = p_fingerprint,
    approved_at = now(), updated_at = now()
    where id = p_job_id returning * into v_job;
  return v_job;
end;
$$;
revoke all on function public.approve_outbound_call_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.approve_outbound_call_job(uuid,uuid,text) to service_role;

create or replace function public.resolve_outbound_call_live_approval(
  p_user_id uuid, p_job_id uuid, p_approved boolean
) returns public.outbound_call_jobs
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.outbound_call_jobs;
begin
  select * into v_job from public.outbound_call_jobs
    where id=p_job_id and user_id=p_user_id for update;
  if not found then raise exception 'call_job_not_found'; end if;
  if v_job.status <> 'awaiting_live_approval'
     or v_job.pending_action_summary is null then
    raise exception 'live_approval_not_pending';
  end if;
  update public.outbound_call_jobs set
    status='in_progress',
    pending_action_decision=case when p_approved then 'approved' else 'declined' end,
    pending_action_decided_at=now(),
    updated_at=now()
  where id=p_job_id returning * into v_job;
  return v_job;
end;
$$;
revoke all on function public.resolve_outbound_call_live_approval(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.resolve_outbound_call_live_approval(uuid,uuid,boolean)
  to service_role;

create or replace function public.record_recipient_call_opt_out(
  p_job_id uuid, p_source text default 'recipient_request'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.outbound_call_jobs;
begin
  if p_source not in ('recipient_request','provider') then
    raise exception 'invalid_opt_out_source';
  end if;
  select * into v_job from public.outbound_call_jobs where id=p_job_id for update;
  if not found then raise exception 'call_job_not_found'; end if;
  insert into public.recipient_opt_outs(
    phone_number_e164,scope,user_id,source
  ) values (
    v_job.destination_phone_e164,'all_vibespace',null,p_source
  )
  on conflict (phone_number_e164) where scope='all_vibespace'
  do update set source=excluded.source, created_at=now();
  update public.jarvis_contacts
    set consent_status='revoked',allow_ai_calls=false,allow_ai_messages=false,
        blocked_at=now(),updated_at=now()
    where user_id=v_job.user_id
      and phone_number_e164=v_job.destination_phone_e164;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.record_recipient_call_opt_out(uuid,text)
  from public,anon,authenticated;
grant execute on function public.record_recipient_call_opt_out(uuid,text)
  to service_role;

create or replace function public.reserve_outbound_call_job(
  p_user_id uuid, p_job_id uuid, p_fingerprint text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.outbound_call_jobs;
  v_res jsonb;
  v_window timestamptz := date_trunc('minute', now());
  v_attempts integer;
begin
  select * into v_job from public.outbound_call_jobs
    where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','call_job_not_found'); end if;
  if v_job.status in ('credits_reserved','queued','dialing','ringing','in_progress') then
    return jsonb_build_object('ok',true,'already_reserved',true,'reserved_credits',v_job.reserved_credits);
  end if;
  if v_job.status <> 'approved' or v_job.approval_fingerprint is distinct from p_fingerprint
     or not exists (
       select 1 from public.outbound_call_approvals
       where call_job_id = v_job.id and invalidated_at is null
         and approval_fingerprint = p_fingerprint
     ) then
    return jsonb_build_object('ok',false,'reason','approval_required');
  end if;
  if exists (
    select 1 from public.recipient_opt_outs
    where phone_number_e164 = v_job.destination_phone_e164
      and (scope = 'all_vibespace' or user_id = p_user_id)
  ) or exists (
    select 1 from public.blocked_call_destinations
    where user_id = p_user_id and phone_number_e164 = v_job.destination_phone_e164
  ) then
    update public.outbound_call_jobs set status='blocked', failure_reason='recipient_blocked',
      updated_at=now() where id=v_job.id;
    return jsonb_build_object('ok',false,'reason','recipient_blocked');
  end if;
  insert into public.call_rate_limits (
    user_id, destination_phone_e164, window_start, attempts, last_attempt_at
  ) values (p_user_id, v_job.destination_phone_e164, v_window, 1, now())
  on conflict (user_id, destination_phone_e164, window_start) do update
    set attempts = public.call_rate_limits.attempts + 1, last_attempt_at = now()
  returning attempts into v_attempts;
  if v_attempts > 1 or exists (
    select 1 from public.outbound_call_jobs
    where user_id = p_user_id
      and destination_phone_e164 = v_job.destination_phone_e164
      and id <> v_job.id
      and created_at > now() - interval '5 minutes'
      and status in ('dialing','ringing','in_progress','completed','failed')
  ) then
    insert into public.call_abuse_events(user_id,call_job_id,category,decision)
      values (p_user_id,v_job.id,'rapid_redial','rate_limited');
    return jsonb_build_object('ok',false,'reason','rate_limited');
  end if;
  v_res := public.reserve_call_budget(
    p_user_id, v_job.maximum_credit_reservation::numeric / 1000
  );
  if not coalesce((v_res->>'ok')::boolean,false) then return v_res; end if;
  update public.outbound_call_jobs set
    status='credits_reserved',
    reserved_credits=maximum_credit_reservation,
    updated_at=now()
  where id=v_job.id;
  return jsonb_build_object(
    'ok',true,
    'reserved_credits',v_job.maximum_credit_reservation,
    'remaining_credits',floor(coalesce((v_res->>'remaining_usd')::numeric,0)*1000)::bigint
  );
end;
$$;
revoke all on function public.reserve_outbound_call_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.reserve_outbound_call_job(uuid,uuid,text) to service_role;

create or replace function public.cancel_outbound_call_job(
  p_user_id uuid, p_job_id uuid, p_reason text default 'user_cancelled'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.outbound_call_jobs;
begin
  select * into v_job from public.outbound_call_jobs
    where id=p_job_id and user_id=p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','call_job_not_found'); end if;
  if v_job.status in ('completed','failed','cancelled','blocked') then
    return jsonb_build_object('ok',true,'status',v_job.status);
  end if;
  if v_job.reserved_credits > v_job.settled_credits then
    perform public.settle_call_budget(
      p_user_id,
      v_job.reserved_credits::numeric/1000,
      v_job.settled_credits::numeric/1000,
      0
    );
  end if;
  update public.outbound_call_jobs set status='cancelled',
    failure_reason=left(coalesce(p_reason,'user_cancelled'),500),
    settled_credits=least(settled_credits,reserved_credits),
    completed_at=now(),updated_at=now() where id=v_job.id;
  return jsonb_build_object('ok',true,'status','cancelled');
end;
$$;
revoke all on function public.cancel_outbound_call_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.cancel_outbound_call_job(uuid,uuid,text) to service_role;

create or replace function public.complete_outbound_call_job(
  p_job_id uuid,
  p_status text,
  p_actual_credits bigint,
  p_duration_seconds integer,
  p_provider_call_id text,
  p_provider_status text,
  p_result_summary text,
  p_failure_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.outbound_call_jobs;
  v_actual bigint;
begin
  select * into v_job from public.outbound_call_jobs where id=p_job_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','call_job_not_found'); end if;
  if v_job.status in ('completed','failed','cancelled','blocked') then
    return jsonb_build_object('ok',true,'duplicate',true,'status',v_job.status);
  end if;
  if p_status not in ('completed','failed','cancelled','blocked') then
    return jsonb_build_object('ok',false,'reason','invalid_terminal_status');
  end if;
  v_actual := least(v_job.reserved_credits, greatest(0,coalesce(p_actual_credits,0)));
  perform public.settle_call_budget(
    v_job.user_id,
    v_job.reserved_credits::numeric/1000,
    v_actual::numeric/1000,
    greatest(0,coalesce(p_duration_seconds,0))
  );
  update public.outbound_call_jobs set
    status=p_status, settled_credits=v_actual,
    provider_call_id=coalesce(p_provider_call_id,provider_call_id),
    provider_status=left(coalesce(p_provider_status,p_status),120),
    result_summary=left(p_result_summary,4000),
    failure_reason=left(p_failure_reason,500),
    completed_at=now(), updated_at=now()
  where id=v_job.id;
  return jsonb_build_object(
    'ok',true,'status',p_status,'settled_credits',v_actual,
    'returned_credits',greatest(0,v_job.reserved_credits-v_actual)
  );
end;
$$;
revoke all on function public.complete_outbound_call_job(uuid,text,bigint,integer,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.complete_outbound_call_job(uuid,text,bigint,integer,text,text,text,text)
  to service_role;
