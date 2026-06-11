-- =============================================================================
-- 0015_protect_billing_columns: stop clients from self-upgrading their plan
-- =============================================================================
-- The "own profile" RLS policy on public.profiles allows FOR ALL on the user's
-- own row, which (before this migration) let any authenticated user PATCH
-- `tier`, `monthly_quota`, or `stripe_customer_id` through the REST API and
-- escalate their hosted budgets without paying (the tier-sync triggers in
-- 0012/0013 would then happily raise voice/message/call budgets).
--
-- Fix: a BEFORE INSERT OR UPDATE trigger that, for client roles
-- ('authenticated' / 'anon'), forces billing columns to safe values:
--   * INSERT  -> tier 'free', default quota, no stripe customer id
--   * UPDATE  -> billing columns silently keep their previous values
--
-- Server-side writers (service_role used by the Stripe webhook and edge
-- functions, the auth signup trigger, migrations) are unaffected because
-- auth.role() is not 'authenticated'/'anon' for them.
--
-- Columns are preserved rather than rejected with an exception so existing
-- clients that naively round-trip the whole profile row keep working.

create or replace function public.protect_profile_billing_columns()
returns trigger
language plpgsql
as $$
declare
  requester text := coalesce(auth.role(), '');
begin
  -- Only constrain end-user requests. service_role, supabase_auth_admin
  -- (signup trigger), and direct admin connections pass through untouched.
  if requester not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.tier := 'free';
    new.monthly_quota := 50;
    new.stripe_customer_id := null;
    return new;
  end if;

  -- UPDATE from a client: billing columns are server-managed.
  new.tier := old.tier;
  new.monthly_quota := old.monthly_quota;
  new.stripe_customer_id := old.stripe_customer_id;
  return new;
end;
$$;

drop trigger if exists profiles_protect_billing on public.profiles;
create trigger profiles_protect_billing
  before insert or update on public.profiles
  for each row
  execute function public.protect_profile_billing_columns();

comment on function public.protect_profile_billing_columns() is
  'Forces tier/monthly_quota/stripe_customer_id to server-managed values when written by authenticated/anon roles. Stripe webhook (service_role) remains the only writer of billing state.';

-- =============================================================================
-- message_rate_limit_hit: dedicated rate-limit RPC for the message pipeline
-- =============================================================================
-- 0013 created public.message_rate_limits but never gave it an increment
-- function, so the message-complete edge function was borrowing
-- voice_rate_limit_hit and polluting the voice window. This mirrors the voice
-- RPC against the message table. Service role only.

alter table public.message_rate_limits
  add column if not exists total_chars integer not null default 0;

create or replace function public.message_rate_limit_hit(
  p_user_id uuid, p_window_start timestamptz, p_chars integer, p_max_requests integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  insert into public.message_rate_limits (user_id, window_start, request_count, total_chars)
  values (p_user_id, p_window_start, 1, greatest(coalesce(p_chars, 0), 0))
  on conflict (user_id, window_start) do update
    set request_count = public.message_rate_limits.request_count + 1,
        total_chars = public.message_rate_limits.total_chars + greatest(coalesce(p_chars, 0), 0),
        updated_at = now()
  returning request_count into v_count;
  return jsonb_build_object('count', v_count, 'limited', v_count > p_max_requests);
end;
$$;
revoke all on function public.message_rate_limit_hit(uuid, timestamptz, integer, integer) from public, anon, authenticated;
