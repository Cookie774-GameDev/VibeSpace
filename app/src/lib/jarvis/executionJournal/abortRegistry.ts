import type {
  CancellationDelivery,
  JarvisAbortRegistration,
  JarvisAbortRegistrationAuthority,
  JarvisAbortRegistry,
  JarvisCancellationAggregate,
  JarvisCancellationDeliveryAuthority,
  JarvisCancellationOwnerOutcome,
  JarvisCancellationRequestResult,
  JarvisExecutionJournal,
  JarvisPreparedCancellation,
  JarvisRun,
} from '@/lib/jarvis/contracts/execution';

type AbortFunction = JarvisAbortRegistration['abort'];
type DeliveryRecord =
  | {
      registrationId: string;
      outcome: JarvisCancellationOwnerOutcome;
      trustedQueueOwner: boolean;
    }
  | { registrationId: string; error: true };

type PendingCancellation = {
  plan: JarvisPreparedCancellation;
  accountId: string;
  runId: string;
  cancellationRequestId: string;
  deliveryStarted: boolean;
  activated: boolean;
  abandoned: boolean;
  cleared: boolean;
  deliveryClosed: boolean;
  queueResolutionPending: boolean;
  invoked: Map<string, WeakSet<AbortFunction>>;
  invocationVersions: Map<string, number>;
  latestDeliveries: Map<string, DeliveryRecord>;
  deliveries: DeliveryRecord[];
  inFlight: Set<Promise<void>>;
};

const failClosedQueueAborters = new WeakSet<AbortFunction>();

export type JarvisAbortRegistryCore = {
  registrationAuthority: JarvisAbortRegistrationAuthority;
  cancellationDeliveryAuthority: JarvisCancellationDeliveryAuthority;
  clearRun(accountId: string, runId: string): void;
  readRunDiagnostic(accountId: string, runId: string): Readonly<{
    owners: readonly Readonly<{ id: string; kind: string }>[];
    pendingCancellation: boolean; truncated: boolean; aggregateKind: string | null;
  }>;
};

export type JarvisAbortRegistryDependencies = {
  getRun(accountId: string, runId: string): Promise<Readonly<JarvisRun> | undefined>;
  newCancellationRequestId?: () => string;
};

export type JarvisQueuedCancellationIdentity = Readonly<{
  accountId: string;
  runId: string;
  queueItemId: string;
  executionId: string;
  ownerId: string;
}>;

export type JarvisQueuedCancellationTombstoneV1 = Readonly<{
  schemaVersion: 1;
  kind: 'cancellation_tombstone';
  runnable: false;
  accountId: string;
  runId: string;
  queueItemId: string;
  executionId: string;
}>;

export interface JarvisQueuedCancellationQueueAuthority {
  withExclusiveItemLock<T>(
    identity: JarvisQueuedCancellationIdentity,
    operation: () => Promise<T>,
  ): Promise<T>;
  replaceExactRunnableWithTombstone(input: {
    identity: JarvisQueuedCancellationIdentity;
    tombstone: JarvisQueuedCancellationTombstoneV1;
  }): Promise<
    | { applied: true; tombstone: JarvisQueuedCancellationTombstoneV1 }
    | {
        applied: false;
        reason: 'exact_item_mismatch' | 'claimed_or_drained' | 'tombstone_conflict';
        handoffProven: boolean;
      }
  >;
  restoreExactRunnable(tombstone: JarvisQueuedCancellationTombstoneV1): Promise<boolean>;
}

export interface JarvisQueuedCancellationTransitionAuthority {
  transitionQueuedRunToCancelled(input: {
    accountId: string;
    runId: string;
    expectedStatus: 'queued';
  }): Promise<
    { applied: true } | { applied: false; reason: 'status_conflict' | 'authority_revoked' }
  >;
}

export type JarvisCancellationIntentEvent = Readonly<
  Omit<JarvisEventInput, 'idempotencyKey'> & { idempotencyKey: string }
>;

type JarvisEventInput = Parameters<JarvisExecutionJournal['appendEvent']>[2];

