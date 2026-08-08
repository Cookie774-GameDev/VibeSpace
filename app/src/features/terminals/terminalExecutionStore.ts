import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import type {
  JarvisAbortRegistration,
  JarvisAbortRegistrationAuthority,
  JarvisCancellationOwnerOutcome,
  JarvisCancellationRequestResult,
} from '@/lib/jarvis/contracts/execution';
import {
  jarvisTerminalHandoffReceiptBrand,
  type JarvisTerminalExecutionAcceptor,
  type JarvisTerminalOwnedExecution,
} from '@/lib/jarvis/approvalEngine';
import {
  createJarvisQueuedCancellationRegistration,
  type JarvisQueuedCancellationTransitionAuthority,
} from '@/lib/jarvis/executionJournal/abortRegistry';
import {
  commitCanonicalTerminalCancellation,
  enqueueCanonicalTerminalCommand,
  jarvisTerminalCommandQueueAuthority,
  useTerminalCommandQueue,
} from './terminalCommandQueue';
import type {
  CanonicalTerminalEvidence,
  CanonicalTerminalEvidenceAuthority,
} from '@/lib/jarvis/artifactProducerAdapters';

export type TerminalExecutionStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'cancellation_requested'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface TerminalExecution {
  id: string;
  status: TerminalExecutionStatus;
  accountId?: string;
  runId?: string;
  sessionId?: string;
  exitCode?: number | null;
  timeoutMs?: number;
  timedOut?: boolean;
  settlementError?: string;
  updatedAt: number;
}

export type NativeTerminalKillRequest = Readonly<{
  sessionId: string;
  cancellationToken?: string;
}>;

export type NativeTerminalKillResult = Readonly<{
  kind: 'missing' | 'already_exited' | 'delivery_rejected' | 'signal_delivered';
  requestKind: 'canonical_cancellation' | 'manual_termination';
  cancellationToken?: string;
}>;

export type NativeTerminalExitPayload = Readonly<{
  sessionId: string;
  code: number | null;
  reason: 'natural_exit' | 'accepted_cancellation' | 'manual_termination';
  cancellationToken?: string;
}>;

export type CanonicalTerminalExecutionRequest = Readonly<{
  accountId: string;
  runId: string;
  executionId: string;
  cancellationToken: string;
  command: string;
  label?: string;
  cwd?: string;
  timeoutMs?: number;
}>;

export type JarvisTerminalExecutionAcceptorDependencies = Readonly<{
  request: CanonicalTerminalExecutionRequest;
  registrationAuthority: JarvisAbortRegistrationAuthority;
  queuedTransitionAuthority: JarvisQueuedCancellationTransitionAuthority;
}>;

/** @internal Re-reads the canonical Task 19C terminal result journal. */
export interface CanonicalTerminalArtifactEvidenceReadPort {
  readCanonicalTerminalEvidence(
    evidence: CanonicalTerminalEvidence,
  ): Promise<CanonicalTerminalEvidence | null>;
}

function validTerminalEvidence(evidence: CanonicalTerminalEvidence): boolean {
  const stable = (value: string) =>
    value.length > 0 && value.trim() === value && !value.includes('\u0000');
  const resultPrefix =
    evidence.state === 'exited'
      ? `jterminal_result:${evidence.executionId}:${evidence.sessionId}:`
      : `jterminal_partial:${evidence.executionId}:${evidence.sessionId}:`;
  return (
    Object.isFrozen(evidence) &&
    evidence.producerId === 'terminal_exit' &&
    (evidence.state === 'exited' || evidence.state === 'partial') &&
    Number.isSafeInteger(evidence.attemptNumber) &&
    evidence.attemptNumber > 0 &&
    Number.isSafeInteger(evidence.verifiedAt) &&
    evidence.verifiedAt >= 0 &&
    stable(evidence.accountId) &&
    stable(evidence.runId) &&
    stable(evidence.requestId) &&
    stable(evidence.resultRef) &&
    stable(evidence.sessionId) &&
    canonicalExecutionId(evidence.executionId) &&
    evidence.resultRef.startsWith(resultPrefix)
  );
}

