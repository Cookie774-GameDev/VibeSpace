-- =============================================================================
-- 0007_security_hardening
-- =============================================================================
-- Address advisor findings:
--   * function_search_path_mutable on touch_*_updated  (set search_path)
--   * anon/auth_security_definer_function_executable on trigger functions
--     (revoke execute from public; only the trigger itself calls them)
--   * stripe_events RLS-with-no-policy is intentional but make it explicit.
-- Also: keep legacy 'plus' tier value working so the existing HostedJarvis.tsx
-- UI doesn't break when reading old profile rows.

-- 1. Allow legacy 'plus' as a valid tier value alongside the canonical four.
alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles add constraint profiles_tier_check
  check (tier in ('free','plus','starter','pro','ultra','byok-only'));

-- 2. Pin search_path on housekeeping trigger functions ----------------------
create or replace function public.touch_updated_at_ts()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.touch_phone_settings_updated()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 3. Lock down trigger-only SECURITY DEFINER functions from RPC abuse -------
revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

revoke all on function public.sync_profile_tier_from_subscription() from public;
revoke all on function public.sync_profile_tier_from_subscription() from anon;
revoke all on function public.sync_profile_tier_from_subscription() from authenticated;

-- set_phone_pin is intentionally exposed to authenticated; keep that.

-- 4. Make stripe_events deny-by-default explicit so the advisor recognises
--    intent.  Service role bypasses RLS; nobody else should read this table.
drop policy if exists "stripe_events service only" on public.stripe_events;
create policy "stripe_events service only" on public.stripe_events
  for select
  using (false);

-- 5. Pin search_path on the remaining functions.
alter function public.sync_profile_tier_from_subscription()
  set search_path = pg_catalog, public;
alter function public.handle_new_user()
  set search_path = pg_catalog, public;
alter function public.prune_outbound_pending()
  set search_path = pg_catalog, public;
alter function public.prune_call_audit(integer)
  set search_path = pg_catalog, public;
alter function public.set_phone_pin(uuid, text)
  set search_path = pg_catalog, public;