export interface JarvisCancellationIntentCommitAuthority {
  commitIntent(input: {
    accountId: string;
    runId: string;
    cancellationRequestId: string;
    event: JarvisCancellationIntentEvent;
  }): Promise<
    { committed: true } | { committed: false; reason: 'authority_revoked_before_intent' }
  >;
}

export interface JarvisCancellationRequestAuthority {
  requestCancellation(accountId: string, runId: string): Promise<JarvisCancellationRequestResult>;
}

type TerminalRunStatus = Extract<
  CancellationDelivery,
  { kind: 'already_terminal' }
>['terminalStatus'];

const TERMINAL_STATUSES = new Set<TerminalRunStatus>([
  'partial',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

function isTerminalRunStatus(status: JarvisRun['status']): status is TerminalRunStatus {
  return TERMINAL_STATUSES.has(status as TerminalRunStatus);
}

function registryKey(accountId: string, runId: string): string {
  return `${accountId}\u0000${runId}`;
}

function registrationKey(registration: JarvisAbortRegistration): string {
  return `${registryKey(registration.accountId, registration.runId)}\u0000${registration.registrationId}`;
}

function assertStableIdentifier(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\u0000')
  ) {
    throw new JarvisCancellationPlanError('invalid_abort_registration');
  }
}

function assertRegistration(registration: JarvisAbortRegistration): void {
  assertStableIdentifier(registration.accountId);
  assertStableIdentifier(registration.runId);
  assertStableIdentifier(registration.registrationId);
  if (registration.parentRunId !== undefined) assertStableIdentifier(registration.parentRunId);
  if (typeof registration.abort !== 'function') {
    throw new JarvisCancellationPlanError('invalid_abort_registration');
  }
}

function defaultNewCancellationRequestId(): string {
  return `jcancel_${crypto.randomUUID()}`;
}

function ownerIds(
  records: readonly DeliveryRecord[],
  kind: JarvisCancellationOwnerOutcome['kind'],
) {
  const ids: string[] = [];
  for (const record of records) {
    if (
      'outcome' in record &&
      record.outcome.kind === kind &&
      !ids.includes(record.outcome.ownerId)
    ) {
      ids.push(record.outcome.ownerId);
    }
  }
  return ids;
}

function aggregateDelivery(
  state: PendingCancellation,
): Exclude<CancellationDelivery, { kind: 'already_terminal' }> {
  const records = state.deliveries;
  const tombstone = records.find(
    (record): record is Extract<DeliveryRecord, { outcome: JarvisCancellationOwnerOutcome }> =>
      'outcome' in record &&
      record.trustedQueueOwner &&
      record.outcome.kind === 'queued_tombstoned',
  );
  if (tombstone?.outcome.kind === 'queued_tombstoned') {
    return {
      kind: 'queued_tombstoned',
      cancellationRequestId: state.cancellationRequestId,
      ownerId: tombstone.outcome.ownerId,
      queueItemId: tombstone.outcome.queueItemId,
    };
  }
  const delivered = ownerIds(records, 'signal_delivered');
  if (delivered.length > 0) {
    return {
      kind: 'signal_delivered',
      cancellationRequestId: state.cancellationRequestId,
      ownerIds: delivered,
    };
  }
  const errors = records
    .filter((record): record is Extract<DeliveryRecord, { error: true }> => 'error' in record)
    .map((record) => record.registrationId)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (errors.length > 0) {
    return {
      kind: 'delivery_error',
      cancellationRequestId: state.cancellationRequestId,
      ownerIds: errors,
      safeErrorCategory: 'abort_owner_error',
    };
  }
  const handoff = ownerIds(records, 'handoff_pending');
  if (handoff.length > 0) {
    return {
      kind: 'handoff_pending',
      cancellationRequestId: state.cancellationRequestId,
      ownerIds: handoff,
    };
  }
  const rejected = [
    ...ownerIds(records, 'delivery_rejected'),
    ...ownerIds(records, 'already_exited'),
  ].filter((value, index, values) => values.indexOf(value) === index);
  if (rejected.length > 0) {
    return {
      kind: 'delivery_rejected',
      cancellationRequestId: state.cancellationRequestId,
      ownerIds: rejected,
    };
  }
  const unsupported = ownerIds(records, 'unsupported');
  if (unsupported.length > 0) {
    return {
      kind: 'unsupported',
      cancellationRequestId: state.cancellationRequestId,
      ownerIds: unsupported,
    };
  }
  return { kind: 'executor_missing', cancellationRequestId: state.cancellationRequestId };
}

export type JarvisCancellationPlanErrorCode =
  | 'invalid_abort_registration'
  | 'invalid_prepared_cancellation'
  | 'cancellation_request_mismatch'
  | 'cancellation_registration_closed'
  | 'queued_cancellation_fail_closed';

export class JarvisCancellationPlanError extends Error {
  readonly code: JarvisCancellationPlanErrorCode;

  constructor(code: JarvisCancellationPlanErrorCode) {
    super(code);
    this.name = 'JarvisCancellationPlanError';
    this.code = code;
  }
}

function queuedCancellationTombstone(
  identity: JarvisQueuedCancellationIdentity,
): JarvisQueuedCancellationTombstoneV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'cancellation_tombstone',
    runnable: false,
    accountId: identity.accountId,
    runId: identity.runId,
    queueItemId: identity.queueItemId,
    executionId: identity.executionId,
  });
}