function sameTerminalEvidence(
  left: CanonicalTerminalEvidence,
  right: CanonicalTerminalEvidence,
): boolean {
  return (
    left.producerId === right.producerId &&
    left.accountId === right.accountId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.attemptNumber === right.attemptNumber &&
    left.resultRef === right.resultRef &&
    left.state === right.state &&
    left.verifiedAt === right.verifiedAt &&
    left.sessionId === right.sessionId &&
    left.executionId === right.executionId
  );
}

/** @internal Supplied only to the trusted artifact runtime composition. */
export function createCanonicalTerminalEvidenceAuthority(
  port: CanonicalTerminalArtifactEvidenceReadPort,
): CanonicalTerminalEvidenceAuthority {
  return Object.freeze({
    async verify(evidence: CanonicalTerminalEvidence) {
      if (!validTerminalEvidence(evidence)) return null;
      let current: CanonicalTerminalEvidence | null;
      try {
        current = await port.readCanonicalTerminalEvidence(evidence);
      } catch {
        return null;
      }
      return current && validTerminalEvidence(current) && sameTerminalEvidence(evidence, current)
        ? current
        : null;
    },
  });
}

interface TerminalExecutionState {
  executions: Record<string, TerminalExecution>;
  mark: (id: string, status: TerminalExecutionStatus, patch?: Partial<TerminalExecution>) => void;
  clear: () => void;
}

type CanonicalExecutionRecord = {
  request: CanonicalTerminalExecutionRequest;
  ownerId: string;
  controller: JarvisTerminalOwnedExecution;
  registrationAuthority: JarvisAbortRegistrationAuthority;
  queueOwnerDisposer?: () => void;
  nativeOwnerDisposer?: () => void;
  sessionId?: string;
  cancellationRequestId?: string;
  claimed: boolean;
  settled: boolean;
  disposed: boolean;
  settlement?: Promise<void>;
};

const MAX_EXECUTIONS = 100;
const executionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const canonicalExecutions = new Map<string, CanonicalExecutionRecord>();
const canonicalSessionOwners = new Map<string, string>();
const pendingNativeExits = new Map<string, NativeTerminalExitPayload>();
const settledCanonicalExecutions = new Map<string, { sessionId?: string }>();
let terminalExitListener: Promise<void> | undefined;

function stableIdentifier(value: string, label: string): string {
  if (!value || value !== value.trim() || value.includes('\u0000')) {
    throw new TypeError(`${label} must be a stable nonblank identifier.`);
  }
  return value;
}

function canonicalExecutionId(value: string | undefined): value is `jterm_${string}` {
  return typeof value === 'string' && /^jterm_[A-Za-z0-9_-]+$/.test(value);
}

function clearExecutionTimeout(id: string): void {
  const timer = executionTimeouts.get(id);
  if (timer !== undefined) clearTimeout(timer);
  executionTimeouts.delete(id);
}

function disposeRecord(record: CanonicalExecutionRecord): void {
  if (record.disposed) return;
  record.disposed = true;
  record.queueOwnerDisposer?.();
  record.nativeOwnerDisposer?.();
  record.queueOwnerDisposer = undefined;
  record.nativeOwnerDisposer = undefined;
  record.controller.dispose();
  if (
    record.sessionId &&
    canonicalSessionOwners.get(record.sessionId) === record.request.executionId
  ) {
    canonicalSessionOwners.delete(record.sessionId);
  }
  clearExecutionTimeout(record.request.executionId);
}

function rememberSettledRecord(record: CanonicalExecutionRecord): void {
  settledCanonicalExecutions.delete(record.request.executionId);
  settledCanonicalExecutions.set(record.request.executionId, {
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
  });
  while (settledCanonicalExecutions.size > MAX_EXECUTIONS) {
    const oldest = settledCanonicalExecutions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    settledCanonicalExecutions.delete(oldest);
  }
  if (canonicalExecutions.get(record.request.executionId) === record) {
    canonicalExecutions.delete(record.request.executionId);
  }
}

