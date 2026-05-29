-- =============================================================================
-- Jarvis V1 - initial Postgres schema
-- =============================================================================
-- This migration mirrors the Dexie tables defined in
-- `app/src/lib/db/schema.ts`. Cloud sync is optional; this schema only runs
-- on Supabase projects where the user has opted in.
--
-- Conventions:
--   * Primary keys are TEXT and supplied by the client (matching our
--     `tsk_*`, `cht_*`, `agt_*` prefix style). No server-side default.
--   * `owner_id` is a `uuid not null default auth.uid()` on every table so
--     RLS works without callers having to remember to set it.
--   * All timestamps are unix milliseconds stored as `bigint`.
--   * Complex / nested fields (parts, reminders, source_refs, capabilities,
--     external_ids, embeddings) are `jsonb`.
--   * RLS is enabled on every table with a single `for all` policy that
--     restricts both visibility and writes to rows owned by the caller.
--
-- How to apply:
--   * Supabase dashboard: open the SQL editor, paste the contents below and
--     run.
--   * Supabase CLI: `supabase db push` from the `app/` directory after
--     running `supabase link --project-ref <ref>`.
--
-- Idempotency: all DDL is `if not exists` / `or replace` so re-running this
-- file is safe.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- workspaces
-- -----------------------------------------------------------------------------
create table if not exists public.workspaces (
  id          text primary key,
  owner_id    uuid not null default auth.uid(),
  name        text not null,
  created_at  bigint not null,
  updated_at  bigint not null
);

create index if not exists workspaces_owner_idx on public.workspaces (owner_id);
create index if not exists workspaces_updated_idx on public.workspaces (updated_at desc);

alter table public.workspaces enable row level security;

drop policy if exists workspaces_owner on public.workspaces;
create policy workspaces_owner on public.workspaces
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
create table if not exists public.projects (
  id            text primary key,
  owner_id      uuid not null default auth.uid(),
  workspace_id  text not null references public.workspaces(id) on delete cascade,
  name          text not null,
  color_hue     smallint,
  created_at    bigint not null,
  updated_at    bigint not null
);

create index if not exists projects_workspace_idx on public.projects (workspace_id);
create index if not exists projects_owner_idx on public.projects (owner_id);

alter table public.projects enable row level security;

drop policy if exists projects_owner on public.projects;
create policy projects_owner on public.projects
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- chats
-- -----------------------------------------------------------------------------
create table if not exists public.chats (
  id                text primary key,
  owner_id          uuid not null default auth.uid(),
  workspace_id      text not null references public.workspaces(id) on delete cascade,
  project_id        text references public.projects(id) on delete set null,
  title             text not null,
  mode              text not null check (mode in ('chat','council','doc','code')),
  active_agent_ids  jsonb not null default '[]'::jsonb,
  archived          boolean not null default false,
  created_at        bigint not null,
  updated_at        bigint not null
);

create index if not exists chats_workspace_idx on public.chats (workspace_id);
create index if not exists chats_project_idx on public.chats (project_id);
create index if not exists chats_archived_updated_idx on public.chats (archived, updated_at desc);
create index if not exists chats_updated_idx on public.chats (updated_at desc);

alter table public.chats enable row level security;

drop policy if exists chats_owner on public.chats;
create policy chats_owner on public.chats
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
create table if not exists public.messages (
  id          text primary key,
  owner_id    uuid not null default auth.uid(),
  chat_id     text not null references public.chats(id) on delete cascade,
  role        text not null check (role in ('user','assistant','agent','system','tool')),
  agent_id    text,
  parts       jsonb not null default '[]'::jsonb,
  parent_id   text references public.messages(id) on delete set null,
  usage       jsonb,
  created_at  bigint not null,
  updated_at  bigint not null
);

create index if not exists messages_chat_idx on public.messages (chat_id);
create index if not exists messages_chat_created_idx on public.messages (chat_id, created_at);
create index if not exists messages_parent_idx on public.messages (parent_id);

alter table public.messages enable row level security;

drop policy if exists messages_owner on public.messages;
create policy messages_owner on public.messages
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- agents
-- -----------------------------------------------------------------------------
create table if not exists public.agents (
  id                  text primary key,
  owner_id            uuid not null default auth.uid(),
  slug                text not null,
  name                text not null,
  description         text not null,
  system_prompt       text not null,
  model               jsonb not null,
  tools_allowed       jsonb not null default '[]'::jsonb,
  memory_scope        text not null check (memory_scope in ('agent','project','workspace')),
  temperature         real,
  max_output_tokens   integer,
  color_hue           smallint,
  capabilities        jsonb not null default '[]'::jsonb,
  builtin             boolean not null default false,
  created_at          bigint not null,
  updated_at          bigint not null,
  unique (owner_id, slug)
);

