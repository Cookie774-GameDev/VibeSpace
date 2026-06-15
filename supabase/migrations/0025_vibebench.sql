-- VibeBench: store batch benchmark runs and per-model scores.

create table if not exists public.vibebench_runs (
  id uuid primary key default gen_random_uuid(),
  suite_version text not null,
  git_commit text,
  status text not null default 'pending' check (status in ('pending', 'running', 'ok', 'error')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.vibebench_scores (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.vibebench_runs(id) on delete cascade,
  provider text not null,
  model text not null,
  label text,
  vibe_score numeric(6,2) not null,
  category_scores jsonb not null default '{}',
  cost_usd numeric(12,6),
  latency_p50_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.vibebench_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.vibebench_runs(id) on delete cascade,
  prompt_id text not null,
  provider text not null,
  model text not null,
  output_text text,
  score numeric(6,2),
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists vibebench_scores_run_id_idx on public.vibebench_scores(run_id);
create index if not exists vibebench_scores_vibe_score_idx on public.vibebench_scores(vibe_score desc);
create index if not exists vibebench_artifacts_run_id_idx on public.vibebench_artifacts(run_id);

alter table public.vibebench_runs enable row level security;
alter table public.vibebench_scores enable row level security;
alter table public.vibebench_artifacts enable row level security;

-- Public read for published leaderboard rows
create policy vibebench_runs_public_read on public.vibebench_runs
  for select using (status = 'ok');

create policy vibebench_scores_public_read on public.vibebench_scores
  for select using (
    exists (select 1 from public.vibebench_runs r where r.id = run_id and r.status = 'ok')
  );

create policy vibebench_artifacts_public_read on public.vibebench_artifacts
  for select using (
    exists (select 1 from public.vibebench_runs r where r.id = run_id and r.status = 'ok')
  );