function clearCanonicalExecutions(): void {
  for (const record of canonicalExecutions.values()) disposeRecord(record);
  canonicalExecutions.clear();
  canonicalSessionOwners.clear();
  pendingNativeExits.clear();
  settledCanonicalExecutions.clear();
}

function boundedExecutions(
  executions: Record<string, TerminalExecution>,
): Record<string, TerminalExecution> {
  const entries = Object.values(executions).sort((left, right) => right.updatedAt - left.updatedAt);
  const active = entries.filter(
    (entry) =>
      canonicalExecutions.has(entry.id) &&
      ['queued', 'starting', 'running', 'cancellation_requested'].includes(entry.status),
  );
  const activeIds = new Set(active.map((entry) => entry.id));
  const settled = entries.filter((entry) => !activeIds.has(entry.id));
  return Object.fromEntries(
    [...active, ...settled.slice(0, Math.max(0, MAX_EXECUTIONS - active.length))].map((entry) => [
      entry.id,
      entry,
    ]),
  );
}

export const useTerminalExecutionStore = create<TerminalExecutionState>((set) => ({
  executions: {},
  mark: (id, status, patch = {}) =>
    set((state) => ({
      executions: boundedExecutions({
        ...state.executions,
        [id]: {
          ...state.executions[id],
          ...patch,
          id,
          status,
          updatedAt: Date.now(),
        },
      }),
    })),
  clear: () => {
    for (const timer of executionTimeouts.values()) clearTimeout(timer);
    executionTimeouts.clear();
    clearCanonicalExecutions();
    useTerminalCommandQueue.getState().clear();
    set({ executions: {} });
  },
}));

export async function ensureTerminalExecutionExitListener(): Promise<void> {
  if (!terminalExitListener) {
    terminalExitListener = listen<NativeTerminalExitPayload>('terminal://exit', (event) => {
      void observeTerminalExecutionNativeExit(event.payload);
    })
      .then(() => undefined)
      .catch((error) => {
        terminalExitListener = undefined;
        throw error;
      });
  }
  return terminalExitListener;
}

export async function observeTerminalExecutionNativeExit(
  payload: NativeTerminalExitPayload,
): Promise<boolean> {
  const executionId = canonicalSessionOwners.get(payload.sessionId);
  if (executionId) return settleTerminalExecutionFromNativeExit(executionId, payload);
  pendingNativeExits.delete(payload.sessionId);
  pendingNativeExits.set(payload.sessionId, Object.freeze({ ...payload }));
  while (pendingNativeExits.size > MAX_EXECUTIONS) {
    const oldest = pendingNativeExits.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingNativeExits.delete(oldest);
  }
  return false;
}

function markCanonical(
  id: string,
  status: TerminalExecutionStatus,
  patch?: Partial<TerminalExecution>,
): void {
  useTerminalExecutionStore.getState().mark(id, status, patch);
  if (['complete', 'failed', 'cancelled'].includes(status)) clearExecutionTimeout(id);
  // Real terminal lifecycle event → Settings → Notifications "Terminal done".
  // Skip pure cancellations (user-initiated abort is not a "command finished" cue).
  if (status === 'complete' || status === 'failed') {
    const exitCode = patch?.exitCode;
    const body =
      status === 'complete'
        ? 'Command finished successfully.'
        : typeof exitCode === 'number'
          ? `Command exited with code ${exitCode}.`
          : 'Command failed.';
    void import('@/lib/notifications').then(({ notifyDone }) => {
      void notifyDone('terminal', 'Terminal done', body);
    });
  }
}

