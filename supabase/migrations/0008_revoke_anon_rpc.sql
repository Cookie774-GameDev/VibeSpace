-- =============================================================================
-- 0008_revoke_anon_rpc
-- =============================================================================
-- Revoke EXECUTE on set_phone_pin from anon. Authenticated users keep
-- access (the function's body checks auth.uid() = p_user_id and raises
-- 'forbidden' otherwise, which is the intentional design).

revoke execute on function public.set_phone_pin(uuid, text) from anon;
