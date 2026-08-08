-- =============================================================================
-- 0040_telemetry_reward_discount
-- Account-bound optional telemetry consent and authoritative discount routing.
-- No client may write reward eligibility or coupon identifiers directly.
-- =============================================================================

alter table public.profiles
  add column if not exists telemetry_policy_version text,
  add column if not exists telemetry_data_classes text[] not null default '{}',
  add column if not exists telemetry_consented_at timestamptz,
  add column if not exists telemetry_withdrawn_at timestamptz;

create table if not exists public.telemetry_consent_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null,
  policy_version text not null check (length(policy_version) between 1 and 160),
  data_classes text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists telemetry_consent_audit_user_created_idx
  on public.telemetry_consent_audit (user_id, created_at desc);

alter table public.telemetry_consent_audit enable row level security;
revoke all on table public.telemetry_consent_audit from anon, authenticated;

create table if not exists public.family_discount_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  family_percent_off numeric(6,3) not null
    check (family_percent_off > 0 and family_percent_off < 100),
  family_coupon_id text not null check (family_coupon_id ~ '^coupon_[A-Za-z0-9_]+$'),
  combined_telemetry_coupon_id text
    check (
      combined_telemetry_coupon_id is null
      or combined_telemetry_coupon_id ~ '^coupon_[A-Za-z0-9_]+$'
    ),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.family_discount_entitlements enable row level security;
revoke all on table public.family_discount_entitlements from anon, authenticated;

create or replace function public.set_telemetry_reward_consent(
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
  v_classes text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_policy_version is null
     or length(trim(p_policy_version)) not between 1 and 160 then
    raise exception 'invalid consent payload' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct value order by value), '{}')
    into v_classes
    from unnest(coalesce(p_data_classes, '{}')) as value;

  if p_enabled and v_classes <> array['diagnostics','product_usage','tool_outcomes']::text[] then
    raise exception 'all disclosed data classes are required' using errcode = '22023';
  end if;
  if not p_enabled and cardinality(v_classes) <> 0 then
    raise exception 'withdrawal must clear data classes' using errcode = '22023';
  end if;

  update public.profiles
     set telemetry_opt_in = p_enabled,
         telemetry_policy_version = p_policy_version,
         telemetry_data_classes = v_classes,
         telemetry_consented_at = case when p_enabled then now() else telemetry_consented_at end,
         telemetry_withdrawn_at = case when p_enabled then null else now() end,
         updated_at = now()
   where id = p_user_id;
  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  insert into public.telemetry_consent_audit
    (user_id, enabled, policy_version, data_classes)
  values
    (p_user_id, p_enabled, p_policy_version, v_classes);

  return jsonb_build_object(
    'enabled', p_enabled,
    'policyVersion', p_policy_version,
    'dataClasses', to_jsonb(v_classes),
    'eligible', p_enabled
  );
end;
$$;

revoke all on function public.set_telemetry_reward_consent(uuid, boolean, text, text[])
  from public, anon, authenticated;
grant execute on function public.set_telemetry_reward_consent(uuid, boolean, text, text[])
  to service_role;