function exactTombstone(
  left: JarvisQueuedCancellationTombstoneV1,
  right: JarvisQueuedCancellationTombstoneV1,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.runnable === right.runnable &&
    left.accountId === right.accountId &&
    left.runId === right.runId &&
    left.queueItemId === right.queueItemId &&
    left.executionId === right.executionId &&
    Object.keys(left).length === Object.keys(right).length
  );
}

/**
 * @internal Queue-owner seam. Its repository keeps the lock across tombstone,
 * terminal CAS, and any exact rollback; this factory never exposes those
 * operations to an ordinary cancellation caller.
 */
export function createJarvisQueuedCancellationRegistration(input: {
  identity: JarvisQueuedCancellationIdentity;
  queue: JarvisQueuedCancellationQueueAuthority;
  transition: JarvisQueuedCancellationTransitionAuthority;
  isAuthorityCurrent(): boolean;
}): JarvisAbortRegistration {
  const identity = Object.freeze({ ...input.identity });
  for (const value of [
    identity.accountId,
    identity.runId,
    identity.queueItemId,
    identity.executionId,
    identity.ownerId,
  ]) {
    assertStableIdentifier(value);
  }
  const tombstone = queuedCancellationTombstone(identity);
  const authorityCurrent = () => {
    try {
      return input.isAuthorityCurrent() === true;
    } catch {
      return false;
    }
  };

  const abort: AbortFunction = async () =>
    input.queue.withExclusiveItemLock(identity, async () => {
      if (!authorityCurrent()) {
        return { kind: 'handoff_pending', ownerId: identity.ownerId };
      }
      const replaced = await input.queue.replaceExactRunnableWithTombstone({
        identity,
        tombstone,
      });
      if (!replaced.applied) {
        if (replaced.handoffProven) {
          return { kind: 'handoff_pending', ownerId: identity.ownerId };
        }
        throw new JarvisCancellationPlanError('queued_cancellation_fail_closed');
      }

      if (!exactTombstone(replaced.tombstone, tombstone)) {
        const restored = await input.queue.restoreExactRunnable(tombstone);
        if (restored) return { kind: 'handoff_pending', ownerId: identity.ownerId };
        throw new JarvisCancellationPlanError('queued_cancellation_fail_closed');
      }

      if (!authorityCurrent()) {
        const restored = await input.queue.restoreExactRunnable(tombstone);
        if (restored) return { kind: 'handoff_pending', ownerId: identity.ownerId };
        throw new JarvisCancellationPlanError('queued_cancellation_fail_closed');
      }

      const transition = await input.transition.transitionQueuedRunToCancelled({
        accountId: identity.accountId,
        runId: identity.runId,
        expectedStatus: 'queued',
      });
      if (!transition.applied) {
        const restored = await input.queue.restoreExactRunnable(tombstone);
        if (restored) return { kind: 'handoff_pending', ownerId: identity.ownerId };
        throw new JarvisCancellationPlanError('queued_cancellation_fail_closed');
      }
      return {
        kind: 'queued_tombstoned',
        ownerId: identity.ownerId,
        queueItemId: identity.queueItemId,
      };
    });

  failClosedQueueAborters.add(abort);
  return Object.freeze({
    accountId: identity.accountId,
    runId: identity.runId,
    registrationId: identity.ownerId,
    kind: 'other',
    abort,
  });
}

