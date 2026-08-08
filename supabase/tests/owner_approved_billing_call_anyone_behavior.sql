-- Transactional verification for migration 0036. Safe against a VibeSPACE
-- test database: all throwaway rows roll back.
begin;

do $$
declare
  uid uuid := gen_random_uuid();
  other_uid uuid := gen_random_uuid();
  contact_row public.jarvis_contacts;
  job public.outbound_call_jobs;
  result jsonb;
  fingerprint text := repeat('a',64);
begin
  if public.plan_monthly_credits('free') <> 1000
     or public.plan_monthly_credits('starter') <> 5500
     or public.plan_monthly_credits('pro') <> 27500
     or public.plan_monthly_credits('ultra') <> 55000
     or public.plan_monthly_credits('apex') <> 110000 then
    raise exception 'canonical monthly credit mapping is incorrect';
  end if;
  if public.unified_plan_budget_usd('free') <> 1
     or public.unified_plan_budget_usd('starter') <> 5.5
     or public.unified_plan_budget_usd('pro') <> 27.5
     or public.unified_plan_budget_usd('ultra') <> 55
     or public.unified_plan_budget_usd('apex') <> 110 then
    raise exception 'canonical provider budget mapping is incorrect';
  end if;

  insert into auth.users(id,email) values
    (uid,'call-anyone-'||uid||'@test.local'),
    (other_uid,'call-anyone-'||other_uid||'@test.local');
  insert into public.profiles(id,tier) values (uid,'starter'),(other_uid,'starter')
    on conflict(id) do update set tier=excluded.tier;
  perform public.sync_message_call_usage_for_user(uid,'starter');
  perform public.sync_message_call_usage_for_user(other_uid,'starter');

  insert into public.jarvis_contacts(
    user_id,display_name,phone_number_e164,destination_type,
    consent_status,allow_ai_calls
  ) values (
    uid,'Mario''s Pizza','+13125550192','business','user_asserted',true
  ) returning * into contact_row;

  job := public.prepare_outbound_call_job(
    uid,contact_row.id,'business','+1 (312) 555-0192','Mario''s Pizza',
    'business_information','Ask when the restaurant closes.','Only ask for hours.',
    'Ask for today''s closing time.',
    'Hello, I am the VibeSPACE AI assistant calling on behalf of Alex.',
    array['ask_questions'],300,480,'test-idempotency-key-00000001'
  );
  if job.status <> 'awaiting_user_approval' then raise exception 'prepare dialed early'; end if;
  if (public.prepare_outbound_call_job(
    uid,contact_row.id,'business','+13125550192','Mario''s Pizza',
    'business_information','Ask when the restaurant closes.','Only ask for hours.',
    'Ask for today''s closing time.',
    'Hello, I am the VibeSPACE AI assistant calling on behalf of Alex.',
    array['ask_questions'],300,480,'test-idempotency-key-00000001'
  )).id <> job.id then raise exception 'prepare idempotency failed'; end if;

  result := public.reserve_outbound_call_job(uid,job.id,fingerprint);
  if result->>'reason' <> 'approval_required' then raise exception 'unapproved call reserved: %',result; end if;

  job := public.approve_outbound_call_job(uid,job.id,fingerprint);
  result := public.reserve_outbound_call_job(uid,job.id,fingerprint);
  if not coalesce((result->>'ok')::boolean,false) then raise exception 'approved reserve failed: %',result; end if;
  result := public.reserve_outbound_call_job(uid,job.id,fingerprint);
  if not coalesce((result->>'already_reserved')::boolean,false) then
    raise exception 'duplicate reserve was not idempotent: %',result;
  end if;

  result := public.complete_outbound_call_job(
    job.id,'completed',214,138,'telnyx-test-call','hangup',
    'Open until 10 PM. No commitment made.',null
  );
  if (result->>'returned_credits')::bigint <> 266 then
    raise exception 'settlement did not return exact remainder: %',result;
  end if;
  result := public.complete_outbound_call_job(
    job.id,'completed',214,138,'telnyx-test-call','hangup',
    'duplicate callback',null
  );
  if not coalesce((result->>'duplicate')::boolean,false) then
    raise exception 'terminal callback replay was not idempotent';
  end if;

  perform public.record_recipient_call_opt_out(job.id,'recipient_request');
  if not exists (
    select 1 from public.recipient_opt_outs
    where phone_number_e164='+13125550192' and scope='all_vibespace'
  ) then raise exception 'recipient opt-out was not persisted'; end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and table_name='outbound_call_jobs'
      and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')
  ) then raise exception 'authenticated role can mutate call jobs'; end if;

  raise notice 'owner_approved_billing_call_anyone_behavior: ALL CHECKS PASSED';
end $$;

rollback;
