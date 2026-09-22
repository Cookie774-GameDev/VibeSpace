import { snapshotEvidenceHash } from './targetSnapshot';
import type { CaoSentinelTrigger, CaoTargetSnapshot } from './types';

type SchedulerKey = string;

export function createCaoSentinelScheduler(input: {
  observe: (snapshot: CaoTargetSnapshot, trigger: CaoSentinelTrigger) => Promise<void> | void;
  debounceMs?: number;
  sweepMs?: number;
  now?: () => number;
}) {
  const debounceMs = input.debounceMs ?? 500;
  const sweepMs = input.sweepMs ?? 30_000;
  const now = input.now ?? Date.now;
  const timers = new Map<SchedulerKey, ReturnType<typeof setTimeout>>();
  const fingerprints = new Map<SchedulerKey, string>();
  const inFlight = new Map<SchedulerKey, Promise<void>>();
  const pending = new Map<SchedulerKey, { snapshot: CaoTargetSnapshot; trigger: CaoSentinelTrigger }>();
  let epoch = 0;
  let disposed = false;

  const keyOf = (snapshot: CaoTargetSnapshot): SchedulerKey =>
    `${snapshot.accountId}\u0000${snapshot.workspaceId}\u0000${snapshot.missionId}\u0000${snapshot.targetId}`;

  const run = async (
    snapshot: CaoTargetSnapshot,
    trigger: CaoSentinelTrigger,
    runEpoch: number,
  ): Promise<void> => {
    if (disposed || runEpoch !== epoch) return;
    const key = keyOf(snapshot);
    const active = inFlight.get(key);
    if (active) {
      pending.set(key, { snapshot, trigger });
      await active;
      return;
    }
    const operation = Promise.resolve()
      .then(() => input.observe(snapshot, trigger))
      .then(() => {
        if (!disposed && runEpoch === epoch) fingerprints.set(key, snapshotEvidenceHash(snapshot));
      })
      .catch(() => {
        // Sentinel observation is advisory. A failed observation is retried by
        // the next event/sweep and never becomes an unhandled rejection.
      })
      .finally(() => {
        if (inFlight.get(key) === operation) inFlight.delete(key);
      });
    inFlight.set(key, operation);
    await operation;
    const next = pending.get(key);
    if (next && !disposed && runEpoch === epoch) {
      pending.delete(key);
      await run(next.snapshot, next.trigger, runEpoch);
    }
  };

  const schedule = (snapshot: CaoTargetSnapshot, trigger: CaoSentinelTrigger) => {
    if (disposed) return;
    const key = keyOf(snapshot);
    const current = timers.get(key);
    if (current) clearTimeout(current);
    const scheduledEpoch = epoch;
    const timer = setTimeout(() => {
      timers.delete(key);
      void run(snapshot, trigger, scheduledEpoch);
    }, debounceMs);
    timers.set(key, timer);
  };

  return Object.freeze({
    notify(snapshot: CaoTargetSnapshot, trigger: CaoSentinelTrigger): void {
      schedule(snapshot, trigger);
    },
    async sweep(snapshots: readonly CaoTargetSnapshot[]): Promise<void> {
      if (disposed) return;
      const timestamp = now();
      for (const snapshot of snapshots) {
        if (disposed) return;
        const key = keyOf(snapshot);
        const fingerprint = snapshotEvidenceHash(snapshot);
        const activeAge = Math.max(0, timestamp - snapshot.lastActivityAt);
        const unchanged = fingerprints.get(key) === fingerprint;
        if (inFlight.has(key)) {
          pending.set(key, { snapshot, trigger: 'sweep' });
          continue;
        }
        if (unchanged && snapshot.runStatus === 'running' && snapshot.errors.length === 0 && activeAge < sweepMs) continue;
        if (snapshot.runStatus === 'running' && snapshot.errors.length === 0 && activeAge < sweepMs && !unchanged) {
          continue;
        }
        await run(snapshot, 'sweep', epoch);
      }
    },
    dispose(): void {
      disposed = true;
      epoch += 1;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      fingerprints.clear();
      pending.clear();
    },
  });
}
