-- =============================================================================
-- 0017_advisor_hardening: close out remaining Supabase advisor findings
-- =============================================================================
-- 1. protect_profile_billing_columns (added in 0015) was created without an
--    explicit search_path; pin it like every other function.
-- 2. subscription_events.user_id foreign key had no covering index.
-- 3. plan_limits_read RLS policy re-evaluated auth.role() per row
--    (auth_rls_initplan). Recreate it scoped to the authenticated role, which
--    needs no per-row qual at all.

alter function public.protect_profile_billing_columns() set search_path = public;

create index if not exists subscription_events_user_idx
  on public.subscription_events (user_id);

drop policy if exists plan_limits_read on public.subscription_plan_limits;
create policy plan_limits_read on public.subscription_plan_limits
  for select to authenticated
  using (true);