function nativeRegistration(record: CanonicalExecutionRecord): JarvisAbortRegistration {
  const registrationId = `terminal:${record.request.executionId}`;
  return Object.freeze({
    accountId: record.request.accountId,
    runId: record.request.runId,
    registrationId,
    kind: 'terminal' as const,
    abort: async (): Promise<JarvisCancellationOwnerOutcome> => {
      if (record.settled) return { kind: 'already_exited', ownerId: registrationId };
      if (!record.sessionId) return { kind: 'handoff_pending', ownerId: registrationId };
      let result: NativeTerminalKillResult;
      try {
        result = await invoke<NativeTerminalKillResult>('terminal_kill', {
          sessionId: record.sessionId,
          cancellationToken: record.request.cancellationToken,
        } satisfies NativeTerminalKillRequest);
      } catch {
        return { kind: 'delivery_rejected', ownerId: registrationId };
      }
      if (result.kind === 'missing' || result.kind === 'already_exited') {
        return { kind: 'already_exited', ownerId: registrationId };
      }
      if (
        result.kind !== 'signal_delivered' ||
        result.requestKind !== 'canonical_cancellation' ||
        result.cancellationToken !== record.request.cancellationToken
      ) {
        return { kind: 'delivery_rejected', ownerId: registrationId };
      }
      return {
        kind: 'signal_delivered',
        ownerId: registrationId,
        cancellationToken: record.request.cancellationToken,
      };
    },
  });
}

function replaceWithNativeOwner(record: CanonicalExecutionRecord): void {
  const previousNative = record.nativeOwnerDisposer;
  const next = record.registrationAuthority.registerIssuedOwner(nativeRegistration(record));
  record.nativeOwnerDisposer = next;
  previousNative?.();
  record.queueOwnerDisposer?.();
  record.queueOwnerDisposer = undefined;
}

function completeQueuedCancellation(record: CanonicalExecutionRecord): void {
  if (record.settled) return;
  record.settled = true;
  markCanonical(record.request.executionId, 'cancelled', { exitCode: null });
  disposeRecord(record);
  rememberSettledRecord(record);
}

