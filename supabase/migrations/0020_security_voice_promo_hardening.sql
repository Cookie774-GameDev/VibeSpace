-- =============================================================================
-- 0020_security_voice_promo_hardening: close promo/billing loopholes + $1k pool
-- =============================================================================
-- 0. Promo pool budget $6k → $1k (90% kill switch = $900 pause). Bump later via:
--    update deepgram_promo_pool set budget_usd=6000, pause_at_usd=5400, active=true where id=1;
-- 1. is_app_admin: authenticated users may only query their own uid (no admin
--    enumeration). service_role may query any uid.
-- 2. settle_deepgram_promo: cap usage at per-user seconds_limit; clamp refund
--    deltas so settlements cannot credit more than was reserved.
-- 3. Explicit client-deny write policies on promo tables (defence in depth).
-- 4. reserve_deepgram_promo: reject estimates above per-user remaining allowance
--    in a single statement (already checked; add seconds_limit cap on settle).

-- ─── Promo pool: $6k → $1k (live projects that already ran 0019) ─────────────
update public.deepgram_promo_pool
   set budget_usd   = 1000,
       pause_at_usd = 900,
       active       = case when used_usd < 900 then true else active end,
       updated_at   = now()
 where id = 1;

alter table public.deepgram_promo_pool
  alter column budget_usd set default 1000,
  alter column pause_at_usd set default 900;

-- ─── is_app_admin: self-only for authenticated callers ───────────────────────
create or replace function public.is_app_admin(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'authenticated'
     and auth.uid() is distinct from p_user_id then
    return false;
  end if;
  return exists (select 1 from public.app_admins where user_id = p_user_id);
end;
$$;

revoke all on function public.is_app_admin(uuid) from public;
grant execute on function public.is_app_admin(uuid) to authenticated;
grant execute on function public.is_app_admin(uuid) to service_role;

-- ─── settle_deepgram_promo: cap usage + clamp refund deltas ──────────────────
create or replace function public.settle_deepgram_promo(
  p_user_id uuid,
  p_reserved_seconds integer,
  p_reserved_usd numeric,
  p_actual_seconds integer,
  p_actual_usd numeric
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row public.deepgram_promo_usage%rowtype;
  v_sec_delta integer;
  v_usd_delta numeric;
begin
  select * into v_row from public.deepgram_promo_usage where user_id = p_user_id for update;
  if not found then
    return;
  end if;

  -- Refunds cannot exceed what was reserved on this request.
  v_sec_delta := coalesce(p_actual_seconds, 0) - coalesce(p_reserved_seconds, 0);
  if v_sec_delta < 0 then
    v_sec_delta := greatest(v_sec_delta, -coalesce(p_reserved_seconds, 0));
  end if;
  v_usd_delta := coalesce(p_actual_usd, 0) - coalesce(p_reserved_usd, 0);
  if v_usd_delta < 0 then
    v_usd_delta := greatest(v_usd_delta, -coalesce(p_reserved_usd, 0));
  end if;

  if v_sec_delta <> 0 then
    update public.deepgram_promo_usage
       set used_seconds = least(
             v_row.seconds_limit,
             greatest(0, used_seconds + v_sec_delta)
           ),
           updated_at = now()
     where user_id = p_user_id;
  end if;

  if v_usd_delta <> 0 then
    update public.deepgram_promo_usage
       set used_usd = greatest(0, used_usd + v_usd_delta),
           updated_at = now()
     where user_id = p_user_id;
    update public.deepgram_promo_pool
       set used_usd = greatest(0, used_usd + v_usd_delta),
           updated_at = now()
       where id = 1;
  end if;
end;
$$;
revoke all on function public.settle_deepgram_promo(uuid, integer, numeric, integer, numeric)
  from public, anon, authenticated;

-- ─── Client write deny on promo tables ───────────────────────────────────────
drop policy if exists deepgram_promo_usage_no_client_write on public.deepgram_promo_usage;
create policy deepgram_promo_usage_no_client_write on public.deepgram_promo_usage
  for all to authenticated
  using (false)
  with check (false);

drop policy if exists deepgram_promo_pool_no_client_write on public.deepgram_promo_pool;
create policy deepgram_promo_pool_no_client_write on public.deepgram_promo_pool
  for all to authenticated
  using (false)
  with check (false);
