-- =============================================================================
-- Jarvis app sync records
-- =============================================================================
-- Generic local-first document sync target for desktop sync_queue mutations.

create table if not exists public.app_sync_records (
  user_id     uuid not null references auth.users(id) on delete cascade,
  table_name  text not null,
  row_id      text not null,
  op          text not null check (op in ('insert', 'update', 'delete')),
  payload     jsonb,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, table_name, row_id)
);

create index if not exists app_sync_records_user_updated_idx
  on public.app_sync_records (user_id, updated_at desc);

create index if not exists app_sync_records_user_table_idx
  on public.app_sync_records (user_id, table_name, updated_at desc);

alter table public.app_sync_records enable row level security;

drop policy if exists app_sync_records_owner on public.app_sync_records;
create policy app_sync_records_owner on public.app_sync_records
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
