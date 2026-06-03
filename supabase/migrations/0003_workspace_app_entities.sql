-- =============================================================================
-- 0003_workspace_app_entities
-- =============================================================================
-- Mirrors the frontend type definitions in app/src/types/* so client mutations
-- can sync via the existing sync_queue path. All tables use text PKs to match
-- nanoid client-generated IDs; user_id is uuid pointing at auth.users.

-- workspaces -------------------------------------------------------------------
create table if not exists public.workspaces (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists workspaces_user_idx on public.workspaces (user_id);

-- projects ---------------------------------------------------------------------
create table if not exists public.projects (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  workspace_id  text references public.workspaces(id) on delete cascade,
  name          text not null,
  description   text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists projects_user_idx on public.projects (user_id);
create index if not exists projects_workspace_idx on public.projects (workspace_id);

-- agents -----------------------------------------------------------------------
create table if not exists public.agents (
  id                 text primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  slug               text not null,
  name               text not null,
  description        text,
  system_prompt      text,
  model              jsonb not null,
  tools_allowed      jsonb not null default '["*"]'::jsonb,
  memory_scope       text check (memory_scope in ('agent','project','workspace')),
  temperature        numeric,
  max_output_tokens  integer,
  color_hue          integer,
  capabilities       jsonb not null default '[]'::jsonb,
  builtin            boolean not null default false,
  effort             text,
  effort_custom      jsonb,
  persona            text,
  skills             jsonb,
  source             text default 'builtin',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, slug)
);
create index if not exists agents_user_idx on public.agents (user_id);

-- chats ------------------------------------------------------------------------
create table if not exists public.chats (
  id                 text primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  workspace_id       text references public.workspaces(id) on delete set null,
  project_id         text references public.projects(id) on delete set null,
  title              text not null,
  mode               text not null default 'chat'
                     check (mode in ('chat','council','doc','code')),
  active_agent_ids   text[] not null default '{}',
  archived           boolean not null default false,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists chats_user_idx on public.chats (user_id, updated_at desc);
create index if not exists chats_workspace_idx on public.chats (workspace_id);

-- messages ---------------------------------------------------------------------
create table if not exists public.messages (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  chat_id     text not null references public.chats(id) on delete cascade,
  role        text not null check (role in ('user','assistant','agent','system','tool')),
  agent_id    text,
  parts       jsonb not null default '[]'::jsonb,
  parent_id   text,
  usage       jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists messages_chat_idx on public.messages (chat_id, created_at);
create index if not exists messages_user_idx on public.messages (user_id, created_at desc);

-- tasks ------------------------------------------------------------------------
create table if not exists public.tasks (
  id                       text primary key,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  workspace_id             text references public.workspaces(id) on delete set null,
  project_id               text references public.projects(id) on delete set null,
  title                    text not null,
  notes                    text,
  status                   text not null default 'open'
                           check (status in ('open','in_progress','blocked','done','cancelled')),
  priority                 text not null default 'normal'
                           check (priority in ('low','normal','high','urgent')),
  due_at                   timestamptz,
  scheduled_for            timestamptz,
  estimated_duration_min   integer,
  effort                   integer,
  context_tags             text[] not null default '{}',
  location                 text,
  energy_required          text check (energy_required in ('low','medium','high')),
  blocked_by_task_ids      text[] not null default '{}',
  created_by               text,
  source_refs              jsonb not null default '[]'::jsonb,
  agent_owner              text,
  external_ids             jsonb,
  done_at                  timestamptz,
  completion_evidence      jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists tasks_user_idx on public.tasks (user_id, status, due_at);
create index if not exists tasks_workspace_idx on public.tasks (workspace_id);

-- reminders --------------------------------------------------------------------
create table if not exists public.reminders (
  id                text primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  task_id           text not null references public.tasks(id) on delete cascade,
  fires_at          timestamptz not null,
  channels          text[] not null default '{}',
  message_override  text,
  status            text not null default 'scheduled'
                    check (status in ('scheduled','fired','snoozed','dismissed','completed')),
  snooze_history    jsonb not null default '[]'::jsonb,
  smart_reason      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists reminders_task_idx on public.reminders (task_id);
create index if not exists reminders_fires_idx on public.reminders (fires_at) where status = 'scheduled';

-- memories ---------------------------------------------------------------------
create table if not exists public.memories (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  workspace_id  text references public.workspaces(id) on delete set null,
  project_id    text references public.projects(id) on delete set null,
  agent_id      text,
  scope         text not null default 'workspace'
                check (scope in ('agent','project','workspace','global')),
  content       text not null,
  metadata      jsonb not null default '{}'::jsonb,
  embedding     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists memories_user_scope_idx on public.memories (user_id, scope);

-- events -----------------------------------------------------------------------
create table if not exists public.events (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  workspace_id  text references public.workspaces(id) on delete set null,
  title         text not null,
  description   text,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  all_day       boolean not null default false,
  location      text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists events_user_starts_idx on public.events (user_id, starts_at);

-- integrations -----------------------------------------------------------------
create table if not exists public.integrations (
  id                text primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  kind              text not null
                    check (kind in ('supabase','github','google','opencode','ollama')),
  label             text,
  config            jsonb not null default '{}'::jsonb,
  encrypted_secret  text,
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists integrations_user_idx on public.integrations (user_id);

-- quick_links ------------------------------------------------------------------
create table if not exists public.quick_links (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  group_id    text,
  label       text not null,
  url         text not null,
  icon        text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists quick_links_user_idx on public.quick_links (user_id, position);

-- terminal_sessions ------------------------------------------------------------
create table if not exists public.terminal_sessions (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  preset_id   text,
  title       text,
  cwd         text,
  command     text,
  status      text not null default 'idle',
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists terminal_sessions_user_idx on public.terminal_sessions (user_id);

-- RLS --------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'workspaces','projects','agents','chats','messages','tasks',
      'reminders','memories','events','integrations','quick_links',
      'terminal_sessions'
    ])
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "own rows" on public.%I;', t);
    execute format(
      'create policy "own rows" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id);',
      t
    );
  end loop;
end$$;

-- updated_at triggers ----------------------------------------------------------
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'workspaces','projects','agents','chats','messages','tasks',
      'reminders','memories','events','integrations','quick_links',
      'terminal_sessions'
    ])
  loop
    execute format('drop trigger if exists %I_touch_updated on public.%I;', t, t);
    execute format(
      'create trigger %I_touch_updated before update on public.%I
        for each row when (old.updated_at is not distinct from new.updated_at)
        execute function public.touch_updated_at_ts();',
      t, t
    );
  end loop;
end$$;
