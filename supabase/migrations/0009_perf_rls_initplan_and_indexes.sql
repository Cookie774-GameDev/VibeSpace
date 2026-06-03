-- =============================================================================
-- 0009_perf_rls_initplan_and_indexes
-- =============================================================================
-- Performance hardening flagged by the Supabase advisor:
--   * auth_rls_initplan: rewrap auth.uid() as (select auth.uid()) so the
--     planner caches it once instead of re-evaluating per row.
--   * unindexed_foreign_keys: add covering indexes on FKs that miss them.

-- 1. profiles ------------------------------------------------------------------
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- 2. api_keys ------------------------------------------------------------------
drop policy if exists "own keys" on public.api_keys;
create policy "own keys" on public.api_keys
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 3. usage_log -----------------------------------------------------------------
drop policy if exists "own usage" on public.usage_log;
create policy "own usage" on public.usage_log
  for select
  using ((select auth.uid()) = user_id);

-- 4. phone_settings ------------------------------------------------------------
drop policy if exists "own phone settings" on public.phone_settings;
create policy "own phone settings" on public.phone_settings
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 5. outbound_pending ----------------------------------------------------------
drop policy if exists "own outbound pending" on public.outbound_pending;
create policy "own outbound pending" on public.outbound_pending
  for select
  using ((select auth.uid()) = user_id);

-- 6. call_audit ----------------------------------------------------------------
drop policy if exists "own call audit" on public.call_audit;
create policy "own call audit" on public.call_audit
  for select
  using ((select auth.uid()) = user_id);

-- 7. subscriptions -------------------------------------------------------------
drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions
  for select
  using ((select auth.uid()) = user_id);

-- 8. workspace-app entities (single 'own rows' policy each) -------------------
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
    execute format('drop policy if exists "own rows" on public.%I;', t);
    execute format(
      'create policy "own rows" on public.%I for all
        using ((select auth.uid()) = user_id)
        with check ((select auth.uid()) = user_id);',
      t
    );
  end loop;
end$$;

-- 9. Cover the foreign keys that lacked indexes -------------------------------
create index if not exists chats_project_idx
  on public.chats (project_id) where project_id is not null;
create index if not exists events_workspace_idx
  on public.events (workspace_id) where workspace_id is not null;
create index if not exists memories_project_idx
  on public.memories (project_id) where project_id is not null;
create index if not exists memories_workspace_idx
  on public.memories (workspace_id) where workspace_id is not null;
create index if not exists reminders_user_idx
  on public.reminders (user_id);
create index if not exists tasks_project_idx
  on public.tasks (project_id) where project_id is not null;
