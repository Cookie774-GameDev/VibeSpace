-- =============================================================================
-- 0004_billing_stripe: subscriptions + stripe webhook event log
-- =============================================================================
-- subscriptions: 1:N user -> stripe subscriptions (history kept; the active
-- one is the row with status in ('active','trialing','past_due')).
-- stripe_events: idempotent dedup log for the webhook handler.

create table if not exists public.subscriptions (
  id                       text primary key,  -- stripe subscription id (sub_...)
  user_id                  uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id       text,
  status                   text not null,
  plan                     text not null
                           check (plan in ('free','starter','pro','ultra')),
  price_id                 text,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  canceled_at              timestamptz,
  trial_end                timestamptz,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id, status);
create index if not exists subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

create table if not exists public.stripe_events (
  id            text primary key,  -- stripe event id (evt_...)
  type          text not null,
  payload       jsonb not null,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists stripe_events_type_idx on public.stripe_events (type, created_at desc);

-- RLS --------------------------------------------------------------------------
-- Users can read their own subscriptions; only the service role writes
-- (via the stripe-webhook edge function).
alter table public.subscriptions enable row level security;
drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions
  for select
  using (auth.uid() = user_id);

-- stripe_events is service-role only.
alter table public.stripe_events enable row level security;
drop policy if exists "stripe_events service only" on public.stripe_events;
create policy "stripe_events service only" on public.stripe_events
  for select
  using (false);

-- updated_at trigger -----------------------------------------------------------
drop trigger if exists subscriptions_touch_updated on public.subscriptions;
create trigger subscriptions_touch_updated
  before update on public.subscriptions
  for each row
  when (old.updated_at is not distinct from new.updated_at)
  execute function public.touch_updated_at_ts();

-- Helper: keep profiles.tier in sync with the active subscription -------------
create or replace function public.sync_profile_tier_from_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_tier text;
begin
  select case
           when bool_or(status in ('active','trialing')) then
             (select plan from public.subscriptions
              where user_id = new.user_id
                and status in ('active','trialing')
              order by case plan
                         when 'ultra' then 4
                         when 'pro' then 3
                         when 'starter' then 2
                         else 1
                       end desc,
                       current_period_end desc nulls last
              limit 1)
           else 'free'
         end
    into v_target_tier
  from public.subscriptions
  where user_id = new.user_id;

  if v_target_tier is null then
    v_target_tier := 'free';
  end if;

  update public.profiles
     set tier = v_target_tier,
         monthly_quota = case v_target_tier
                           when 'free' then 50
                           when 'starter' then 1500
                           when 'pro' then 5000
                           when 'ultra' then 25000
                           else 50
                         end,
         updated_at = now()
   where id = new.user_id;

  return new;
end;
$$;

revoke all on function public.sync_profile_tier_from_subscription() from public;
revoke all on function public.sync_profile_tier_from_subscription() from anon;
revoke all on function public.sync_profile_tier_from_subscription() from authenticated;

drop trigger if exists subscriptions_sync_profile on public.subscriptions;
create trigger subscriptions_sync_profile
  after insert or update on public.subscriptions
  for each row
  execute function public.sync_profile_tier_from_subscription();
