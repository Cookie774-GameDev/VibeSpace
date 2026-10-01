-- Model Foundry metadata only. Dataset content, model weights, adapters, and
-- inference logs remain local to the desktop device.

create table if not exists public.model_foundry_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_project_id text not null,
  specialist jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, local_project_id)
);

create table if not exists public.model_foundry_dataset_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.model_foundry_projects(id) on delete cascade,
  local_version_id text not null,
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, project_id, local_version_id)
);

create table if not exists public.model_foundry_training_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.model_foundry_projects(id) on delete cascade,
  local_job_id text not null,
  dataset_version_id uuid references public.model_foundry_dataset_versions(id) on delete set null,
  base_model_id text not null,
  base_revision text not null,
  state text not null check (state in ('queued', 'preparing', 'training', 'checkpointing', 'completed', 'cancelled', 'failed', 'interrupted')),
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, local_job_id)
);

create table if not exists public.model_foundry_model_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.model_foundry_projects(id) on delete cascade,
  training_job_id uuid references public.model_foundry_training_jobs(id) on delete set null,
  local_version_id text not null,
  artifact_fingerprint text not null check (artifact_fingerprint ~ '^[a-f0-9]{64}$'),
  license text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, project_id, local_version_id)
);

create table if not exists public.model_foundry_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.model_foundry_projects(id) on delete cascade,
  model_version_id uuid references public.model_foundry_model_versions(id) on delete set null,
  local_evaluation_id text not null,
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  gate_result text not null check (gate_result in ('pass', 'blocked', 'incomplete')),
  summary jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, project_id, local_evaluation_id)
);

create table if not exists public.model_foundry_deployments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.model_foundry_projects(id) on delete cascade,
  model_version_id uuid references public.model_foundry_model_versions(id) on delete set null,
  local_deployment_id text not null,
  state text not null check (state in ('active', 'paused', 'rolled_back')),
  routing_mode text not null check (routing_mode in ('manual', 'specialist_default', 'shadow')),
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, local_deployment_id)
);

create index if not exists model_foundry_projects_user_id_idx on public.model_foundry_projects(user_id);
create index if not exists model_foundry_jobs_project_id_idx on public.model_foundry_training_jobs(project_id, created_at desc);
create index if not exists model_foundry_versions_project_id_idx on public.model_foundry_model_versions(project_id, created_at desc);
create index if not exists model_foundry_evaluations_project_id_idx on public.model_foundry_evaluations(project_id, created_at desc);

create trigger model_foundry_projects_touch_updated before update on public.model_foundry_projects
  for each row execute function public.touch_updated_at_ts();
create trigger model_foundry_training_jobs_touch_updated before update on public.model_foundry_training_jobs
  for each row execute function public.touch_updated_at_ts();
create trigger model_foundry_deployments_touch_updated before update on public.model_foundry_deployments
  for each row execute function public.touch_updated_at_ts();

alter table public.model_foundry_projects enable row level security;
alter table public.model_foundry_dataset_versions enable row level security;
alter table public.model_foundry_training_jobs enable row level security;
alter table public.model_foundry_model_versions enable row level security;
alter table public.model_foundry_evaluations enable row level security;
alter table public.model_foundry_deployments enable row level security;

grant select, insert, update, delete on public.model_foundry_projects, public.model_foundry_dataset_versions, public.model_foundry_training_jobs, public.model_foundry_model_versions, public.model_foundry_evaluations, public.model_foundry_deployments to authenticated;

create policy "model_foundry_projects_owner" on public.model_foundry_projects for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "model_foundry_dataset_versions_owner" on public.model_foundry_dataset_versions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "model_foundry_training_jobs_owner" on public.model_foundry_training_jobs for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "model_foundry_model_versions_owner" on public.model_foundry_model_versions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "model_foundry_evaluations_owner" on public.model_foundry_evaluations for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "model_foundry_deployments_owner" on public.model_foundry_deployments for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
