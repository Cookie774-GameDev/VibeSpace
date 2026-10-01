-- Focused verification for migration 0032. Transactional and rollback-only.
begin;

do $$
declare
  uid uuid := gen_random_uuid();
  first jsonb;
  duplicate jsonb;
  reservation_id uuid;
  used_before numeric;
  used_after numeric;
  window_after numeric;
  hive jsonb;
  hive_id uuid;
  admin_uid uuid := gen_random_uuid();
  admin_reservation jsonb;
  admin_reservation_id uuid;
  rollover jsonb;
  rollover_id uuid;
  expired jsonb;
  expired_id uuid;
  terminal_retry jsonb;
  concurrent_one jsonb;
  concurrent_two jsonb;
  concurrent_three jsonb;
begin
  insert into auth.users (id, email) values (uid, 'usage-ledger-' || uid || '@test.local');
  insert into public.profiles (id, tier) values (uid, 'starter')
    on conflict (id) do update set tier='starter';
  perform public.sync_message_call_usage_for_user(uid, 'starter');
  perform public.sync_hive_credit_usage_for_user(uid, 'starter');

  first := public.reserve_usage_budget(uid, 'call', 0.05, 'call-idempotency-key', 60, '{}'::jsonb);
  duplicate := public.reserve_usage_budget(uid, 'call', 0.05, 'call-idempotency-key', 60, '{}'::jsonb);
  if (first->>'reservation_id') is distinct from (duplicate->>'reservation_id') then
    raise exception 'duplicate reserve created a second reservation';
  end if;
  reservation_id := (first->>'reservation_id')::uuid;
  if public.claim_usage_reservation(
      uid, reservation_id, 'call', 'provider-call-123'
    ) then
    raise exception 'unbound reservation was claimable';
  end if;
  if not public.attach_usage_provider_reference(
      uid, reservation_id, 'provider-call-123'
    ) then
    raise exception 'provider reference could not be attached';
  end if;
  if not public.claim_usage_reservation(
      uid, reservation_id, 'call', 'provider-call-123'
    ) then
    raise exception 'valid reserved call was not claimable';
  end if;
  if public.claim_usage_reservation(
      uid, reservation_id, 'call', 'provider-call-123'
    ) then
    raise exception 'reservation replay was claimable';
  end if;
  if public.claim_usage_reservation(
      uid, reservation_id, 'call', 'provider-call-999'
    ) then
    raise exception 'wrong provider reference was claimable';
  end if;
  select used_usd into used_before from public.call_usage where user_id=uid;
  perform public.settle_usage_budget(uid, reservation_id, 0, 0, 'released');
  perform public.settle_usage_budget(uid, reservation_id, 0, 0, 'released');
  select used_usd into used_after from public.call_usage where user_id=uid;
  select window_5h_used_usd into window_after from public.message_usage where user_id=uid;
  if used_before <= 0 or used_after <> 0 or window_after <> 0 then
    raise exception 'release/double-settle corrupted shared usage: before %, after %, window %',
      used_before, used_after, window_after;
  end if;

  perform public.settle_usage_budget(uid, reservation_id, 0.02, 30, 'settled');
  if (select used_usd from public.call_usage where user_id=uid) <> 0.02
     or (select used_seconds from public.call_usage where user_id=uid) <> 30
     or (select window_5h_used_usd from public.message_usage where user_id=uid) <> 0.02 then
    raise exception 'late success did not correct a released reservation';
  end if;
  perform public.settle_usage_budget(uid, reservation_id, 0, 0, 'refunded');
  if (select used_usd from public.call_usage where user_id=uid) <> 0
     or (select used_seconds from public.call_usage where user_id=uid) <> 0
     or (select window_5h_used_usd from public.message_usage where user_id=uid) <> 0 then
    raise exception 'refund did not reverse the settled contribution';
  end if;
  terminal_retry := public.reserve_usage_budget(
    uid, 'call', 0.05, 'call-idempotency-key', 60, '{}'::jsonb
  );
  if coalesce((terminal_retry->>'ok')::boolean, true)
     or (terminal_retry->>'reason') is distinct from 'reservation_finalized' then
    raise exception 'terminal reservation replay was allowed: %', terminal_retry;
  end if;

  rollover := public.reserve_usage_budget(
    uid, 'message', 0.01, 'message-rollover-key', 0, '{}'::jsonb
  );
  rollover_id := (rollover->>'reservation_id')::uuid;
  update public.message_usage
     set used_usd = 0,
         reset_date = reset_date + interval '1 month',
         window_5h_start = now() + interval '1 day',
         window_5h_used_usd = 0,
         window_week_start = now() + interval '1 day',
         window_week_used_usd = 0
   where user_id = uid;
  perform public.settle_usage_budget(uid, rollover_id, 0, 0, 'released');
  if (select used_usd from public.message_usage where user_id=uid) <> 0
     or (select window_5h_used_usd from public.message_usage where user_id=uid) <> 0 then
    raise exception 'old reservation settlement mutated a new accounting period';
  end if;

  perform public.sync_message_call_usage_for_user(uid, 'starter');
  expired := public.reserve_usage_budget(
    uid, 'sms', 0.01, 'sms-expiry-key', 1, '{}'::jsonb
  );
  expired_id := (expired->>'reservation_id')::uuid;
  update public.usage_reservations set expires_at = now() - interval '1 second'
   where id = expired_id;
  if public.release_expired_usage_reservations_for_user(uid, 10) <> 1
     or (select status from public.usage_reservations where id=expired_id) <> 'released' then
    raise exception 'expired reservation was not recovered';
  end if;

  hive := public.reserve_ai_credits(uid, 25, jsonb_build_object('idempotency_key','hive-key'));
  hive_id := (hive->>'event_id')::uuid;
  perform public.settle_ai_credits(uid, hive_id, 25, 10);
  perform public.settle_ai_credits(uid, hive_id, 25, 10);
  if (select used_ai_credits from public.hive_credit_usage where user_id=uid) <> 10 then
    raise exception 'Hive duplicate settlement was not idempotent';
  end if;
  duplicate := public.reserve_ai_credits(
    uid, 25, jsonb_build_object('idempotency_key','hive-key')
  );
  if coalesce((duplicate->>'ok')::boolean, true)
     or (duplicate->>'reason') is distinct from 'reservation_finalized' then
    raise exception 'finalized Hive reservation replay was allowed: %', duplicate;
  end if;
  duplicate := public.reserve_ai_credits(uid, 25, '{}'::jsonb);
  if coalesce((duplicate->>'ok')::boolean, true)
     or (duplicate->>'reason') is distinct from 'invalid_idempotency_key' then
    raise exception 'Hive reservation accepted a missing idempotency key: %', duplicate;
  end if;

  if has_function_privilege('authenticated',
      'public.reserve_usage_budget(uuid,text,numeric,text,integer,jsonb)', 'execute') then
    raise exception 'client can reserve server usage';
  end if;
  if has_function_privilege('authenticated',
      'public.claim_usage_reservation(uuid,uuid,text,text)', 'execute') then
    raise exception 'client can claim server usage';
  end if;

  insert into auth.users (id, email)
  values (admin_uid, 'usage-admin-' || admin_uid || '@test.local');
  insert into public.profiles (id, tier) values (admin_uid, 'free')
    on conflict (id) do update set tier='free';
  insert into public.app_admins (user_id, note)
  values (admin_uid, 'rollback test admin');
  admin_reservation := public.reserve_usage_budget(
    admin_uid, 'call', 1.25, 'admin-call-idempotency', 1800,
    jsonb_build_object('provider', 'twilio', 'operation', 'outbound_call')
  );
  if not coalesce((admin_reservation->>'ok')::boolean, false)
     or (admin_reservation->>'reserved_usd')::numeric <> 0
     or (admin_reservation->>'reserved_count')::integer <> 1800 then
    raise exception 'admin reservation was denied or charged: %', admin_reservation;
  end if;
  admin_reservation_id := (admin_reservation->>'reservation_id')::uuid;
  perform public.settle_usage_budget(
    admin_uid, admin_reservation_id, 0.75, 900, 'settled'
  );
  if not exists (
    select 1 from public.usage_reservations
     where id = admin_reservation_id
       and status = 'settled'
       and reserved_usd = 0
       and actual_usd = 0.75
       and metadata @> '{"admin_unlimited":true}'::jsonb
  ) then
    raise exception 'admin usage audit settlement was not retained';
  end if;
  if exists (select 1 from public.call_usage where user_id = admin_uid) then
    raise exception 'admin reservation unexpectedly mutated plan usage';
  end if;
  concurrent_one := public.reserve_usage_budget(
    admin_uid, 'call', 1.25, 'admin-concurrent-call-one', 1800, '{}'::jsonb
  );
  concurrent_two := public.reserve_usage_budget(
    admin_uid, 'call', 1.25, 'admin-concurrent-call-two', 1800, '{}'::jsonb
  );
  concurrent_three := public.reserve_usage_budget(
    admin_uid, 'call', 1.25, 'admin-concurrent-call-three', 1800, '{}'::jsonb
  );
  if not coalesce((concurrent_one->>'ok')::boolean, false)
     or not coalesce((concurrent_two->>'ok')::boolean, false)
     or coalesce((concurrent_three->>'ok')::boolean, true)
     or (concurrent_three->>'reason') is distinct from 'concurrent_call_limit' then
    raise exception 'universal concurrent call limit failed: %, %, %',
      concurrent_one, concurrent_two, concurrent_three;
  end if;
end $$;

rollback;
