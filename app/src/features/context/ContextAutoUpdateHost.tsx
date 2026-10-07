import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { db, openDb } from '@/lib/db';
import {
  CONTEXT_AUTO_UPDATE_EVENT,
  contextAutoUpdateKey,
  createProductionContextAutoUpdater,
  type ContextAutoUpdateScope,
  type ContextAutoUpdateSetting,
} from './contextAutoUpdate';
import { devConsole } from '@/features/dev-console';

/** Saved physical files only. Runs while the app is open, including after restart. */
export function ContextAutoUpdateHost() {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? null);
  const accountSource = useAuthStore((state) => resolveAccountIdentity(state)?.source ?? null);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  useEffect(() => {
    if (!accountId || !workspaceId || !projectId || !('__TAURI_INTERNALS__' in window)) return;
    let stopped = false;
    let running = false;
    let scopeEpoch = 0;
    const authScopeKey = (state: ReturnType<typeof useAuthStore.getState>) => {
      const identity = resolveAccountIdentity(state);
      return JSON.stringify([
        identity?.accountId ?? null,
        identity?.source ?? null,
        state.workspaceId,
        state.projectId,
      ]);
    };
    const expectedScopeKey = JSON.stringify([accountId, accountSource, workspaceId, projectId]);
    const current = (epoch = scopeEpoch) =>
      !stopped &&
      epoch === scopeEpoch &&
      authScopeKey(useAuthStore.getState()) === expectedScopeKey;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controllers = new Map<string, AbortController>();
    const runners = new Map<
      string,
      { revision: number; updater?: Awaited<ReturnType<typeof createProductionContextAutoUpdater>> }
    >();
    const scope = (mapId: string): ContextAutoUpdateScope => ({
      accountId,
      workspaceId: String(workspaceId),
      projectId: String(projectId),
      mapId,
    });
    const schedule = (delay: number) => {
      if (!current()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, delay);
    };
    const tick = async () => {
      if (!current() || running) return;
      const epoch = scopeEpoch;
      running = true;
      let waiting = false;
      try {
        await openDb();
        if (!current(epoch)) return;
        const settings = (
          await db.settings.where('key').startsWith('context-auto-update-v1:').toArray()
        )
          .map((row) => row.value as ContextAutoUpdateSetting)
          .filter(
            (setting) =>
              setting.kind === 'context-auto-update-v1' &&
              setting.enabled &&
              setting.accountId === accountId &&
              setting.workspaceId === String(workspaceId) &&
              setting.projectId === String(projectId),
          );
        if (!current(epoch)) return;
        const enabled = new Set(settings.map((setting) => setting.mapId));
        for (const [id, controller] of controllers)
          if (!enabled.has(id)) {
            controller.abort();
            controllers.delete(id);
            runners.delete(id);
          }
        for (const setting of settings) {
          if (!current(epoch)) break;
          let runner = runners.get(setting.mapId);
          if (!runner?.updater || runner.revision !== setting.consentRevision) {
            controllers.get(setting.mapId)?.abort();
            const controller = new AbortController();
            controllers.set(setting.mapId, controller);
            // Track initialization too, so disabling this setting can revoke it.
            runners.set(setting.mapId, { revision: setting.consentRevision });
            const updater = await createProductionContextAutoUpdater(scope(setting.mapId));
            if (
              !current(epoch) ||
              controller.signal.aborted ||
              controllers.get(setting.mapId) !== controller
            )
              break;
            runner = { revision: setting.consentRevision, updater };
            runners.set(setting.mapId, runner);
          }
          const controller = controllers.get(setting.mapId);
          if (!controller || controller.signal.aborted || !runner.updater) continue;
          try {
            const result = await runner.updater.tick(controller.signal);
            waiting ||= result === 'waiting';
          } catch (error) {
            if (!current(epoch) || controller.signal.aborted) break;
            await db.transaction('rw', db.settings, async () => {
              const key = contextAutoUpdateKey(scope(setting.mapId));
              const row = await db.settings.get(key);
              const saved = row?.value as ContextAutoUpdateSetting | undefined;
              if (
                !current(epoch) ||
                controller.signal.aborted ||
                !saved?.enabled ||
                saved.consentRevision !== setting.consentRevision
              )
                return;
              await db.settings.put({
                key,
                value: {
                  ...saved,
                  status: 'failed',
                  error: error instanceof Error ? error.message : 'context_auto_update_failed',
                },
                updated_at: Date.now(),
              });
            });
            window.dispatchEvent(new Event(CONTEXT_AUTO_UPDATE_EVENT));
          }
        }
      } catch (error) {
        if (!current(epoch)) return;
        devConsole.log({
          channel: 'ai',
          level: 'warn',
          message: 'Automatic Context map polling needs review',
          detail: {
            error: error instanceof Error ? error.message : 'context_auto_update_poll_failed',
          },
        });
      } finally {
        running = false;
        schedule(epoch !== scopeEpoch ? 0 : waiting ? 1_600 : 30_000);
      }
    };
    const wake = () => {
      if (!running) schedule(0);
    };
    // A user disable/change cancels immediately; ordinary persistence notifications
    // merely wake the poll and must not cancel its own guarded map publication.
    const settingsChanged = () => {
      const epoch = scopeEpoch;
      void db.settings
        .where('key')
        .startsWith('context-auto-update-v1:')
        .toArray()
        .then((rows) => {
          if (!current(epoch)) return;
          for (const [id, runner] of runners) {
            const setting = rows.find((row) => row.key === contextAutoUpdateKey(scope(id)))
              ?.value as ContextAutoUpdateSetting | undefined;
            if (!setting?.enabled || setting.consentRevision !== runner.revision) {
              controllers.get(id)?.abort();
              controllers.delete(id);
              runners.delete(id);
            }
          }
          wake();
        })
        .catch(() => {
          if (!current(epoch)) return;
          for (const controller of controllers.values()) controller.abort();
          // A later successful poll must not reuse these revoked lifetimes.
          controllers.clear();
          runners.clear();
        });
    };
    // React can batch A -> B -> A into one render. Revoke old work synchronously
    // at the auth-store boundary instead of waiting for effect cleanup.
    const unsubscribe = useAuthStore.subscribe((next, previous) => {
      if (authScopeKey(next) === authScopeKey(previous)) return;
      scopeEpoch += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      runners.clear();
      wake();
    });
    window.addEventListener(CONTEXT_AUTO_UPDATE_EVENT, settingsChanged);
    window.addEventListener('jarvis:context-tree-updated', settingsChanged);
    window.addEventListener('focus', wake);
    schedule(0);
    return () => {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      for (const controller of controllers.values()) controller.abort();
      window.removeEventListener(CONTEXT_AUTO_UPDATE_EVENT, settingsChanged);
      window.removeEventListener('jarvis:context-tree-updated', settingsChanged);
      window.removeEventListener('focus', wake);
    };
  }, [accountId, accountSource, workspaceId, projectId]);
  return null;
}
