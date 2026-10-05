import { useEffect } from 'react';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { NightlySecondBrainScheduler } from './nightlySecondBrainScheduler';
import {
  runNightlySecondBrain,
  isIncompleteSecondBrainCoverage,
} from './nightlySecondBrainRuntime';
import {
  getNightlySecondBrainScope,
  nightlySecondBrainScopeKey,
  useNightlySecondBrainStore,
} from './nightlySecondBrainStore';

export function NightlySecondBrainHost() {
  const cloudSession = useAuthStore((state) => state.cloudSession);
  const localUserId = useAuthStore((state) => state.localUserId);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const identity = resolveAccountIdentity({ cloudSession, localUserId });
  const scopeKey =
    identity && workspaceId
      ? nightlySecondBrainScopeKey({
          accountId: identity.accountId,
          workspaceId: String(workspaceId),
          projectId: projectId ? String(projectId) : null,
        })
      : '';

  useEffect(() => {
    if (!scopeKey) return;
    const scheduler = new NightlySecondBrainScheduler({
      now: () => new Date(),
      schedule: () => getNightlySecondBrainScope(scopeKey).config,
      canRun: () => {
        const config = getNightlySecondBrainScope(scopeKey).config;
        return config.enabled && Boolean(config.model);
      },
      lastScheduledFor: () =>
        getNightlySecondBrainScope(scopeKey).runs.reduce<number | undefined>(
          (latest, run) =>
            ((run.status === 'applied' && !isIncompleteSecondBrainCoverage(run)) ||
              run.status === 'pending_approval') &&
            (latest === undefined || run.scheduledFor > latest)
              ? run.scheduledFor
              : latest,
          undefined,
        ),
      run: async (scheduledFor) => {
        const config = getNightlySecondBrainScope(scopeKey).config;
        if (!config.enabled || !config.model) return;
        const run = await runNightlySecondBrain(scheduledFor);
        return run.status !== 'failed' && !isIncompleteSecondBrainCoverage(run);
      },
      setTimer: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimer: (timer) => globalThis.clearTimeout(timer),
    });
    const resume = () => {
      if (document.visibilityState === 'visible') scheduler.resume();
    };
    scheduler.start();
    const unsubscribe = useNightlySecondBrainStore.subscribe((state, previous) => {
      if (
        state.scopes[scopeKey]?.config !== previous.scopes[scopeKey]?.config ||
        state.scopes[scopeKey]?.runs !== previous.scopes[scopeKey]?.runs
      )
        scheduler.resume();
    });
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      unsubscribe();
      scheduler.stop();
    };
  }, [scopeKey]);
  return null;
}
