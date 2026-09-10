-- Owner-authorized permanent access for users present when this migration runs.
-- No signup trigger: future users retain the ordinary wallpaper policy.
create table public.wallpaper_access_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  reason text not null default 'owner_authorized_current_users'
);
alter table public.wallpaper_access_grants enable row level security;
revoke all on public.wallpaper_access_grants from public, anon, authenticated;
grant select, insert, update, delete on public.wallpaper_access_grants to service_role;
insert into public.wallpaper_access_grants (user_id) select id from auth.users;
CREATE OR REPLACE FUNCTION public.user_wallpaper_access(p_user_id uuid)
 RETURNS TABLE(access_mode text, plan text, status text, period_end timestamp with time zone, is_admin boolean, orbit_wallpaper_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan text := 'free';
  v_status text := 'inactive';
  v_end timestamptz := null;
  v_admin boolean := false;
  v_mode text;
  v_grace interval := interval '72 hours';
begin
  v_admin := exists (select 1 from public.app_admins a where a.user_id = p_user_id);

  select s.plan, s.status, s.current_period_end
    into v_plan, v_status, v_end
  from public.subscriptions s
  where s.user_id = p_user_id
  order by
    case s.status when 'active' then 0 when 'trialing' then 1 else 2 end,
    s.current_period_end desc nulls last
  limit 1;

  if v_admin then
    v_mode := 'full_catalog';
  elsif lower(coalesce(v_status, '')) in ('active', 'trialing') then
    v_mode := public.wallpaper_plan_access_mode(v_plan, false);
  elsif v_end is not null and now() <= v_end + v_grace then
    v_mode := public.wallpaper_plan_access_mode(v_plan, false);
  else
    v_mode := 'none';
  end if;

  -- Permanent wallpaper grants are independent of subscription and admin rights.
  if exists (select 1 from public.wallpaper_access_grants g where g.user_id = p_user_id) then
    v_mode := 'full_catalog';
    -- Existing clients resolve wallpaper-only access from these fields.
    v_plan := 'pro';
    v_status := 'active';
    v_end := null;
  end if;

  return query
  select
    v_mode,
    coalesce(v_plan, 'free'),
    coalesce(v_status, 'inactive'),
    v_end,
    v_admin,
    coalesce(
      (select array_agg(o.wallpaper_id order by o.slot_number)
       from public.orbit_wallpaper_slots o
       where o.user_id = p_user_id),
      '{}'::uuid[]
    );
end;
$function$;
comment on table public.wallpaper_access_grants is 'Permanent wallpaper-only grants; no subscription, billing or admin changes.';
