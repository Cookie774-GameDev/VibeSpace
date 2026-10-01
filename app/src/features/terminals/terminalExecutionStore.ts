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
  processIdentity?: TerminalProcessIdentity;
  updatedAt: number;
}

export type NativeTerminalProcessBinding = Readonly<{
  processInstanceId: string;
  pid: number;
  processStartedAt: number;
  runtimeGeneration: string;
}>;

export type TerminalProcessAttachment = Readonly<
  NativeTerminalProcessBinding & {
    accountId: string;
    projectId: string | null;
    paneId: string;
    sessionId: string;
  }
>;

export type TerminalProcessIdentity = Readonly<
  TerminalProcessAttachment & {
    runId: string;
    executionId: string;
  }
>;

export type TerminalProcessIdentityScope = Readonly<{
  accountId: string;
  projectId: string | null;
  runId: string;
  executionId: string;
  paneId: string;
}>;

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
  processInstanceId: string;
  pid: number;
  processStartedAt: number;
  runtimeGeneration: string;
  code: number | null;
  reason: 'natural_exit' | 'accepted_cancellation' | 'manual_termination';
  cancellationToken?: string;
}>;

export type CanonicalTerminalExecutionRequest = Readonly<{
  accountId: string;
  workspaceId?: string;
  projectId?: string;
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
  processIdentity?: TerminalProcessIdentity;
  cancellationRequestId?: string;
  claimed: boolean;
  settled: boolean;
  disposed: boolean;
  settlement?: Promise<void>;
  accountRevocation?: Promise<boolean>;
};

const MAX_EXECUTIONS = 100;
const executionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const canonicalExecutions = new Map<string, CanonicalExecutionRecord>();
const canonicalSessionOwners = new Map<string, string>();
const canonicalProcessOwners = new Map<string, string>();
const pendingLegacyProcessAttachments = new Map<string, TerminalProcessAttachment>();
const pendingNativeExits = new Map<string, NativeTerminalExitPayload>();
const settledCanonicalExecutions = new Map<string, { processIdentity?: TerminalProcessIdentity }>();
let terminalExitListener: Promise<void> | undefined;

function stableIdentifier(value: string, label: string): string {
  return stableBoundedIdentifier(value, label, 256);
}

