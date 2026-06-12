-- =============================================================================
-- 0018_app_admins: server-side admin list for unlimited cloud access
-- =============================================================================
-- Complements client env allowlists (VITE_JARVIS_ADMIN_*). Edge functions call
-- is_app_admin() to skip voice rate limits and call/voice budget reservations.

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  note text
);

comment on table public.app_admins is
  'Users with unlimited cloud voice/call budget and no plan paywalls in edge functions.';

alter table public.app_admins enable row level security;

-- Only service role manages rows; clients never read the table directly.
drop policy if exists app_admins_service on public.app_admins;
create policy app_admins_service on public.app_admins
  for all to service_role
  using (true)
  with check (true);

create or replace function public.is_app_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_admins where user_id = p_user_id
  );
$$;

revoke all on function public.is_app_admin(uuid) from public;
grant execute on function public.is_app_admin(uuid) to authenticated;
grant execute on function public.is_app_admin(uuid) to service_role;