export function createJarvisAbortRegistry(
  dependencies: JarvisAbortRegistryDependencies,
): JarvisAbortRegistryCore {
  const registrations = new Map<string, JarvisAbortRegistration>();
  const pending = new Map<string, PendingCancellation>();
  const issuedPlans = new WeakSet<object>();
  const newCancellationRequestId =
    dependencies.newCancellationRequestId ?? defaultNewCancellationRequestId;

  function targetsRun(registration: JarvisAbortRegistration, targetRunId: string): boolean {
    if (registration.runId === targetRunId) return true;
    let parentRunId = registration.parentRunId;
    const visited = new Set<string>([registration.runId]);
    while (parentRunId !== undefined && !visited.has(parentRunId)) {
      if (parentRunId === targetRunId) return true;
      visited.add(parentRunId);
      const parentIds = [
        ...new Set(
          [...registrations.values()]
            .filter(
              (candidate) =>
                candidate.accountId === registration.accountId && candidate.runId === parentRunId,
            )
            .map((candidate) => candidate.parentRunId)
            .filter((value): value is string => value !== undefined),
        ),
      ];
      parentRunId = parentIds.length === 1 ? parentIds[0] : undefined;
    }
    return false;
  }

  function matchingRegistrations(state: PendingCancellation): JarvisAbortRegistration[] {
    return [...registrations.values()].filter(
      (registration) =>
        registration.accountId === state.accountId && targetsRun(registration, state.runId),
    );
  }

  function invokeRegistration(
    state: PendingCancellation,
    registration: JarvisAbortRegistration,
  ): boolean {
    if (state.cleared || state.abandoned || state.deliveryClosed || !state.activated) return false;
    const key = registrationKey(registration);
    let invokedForKey = state.invoked.get(key);
    if (!invokedForKey) {
      invokedForKey = new WeakSet();
      state.invoked.set(key, invokedForKey);
    }
    if (invokedForKey.has(registration.abort)) return false;
    invokedForKey.add(registration.abort);
    const invocationVersion = (state.invocationVersions.get(key) ?? 0) + 1;
    state.invocationVersions.set(key, invocationVersion);
    state.latestDeliveries.delete(key);
    const trustedQueueOwner = failClosedQueueAborters.has(registration.abort);
    const invocation = Promise.resolve()
      .then(() => registration.abort())
      .then(
        (outcome) => {
          if (!state.cleared && !state.abandoned) {
            let record: DeliveryRecord;
            if (outcome.kind === 'queued_tombstoned' && !trustedQueueOwner) {
              record = { registrationId: registration.registrationId, error: true };
            } else {
              record = {
                registrationId: registration.registrationId,
                outcome,
                trustedQueueOwner,
              };
            }
            state.deliveries.push(record);
            if (state.invocationVersions.get(key) === invocationVersion) {
              state.latestDeliveries.set(key, record);
            }
            if (trustedQueueOwner && outcome.kind === 'queued_tombstoned') {
              state.deliveryClosed = true;
            }
          }
        },
        () => {
          if (!state.cleared && !state.abandoned) {
            const record: DeliveryRecord = {
              registrationId: registration.registrationId,
              error: true,
            };
            state.deliveries.push(record);
            if (state.invocationVersions.get(key) === invocationVersion) {
              state.latestDeliveries.set(key, record);
            }
            if (trustedQueueOwner) state.deliveryClosed = true;
          }
        },
      )
      .finally(() => state.inFlight.delete(invocation));
    state.inFlight.add(invocation);
    return true;
  }

  async function drain(state: PendingCancellation): Promise<void> {
    while (state.inFlight.size > 0) await Promise.all([...state.inFlight]);
  }

  function requirePlan(plan: JarvisPreparedCancellation): PendingCancellation {
    if (typeof plan !== 'object' || plan === null || !issuedPlans.has(plan)) {
      throw new JarvisCancellationPlanError('invalid_prepared_cancellation');
    }
    const state = pending.get(registryKey(plan.accountId, plan.runId));
    if (!state || state.plan !== plan || state.abandoned || state.cleared) {
      throw new JarvisCancellationPlanError('invalid_prepared_cancellation');
    }
    return state;
  }

  function clearRun(accountId: string, runId: string): void {
    const key = registryKey(accountId, runId);
    const state = pending.get(key);
    if (state) {
      state.cleared = true;
      state.inFlight.clear();
      pending.delete(key);
    }
    for (const [entryKey, registration] of registrations) {
      if (registration.accountId === accountId && registration.runId === runId) {
        registrations.delete(entryKey);
      }
    }
  }

  const registrationAuthority: JarvisAbortRegistrationAuthority = {
    registerIssuedOwner(registration) {
      assertRegistration(registration);
      const storedRegistration = Object.freeze({ ...registration });
      const key = registrationKey(storedRegistration);
      for (const state of pending.values()) {
        if (
          state.activated &&
          state.deliveryClosed &&
          state.accountId === storedRegistration.accountId &&
          targetsRun(storedRegistration, state.runId)
        ) {
          throw new JarvisCancellationPlanError('cancellation_registration_closed');
        }
      }
      registrations.set(key, storedRegistration);
      for (const state of pending.values()) {
        if (
          state.activated &&
          !state.queueResolutionPending &&
          state.accountId === storedRegistration.accountId &&
          targetsRun(storedRegistration, state.runId)
        ) {
          invokeRegistration(state, storedRegistration);
        }
      }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (registrations.get(key) === storedRegistration) registrations.delete(key);
      };
    },
  };

  const cancellationDeliveryAuthority: JarvisCancellationDeliveryAuthority = {
    async prepare(accountId, runId) {
      assertStableIdentifier(accountId);
      assertStableIdentifier(runId);
      const canonicalRun = await dependencies.getRun(accountId, runId);
      if (canonicalRun && isTerminalRunStatus(canonicalRun.status)) {
        clearRun(accountId, runId);
        return { kind: 'already_terminal', terminalStatus: canonicalRun.status } as const;
      }
      const key = registryKey(accountId, runId);
      const existing = pending.get(key);
      if (existing) {
        await drain(existing);
        return {
          kind: 'already_pending',
          cancellationRequestId: existing.cancellationRequestId,
          currentDelivery: aggregateDelivery(existing),
        };
      }
      const cancellationRequestId = newCancellationRequestId();
      assertStableIdentifier(cancellationRequestId);
      const plan = Object.freeze({
        accountId,
        runId,
        cancellationRequestId,
      }) as JarvisPreparedCancellation;
      const state: PendingCancellation = {
        plan,
        accountId,
        runId,
        cancellationRequestId,
        deliveryStarted: false,
        activated: false,
        abandoned: false,
        cleared: false,
        deliveryClosed: false,
        queueResolutionPending: false,
        invoked: new Map(),
        invocationVersions: new Map(),
        latestDeliveries: new Map(),
        deliveries: [],
        inFlight: new Set(),
      };
      issuedPlans.add(plan);
      pending.set(key, state);
      return { kind: 'prepared', plan };
    },

    async deliver(plan) {
      const state = requirePlan(plan);
      if (state.deliveryStarted) {
        throw new JarvisCancellationPlanError('invalid_prepared_cancellation');
      }
      state.deliveryStarted = true;
      const canonicalBeforeDelivery = await dependencies.getRun(state.accountId, state.runId);
      if (canonicalBeforeDelivery && isTerminalRunStatus(canonicalBeforeDelivery.status)) {
        const terminalStatus = canonicalBeforeDelivery.status;
        clearRun(state.accountId, state.runId);
        return { kind: 'already_terminal', terminalStatus };
      }
      if (state.cleared || state.abandoned) {
        throw new JarvisCancellationPlanError('invalid_prepared_cancellation');
      }
      state.activated = true;
      state.queueResolutionPending = true;
      while (!state.deliveryClosed) {
        let invokedQueueOwner = false;
        for (const registration of matchingRegistrations(state)) {
          if (!failClosedQueueAborters.has(registration.abort)) continue;
          if (!invokeRegistration(state, registration)) continue;
          invokedQueueOwner = true;
          await drain(state);
          if (state.deliveryClosed) break;
        }
        if (!invokedQueueOwner) break;
      }
      state.queueResolutionPending = false;
      if (!state.deliveryClosed) {
        for (const registration of matchingRegistrations(state)) {
          if (!failClosedQueueAborters.has(registration.abort)) {
            invokeRegistration(state, registration);
          }
        }
      }
      await drain(state);
      const aggregate = aggregateDelivery(state);
      if (aggregate.kind === 'queued_tombstoned') {
        clearRun(state.accountId, state.runId);
        return aggregate;
      }
      const canonicalRun = await dependencies.getRun(state.accountId, state.runId);
      if (canonicalRun && isTerminalRunStatus(canonicalRun.status)) {
        const terminalStatus = canonicalRun.status;
        clearRun(state.accountId, state.runId);
        return { kind: 'already_terminal', terminalStatus };
      }
      return aggregate;
    },

    async current(accountId, runId, cancellationRequestId) {
      const state = pending.get(registryKey(accountId, runId));
      if (!state || state.cancellationRequestId !== cancellationRequestId) {
        throw new JarvisCancellationPlanError('cancellation_request_mismatch');
      }
      await drain(state);
      return aggregateDelivery(state);
    },

    async sealWorkflowQuiescence(accountId, runId, cancellationRequestId) {
      const state = pending.get(registryKey(accountId, runId));
      if (!state || state.cancellationRequestId !== cancellationRequestId) {
        throw new JarvisCancellationPlanError('cancellation_request_mismatch');
      }
      await drain(state);
      const latest = [...state.latestDeliveries.values()];
      if (
        latest.length === 0 ||
        latest.some(
          (record) => !('outcome' in record) || record.outcome.kind !== 'signal_delivered',
        )
      ) {
        return {
          kind: 'not_quiescent',
          cancellationRequestId,
          currentDelivery: aggregateDelivery(state),
        } as const;
      }
      state.deliveryClosed = true;
      return Object.freeze({
        kind: 'sealed' as const,
        cancellationRequestId,
        ownerIds: Object.freeze(
          latest.map((record) => {
            if (!('outcome' in record)) throw new Error('cancellation_delivery_state_invalid');
            return record.outcome.ownerId;
          }),
        ),
      });
    },

    abandonBeforeDelivery(plan) {
      const state = requirePlan(plan);
      if (state.activated) throw new JarvisCancellationPlanError('invalid_prepared_cancellation');
      state.abandoned = true;
      pending.delete(registryKey(state.accountId, state.runId));
    },
  };

  return {
    registrationAuthority, cancellationDeliveryAuthority, clearRun,
    readRunDiagnostic(accountId, runId) {
      assertStableIdentifier(accountId); assertStableIdentifier(runId);
      const owners = [...registrations.values()].filter(row =>
        row.accountId === accountId && targetsRun(row, runId));
      const state = pending.get(registryKey(accountId, runId));
      return Object.freeze({
        owners: owners.slice(0, 100).map(row => Object.freeze({ id: row.registrationId, kind: row.kind })),
        pendingCancellation: Boolean(state && !state.abandoned && !state.cleared),
        aggregateKind: state ? aggregateDelivery(state).kind : null,
        truncated: owners.length > 100,
      });
    },
  };
}

