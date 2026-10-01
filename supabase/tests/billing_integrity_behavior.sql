-- Focused verification for migration 0031. Transactional and rollback-only.
begin;

do $$
declare
  uid uuid := gen_random_uuid();
  customer text := 'cus_test_' || replace(uid::text, '-', '');
  first_sub text := 'sub_first_' || replace(uid::text, '-', '');
  second_sub text := 'sub_second_' || replace(uid::text, '-', '');
  tie_paid_sub text := 'sub_tie_paid_' || replace(uid::text, '-', '');
  tie_reverse_sub text := 'sub_tie_reverse_' || replace(uid::text, '-', '');
  unknown_sub text := 'sub_unknown_' || replace(uid::text, '-', '');
  tie_time timestamptz := now() + interval '3 seconds';
  result jsonb;
  current_tier text;
begin
  insert into auth.users (id, email) values (uid, 'billing-integrity-' || uid || '@test.local');
  insert into public.profiles (id, tier, stripe_customer_id) values (uid, 'free', customer)
    on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id;

  perform public.sync_voice_usage_for_user(uid, 'apex');
  if (select plan from public.voice_usage where user_id = uid) is distinct from 'apex' then
    raise exception 'Apex voice usage propagation failed';
  end if;
  if public.voice_budget_for_plan('apex') is distinct from 28.05 then
    raise exception 'Apex voice budget must mirror current call budget';
  end if;

  result := public.apply_stripe_subscription_event(
    'evt_newer', 'customer.subscription.created', now(), customer, first_sub,
    'active', 'starter', 'price_starter', now(), now() + interval '1 month', false
  );
  if coalesce((result->>'applied')::boolean, false) is not true then
    raise exception 'new subscription event was not applied: %', result;
  end if;

  result := public.apply_stripe_subscription_event(
    'evt_stale', 'customer.subscription.updated', now() - interval '1 day', customer, first_sub,
    'canceled', 'starter', 'price_starter', now() - interval '1 month', now(), false
  );
  if (result->>'reason') is distinct from 'stale_event' then
    raise exception 'out-of-order event was not ignored: %', result;
  end if;

  perform public.apply_stripe_subscription_event(
    'evt_second', 'customer.subscription.created', now() + interval '1 second', customer, second_sub,
    'active', 'pro', 'price_pro', now(), now() + interval '1 month', false
  );
  perform public.apply_stripe_subscription_event(
    'evt_delete_first', 'customer.subscription.deleted', now() + interval '2 seconds', customer, first_sub,
    'canceled', null, null, null, null, false
  );
  select tier into current_tier from public.profiles where id = uid;
  if current_tier is distinct from 'pro' then
    raise exception 'deleting one subscription revoked another active subscription: %', current_tier;
  end if;

  delete from public.subscriptions where id = first_sub;
  select tier into current_tier from public.profiles where id = uid;
  if current_tier is distinct from 'pro' then
    raise exception 'deleting a subscription row revoked another active subscription: %', current_tier;
  end if;

  perform public.apply_stripe_subscription_event(
    'evt_tie_revoke', 'customer.subscription.deleted', tie_time, customer, second_sub,
    'canceled', 'pro', 'price_pro', null, null, false
  );
  result := public.apply_stripe_subscription_event(
    'evt_tie_paid', 'customer.subscription.updated', tie_time, customer, second_sub,
    'active', 'pro', 'price_pro', now(), now() + interval '1 month', false
  );
  if (result->>'reason') is distinct from 'stale_event' then
    raise exception 'same-second paid snapshot overrode revocation: %', result;
  end if;
  select tier into current_tier from public.profiles where id = uid;
  if current_tier is distinct from 'free' then
    raise exception 'same-second ordering restored paid access: %', current_tier;
  end if;

  perform public.apply_stripe_subscription_event(
    'evt_same_a', 'customer.subscription.created', tie_time + interval '1 second',
    customer, tie_paid_sub, 'active', 'starter', 'price_starter', now(), now() + interval '1 month', false
  );
  perform public.apply_stripe_subscription_event(
    'evt_same_z', 'customer.subscription.updated', tie_time + interval '1 second',
    customer, tie_paid_sub, 'active', 'pro', 'price_pro', now(), now() + interval '1 month', false
  );
  result := public.apply_stripe_subscription_event(
    'evt_same_m', 'customer.subscription.updated', tie_time + interval '1 second',
    customer, tie_paid_sub, 'active', 'ultra', 'price_ultra', now(), now() + interval '1 month', false
  );
  if (result->>'reason') is distinct from 'stale_event'
     or (select plan from public.subscriptions where id = tie_paid_sub) is distinct from 'pro' then
    raise exception 'same-class event-id tie break is delivery-order dependent: %', result;
  end if;

  perform public.apply_stripe_subscription_event(
    'evt_reverse_paid', 'customer.subscription.created', tie_time + interval '2 seconds',
    customer, tie_reverse_sub, 'active', 'starter', 'price_starter', now(), now() + interval '1 month', false
  );
  result := public.apply_stripe_subscription_event(
    'evt_reverse_revoke', 'customer.subscription.deleted', tie_time + interval '2 seconds',
    customer, tie_reverse_sub, 'paused', null, null, null, null, false
  );
  if coalesce((result->>'applied')::boolean, false) is not true
     or (select status from public.subscriptions where id = tie_reverse_sub) is distinct from 'paused' then
    raise exception 'same-second revocation did not win after paid event: %', result;
  end if;

  result := public.apply_stripe_subscription_event(
    'evt_unknown_delete', 'customer.subscription.deleted', tie_time + interval '1 second',
    customer, unknown_sub, 'canceled', null, null, null, null, false
  );
  if coalesce((result->>'applied')::boolean, false) is not true
     or (select plan from public.subscriptions where id = unknown_sub) is distinct from 'free' then
    raise exception 'unknown historical cancellation was not recorded safely: %', result;
  end if;

  if exists (
    select 1 from public.subscriptions
     where stripe_event_created_at is null or stripe_event_id is null
  ) then
    raise exception 'subscription event ordering baseline was not backfilled';
  end if;

  result := public.claim_checkout_slot(uid, 'checkout:test:first', 'pro');
  if coalesce((result->>'claimed')::boolean, false) is not true then
    raise exception 'initial checkout slot was not claimed: %', result;
  end if;
  result := public.claim_checkout_slot(uid, 'checkout:test:first', 'pro');
  if coalesce((result->>'duplicate')::boolean, false) is not true then
    raise exception 'same checkout request was not idempotent: %', result;
  end if;
  result := public.claim_checkout_slot(uid, 'checkout:test:second', 'ultra');
  if (result->>'reason') is distinct from 'checkout_in_progress' then
    raise exception 'parallel checkout request was not rejected: %', result;
  end if;
  if not public.attach_checkout_session(uid, 'checkout:test:first', 'cs_test_first') then
    raise exception 'checkout session was not attached to its slot';
  end if;
  if not public.complete_checkout_slot(uid, 'cs_test_first') then
    raise exception 'completed checkout slot was not released';
  end if;
  if not public.complete_checkout_slot(uid, 'cs_test_first') then
    raise exception 'completed checkout cleanup was not idempotent';
  end if;
  result := public.claim_checkout_slot(uid, 'checkout:test:second', 'ultra');
  if coalesce((result->>'claimed')::boolean, false) is not true then
    raise exception 'checkout slot was not reusable after completion: %', result;
  end if;
  if not public.release_checkout_slot(uid, 'checkout:test:second') then
    raise exception 'unattached checkout slot was not releasable';
  end if;

  if has_function_privilege('anon', 'public.pbkdf2_sha256(bytea,bytea,integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.pbkdf2_sha256(bytea,bytea,integer,integer)', 'execute') then
    raise exception 'PBKDF2 remains client executable';
  end if;
  if has_function_privilege('authenticated', 'public.prune_outbound_pending()', 'execute')
     or has_function_privilege('authenticated', 'public.prune_call_audit(integer)', 'execute') then
    raise exception 'maintenance RPC remains client executable';
  end if;
  if not has_function_privilege('service_role',
      'public.voice_rate_limit_hit(uuid,timestamptz,integer,integer)', 'execute')
     or not has_function_privilege('service_role',
      'public.message_rate_limit_hit(uuid,timestamptz,integer,integer)', 'execute') then
    raise exception 'service rate-limit RPC grants are missing';
  end if;
  insert into public.app_admins (user_id, note) values (uid, 'rollback test admin');
  if coalesce((public.voice_rate_limit_hit(uid, date_trunc('minute', now()), 0, 1)->>'limited')::boolean, true)
     or not coalesce((public.voice_rate_limit_hit(uid, date_trunc('minute', now()), 0, 1)->>'limited')::boolean, false) then
    raise exception 'universal voice rate limit was not enforced for admin';
  end if;
  if (select request_count from public.voice_rate_limits
       where user_id = uid and window_start = date_trunc('minute', now())) <> 2 then
    raise exception 'universal admin voice rate-limit counter was not recorded';
  end if;
  if has_table_privilege('authenticated', 'public.subscription_events', 'select') then
    raise exception 'authenticated users can read Stripe event data';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public'
                 and indexname='admin_credit_grants_admin_user_idx') then
    raise exception 'verified missing admin-credit FK index was not added';
  end if;
end $$;

rollback;
