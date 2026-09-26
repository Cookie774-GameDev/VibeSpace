import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { db, type JarvisDexie } from '@/lib/db';
import { eventRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/stores/auth';
import type { EventRow } from '@/types/event';

import { parseJarvisScheduleMetadata } from '@/features/schedule/jarvisSchedules';
import {
  createCaoScheduledLearningController,
  parseCaoScheduledLearningSnapshot,
  type CaoLearningExecutionInput,
  type CaoLearningExecutionResult,
  type CaoLearningTrigger,
  type CaoScheduledLearningPersistence,
  type CaoScheduledLearningRunResult,
  type CaoScheduledLearningScope,
} from './caoScheduledLearning';
import { useJarvisLearningStore } from './learningStore';
import { executeProductionCaoLearning } from './caoLearningProduction';

export type CaoScheduledLearningRuntimeState =
  'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CaoScheduledLearningRuntimeStatus {
  state: CaoScheduledLearningRuntimeState;
  trigger?: CaoLearningTrigger;
  scope?: CaoScheduledLearningScope;
  updatedAt?: number;
}

export interface CaoScheduledLearningRuntimeInput {
  scope: CaoScheduledLearningScope;
  trigger: CaoLearningTrigger;
  requestId?: string;
  scheduledDueAt?: number;
}

interface CaoScheduledLearningRuntimeDeps {
  persistence: CaoScheduledLearningPersistence;
  journalHighWater(scope: CaoScheduledLearningScope): Promise<number> | number;
  execute(
    input: CaoLearningExecutionInput,
    signal: AbortSignal,
  ): Promise<CaoLearningExecutionResult>;
  now?: () => number;
  newPassId?: () => string;
  newRequestId?: () => string;
}

function scopeKey(scope: CaoScheduledLearningScope): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    scope.projectId,
    scope.scheduleId,
    scope.targetId,
    scope.scheduleAnchorAt,
  ]);
}

function requestKey(input: CaoScheduledLearningRuntimeInput, requestId: string): string {
  return `${scopeKey(input.scope)}\u0000${input.trigger}\u0000${requestId}\u0000${input.scheduledDueAt ?? ''}`;
}

