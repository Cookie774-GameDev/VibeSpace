-- =============================================================================
-- 0038_backend_advisor_hardening
-- =============================================================================
-- Resolve the concrete security/performance advisor findings without changing
-- product behavior. Server-owned ledgers remain readable only where an
-- existing owner/catalog policy permits and are never client-writable.

-- The function already enforces auth.uid() = p_user_id. Running with invoker
-- rights adds the table's RLS and caller privileges as a second authorization
-- boundary and removes the authenticated SECURITY DEFINER exposure.
alter function public.set_phone_pin(uuid, text)
  security invoker;

-- Scope the immutable display catalog by database role. This avoids evaluating
-- auth.role() once per row while preserving authenticated-only reads.
drop policy if exists deepgram_promo_plan_limits_read
  on public.deepgram_promo_plan_limits;
create policy deepgram_promo_plan_limits_read
  on public.deepgram_promo_plan_limits
  for select
  to authenticated
  using (true);

-- These FOR ALL false policies also participated in SELECT policy evaluation,
-- producing redundant permissive-policy work. RLS default-deny plus explicit
-- DML/TRUNCATE revocation is both stronger and cheaper.
drop policy if exists deepgram_promo_pool_no_client_write
  on public.deepgram_promo_pool;
drop policy if exists deepgram_promo_usage_no_client_write
  on public.deepgram_promo_usage;
drop policy if exists hive_credit_usage_no_client_write
  on public.hive_credit_usage;
drop policy if exists hive_usage_events_no_client_write
  on public.hive_usage_events;
drop policy if exists sms_usage_no_client_write
  on public.sms_usage;

revoke insert, update, delete, truncate on table public.deepgram_promo_pool
  from anon, authenticated;
revoke insert, update, delete, truncate on table public.deepgram_promo_usage
  from anon, authenticated;
revoke insert, update, delete, truncate on table public.hive_credit_usage
  from anon, authenticated;
revoke insert, update, delete, truncate on table public.hive_usage_events
  from anon, authenticated;
revoke insert, update, delete, truncate on table public.sms_usage
  from anon, authenticated;

-- Cover the nullable audit foreign key used for administrator attribution and
-- cleanup without removing the existing target-user chronology index.
create index if not exists admin_credit_grants_admin_idx
  on public.admin_credit_grants (admin_user_id, created_at desc);
