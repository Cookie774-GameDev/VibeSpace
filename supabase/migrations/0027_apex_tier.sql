-- =============================================================================
-- 0027_apex_tier: allow 'apex' in profiles.tier and subscriptions.plan
-- =============================================================================
-- The Supernova / Apex plan is defined in lib/entitlements.ts but the DB
-- check constraints previously capped at 'ultra'. This migration widens
-- both constraints so Stripe webhook-driven inserts and profile syncs
-- for apex subscribers don't fail with a constraint violation.
--
-- Also updates the sync_profile_tier_from_subscription() trigger function
-- to rank apex above ultra and assign the correct monthly_quota.

-- ─── 1. profiles.tier: drop old constraint, add wider one ────────────────────

alter table public.profiles
  drop constraint if exists profiles_tier_check;

alter table public.profiles
  add constraint profiles_tier_check
  check (tier in ('free', 'starter', 'pro', 'ultra', 'apex', 'plus', 'byok-only'));

-- ─── 2. subscriptions.plan: drop old constraint, add wider one ───────────────

alter table public.subscriptions
  drop constraint if exists subscriptions_plan_check;

alter table public.subscriptions
  add constraint subscriptions_plan_check
  check (plan in ('free', 'starter', 'pro', 'ultra', 'apex'));

-- ─── 3. Update sync trigger to rank apex above ultra and set quota ────────────

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
                         when 'apex'    then 5
                         when 'ultra'   then 4
                         when 'pro'     then 3
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
                           when 'free'    then 50
                           when 'starter' then 1500
                           when 'pro'     then 5000
                           when 'ultra'   then 25000
                           when 'apex'    then 62000
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

-- Ensure the trigger is still wired (idempotent re-creation is safe).
drop trigger if exists subscriptions_sync_profile on public.subscriptions;
create trigger subscriptions_sync_profile
  after insert or update on public.subscriptions
  for each row
  execute function public.sync_profile_tier_from_subscription();

-- ─── 4. voice_budget_for_plan: add apex ──────────────────────────────────────

create or replace function public.voice_budget_for_plan(p_plan text)
returns numeric language sql immutable
set search_path = public as $$
  select case p_plan
           when 'starter' then 2.17::numeric
           when 'pro'     then 10.85::numeric
           when 'ultra'   then 21.70::numeric
           when 'apex'    then 43.40::numeric
           else 0::numeric end;
$$;