create index if not exists agents_owner_idx on public.agents (owner_id);

alter table public.agents enable row level security;

drop policy if exists agents_owner on public.agents;
create policy agents_owner on public.agents
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- tasks
-- -----------------------------------------------------------------------------
create table if not exists public.tasks (
  id                       text primary key,
  owner_id                 uuid not null default auth.uid(),
  workspace_id             text not null references public.workspaces(id) on delete cascade,
  project_id               text references public.projects(id) on delete set null,
  title                    text not null,
  notes                    text,
  status                   text not null check (status in ('open','in_progress','blocked','done','cancelled')),
  priority                 text not null check (priority in ('low','normal','high','urgent')),
  due_at                   bigint,
  scheduled_for            bigint,
  estimated_duration_min   integer,
  effort                   smallint not null check (effort in (1,2,3,5,8,13)),
  context_tags             jsonb not null default '[]'::jsonb,
  location                 text,
  energy_required          text not null check (energy_required in ('low','medium','high')),
  blocked_by_task_ids      jsonb,
  reminders                jsonb not null default '[]'::jsonb,
  created_by               text not null check (created_by in ('user_voice','user_text','extracted_chat','extracted_meeting','agent')),
  source_refs              jsonb not null default '[]'::jsonb,
  agent_owner              text,
  external_ids             jsonb,
  done_at                  bigint,
  completion_evidence      jsonb,
  created_at               bigint not null,
  updated_at               bigint not null
);

create index if not exists tasks_workspace_idx on public.tasks (workspace_id);
create index if not exists tasks_project_idx on public.tasks (project_id);
create index if not exists tasks_status_idx on public.tasks (status);
create index if not exists tasks_status_priority_idx on public.tasks (status, priority);
create index if not exists tasks_due_idx on public.tasks (due_at);
create index if not exists tasks_scheduled_idx on public.tasks (scheduled_for);
create index if not exists tasks_workspace_status_idx on public.tasks (workspace_id, status);

alter table public.tasks enable row level security;

drop policy if exists tasks_owner on public.tasks;
create policy tasks_owner on public.tasks
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- memory_items
-- -----------------------------------------------------------------------------
create table if not exists public.memory_items (
  id                text primary key,
  owner_id          uuid not null default auth.uid(),
  workspace_id      text not null references public.workspaces(id) on delete cascade,
  project_id        text references public.projects(id) on delete set null,
  agent_id          text,
  source            text not null check (source in ('chat','voice','meeting','web','file','task','manual')),
  source_ref        jsonb not null,
  content           text not null,
  embedding         jsonb,
  tags              jsonb not null default '[]'::jsonb,
  confidence        real not null default 0.5,
  last_accessed_at  bigint,
  created_at        bigint not null,
  updated_at        bigint not null
);

create index if not exists memory_items_workspace_idx on public.memory_items (workspace_id);
create index if not exists memory_items_project_idx on public.memory_items (project_id);
create index if not exists memory_items_agent_idx on public.memory_items (agent_id);
create index if not exists memory_items_workspace_source_idx on public.memory_items (workspace_id, source);
create index if not exists memory_items_last_accessed_idx on public.memory_items (last_accessed_at desc);

alter table public.memory_items enable row level security;

drop policy if exists memory_items_owner on public.memory_items;
create policy memory_items_owner on public.memory_items
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- settings (per-user key/value)
-- -----------------------------------------------------------------------------
create table if not exists public.settings (
  owner_id    uuid not null default auth.uid(),
  key         text not null,
  value       jsonb,
  updated_at  bigint not null,
  primary key (owner_id, key)
);

alter table public.settings enable row level security;

drop policy if exists settings_owner on public.settings;
create policy settings_owner on public.settings
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- updated_at trigger helper (optional; Dexie writes this from the client,
-- but a trigger keeps server-side direct edits honest).
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = (extract(epoch from now()) * 1000)::bigint;
  return new;
end;
$$;

-- Attach the trigger to the major tables. Skips `messages` because we want
-- updated_at to reflect explicit client edits there (parts mutate often).
do $$
declare
  tbl text;
begin
  foreach tbl in array array['workspaces','projects','chats','agents','tasks','memory_items']
  loop
    execute format(
      'drop trigger if exists %I_touch_updated on public.%I;', tbl || '_touch', tbl
    );
    execute format(
      'create trigger %I_touch_updated before update on public.%I
       for each row when (old.updated_at is not distinct from new.updated_at)
       execute function public.touch_updated_at();',
      tbl || '_touch', tbl
    );
  end loop;
end$$;
