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
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  useEffect(() => {
    if (!accountId || !workspaceId || !projectId || !('__TAURI_INTERNALS__' in window)) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controllers = new Map<string, AbortController>();
    const runners = new Map<
      string,
      { revision: number; updater: Awaited<ReturnType<typeof createProductionContextAutoUpdater>> }
    >();
    const scope = (mapId: string): ContextAutoUpdateScope => ({
      accountId,
      workspaceId: String(workspaceId),
      projectId: String(projectId),
      mapId,
    });
    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, delay);
    };
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      let waiting = false;
      try {
        await openDb();
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
        const enabled = new Set(settings.map((setting) => setting.mapId));
        for (const [id, controller] of controllers)
          if (!enabled.has(id)) {
            controller.abort();
            controllers.delete(id);
            runners.delete(id);
          }
        for (const setting of settings) {
          if (stopped) break;
          let runner = runners.get(setting.mapId);
          if (!runner || runner.revision !== setting.consentRevision) {
            controllers.get(setting.mapId)?.abort();
            controllers.set(setting.mapId, new AbortController());
            runner = {
              revision: setting.consentRevision,
              updater: await createProductionContextAutoUpdater(scope(setting.mapId)),
            };
            runners.set(setting.mapId, runner);
          }
          try {
            const result = await runner.updater.tick(controllers.get(setting.mapId)!.signal);
            waiting ||= result === 'waiting';
          } catch (error) {
            if (stopped) break;
            await db.transaction('rw', db.settings, async () => {
              const key = contextAutoUpdateKey(scope(setting.mapId));
              const row = await db.settings.get(key);
              const current = row?.value as ContextAutoUpdateSetting | undefined;
              if (!current?.enabled || current.consentRevision !== setting.consentRevision) return;
              await db.settings.put({
                key,
                value: {
                  ...current,
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
        schedule(waiting ? 1_600 : 30_000);
      }
    };
    const wake = () => {
      if (!running) schedule(0);
    };
    // A user disable/change cancels immediately; ordinary persistence notifications
    // merely wake the poll and must not cancel its own guarded map publication.
    const settingsChanged = () => {
      void db.settings
        .where('key')
        .startsWith('context-auto-update-v1:')
        .toArray()
        .then((rows) => {
          if (stopped) return;
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
          for (const controller of controllers.values()) controller.abort();
        });
    };
    window.addEventListener(CONTEXT_AUTO_UPDATE_EVENT, settingsChanged);
    window.addEventListener('jarvis:context-tree-updated', settingsChanged);
    window.addEventListener('focus', wake);
    schedule(0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const controller of controllers.values()) controller.abort();
      window.removeEventListener(CONTEXT_AUTO_UPDATE_EVENT, settingsChanged);
      window.removeEventListener('jarvis:context-tree-updated', settingsChanged);
      window.removeEventListener('focus', wake);
    };
  }, [accountId, workspaceId, projectId]);
  return null;
}
