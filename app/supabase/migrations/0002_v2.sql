-- =============================================================================
-- Jarvis V2 - additive Postgres migration
-- =============================================================================
-- Mirrors the Dexie v2 additions in `app/src/lib/db/schema.ts`. Cloud sync is
-- optional; this migration only runs on Supabase projects where the user has
-- opted in.
--
-- Conventions match 0001_initial.sql:
--   * `owner_id uuid not null default auth.uid()` on every new table
--   * Text primary keys supplied by the client (`evt_*`, `qlk_*`, `qlg_*`,
--     `tpr_*`, `tss_*`, `int_*`)
--   * Timestamps as bigint (unix ms)
--   * Complex/nested fields as jsonb
--   * RLS enabled with single owner-scoped `for all` policy per table
--   * `if not exists` / `or replace` so re-running this file is safe
--
-- How to apply:
--   * Supabase dashboard SQL editor: paste and run.
--   * Supabase CLI: `supabase db push` after `supabase link`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- agents - additive columns for V2
-- -----------------------------------------------------------------------------
alter table public.agents
  add column if not exists effort text not null default 'medium'
  check (effort in ('minimal','low','medium','high','max','custom'));

alter table public.agents
  add column if not exists effort_custom jsonb;

alter table public.agents
  add column if not exists persona text not null default 'jarvis'
  check (persona in ('jarvis','athena','edge','watson','hal','custom'));

alter table public.agents
  add column if not exists skills jsonb not null default '[]'::jsonb;

alter table public.agents
  add column if not exists source text not null default 'builtin'
  check (source in ('builtin','user-md','user-form'));

-- -----------------------------------------------------------------------------
-- events
-- -----------------------------------------------------------------------------
create table if not exists public.events (
  id              text primary key,
  owner_id        uuid not null default auth.uid(),
  workspace_id    text not null references public.workspaces(id) on delete cascade,
  project_id      text references public.projects(id) on delete set null,
  title           text not null,
  description     text,
  start_at        bigint not null,
  end_at          bigint not null,
  all_day         boolean not null default false,
  timezone        text not null,
  location        text,
  attendees       jsonb not null default '[]'::jsonb,
  source          text not null check (source in ('manual','voice','ai','google','extracted')),
  source_ref      jsonb,
  recurrence_rule text,
  reminders       jsonb not null default '[]'::jsonb,
  status          text not null default 'scheduled'
                  check (status in ('scheduled','tentative','cancelled','done')),
  color_hue       smallint,
  created_by      text not null,
  created_at      bigint not null,
  updated_at      bigint not null
);
create index if not exists events_workspace_idx       on public.events (workspace_id);
create index if not exists events_project_idx          on public.events (project_id);
create index if not exists events_start_idx            on public.events (start_at);
create index if not exists events_workspace_start_idx  on public.events (workspace_id, start_at);
create index if not exists events_status_idx           on public.events (status);

alter table public.events enable row level security;
drop policy if exists events_owner on public.events;
create policy events_owner on public.events
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- terminal_presets
-- Built-in presets live in code only; this table holds user-defined entries
-- (and overrides of built-ins). Uniqueness scoped to (owner, workspace, slug).
-- -----------------------------------------------------------------------------
create table if not exists public.terminal_presets (
  id            text primary key,
  owner_id      uuid not null default auth.uid(),
  workspace_id  text not null references public.workspaces(id) on delete cascade,
  name          text not null,
  slug          text not null,
  command       text not null,
  args          jsonb not null default '[]'::jsonb,
  env           jsonb not null default '{}'::jsonb,
  cwd           text,
  color_hue     smallint,
  icon          text,
  one_shot      boolean not null default false,
  auto_run      boolean not null default false,
  requires      text,
  user_defined  boolean not null default true,
  created_at    bigint not null,
  updated_at    bigint not null,
  unique (owner_id, workspace_id, slug)
);
create index if not exists terminal_presets_workspace_idx on public.terminal_presets (workspace_id);

alter table public.terminal_presets enable row level security;
drop policy if exists terminal_presets_owner on public.terminal_presets;
create policy terminal_presets_owner on public.terminal_presets
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- terminal_sessions
-- Denormalized columns (preset_slug, shell_command, shell_args) keep the
-- session usable after the originating preset is deleted.
-- -----------------------------------------------------------------------------
create table if not exists public.terminal_sessions (
  id              text primary key,
  owner_id        uuid not null default auth.uid(),
  workspace_id    text not null references public.workspaces(id) on delete cascade,
  project_id      text references public.projects(id) on delete set null,
  title           text not null,
  preset_id       text references public.terminal_presets(id) on delete set null,
  preset_slug     text,
  shell_command   text not null,
  shell_args      jsonb not null default '[]'::jsonb,
  status          text not null check (status in ('running','detached','exited')),
  pid             integer,
  cols            integer not null default 80,
  rows            integer not null default 24,
  cwd             text,
  env             jsonb,
  exit_code       integer,
  one_shot        boolean not null default false,
  created_at      bigint not null,
  last_active_at  bigint not null
);
create index if not exists terminal_sessions_project_idx        on public.terminal_sessions (project_id);
create index if not exists terminal_sessions_workspace_idx      on public.terminal_sessions (workspace_id);
create index if not exists terminal_sessions_status_idx         on public.terminal_sessions (status);
create index if not exists terminal_sessions_project_status_idx on public.terminal_sessions (project_id, status);
create index if not exists terminal_sessions_active_idx         on public.terminal_sessions (last_active_at desc);