export function createJarvisTerminalExecutionAcceptor(
  dependencies: JarvisTerminalExecutionAcceptorDependencies,
): JarvisTerminalExecutionAcceptor {
  const request = Object.freeze({
    ...dependencies.request,
    accountId: stableIdentifier(dependencies.request.accountId, 'accountId'),
    runId: stableIdentifier(dependencies.request.runId, 'runId'),
    executionId: stableIdentifier(dependencies.request.executionId, 'executionId'),
    cancellationToken: stableIdentifier(
      dependencies.request.cancellationToken,
      'cancellationToken',
    ),
  });
  if (!canonicalExecutionId(request.executionId)) {
    throw new TypeError('Canonical terminal execution id must use the jterm_ namespace.');
  }
  let accepted = false;
  return Object.freeze({
    acceptIssuedExecution(
      input: Parameters<JarvisTerminalExecutionAcceptor['acceptIssuedExecution']>[0],
    ) {
      if (
        accepted ||
        input.executionId !== request.executionId ||
        canonicalExecutions.has(request.executionId)
      ) {
        throw new TypeError('Terminal execution handoff identity mismatch.');
      }
      const ownerId = stableIdentifier(input.ownerId, 'ownerId');
      if (!input.execution || typeof input.execution.dispose !== 'function') {
        throw new TypeError('Terminal execution controller is unavailable.');
      }
      const record: CanonicalExecutionRecord = {
        request,
        ownerId,
        controller: input.execution,
        registrationAuthority: dependencies.registrationAuthority,
        claimed: false,
        settled: false,
        disposed: false,
      };
      canonicalExecutions.set(request.executionId, record);
      try {
        const queuedRegistration = createJarvisQueuedCancellationRegistration({
          identity: {
            accountId: request.accountId,
            runId: request.runId,
            queueItemId: request.executionId,
            executionId: request.executionId,
            ownerId: `terminal:${request.executionId}`,
          },
          queue: jarvisTerminalCommandQueueAuthority,
          transition: {
            transitionQueuedRunToCancelled: async (transitionInput) => {
              const outcome =
                await dependencies.queuedTransitionAuthority.transitionQueuedRunToCancelled(
                  transitionInput,
                );
              if (outcome.applied) {
                if (!commitCanonicalTerminalCancellation(request.executionId)) {
                  completeQueuedCancellation(record);
                  throw new TypeError('canonical_terminal_tombstone_commit_failed');
                }
                completeQueuedCancellation(record);
              }
              return outcome;
            },
          },
          isAuthorityCurrent: () => !record.disposed && !record.settled,
        });
        record.queueOwnerDisposer =
          dependencies.registrationAuthority.registerIssuedOwner(queuedRegistration);
        enqueueCanonicalTerminalCommand({
          accountId: request.accountId,
          runId: request.runId,
          executionId: request.executionId,
          ownerId,
          cancellationToken: request.cancellationToken,
          command: request.command,
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        });
        markCanonical(request.executionId, 'queued', {
          accountId: request.accountId,
          runId: request.runId,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
        accepted = true;
        return Object.freeze({
          executionId: request.executionId,
          ownerId,
          [jarvisTerminalHandoffReceiptBrand]: true as const,
        });
      } catch (error) {
        canonicalExecutions.delete(request.executionId);
        disposeRecord(record);
        throw error;
      }
    },
  });
}

export async function claimTerminalExecution(executionId: string): Promise<boolean> {
  const record = canonicalExecutions.get(executionId);
  if (!record || record.disposed || record.settled) return false;
  if (record.claimed) return true;
  replaceWithNativeOwner(record);
  record.claimed = true;
  markCanonical(executionId, 'starting');
  return true;
}

export function terminalExecutionCancellationToken(
  executionId: string | undefined,
): string | undefined {
  if (!executionId) return undefined;
  const record = canonicalExecutions.get(executionId);
  return record && record.claimed && !record.settled && !record.disposed
    ? record.request.cancellationToken
    : undefined;
}

export function hasCanonicalTerminalExecution(executionId: string | undefined): boolean {
  return canonicalExecutionId(executionId);
}

export function markTerminalExecution(
  id: string | undefined,
  status: TerminalExecutionStatus,
  patch?: Partial<TerminalExecution>,
): void {
  if (!id) return;
  const canonical = canonicalExecutions.get(id);
  if (canonical) {
    if (canonical.settled || ['complete', 'failed', 'cancelled'].includes(status)) return;
    markCanonical(id, status, patch);
  } else if (settledCanonicalExecutions.has(id)) {
    return;
  } else if (canonicalExecutionId(id)) {
    useTerminalExecutionStore.getState().mark(id, 'failed', {
      ...patch,
      settlementError: 'canonical_terminal_handle_unavailable_after_restart',
    });
    clearExecutionTimeout(id);
    return;
  } else {
    const current = useTerminalExecutionStore.getState().executions[id];
    if (current?.status === 'cancelled' && status !== 'cancelled') return;
    useTerminalExecutionStore.getState().mark(id, status, patch);
  }
  if (['complete', 'failed', 'cancelled'].includes(status)) {
    clearExecutionTimeout(id);
    return;
  }
  if (status !== 'running') return;
  const execution = useTerminalExecutionStore.getState().executions[id];
  if (!execution?.timeoutMs || execution.timeoutMs <= 0) return;
  clearExecutionTimeout(id);
  const timer = setTimeout(() => {
    executionTimeouts.delete(id);
    const latest = useTerminalExecutionStore.getState().executions[id];
    if (latest?.status !== 'running') return;
    if (canonicalExecutions.has(id)) {
      void requestTerminalExecutionCancellation(id, { timedOut: true });
      return;
    }
    const terminate = latest.sessionId
      ? invoke<NativeTerminalKillResult>('terminal_kill', {
          sessionId: latest.sessionId,
        } satisfies NativeTerminalKillRequest).catch(() => undefined)
      : Promise.resolve();
    void terminate.finally(() => {
      useTerminalExecutionStore.getState().mark(id, 'failed', {
        exitCode: null,
        timedOut: true,
      });
    });
  }, execution.timeoutMs);
  executionTimeouts.set(id, timer);
}

export async function attachTerminalExecution(
  id: string | undefined,
  sessionId: string,
): Promise<boolean> {
  if (!id) return true;
  const record = canonicalExecutions.get(id);
  if (record) {
    if (!record.claimed || record.disposed || record.settled) return false;
    if (record.sessionId && record.sessionId !== sessionId) return false;
    await ensureTerminalExecutionExitListener();
    const stableSessionId = stableIdentifier(sessionId, 'sessionId');
    if (record.sessionId === stableSessionId && record.nativeOwnerDisposer) {
      canonicalSessionOwners.set(stableSessionId, id);
      return true;
    }
    const previousSessionId = record.sessionId;
    record.sessionId = stableSessionId;
    try {
      replaceWithNativeOwner(record);
    } catch (error) {
      record.sessionId = previousSessionId;
      throw error;
    }
    canonicalSessionOwners.set(stableSessionId, id);
    markCanonical(id, 'starting', { sessionId });
    const pendingExit = pendingNativeExits.get(stableSessionId);
    if (pendingExit) {
      pendingNativeExits.delete(stableSessionId);
      await settleTerminalExecutionFromNativeExit(id, pendingExit);
    }
    return true;
  }
  if (settledCanonicalExecutions.has(id)) return false;
  if (canonicalExecutionId(id)) {
    markCanonical(id, 'failed', {
      sessionId,
      settlementError: 'canonical_terminal_handle_unavailable_after_restart',
    });
    return false;
  }
  const execution = useTerminalExecutionStore.getState().executions[id];
  if (execution?.status === 'cancelled') {
    await invoke<NativeTerminalKillResult>('terminal_kill', { sessionId }).catch(() => undefined);
    return false;
  }
  markTerminalExecution(id, 'starting', { sessionId });
  return true;
}

function cancellationRequestId(result: JarvisCancellationRequestResult): string | undefined {
  return result.kind === 'intent_committed' ? result.cancellationRequestId : undefined;
}

export function terminalCancellationDisposition(
  result: JarvisCancellationRequestResult | null,
): 'pending' | 'terminal' | 'rejected' {
  if (result?.kind === 'intent_committed') return 'pending';
  if (result?.kind === 'already_terminal') return 'terminal';
  return 'rejected';
}

function localTerminalCancellationResult(id: string): JarvisCancellationRequestResult | null {
  if (!settledCanonicalExecutions.has(id)) return null;
  const execution = useTerminalExecutionStore.getState().executions[id];
  if (!execution || !['complete', 'failed', 'cancelled'].includes(execution.status)) return null;
  return {
    kind: 'already_terminal',
    terminalStatus:
      execution.status === 'complete'
        ? 'completed'
        : execution.status === 'cancelled'
          ? 'cancelled'
          : execution.timedOut
            ? 'timed_out'
            : 'failed',
  };
}

export async function requestTerminalExecutionCancellation(
  id: string,
  options: { timedOut?: boolean } = {},
): Promise<JarvisCancellationRequestResult | null> {
  const record = canonicalExecutions.get(id);
  if (!record || record.disposed || record.settled) return localTerminalCancellationResult(id);
  let result: JarvisCancellationRequestResult;
  try {
    result = await record.controller.requestCancellation();
  } catch {
    markCanonical(id, 'failed', {
      ...(options.timedOut ? { timedOut: true } : {}),
      settlementError: 'cancellation_request_failed',
    });
    return null;
  }
  const requestId = cancellationRequestId(result);
  if (requestId) record.cancellationRequestId = requestId;
  if (!record.settled && result.kind === 'intent_committed') {
    markCanonical(id, 'cancellation_requested', {
      ...(options.timedOut ? { timedOut: true } : {}),
    });
  }
  return result;
}

function resultReference(
  record: CanonicalExecutionRecord,
  payload: NativeTerminalExitPayload,
): string {
  return `jterminal_result:${record.request.executionId}:${payload.sessionId}:${payload.reason}:${
    payload.code ?? 'none'
  }`;
}

export type TerminalPreNativeFailure =
  | 'native_spawn_failed'
  | 'native_attach_failed'
  | 'pre_session_initialization_failed';

export async function failTerminalExecutionBeforeNativeExit(
  id: string,
  reason: TerminalPreNativeFailure,
): Promise<boolean> {
  const record = canonicalExecutions.get(id);
  if (!record || record.disposed || record.settled || record.sessionId) return false;
  if (record.settlement) {
    await record.settlement;
    return true;
  }
  record.settlement = (async () => {
    const completedAt = Date.now();
    try {
      const outcome = await record.controller.recordResult({
        state: 'degraded',
        resultRef: `jterminal_result:${id}:pre_native:${reason}:none`,
        completedAt,
      });
      if (outcome.kind !== 'committed') throw new TypeError(`result_${outcome.kind}`);
      markCanonical(id, 'failed', { exitCode: null, settlementError: reason });
    } catch (error) {
      markCanonical(id, 'failed', {
        exitCode: null,
        settlementError: error instanceof Error ? error.message : 'terminal_settlement_failed',
      });
    } finally {
      record.settled = true;
      disposeRecord(record);
      rememberSettledRecord(record);
    }
  })();
  await record.settlement;
  return true;
}

export async function settleTerminalExecutionFromNativeExit(
  id: string | undefined,
  payload: NativeTerminalExitPayload,
): Promise<boolean> {
  if (!id) return false;
  const record = canonicalExecutions.get(id);
  if (!record) {
    const settled = settledCanonicalExecutions.get(id);
    if (settled && (!settled.sessionId || settled.sessionId === payload.sessionId)) return true;
    if (canonicalExecutionId(id)) {
      markCanonical(id, 'failed', {
        sessionId: payload.sessionId,
        exitCode: payload.code,
        settlementError: 'canonical_terminal_handle_unavailable_after_restart',
      });
    }
    return false;
  }
  if (record.sessionId !== payload.sessionId) return false;
  if (record.settlement) {
    await record.settlement;
    return true;
  }
  if (record.settled) return true;
  if (
    payload.reason === 'accepted_cancellation' &&
    payload.cancellationToken !== record.request.cancellationToken
  ) {
    return false;
  }
  record.settlement = (async () => {
    const observedAt = Date.now();
    const resultRef = resultReference(record, payload);
    let terminalStatus: Extract<TerminalExecutionStatus, 'complete' | 'failed' | 'cancelled'> =
      'failed';
    try {
      if (payload.reason === 'accepted_cancellation' && !record.cancellationRequestId) {
        const reconciled = await record.controller.requestCancellation();
        const reconciledRequestId = cancellationRequestId(reconciled);
        if (!reconciledRequestId) throw new TypeError(`cancellation_${reconciled.kind}`);
        record.cancellationRequestId = reconciledRequestId;
      }
      if (payload.reason === 'accepted_cancellation') {
        const outcome = await record.controller.recordCancellationVerified({
          cancellationRequestId: record.cancellationRequestId!,
          resultRef,
          verifiedAt: observedAt,
        });
        if (outcome.kind !== 'committed') {
          throw new TypeError(`cancellation_${outcome.kind}`);
        }
        terminalStatus = 'cancelled';
      } else {
        const completed = payload.reason === 'natural_exit' && payload.code === 0;
        const outcome = await record.controller.recordResult({
          state: completed ? 'completed' : 'degraded',
          resultRef,
          completedAt: observedAt,
        });
        if (outcome.kind !== 'committed') throw new TypeError(`result_${outcome.kind}`);
        terminalStatus = completed ? 'complete' : 'failed';
      }
      markCanonical(id, terminalStatus, { exitCode: payload.code });
    } catch (error) {
      markCanonical(id, 'failed', {
        exitCode: payload.code,
        settlementError: error instanceof Error ? error.message : 'terminal_settlement_failed',
      });
    } finally {
      record.settled = true;
      disposeRecord(record);
      rememberSettledRecord(record);
    }
  })();
  await record.settlement;
  return true;
}
