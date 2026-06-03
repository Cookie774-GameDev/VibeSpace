-- =============================================================================
-- Jarvis V3 - billing additions
-- =============================================================================
-- Mirrors the Stripe webhook contract in
-- `supabase/functions/stripe-webhook/index.ts`. This migration is optional —
-- only deployments that flip on paid tiers need it.
--
-- Conventions match 0001/0002:
--   * `if not exists` so re-running this file is safe
--   * Tier as a constrained text column (no enum churn on rollouts)
--   * `stripe_customer_id` is unique-but-nullable so free users still fit
--   * RLS unchanged — the existing `profiles_owner` policy already covers
--     the new columns
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles - billing-related columns
-- -----------------------------------------------------------------------------
-- The `tier` column already exists on the hosted-tier schema (see
-- supabase/schema.sql in the repo root) but isn't part of the V1 migration.
-- We add it here defensively so deployments running only this migration set
-- still have a column to flip on subscription events.

alter table public.profiles
  add column if not exists tier text not null default 'free'
  check (tier in ('free', 'starter', 'plus', 'pro', 'ultra', 'byok-only'));

-- Stripe customer id — opaque, immutable, unique per Stripe customer.
-- Nullable because free-tier users don't have one until they upgrade.
alter table public.profiles
  add column if not exists stripe_customer_id text;

create unique index if not exists profiles_stripe_customer_idx
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

-- Stripe subscription id — useful for support tooling and to detect a
-- ghost subscription that didn't generate a webhook event. Nullable.
alter table public.profiles
  add column if not exists stripe_subscription_id text;

create index if not exists profiles_stripe_subscription_idx
  on public.profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Track the moment we last applied a webhook event so support can debug
-- "the user paid but didn't get the tier" reports without re-pulling
-- everything from Stripe.
alter table public.profiles
  add column if not exists tier_updated_at timestamptz;

-- -----------------------------------------------------------------------------
-- billing_events - audit log of incoming Stripe webhook events
-- -----------------------------------------------------------------------------
-- Optional but cheap. Each event Stripe sends is appended; the webhook
-- function writes here *before* updating profiles so a partial failure
-- can be replayed by ops.
create table if not exists public.billing_events (
  id            text primary key,                 -- Stripe event.id
  type          text not null,                    -- e.g. customer.subscription.created
  customer_id   text,
  subscription_id text,
  payload       jsonb not null,
  received_at   timestamptz not null default now()
);

create index if not exists billing_events_customer_idx
  on public.billing_events (customer_id);
create index if not exists billing_events_type_idx
  on public.billing_events (type);
create index if not exists billing_events_received_idx
  on public.billing_events (received_at desc);

-- RLS: nobody but the service role should ever read this table; it's
-- written by the edge function (which uses the service role key) and
-- consumed only by ops queries from the dashboard.
alter table public.billing_events enable row level security;

drop policy if exists billing_events_no_select on public.billing_events;
create policy billing_events_no_select on public.billing_events
  for select using (false);