function fixedCancellationIntentEvent(
  cancellationRequestId: string,
  createdAt: number,
): JarvisCancellationIntentEvent {
  return Object.freeze({
    idempotencyKey: cancellationRequestId,
    type: 'warning',
    status: 'cancellation_requested',
    title: 'Cancellation requested',
    safeSummary: 'Cancellation delivery is pending.',
    sourceRefs: [],
    artifactIds: [],
    createdAt,
  });
}

function toCancellationAggregate(delivery: CancellationDelivery): JarvisCancellationAggregate {
  switch (delivery.kind) {
    case 'queued_tombstoned':
      return {
        kind: 'queued_cancelled',
        ownerId: delivery.ownerId,
        queueItemId: delivery.queueItemId,
      };
    case 'signal_delivered':
    case 'handoff_pending':
    case 'unsupported':
    case 'delivery_rejected':
      return { kind: delivery.kind, ownerIds: [...delivery.ownerIds] };
    case 'executor_missing':
      return { kind: 'executor_missing' };
    case 'delivery_error':
      return {
        kind: 'delivery_error',
        ownerIds: [...delivery.ownerIds],
        safeErrorCategory: delivery.safeErrorCategory,
      };
    case 'already_terminal':
      return { kind: 'delivery_pending', ownerIds: [] };
  }
}

