-- Adds optional, HTTPS-only contact images without weakening the existing
-- account-owned contact RPC or exposing raw phone numbers to the renderer.

alter table public.jarvis_contacts
  add column if not exists profile_image_url text
  check (
    profile_image_url is null
    or (
      char_length(profile_image_url) <= 2048
      and profile_image_url ~ '^https://'
    )
  );

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
  v_profile_image_url text := nullif(trim(p_optional->>'profile_image_url'),'');
  v_row public.jarvis_contacts;
begin
  if auth.uid() is null or auth.uid() is distinct from p_user_id then raise exception 'forbidden'; end if;
  if v_phone is null then raise exception 'invalid_phone_number'; end if;
  if p_destination_type not in ('saved_contact','business') then raise exception 'invalid_destination_type'; end if;
  if p_consent_status not in ('unknown','user_asserted','recipient_confirmed','revoked') then
    raise exception 'invalid_consent_status';
  end if;
  if v_profile_image_url is not null
    and (char_length(v_profile_image_url) > 2048 or v_profile_image_url !~ '^https://')
  then
    raise exception 'invalid_profile_image_url';
  end if;

  insert into public.jarvis_contacts (
    id, user_id, display_name, phone_number_e164, destination_type,
    allow_ai_calls, allow_ai_messages, consent_status, organization_name,
    relationship, notes, timezone, business_name, business_category,
    business_address, business_hours, source, source_reference,
    profile_image_url, updated_at
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
    v_profile_image_url,
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
    profile_image_url = excluded.profile_image_url,
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.upsert_jarvis_contact(uuid,uuid,text,text,text,boolean,boolean,text,jsonb)
  from public, anon;
grant execute on function public.upsert_jarvis_contact(uuid,uuid,text,text,text,boolean,boolean,text,jsonb)
  to authenticated;