alter table public.terminal_sessions enable row level security;
drop policy if exists terminal_sessions_owner on public.terminal_sessions;
create policy terminal_sessions_owner on public.terminal_sessions
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- terminal_scrollback (compound key)
-- -----------------------------------------------------------------------------
create table if not exists public.terminal_scrollback (
  session_id  text not null references public.terminal_sessions(id) on delete cascade,
  chunk_seq   integer not null,
  owner_id    uuid not null default auth.uid(),
  data        text not null,           -- base64
  created_at  bigint not null,
  primary key (session_id, chunk_seq)
);
create index if not exists terminal_scrollback_session_idx on public.terminal_scrollback (session_id);
create index if not exists terminal_scrollback_created_idx on public.terminal_scrollback (created_at desc);

alter table public.terminal_scrollback enable row level security;
drop policy if exists terminal_scrollback_owner on public.terminal_scrollback;
create policy terminal_scrollback_owner on public.terminal_scrollback
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- terminal_layouts (project-scoped). One row per project.
-- fullscreen_session_id supports the V2 fullscreen view_mode (Mod+Shift+F).
-- -----------------------------------------------------------------------------
create table if not exists public.terminal_layouts (
  project_id              text primary key references public.projects(id) on delete cascade,
  owner_id                uuid not null default auth.uid(),
  view_mode               text not null default 'grid'
                          check (view_mode in ('single','grid','tabs','fullscreen')),
  layout_id               text not null default '1',
  pane_assignments        jsonb not null default '{}'::jsonb,
  panel_sizes             jsonb not null default '{}'::jsonb,
  fullscreen_session_id   text,
  updated_at              bigint not null
);
create index if not exists terminal_layouts_updated_idx on public.terminal_layouts (updated_at desc);

alter table public.terminal_layouts enable row level security;
drop policy if exists terminal_layouts_owner on public.terminal_layouts;
create policy terminal_layouts_owner on public.terminal_layouts
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- quick_link_groups (must exist before quick_links FK)
-- -----------------------------------------------------------------------------
create table if not exists public.quick_link_groups (
  id            text primary key,
  owner_id      uuid not null default auth.uid(),
  workspace_id  text not null references public.workspaces(id) on delete cascade,
  name          text not null,
  color_hue     smallint,
  position      integer not null default 0,
  created_at    bigint not null,
  updated_at    bigint not null
);
create index if not exists qlg_workspace_idx on public.quick_link_groups (workspace_id);

alter table public.quick_link_groups enable row level security;
drop policy if exists qlg_owner on public.quick_link_groups;
create policy qlg_owner on public.quick_link_groups
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- quick_links
-- -----------------------------------------------------------------------------
create table if not exists public.quick_links (
  id            text primary key,
  owner_id      uuid not null default auth.uid(),
  workspace_id  text not null references public.workspaces(id) on delete cascade,
  project_id    text references public.projects(id) on delete set null,
  group_id      text references public.quick_link_groups(id) on delete set null,
  label         text not null,
  url           text not null,
  kind          text not null
                check (kind in ('web','youtube','youtube-playlist','spotify','soundcloud','app','file','jarvis-action')),
  icon          text,
  color_hue     smallint,
  behavior      text not null default 'external_browser'
                check (behavior in ('external_browser','in_app_player','pip_window','side_panel')),
  hotkey        text,
  position      integer not null default 0,
  tags          jsonb not null default '[]'::jsonb,
  last_used_at  bigint,
  created_at    bigint not null,
  updated_at    bigint not null
);
create index if not exists ql_workspace_idx           on public.quick_links (workspace_id);
create index if not exists ql_workspace_position_idx  on public.quick_links (workspace_id, position);
create index if not exists ql_workspace_group_pos_idx on public.quick_links (workspace_id, group_id, position);
create index if not exists ql_last_used_idx           on public.quick_links (last_used_at desc nulls last);

alter table public.quick_links enable row level security;
drop policy if exists ql_owner on public.quick_links;
create policy ql_owner on public.quick_links
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- integrations
-- One row per (owner, kind) — at most one Supabase, one GitHub, etc per user.
-- -----------------------------------------------------------------------------
create table if not exists public.integrations (
  id              text primary key,
  owner_id        uuid not null default auth.uid(),
  kind            text not null check (kind in ('supabase','github','google','opencode','ollama')),
  status          text not null default 'disconnected'
                  check (status in ('disconnected','connecting','connected','error')),
  config_json     jsonb not null default '{}'::jsonb,
  secret_ref      text,
  scopes_json     jsonb not null default '[]'::jsonb,
  last_synced_at  bigint,
  expires_at      bigint,
  error_message   text,
  created_at      bigint not null,
  updated_at      bigint not null,
  unique (owner_id, kind)
);
create index if not exists integrations_kind_idx   on public.integrations (kind);
create index if not exists integrations_status_idx on public.integrations (status);

alter table public.integrations enable row level security;
drop policy if exists integrations_owner on public.integrations;
create policy integrations_owner on public.integrations
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- updated_at trigger on the new tables (mirrors 0001_initial.sql).
-- terminal_scrollback skipped (append-only) and terminal_layouts skipped
-- (single row per project, edits always set updated_at explicitly).
-- -----------------------------------------------------------------------------
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'events',
    'terminal_presets',
    'terminal_sessions',
    'quick_link_groups',
    'quick_links',
    'integrations'
  ]
  loop
    execute format('drop trigger if exists %I_touch_updated on public.%I;', tbl || '_touch', tbl);
    execute format(
      'create trigger %I_touch_updated before update on public.%I
       for each row when (old.updated_at is not distinct from new.updated_at)
       execute function public.touch_updated_at();',
      tbl || '_touch', tbl
    );
  end loop;
end$$;
