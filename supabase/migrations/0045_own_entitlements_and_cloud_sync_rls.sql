-- =============================================================================
-- 0045_own_entitlements_and_cloud_sync_rls
-- Replace raw billing-table reads with an own-user projection and enforce
-- cloud-sync eligibility at the database boundary.
-- =============================================================================

drop policy if exists plan_limits_read on public.subscription_plan_limits;
revoke all on table public.subscription_plan_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.subscription_plan_limits to service_role;

revoke all on table public.app_admins from public, anon, authenticated;
grant select, insert, update, delete on table public.app_admins to service_role;

create or replace function public.can_use_cloud_sync()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then false
    when exists (
      select 1 from public.app_admins a where a.user_id = auth.uid()
    ) then true
    else coalesce((
      select p.tier in ('starter', 'pro', 'ultra', 'apex')
        from public.profiles p
       where p.id = auth.uid()
    ), false)
  end;
$$;
revoke all on function public.can_use_cloud_sync() from public, anon;
grant execute on function public.can_use_cloud_sync() to authenticated;

create or replace function public.get_my_entitlements()
returns table (
  user_id uuid,
  plan text,
  is_admin boolean,
  cloud_sync_allowed boolean,
  message_credits integer,
  call_minutes integer,
  sms_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select auth.uid() as user_id
  ), resolved as (
    select c.user_id,
           case
             when p.tier in ('starter', 'pro', 'ultra', 'apex') then p.tier
             else 'free'
           end as plan,
           exists (
             select 1 from public.app_admins a where a.user_id = c.user_id
           ) as is_admin
      from caller c
      join public.profiles p on p.id = c.user_id
     where c.user_id is not null
  )
  select r.user_id,
         r.plan,
         r.is_admin,
         (r.is_admin or r.plan <> 'free') as cloud_sync_allowed,
         coalesce(l.message_credits, 0)::integer,
         coalesce(l.call_minutes, 0)::integer,
         coalesce(l.sms_count, 0)::integer
    from resolved r
    left join public.subscription_plan_limits l on l.plan = r.plan;
$$;
revoke all on function public.get_my_entitlements() from public, anon;
grant execute on function public.get_my_entitlements() to authenticated;

comment on function public.get_my_entitlements() is
  'Returns the authenticated caller own server-managed plan and display limits.';
comment on function public.can_use_cloud_sync() is
  'Returns whether the authenticated caller has paid-plan or admin cloud sync access.';

-- Downgrades retain existing data but immediately prevent reads and writes.
-- Restoring an eligible plan makes the preserved records available again.
drop policy if exists "own app sync records" on public.app_sync_records;
drop policy if exists app_sync_records_select_entitled on public.app_sync_records;
drop policy if exists app_sync_records_insert_entitled on public.app_sync_records;
drop policy if exists app_sync_records_update_entitled on public.app_sync_records;
drop policy if exists app_sync_records_delete_entitled on public.app_sync_records;

create policy app_sync_records_select_entitled on public.app_sync_records
  for select to authenticated
  using ((select auth.uid()) = user_id and public.can_use_cloud_sync());
create policy app_sync_records_insert_entitled on public.app_sync_records
  for insert to authenticated
  with check ((select auth.uid()) = user_id and public.can_use_cloud_sync());
create policy app_sync_records_update_entitled on public.app_sync_records
  for update to authenticated
  using ((select auth.uid()) = user_id and public.can_use_cloud_sync())
  with check ((select auth.uid()) = user_id and public.can_use_cloud_sync());
create policy app_sync_records_delete_entitled on public.app_sync_records
  for delete to authenticated
  using ((select auth.uid()) = user_id and public.can_use_cloud_sync());

revoke all on table public.app_sync_records from public, anon;
grant select, insert, update, delete on table public.app_sync_records to authenticated;
grant select, insert, update, delete on table public.app_sync_records to service_role;