function stableBoundedIdentifier(value: string, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a stable nonblank identifier.`);
  }
  return value;
}

function validProcessNumber(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function createTerminalProcessIdentity(
  record: CanonicalExecutionRecord,
  attachment: TerminalProcessAttachment,
): TerminalProcessIdentity | null {
  try {
    if (stableIdentifier(attachment.accountId, 'accountId') !== record.request.accountId) {
      return null;
    }
    const projectId =
      attachment.projectId === null ? null : stableIdentifier(attachment.projectId, 'projectId');
    if (record.request.projectId !== undefined && projectId !== record.request.projectId) {
      return null;
    }
    const identity = Object.freeze({
      accountId: record.request.accountId,
      projectId,
      runId: record.request.runId,
      executionId: record.request.executionId,
      paneId: stableIdentifier(attachment.paneId, 'paneId'),
      sessionId: stableIdentifier(attachment.sessionId, 'sessionId'),
      processInstanceId: stableIdentifier(attachment.processInstanceId, 'processInstanceId'),
      pid: attachment.pid,
      processStartedAt: attachment.processStartedAt,
      runtimeGeneration: stableIdentifier(attachment.runtimeGeneration, 'runtimeGeneration'),
    });
    if (
      !validProcessNumber(identity.pid, 0xffff_ffff) ||
      !validProcessNumber(identity.processStartedAt, Number.MAX_SAFE_INTEGER)
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

function createLegacyTerminalProcessIdentity(
  execution: TerminalExecution,
  attachment: TerminalProcessAttachment,
): TerminalProcessIdentity | null {
  try {
    if (
      !execution.accountId ||
      !execution.runId ||
      stableIdentifier(attachment.accountId, 'accountId') !==
        stableIdentifier(execution.accountId, 'accountId')
    ) {
      return null;
    }
    const identity = Object.freeze({
      accountId: execution.accountId,
      projectId:
        attachment.projectId === null ? null : stableIdentifier(attachment.projectId, 'projectId'),
      runId: stableIdentifier(execution.runId, 'runId'),
      executionId: stableIdentifier(execution.id, 'executionId'),
      paneId: stableIdentifier(attachment.paneId, 'paneId'),
      sessionId: stableIdentifier(attachment.sessionId, 'sessionId'),
      processInstanceId: stableIdentifier(attachment.processInstanceId, 'processInstanceId'),
      pid: attachment.pid,
      processStartedAt: attachment.processStartedAt,
      runtimeGeneration: stableIdentifier(attachment.runtimeGeneration, 'runtimeGeneration'),
    });
    if (
      !validProcessNumber(identity.pid, 0xffff_ffff) ||
      !validProcessNumber(identity.processStartedAt, Number.MAX_SAFE_INTEGER)
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

function validateTerminalProcessAttachment(
  attachment: TerminalProcessAttachment,
): TerminalProcessAttachment | null {
  try {
    const validated = Object.freeze({
      accountId: stableIdentifier(attachment.accountId, 'accountId'),
      projectId:
        attachment.projectId === null ? null : stableIdentifier(attachment.projectId, 'projectId'),
      paneId: stableIdentifier(attachment.paneId, 'paneId'),
      sessionId: stableIdentifier(attachment.sessionId, 'sessionId'),
      processInstanceId: stableIdentifier(attachment.processInstanceId, 'processInstanceId'),
      pid: attachment.pid,
      processStartedAt: attachment.processStartedAt,
      runtimeGeneration: stableIdentifier(attachment.runtimeGeneration, 'runtimeGeneration'),
    });
    return validProcessNumber(validated.pid, 0xffff_ffff) &&
      validProcessNumber(validated.processStartedAt, Number.MAX_SAFE_INTEGER)
      ? validated
      : null;
  } catch {
    return null;
  }
}

function sameTerminalProcessAttachment(
  left: TerminalProcessAttachment,
  right: TerminalProcessAttachment,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.paneId === right.paneId &&
    left.sessionId === right.sessionId &&
    left.processInstanceId === right.processInstanceId &&
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

function sameTerminalProcessIdentity(
  left: TerminalProcessIdentity,
  right: TerminalProcessIdentity,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.runId === right.runId &&
    left.executionId === right.executionId &&
    left.paneId === right.paneId &&
    left.sessionId === right.sessionId &&
    left.processInstanceId === right.processInstanceId &&
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

function readConflictingLegacyProcessOwner(
  key: 'sessionId' | 'processInstanceId',
  value: string,
  claimantId: string,
): string | undefined {
  return Object.values(useTerminalExecutionStore.getState().executions).find(
    (execution) =>
      execution.id !== claimantId &&
      !canonicalExecutions.has(execution.id) &&
      execution.processIdentity?.[key] === value &&
      !['complete', 'failed', 'cancelled'].includes(execution.status),
  )?.id;
}

function nativeExitIdentityKey(
  payload: Pick<TerminalProcessIdentity, 'sessionId'> &
    Partial<
      Pick<
        TerminalProcessIdentity,
        'processInstanceId' | 'pid' | 'processStartedAt' | 'runtimeGeneration'
      >
    >,
): string {
  return JSON.stringify([
    payload.sessionId,
    payload.processInstanceId,
    payload.pid,
    payload.processStartedAt,
    payload.runtimeGeneration,
  ]);
}

function validNativeTerminalExitPayload(
  payload: NativeTerminalExitPayload,
): NativeTerminalExitPayload | null {
  try {
    const reason = payload.reason;
    if (
      reason !== 'natural_exit' &&
      reason !== 'accepted_cancellation' &&
      reason !== 'manual_termination'
    ) {
      return null;
    }
    if (
      payload.code !== null &&
      (!Number.isInteger(payload.code) || payload.code < -0x8000_0000 || payload.code > 0x7fff_ffff)
    ) {
      return null;
    }
    const cancellationToken =
      payload.cancellationToken === undefined
        ? undefined
        : stableBoundedIdentifier(payload.cancellationToken, 'cancellationToken', 512);
    if (
      (reason === 'accepted_cancellation' && cancellationToken === undefined) ||
      (reason !== 'accepted_cancellation' && cancellationToken !== undefined) ||
      !validProcessNumber(payload.pid, 0xffff_ffff) ||
      !validProcessNumber(payload.processStartedAt, Number.MAX_SAFE_INTEGER) ||
      typeof payload.processInstanceId !== 'string'
    ) {
      return null;
    }
    return Object.freeze({
      sessionId: stableIdentifier(payload.sessionId, 'sessionId'),
      processInstanceId: stableIdentifier(payload.processInstanceId, 'processInstanceId'),
      pid: payload.pid,
      processStartedAt: payload.processStartedAt,
      runtimeGeneration: stableIdentifier(payload.runtimeGeneration, 'runtimeGeneration'),
      code: payload.code,
      reason,
      ...(cancellationToken === undefined ? {} : { cancellationToken }),
    });
  } catch {
    return null;
  }
}

function exitMatchesProcessIdentity(
  payload: NativeTerminalExitPayload,
  identity: TerminalProcessIdentity,
): boolean {
  return (
    payload.sessionId === identity.sessionId &&
    payload.processInstanceId === identity.processInstanceId &&
    payload.pid === identity.pid &&
    payload.processStartedAt === identity.processStartedAt &&
    payload.runtimeGeneration === identity.runtimeGeneration
  );
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
  if (
    record.processIdentity &&
    canonicalProcessOwners.get(record.processIdentity.processInstanceId) ===
      record.request.executionId
  ) {
    canonicalProcessOwners.delete(record.processIdentity.processInstanceId);
  }
  clearExecutionTimeout(record.request.executionId);
}

function rememberSettledRecord(record: CanonicalExecutionRecord): void {
  settledCanonicalExecutions.delete(record.request.executionId);
  settledCanonicalExecutions.set(record.request.executionId, {
    ...(record.processIdentity === undefined ? {} : { processIdentity: record.processIdentity }),
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
  canonicalProcessOwners.clear();
  pendingLegacyProcessAttachments.clear();
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
          ...(state.executions[id]?.processIdentity
            ? { processIdentity: state.executions[id].processIdentity }
            : {}),
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
  const validated = validNativeTerminalExitPayload(payload);
  if (!validated) return false;
  const executionId = canonicalSessionOwners.get(validated.sessionId);
  if (executionId) return settleTerminalExecutionFromNativeExit(executionId, validated);
  const identityKey = nativeExitIdentityKey(validated);
  pendingNativeExits.delete(identityKey);
  pendingNativeExits.set(identityKey, validated);
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
  const canonical = canonicalExecutions.get(id);
  const canonicalRunId = canonical?.request.runId;
  const { processIdentity: _untrustedProcessIdentity, ...safePatch } = patch ?? {};
  useTerminalExecutionStore.getState().mark(id, status, {
    ...safePatch,
    ...(canonical?.processIdentity ? { processIdentity: canonical.processIdentity } : {}),
  });
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
      if (status === 'complete' && canonicalRunId) {
        void notifyDone('terminal', 'Terminal done', body, {
          completionIdentity: `jarvis-run:${canonicalRunId}`,
        });
        return;
      }
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
    ...(dependencies.request.workspaceId === undefined
      ? {}
      : { workspaceId: stableIdentifier(dependencies.request.workspaceId, 'workspaceId') }),
    ...(dependencies.request.projectId === undefined
      ? {}
      : { projectId: stableIdentifier(dependencies.request.projectId, 'projectId') }),
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

export async function claimTerminalExecution(
  executionId: string,
  scope: Readonly<{ accountId: string; workspaceId: string; projectId: string }>,
): Promise<boolean> {
  const record = canonicalExecutions.get(executionId);
  if (!record || record.disposed || record.settled) return false;
  if (
    record.request.accountId !== scope.accountId ||
    record.request.workspaceId !== scope.workspaceId ||
    record.request.projectId !== scope.projectId
  ) {
    return false;
  }
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

export function authorizeCanonicalTerminalSpawn(
  executionId: string | undefined,
  scope: Readonly<{ accountId: string; workspaceId: string; projectId: string | null }>,
): string | undefined {
  if (!executionId) return undefined;
  const record = canonicalExecutions.get(executionId);
  if (!record || !record.claimed || record.settled || record.disposed) return undefined;
  if (record.request.workspaceId === undefined && record.request.projectId === undefined) {
    return record.request.cancellationToken;
  }
  if (
    record.request.workspaceId === undefined ||
    record.request.projectId === undefined ||
    record.request.accountId !== scope.accountId ||
    record.request.workspaceId !== scope.workspaceId ||
    record.request.projectId !== scope.projectId
  ) {
    return undefined;
  }
  return record.request.cancellationToken;
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
    pendingLegacyProcessAttachments.delete(id);
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

function attachOwnedLegacyProcess(
  id: string,
  execution: TerminalExecution,
  attachment: TerminalProcessAttachment,
): boolean {
  const processIdentity = createLegacyTerminalProcessIdentity(execution, attachment);
  if (!processIdentity) return false;
  if (
    execution.processIdentity &&
    !sameTerminalProcessIdentity(execution.processIdentity, processIdentity)
  ) {
    return false;
  }
  const sessionOwner =
    canonicalSessionOwners.get(processIdentity.sessionId) ??
    readConflictingLegacyProcessOwner('sessionId', processIdentity.sessionId, id);
  const processOwner =
    canonicalProcessOwners.get(processIdentity.processInstanceId) ??
    readConflictingLegacyProcessOwner('processInstanceId', processIdentity.processInstanceId, id);
  if ((sessionOwner && sessionOwner !== id) || (processOwner && processOwner !== id)) {
    return false;
  }
  useTerminalExecutionStore.getState().mark(id, execution.status, {
    sessionId: processIdentity.sessionId,
    processIdentity,
  });
  return true;
}

export function bindLegacyTerminalExecutionOwner(
  id: string,
  accountId: string,
  runId: string,
): boolean {
  let stableAccountId: string;
  let stableRunId: string;
  try {
    stableAccountId = stableIdentifier(accountId, 'accountId');
    stableRunId = stableIdentifier(runId, 'runId');
  } catch {
    return false;
  }
  if (canonicalExecutions.has(id) || settledCanonicalExecutions.has(id)) return false;
  const execution = useTerminalExecutionStore.getState().executions[id];
  if (
    !execution ||
    ['complete', 'failed', 'cancelled'].includes(execution.status) ||
    (execution.accountId && execution.accountId !== stableAccountId) ||
    (execution.runId && execution.runId !== stableRunId)
  ) {
    return false;
  }
  useTerminalExecutionStore.getState().mark(id, execution.status, {
    accountId: stableAccountId,
    runId: stableRunId,
  });
  const owned = useTerminalExecutionStore.getState().executions[id]!;
  const pending = pendingLegacyProcessAttachments.get(id);
  if (!pending) return true;
  pendingLegacyProcessAttachments.delete(id);
  if (attachOwnedLegacyProcess(id, owned, pending)) return true;
  useTerminalExecutionStore.getState().mark(id, 'failed', {
    settlementError: 'legacy_terminal_native_attach_rejected',
  });
  return false;
}

export async function attachTerminalExecution(
  id: string | undefined,
  attachment: string | TerminalProcessAttachment,
): Promise<boolean> {
  const sessionId = typeof attachment === 'string' ? attachment : attachment.sessionId;
  if (!id) return true;
  const record = canonicalExecutions.get(id);
  if (record) {
    if (!record.claimed || record.disposed || record.settled) return false;
    if (typeof attachment === 'string') return false;
    const processIdentity = createTerminalProcessIdentity(record, attachment);
    if (!processIdentity) return false;
    if (
      record.processIdentity &&
      !sameTerminalProcessIdentity(record.processIdentity, processIdentity)
    ) {
      return false;
    }
    const sessionOwner =
      canonicalSessionOwners.get(processIdentity.sessionId) ??
      readConflictingLegacyProcessOwner('sessionId', processIdentity.sessionId, id);
    const processOwner =
      canonicalProcessOwners.get(processIdentity.processInstanceId) ??
      readConflictingLegacyProcessOwner('processInstanceId', processIdentity.processInstanceId, id);
    if ((sessionOwner && sessionOwner !== id) || (processOwner && processOwner !== id)) {
      return false;
    }
    await ensureTerminalExecutionExitListener();
    if (
      !record.claimed ||
      record.disposed ||
      record.settled ||
      (record.processIdentity &&
        !sameTerminalProcessIdentity(record.processIdentity, processIdentity))
    ) {
      return false;
    }
    const currentSessionOwner =
      canonicalSessionOwners.get(processIdentity.sessionId) ??
      readConflictingLegacyProcessOwner('sessionId', processIdentity.sessionId, id);
    const currentProcessOwner =
      canonicalProcessOwners.get(processIdentity.processInstanceId) ??
      readConflictingLegacyProcessOwner('processInstanceId', processIdentity.processInstanceId, id);
    if (
      (currentSessionOwner && currentSessionOwner !== id) ||
      (currentProcessOwner && currentProcessOwner !== id)
    ) {
      return false;
    }
    const stableSessionId = processIdentity.sessionId;
    if (
      record.sessionId === stableSessionId &&
      record.processIdentity &&
      record.nativeOwnerDisposer
    ) {
      canonicalSessionOwners.set(stableSessionId, id);
      canonicalProcessOwners.set(processIdentity.processInstanceId, id);
      return true;
    }
    const previousSessionId = record.sessionId;
    const previousProcessIdentity = record.processIdentity;
    record.sessionId = stableSessionId;
    record.processIdentity = processIdentity;
    try {
      replaceWithNativeOwner(record);
    } catch (error) {
      record.sessionId = previousSessionId;
      record.processIdentity = previousProcessIdentity;
      throw error;
    }
    canonicalSessionOwners.set(stableSessionId, id);
    canonicalProcessOwners.set(processIdentity.processInstanceId, id);
    markCanonical(id, 'starting', { sessionId: stableSessionId, processIdentity });
    const pendingKey = nativeExitIdentityKey(processIdentity);
    const pendingExit = pendingNativeExits.get(pendingKey);
    if (pendingExit) {
      pendingNativeExits.delete(pendingKey);
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
  if (execution && ['complete', 'failed'].includes(execution.status)) return false;
  if (execution?.accountId || execution?.runId) {
    if (typeof attachment === 'string') return false;
    return attachOwnedLegacyProcess(id, execution, attachment);
  }
  if (typeof attachment !== 'string') {
    const validated = validateTerminalProcessAttachment(attachment);
    if (!validated) return false;
    const pending = pendingLegacyProcessAttachments.get(id);
    if (pending && !sameTerminalProcessAttachment(pending, validated)) return false;
    pendingLegacyProcessAttachments.delete(id);
    pendingLegacyProcessAttachments.set(id, validated);
    while (pendingLegacyProcessAttachments.size > MAX_EXECUTIONS) {
      const oldest = pendingLegacyProcessAttachments.keys().next().value as string | undefined;
      if (!oldest) break;
      pendingLegacyProcessAttachments.delete(oldest);
    }
  }
  markTerminalExecution(id, 'starting', { sessionId });
  return true;
}

export function readTerminalProcessIdentity(
  executionId: string,
  scope: TerminalProcessIdentityScope,
): TerminalProcessIdentity | null {
  const identity =
    canonicalExecutions.get(executionId)?.processIdentity ??
    useTerminalExecutionStore.getState().executions[executionId]?.processIdentity;
  if (
    !identity ||
    scope.executionId !== executionId ||
    identity.accountId !== scope.accountId ||
    identity.projectId !== scope.projectId ||
    identity.runId !== scope.runId ||
    identity.executionId !== scope.executionId ||
    identity.paneId !== scope.paneId
  ) {
    return null;
  }
  return identity;
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

export type TerminalAccountRevocationResult = Readonly<{
  accountId: string;
  targeted: number;
  revoked: number;
  rejected: number;
}>;

function accountRevocationAccepted(
  record: CanonicalExecutionRecord,
  result: JarvisCancellationRequestResult | null,
): boolean {
  if (result?.kind === 'already_terminal') return record.disposed || record.settled;
  if (result?.kind !== 'intent_committed') return false;
  const ownerId = `terminal:${record.request.executionId}`;
  return result.aggregate.kind === 'queued_cancelled'
    ? result.aggregate.ownerId === ownerId &&
        result.aggregate.queueItemId === record.request.executionId
    : result.aggregate.kind === 'signal_delivered' && result.aggregate.ownerIds.includes(ownerId);
}

async function revokeTerminalExecution(record: CanonicalExecutionRecord): Promise<boolean> {
  if (record.disposed || record.settled) return true;
  if (record.accountRevocation) return record.accountRevocation;
  const revocation = requestTerminalExecutionCancellation(record.request.executionId)
    .then((result) => accountRevocationAccepted(record, result))
    .catch(() => false);
  record.accountRevocation = revocation;
  const accepted = await revocation;
  if (!accepted && record.accountRevocation === revocation) {
    record.accountRevocation = undefined;
  }
  return accepted;
}

/**
 * Requests canonical cancellation for every execution owned by one exact
 * account before App revokes that account's kernel authority. Requests are
 * intentionally serialized to avoid a teardown-time native IPC burst.
 */
export async function revokeTerminalExecutionsForAccount(
  accountIdInput: string,
): Promise<TerminalAccountRevocationResult> {
  const accountId = stableIdentifier(accountIdInput, 'accountId');
  const records = [...canonicalExecutions.values()].filter(
    (record) => !record.disposed && !record.settled && record.request.accountId === accountId,
  );
  let revoked = 0;
  for (const record of records) {
    if (await revokeTerminalExecution(record)) revoked += 1;
  }
  return Object.freeze({
    accountId,
    targeted: records.length,
    revoked,
    rejected: records.length - revoked,
  });
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
    const validated = validNativeTerminalExitPayload(payload);
    if (settled) {
      return Boolean(
        settled.processIdentity &&
        validated &&
        exitMatchesProcessIdentity(validated, settled.processIdentity),
      );
    }
    if (!validated) return false;
    payload = validated;
    if (canonicalExecutionId(id)) {
      markCanonical(id, 'failed', {
        sessionId: payload.sessionId,
        exitCode: payload.code,
        settlementError: 'canonical_terminal_handle_unavailable_after_restart',
      });
    }
    return false;
  }
  const validated = validNativeTerminalExitPayload(payload);
  if (!validated || !record.processIdentity) return false;
  payload = validated;
  if (!exitMatchesProcessIdentity(payload, record.processIdentity)) return false;
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