/** @internal Focused Task 18 authority harness; never export from a public barrel. */
export function createTestJarvisCancellationRequestAuthority(
  core: JarvisAbortRegistryCore,
  dependencies: JarvisCancellationIntentCommitAuthority & {
    isAuthorityCurrent(): boolean;
    now?: () => number;
  },
): JarvisCancellationRequestAuthority {
  const now = dependencies.now ?? Date.now;
  const authorityCurrent = () => {
    try {
      return dependencies.isAuthorityCurrent() === true;
    } catch {
      return false;
    }
  };

  return {
    async requestCancellation(accountId, runId) {
      if (!authorityCurrent()) return { kind: 'authority_revoked_before_intent' };
      const preparation = await core.cancellationDeliveryAuthority.prepare(accountId, runId);
      if (preparation.kind === 'already_terminal') return preparation;
      if (preparation.kind === 'already_pending') {
        return {
          kind: 'intent_committed',
          requestState: 'already_pending',
          authorityState: authorityCurrent() ? 'current' : 'revoked_after_intent',
          cancellationRequestId: preparation.cancellationRequestId,
          aggregate: toCancellationAggregate(preparation.currentDelivery),
        };
      }

      const { plan } = preparation;
      if (!authorityCurrent()) {
        core.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
        return { kind: 'authority_revoked_before_intent' };
      }

      let committed: Awaited<ReturnType<JarvisCancellationIntentCommitAuthority['commitIntent']>>;
      try {
        committed = await dependencies.commitIntent({
          accountId,
          runId,
          cancellationRequestId: plan.cancellationRequestId,
          event: fixedCancellationIntentEvent(plan.cancellationRequestId, now()),
        });
      } catch (error) {
        core.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
        throw error;
      }
      if (!committed.committed) {
        core.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
        return { kind: 'authority_revoked_before_intent' };
      }

      let delivery: CancellationDelivery;
      try {
        delivery = await core.cancellationDeliveryAuthority.deliver(plan);
      } catch {
        return {
          kind: 'intent_committed',
          requestState: 'new',
          authorityState: authorityCurrent() ? 'current' : 'revoked_after_intent',
          cancellationRequestId: plan.cancellationRequestId,
          aggregate: {
            kind: 'delivery_error',
            ownerIds: [],
            safeErrorCategory: 'cancellation_delivery_error',
          },
        };
      }
      return {
        kind: 'intent_committed',
        requestState: 'new',
        authorityState: authorityCurrent() ? 'current' : 'revoked_after_intent',
        cancellationRequestId: plan.cancellationRequestId,
        aggregate: toCancellationAggregate(delivery),
      };
    },
  };
}

/** @internal Focused Task 18 test harness only; never export from the execution-journal barrel. */
export function createTestJarvisCancellationFacade(
  core: JarvisAbortRegistryCore,
  dependencies: { journal: Pick<JarvisExecutionJournal, 'appendEvent'>; now?: () => number },
): JarvisAbortRegistry {
  const now = dependencies.now ?? Date.now;
  return {
    registerRunAborter(registration) {
      return core.registrationAuthority.registerIssuedOwner(registration);
    },
    async requestRunCancellation(accountId, runId) {
      const preparation = await core.cancellationDeliveryAuthority.prepare(accountId, runId);
      if (preparation.kind === 'already_terminal') return preparation;
      if (preparation.kind === 'already_pending') return preparation.currentDelivery;
      const { plan } = preparation;
      try {
        await dependencies.journal.appendEvent(
          accountId,
          runId,
          fixedCancellationIntentEvent(plan.cancellationRequestId, now()),
        );
      } catch (error) {
        core.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
        throw error;
      }
      return core.cancellationDeliveryAuthority.deliver(plan);
    },
    clearRun(accountId, runId) {
      core.clearRun(accountId, runId);
    },
  };
}