export function createCaoScheduledLearningRuntime(deps: CaoScheduledLearningRuntimeDeps) {
  const now = deps.now ?? Date.now;
  const controllers = new Map<string, ReturnType<typeof createCaoScheduledLearningController>>();
  const aborters = new Map<string, AbortController>();
  const inFlight = new Map<string, Promise<CaoScheduledLearningRunResult>>();
  const scopeQueues = new Map<string, Promise<void>>();
  const cancellationGenerations = new Map<string, number>();
  const operationGenerations = new Map<string, number>();
  const listeners = new Set<(status: CaoScheduledLearningRuntimeStatus) => void>();
  let status: CaoScheduledLearningRuntimeStatus = { state: 'idle' };

  const publish = (next: CaoScheduledLearningRuntimeStatus) => {
    status = next;
    for (const listener of listeners) listener(status);
  };

  const controllerFor = (scope: CaoScheduledLearningScope) => {
    const key = scopeKey(scope);
    const existing = controllers.get(key);
    if (existing) return existing;
    const created = createCaoScheduledLearningController({
      persistence: deps.persistence,
      now,
      newPassId: deps.newPassId,
      execute: async (input) => {
        if (operationGenerations.get(key) !== (cancellationGenerations.get(key) ?? 0)) {
          return { status: 'cancelled' };
        }
        const aborter = new AbortController();
        aborters.set(key, aborter);
        try {
          return await deps.execute(input, aborter.signal);
        } finally {
          if (aborters.get(key) === aborter) aborters.delete(key);
        }
      },
    });
    controllers.set(key, created);
    return created;
  };

  const settleStatus = (
    result: CaoScheduledLearningRunResult,
    input: { scope: CaoScheduledLearningScope; trigger: CaoLearningTrigger },
  ) => {
    publish({ state: result.status, trigger: input.trigger, scope: input.scope, updatedAt: now() });
    return result;
  };

  const cancelledWithoutExecution = async (
    scope: CaoScheduledLearningScope,
  ): Promise<CaoScheduledLearningRunResult> => {
    let cursor = 0;
    let scheduledOccurrenceCount = 0;
    try {
      const snapshot = parseCaoScheduledLearningSnapshot(await deps.persistence.load(scope));
      if (
        snapshot &&
        snapshot.accountId === scope.accountId &&
        snapshot.workspaceId === scope.workspaceId &&
        snapshot.projectId === scope.projectId &&
        snapshot.scheduleId === scope.scheduleId &&
        snapshot.targetId === scope.targetId &&
        snapshot.scheduleAnchorAt === scope.scheduleAnchorAt
      ) {
        cursor = snapshot.lastLearningSeqConsumed;
        scheduledOccurrenceCount = snapshot.scheduledOccurrenceCount;
      }
    } catch {
      // Cancellation remains truthful even if its read-only status snapshot is unavailable.
    }
    return {
      status: 'cancelled',
      passId: null,
      consumed: { fromSeqExclusive: cursor, throughSeqInclusive: cursor },
      scheduledOccurrenceCount,
      deduplicated: false,
    };
  };

  const enqueue = <T>(
    scope: CaoScheduledLearningScope,
    generation: number,
    operation: () => Promise<T>,
    onCancelled: () => Promise<T>,
  ): Promise<T> => {
    const key = scopeKey(scope);
    const previous = scopeQueues.get(key) ?? Promise.resolve();
    const start = async () => {
      if (generation !== (cancellationGenerations.get(key) ?? 0)) return onCancelled();
      operationGenerations.set(key, generation);
      try {
        return await operation();
      } finally {
        if (operationGenerations.get(key) === generation) operationGenerations.delete(key);
      }
    };
    const pending = previous.then(start, start);
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    scopeQueues.set(key, tail);
    void tail.finally(() => {
      if (scopeQueues.get(key) === tail) scopeQueues.delete(key);
    });
    return pending;
  };

  const run = (input: CaoScheduledLearningRuntimeInput) => {
    const requestId = input.requestId ?? deps.newRequestId?.();
    if (!requestId) return Promise.reject(new Error('cao_learning_request_id_unavailable'));
    const key = requestKey(input, requestId);
    const active = inFlight.get(key);
    if (active) return active;
    const generation = cancellationGenerations.get(scopeKey(input.scope)) ?? 0;
    publish({ state: 'running', trigger: input.trigger, scope: input.scope, updatedAt: now() });
    const pending = enqueue(
      input.scope,
      generation,
      async () => {
        const journalHighWaterSeq = await deps.journalHighWater(input.scope);
        return controllerFor(input.scope).run({
          ...input.scope,
          trigger: input.trigger,
          requestId,
          journalHighWaterSeq,
          ...(input.trigger === 'scheduled' ? { scheduledDueAt: input.scheduledDueAt } : {}),
        });
      },
      () => cancelledWithoutExecution(input.scope),
    )
      .then((result) => settleStatus(result, input))
      .catch((error) => {
        publish({ state: 'failed', trigger: input.trigger, scope: input.scope, updatedAt: now() });
        throw error;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };

  const recover = async (scope: CaoScheduledLearningScope) => {
    let recoveryTrigger: CaoLearningTrigger | undefined;
    try {
      const snapshot = parseCaoScheduledLearningSnapshot(await deps.persistence.load(scope));
      if (
        snapshot &&
        snapshot.accountId === scope.accountId &&
        snapshot.workspaceId === scope.workspaceId &&
        snapshot.projectId === scope.projectId &&
        snapshot.scheduleId === scope.scheduleId &&
        snapshot.targetId === scope.targetId &&
        snapshot.scheduleAnchorAt === scope.scheduleAnchorAt
      ) {
        recoveryTrigger = snapshot.pending?.trigger;
      }
    } catch {
      // The controller performs the authoritative load and stable error mapping below.
    }
    publish({ state: 'running', trigger: recoveryTrigger, scope, updatedAt: now() });
    try {
      const generation = cancellationGenerations.get(scopeKey(scope)) ?? 0;
      const result = await enqueue(
        scope,
        generation,
        () => controllerFor(scope).recover(scope),
        () => cancelledWithoutExecution(scope),
      );
      if (!result) {
        publish({ state: 'idle', scope, updatedAt: now() });
        return null;
      }
      return settleStatus(result, { scope, trigger: recoveryTrigger ?? 'scheduled' });
    } catch (error) {
      publish({ state: 'failed', scope, updatedAt: now() });
      throw error;
    }
  };

  return {
    run,
    recover,
    cancel(scope?: CaoScheduledLearningScope) {
      const cancelKey = (key: string) => {
        cancellationGenerations.set(key, (cancellationGenerations.get(key) ?? 0) + 1);
        aborters.get(key)?.abort();
      };
      if (scope) cancelKey(scopeKey(scope));
      else {
        const keys = new Set([...controllers.keys(), ...scopeQueues.keys(), ...aborters.keys()]);
        for (const key of keys) cancelKey(key);
      }
    },
    getStatus: () => status,
    subscribe(listener: (next: CaoScheduledLearningRuntimeStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function persistenceKey(scope: CaoScheduledLearningScope): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('cao_learning_crypto_unavailable');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(scopeKey(scope)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `cao-scheduled-learning-v1:${hex}`;
}

export function createCaoScheduledLearningDexiePersistence(
  database: JarvisDexie = db,
): CaoScheduledLearningPersistence {
  return {
    async load(scope) {
      const row = await database.settings.get(await persistenceKey(scope));
      return row?.value;
    },
    async save({ expectedRevision, snapshot }) {
      const key = await persistenceKey(snapshot);
      await database.transaction('rw', database.settings, async () => {
        const existing = await database.settings.get(key);
        const revision =
          existing?.value && typeof existing.value === 'object'
            ? Number((existing.value as { revision?: unknown }).revision ?? 0)
            : 0;
        if (revision !== expectedRevision) throw new Error('cao_learning_revision_conflict');
        await database.settings.put({
          key,
          value: structuredClone(snapshot),
          updated_at: Date.now(),
        });
      });
    },
  };
}

function productionHighWater(scope: CaoScheduledLearningScope): number {
  const state = useJarvisLearningStore.getState();
  if (state.activeAccountId !== scope.accountId) throw new Error('cao_learning_account_mismatch');
  return state.currentProfile().meaningfulMessageCount;
}

async function productionExecute(
  input: CaoLearningExecutionInput,
  signal: AbortSignal,
): Promise<CaoLearningExecutionResult> {
  return executeProductionCaoLearning(input, signal);
}

const productionRuntime = createCaoScheduledLearningRuntime({
  persistence: createCaoScheduledLearningDexiePersistence(),
  journalHighWater: productionHighWater,
  execute: async (input, signal) => {
    try {
      return await productionExecute(input, signal);
    } catch (error) {
      return error instanceof DOMException && error.name === 'AbortError'
        ? { status: 'cancelled' }
        : { status: 'failed' };
    }
  },
  newRequestId: () => `cao_request_${globalThis.crypto.randomUUID()}`,
});

export const runCaoScheduledLearning = productionRuntime.run;
export const recoverCaoScheduledLearning = productionRuntime.recover;
export const cancelCaoScheduledLearning = productionRuntime.cancel;
export const getCaoScheduledLearningStatus = productionRuntime.getStatus;
export const subscribeCaoScheduledLearningStatus = productionRuntime.subscribe;

function scopeForEvent(
  accountId: string,
  workspaceId: string,
  event: EventRow,
): CaoScheduledLearningScope | null {
  const cao = parseJarvisScheduleMetadata(event)?.caoSupervision;
  if (
    !cao ||
    String(event.workspace_id) !== workspaceId ||
    String(event.project_id ?? '') !== cao.projectId
  ) {
    return null;
  }
  return {
    accountId,
    workspaceId: String(event.workspace_id),
    projectId: cao.projectId,
    scheduleId: cao.scheduleId,
    targetId: cao.targetId,
    scheduleAnchorAt: event.start_at,
  };
}

export interface CaoManualLearningDeps {
  getAccountIdentity(): { accountId: string } | null;
  getWorkspaceId(): string | null;
  getProjectId?(): string | null;
  listEvents(workspaceId: string): Promise<EventRow[]>;
  recover(
    scope: CaoScheduledLearningScope,
  ): Promise<{ status: 'completed' | 'failed' | 'cancelled' } | null>;
  run(input: CaoScheduledLearningRuntimeInput): Promise<{
    status: 'completed' | 'failed' | 'cancelled';
  }>;
}

const productionManualLearningDeps: CaoManualLearningDeps = {
  getAccountIdentity: getActiveAccountIdentity,
  getWorkspaceId: () => useAuthStore.getState().workspaceId ?? null,
  getProjectId: () => useAuthStore.getState().projectId ?? null,
  listEvents: (workspaceId) => eventRepo.list({ workspace_id: workspaceId as never }),
  recover: productionRuntime.recover,
  run: productionRuntime.run,
};

export async function runManualCaoLearningChecks(
  deps: CaoManualLearningDeps = productionManualLearningDeps,
): Promise<{
  status: 'completed' | 'failed' | 'cancelled';
}> {
  const account = deps.getAccountIdentity();
  const workspaceId = deps.getWorkspaceId();
  if (!account || !workspaceId) return { status: 'failed' };
  let events: EventRow[];
  try {
    events = await deps.listEvents(workspaceId);
  } catch {
    return { status: 'failed' };
  }
  const uniqueScopes = new Map<string, CaoScheduledLearningScope>();
  events
    .filter((event) => event.status === 'scheduled')
    .map((event) => scopeForEvent(account.accountId, workspaceId, event))
    .filter((scope): scope is CaoScheduledLearningScope => scope !== null)
    .forEach((scope) => uniqueScopes.set(scopeKey(scope), scope));
  const scopes = [...uniqueScopes.values()];
  const projectId = deps.getProjectId?.();
  if (projectId && !scopes.some((scope) => scope.projectId === projectId)) {
    scopes.push({ accountId: account.accountId, workspaceId, projectId,
      scheduleId: 'cao-manual-project', targetId: 'jarvis-cao', scheduleAnchorAt: 0 });
  }
  if (scopes.length === 0) return { status: 'failed' };
  for (const scope of scopes) {
    try {
      const recovery = await deps.recover(scope);
      if (recovery && recovery.status !== 'completed') return { status: recovery.status };
      const result = await deps.run({ scope, trigger: 'manual_force' });
      if (result.status !== 'completed') return { status: result.status };
    } catch {
      return { status: 'failed' };
    }
  }
  return { status: 'completed' };
}
