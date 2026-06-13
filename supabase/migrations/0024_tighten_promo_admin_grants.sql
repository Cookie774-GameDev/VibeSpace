-- =============================================================================
-- 0024_tighten_promo_admin_grants
-- =============================================================================
-- Least-privilege follow-up to 0023. The promo-admin RPCs are driven by the
-- service role (agent / edge / dashboard), never from a signed-in browser
-- session, so we revoke EXECUTE from `authenticated`. This also clears the
-- Supabase security advisor warning
--   "Signed-In Users Can Execute SECURITY DEFINER Function"
-- for these three functions.
--
-- The internal is_promo_admin() gate already rejected non-admins, so this is a
-- defense-in-depth tightening, not a behavior change for legitimate callers.
-- If a first-party authenticated admin UI is ever built, re-grant explicitly.
-- =============================================================================

revoke execute on function public.admin_grant_promo_credit(text, numeric, integer, text) from authenticated;
revoke execute on function public.admin_set_promo(text, boolean) from authenticated;
revoke execute on function public.is_promo_admin() from authenticated;

-- service_role retains EXECUTE (granted in 0023); re-assert to be explicit.
grant execute on function public.admin_grant_promo_credit(text, numeric, integer, text) to service_role;
grant execute on function public.admin_set_promo(text, boolean) to service_role;
grant execute on function public.is_promo_admin() to service_role;
