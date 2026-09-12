import Dexie from 'dexie';
import type {
  JarvisApprovalV1,
  JarvisArtifactV1,
  JarvisAttemptEffectClaimInput,
  JarvisAttemptEffectClaimResult,
  JarvisDurableLiveEvidenceV1,
  JarvisEvent,
  JarvisLiveProducerIdentity,
  JarvisPreEffectTransportFailureEvidence,
  JarvisRun,
  JarvisRunStatus,
  JarvisScheduledRetrySnapshotV1,
  JarvisTransportAttemptV1,
  JarvisZeroConsequentialEffectEvidenceV1,
} from '@/lib/jarvis/contracts/execution';
import {
  validateJarvisDurableLiveEvidence,
  validateJarvisEvent,
} from '@/lib/jarvis/contracts/validators';
import {
  assertJarvisArtifactCommitCapabilityInternal,
  type JarvisArtifactRuntimeInternals,
} from '@/lib/jarvis/artifactRuntimeInternals';
import type { JarvisIdentityRevision } from '@/lib/jarvis/identity';
import type { JarvisProfile } from '@/lib/jarvis/profiles/types';
import { db, type JarvisDexie } from './index';
import {
  fromJarvisApprovalRow,
  fromJarvisArtifactRow,
  fromJarvisEventRow,
  fromJarvisIdentityRevisionRow,
  fromJarvisProfileRow,
  fromJarvisRunRow,
  toJarvisArtifactRow,
  toJarvisApprovalRow,
  toJarvisEventRow,
  toJarvisIdentityRevisionRow,
  toJarvisProfileRow,
  toJarvisRunRow,
  type JarvisProfileMigrationMetadata,
} from './jarvisMappers';
import type { KernelApprovalTransactionContext } from './kernelTurnTransactionAuthority';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;
const MAX_TRANSPORT_ATTEMPTS = 32;
const JARVIS_ATTEMPT_EFFECT_IDEMPOTENCY_PREFIX = 'jeffect:';

export interface JarvisIdentityRepository {
  getVersion(identityId: 'jarvis', version: number): Promise<JarvisIdentityRevision | undefined>;
  putIfAbsent(revision: JarvisIdentityRevision): Promise<JarvisIdentityRevision>;
}

export interface JarvisProfileRepository {
  getById(accountId: string, profileId: string): Promise<JarvisProfile | undefined>;
  getActive(accountId: string): Promise<JarvisProfile | undefined>;
  putForAccount(
    accountId: string,
    input: {
      profile: JarvisProfile;
      migration: JarvisProfileMigrationMetadata;
    },
  ): Promise<JarvisProfile>;
  updateCustomInstructions(
    accountId: string,
    profileId: string,
    customInstructions: string,
  ): Promise<JarvisProfile>;
}

export type JarvisRunTransitionEventInput = Omit<JarvisEvent, 'runId' | 'seq' | 'type' | 'status'>;

export interface JarvisRunRepository {
  createIdempotent(run: JarvisRun): Promise<JarvisRun>;
  getById(accountId: string, runId: string): Promise<JarvisRun | undefined>;
  listByAccount(
    accountId: string,
    options?: { statuses?: JarvisRunStatus[]; limit?: number },
  ): Promise<JarvisRun[]>;
  compareAndAppendTransitionEvent(input: {
    accountId: string;
    runId: string;
    expectedStatus: JarvisRunStatus;
    nextStatus: JarvisRunStatus;
    updatedAt: number;
    completedAt?: number;
    event: JarvisRunTransitionEventInput;
  }): Promise<
    { applied: true; run: JarvisRun; event: JarvisEvent } | { applied: false; current: JarvisRun }
  >;
  compareAndMutateTransportAttempt(
    input: JarvisTransportAttemptMutationInput,
  ): Promise<
    | { applied: true; run: JarvisRun; event: JarvisEvent }
    | { applied: false; current: JarvisRun; reason: 'status_conflict' | 'attempt_conflict' }
  >;
  claimAttemptEffect(input: JarvisAttemptEffectClaimInput): Promise<JarvisAttemptEffectClaimResult>;
}

export type JarvisTransportAttemptMutationInput =
  | {
      kind: 'begin_initial';
      accountId: string;
      runId: string;
      expectedStatus: 'queued';
      snapshot: Readonly<JarvisScheduledRetrySnapshotV1>;
      attempt: Omit<JarvisTransportAttemptV1, 'startedEventSeq'>;
      updatedAt: number;
    }
  | {
      kind: 'begin_retry';
      accountId: string;
      runId: string;
      expectedStatus: 'running';
      expectedSnapshot: Readonly<JarvisScheduledRetrySnapshotV1>;
      expectedLatestAttemptNumber: number;
      expectedBarrierVersion: 0;
      expectedEventTailSeq: number;
      revalidatedEvidence: JarvisZeroConsequentialEffectEvidenceV1;
      attempt: Omit<JarvisTransportAttemptV1, 'startedEventSeq'>;
      updatedAt: number;
    }
  | {
      kind: 'settle_retryable';
      accountId: string;
      runId: string;
      expectedStatus: 'running';
      expectedSnapshot: Readonly<JarvisScheduledRetrySnapshotV1>;
      expectedAttemptNumber: number;
      expectedBarrierVersion: 0;
      expectedEventTailSeq: number;
      providerFailure: JarvisPreEffectTransportFailureEvidence;
      zeroEffectEvidence: JarvisZeroConsequentialEffectEvidenceV1;
      updatedAt: number;
    }
  | {
      kind: 'settle_uncertain_failed';
      accountId: string;
      runId: string;
      expectedStatus: 'running';
      expectedSnapshot: Readonly<JarvisScheduledRetrySnapshotV1>;
      expectedAttemptNumber: number;
      providerFailure: JarvisPreEffectTransportFailureEvidence;
      updatedAt: number;
      completedAt: number;
    };

export type JarvisNonTransitionEventInput = Omit<JarvisEvent, 'runId' | 'seq' | 'type'> & {
  type: Exclude<JarvisEvent['type'], 'run_state'>;
};

export interface JarvisEventRepository {
  appendIdempotent(
    accountId: string,
    runId: string,
    event: JarvisNonTransitionEventInput,
  ): Promise<JarvisEvent>;
  listByRun(
    accountId: string,
    runId: string,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<JarvisEvent[]>;
  getBySeq(accountId: string, runId: string, seq: number): Promise<JarvisEvent | undefined>;
}

/** @internal Closed test harness only; production modules must not import this authority. */
export interface JarvisLiveEvidenceEventCommitAuthority {
  appendLiveEvidence(input: {
    accountId: string;
    runId: string;
    evidence: JarvisDurableLiveEvidenceV1;
  }): Promise<JarvisEvent>;
}

export interface JarvisApprovalRepository {
  getById(accountId: string, approvalId: string): Promise<JarvisApprovalV1 | undefined>;
  listByRun(
    accountId: string,
    runId: string,
    options?: {
      requestId?: string;
      attemptNumber?: number;
      createdAtOrAfter?: number;
      limit?: number;
    },
  ): Promise<JarvisApprovalV1[]>;
}

export interface JarvisArtifactRepository {
  getById(accountId: string, artifactId: string): Promise<JarvisArtifactV1 | undefined>;
  listByRun(accountId: string, runId: string, limit?: number): Promise<JarvisArtifactV1[]>;
}

/** @internal Trusted artifact composition only; never expose to UI or model code. */
export interface JarvisArtifactCommitAuthority {
  putForRun(accountId: string, artifact: JarvisArtifactV1): Promise<JarvisArtifactV1>;
}

export type JarvisRepositoryErrorCode =
  | 'account_scope_mismatch'
  | 'parent_run_not_found'
  | 'run_id_conflict'
  | 'event_idempotency_conflict'
  | 'transition_event_requires_atomic_run_update'
  | 'live_evidence_integrity_error'
  | 'transport_attempt_integrity_error'
  | 'attempt_effect_integrity_error'
  | 'profile_integrity_error'
  | 'artifact_integrity_error'
  | 'approval_integrity_error'
  | 'approval_scope_mismatch'
  | 'approval_status_conflict'
  | 'invalid_limit';

export class JarvisRepositoryError extends Error {
  readonly code: JarvisRepositoryErrorCode;

  constructor(code: JarvisRepositoryErrorCode) {
    super(code);
    this.name = 'JarvisRepositoryError';
    this.code = code;
  }
}

export type JarvisRepositories = {
  identity: JarvisIdentityRepository;
  profile: JarvisProfileRepository;
  run: JarvisRunRepository;
  event: JarvisEventRepository;
  approval: JarvisApprovalRepository;
  artifact: JarvisArtifactRepository;
};

export function newJarvisProfileRevisionId(): string {
  return `jprof_rev_${crypto.randomUUID()}`;
}

function repositoryError(code: JarvisRepositoryErrorCode): never {
  throw new JarvisRepositoryError(code);
}

function detachRepositoryInput<T>(value: T, errorCode: JarvisRepositoryErrorCode): T {
  try {
    return structuredClone(value);
  } catch {
    repositoryError(errorCode);
  }
}

function assertAccountId(accountId: string): void {
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId !== accountId.trim()) {
    repositoryError('account_scope_mismatch');
  }
}

function normalizedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIMIT) {
    repositoryError('invalid_limit');
  }
  return resolved;
}

function assertAfterSeq(afterSeq: number | undefined): void {
  if (
    afterSeq !== undefined &&
    (!Number.isSafeInteger(afterSeq) || !Number.isFinite(afterSeq) || afterSeq < 0)
  ) {
    repositoryError('invalid_limit');
  }
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    repositoryError('event_idempotency_conflict');
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function scheduledRetrySnapshotMatchesRun(
  snapshot: unknown,
  run: Readonly<JarvisRun>,
): snapshot is Readonly<JarvisScheduledRetrySnapshotV1> {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const value = snapshot as Partial<JarvisScheduledRetrySnapshotV1>;
  const request = value.request;
  return (
    !!request &&
    value.accountId === run.accountId &&
    request.accountId === run.accountId &&
    request.runId === run.id &&
    request.surface === 'schedule' &&
    request.workspaceId === run.workspaceId &&
    request.projectId === run.projectId &&
    request.chatId === run.chatId &&
    request.parentRunId === run.parentRunId &&
    request.agent?.id === run.agentId &&
    request.identity?.identityVersion === run.identityVersion &&
    request.profile?.revisionId === run.profileRevisionId &&
    valuesEqual(request.model, run.model)
  );
}

function normalizeCustomInstructions(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

async function requireOwnedRun(database: JarvisDexie, accountId: string, runId: string) {
  const row = await database.jarvis_runs.get(runId);
  if (!row || row.account_id !== accountId) repositoryError('parent_run_not_found');
  return row;
}

function nextSequence(lastSequence: number | undefined): number {
  const next = (lastSequence ?? 0) + 1;
  if (!Number.isSafeInteger(next)) repositoryError('event_idempotency_conflict');
  return next;
}

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isStableText(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) repositoryError('live_evidence_integrity_error');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function liveEvidenceOperationsAreClosed(evidence: JarvisDurableLiveEvidenceV1): boolean {
  const allowed =
    evidence.kind === 'model'
      ? new Set(['generate', 'stream', 'embed'])
      : new Set(['execute', 'cancel', 'inspect']);
  return (
    evidence.operations.length > 0 &&
    new Set(evidence.operations).size === evidence.operations.length &&
    evidence.operations.every((operation) => allowed.has(operation))
  );
}

function sameLiveEvidenceOccurrence(
  left: JarvisDurableLiveEvidenceV1,
  right: JarvisDurableLiveEvidenceV1,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.attemptNumber === right.attemptNumber &&
    left.registrationId === right.registrationId &&
    left.previousProofRef === right.previousProofRef
  );
}

async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function transportAttemptInputIsValid(
  attempt: Omit<JarvisTransportAttemptV1, 'startedEventSeq'>,
  expected: { number: number; kind: JarvisTransportAttemptV1['kind'] },
): boolean {
  return (
    attempt.schemaVersion === 1 &&
    attempt.attemptNumber === expected.number &&
    attempt.kind === expected.kind &&
    isStableText(attempt.requestId) &&
    attempt.state === 'provider_in_flight' &&
    attempt.effectBarrier.state === 'open' &&
    attempt.effectBarrier.version === 0 &&
    isFiniteTimestamp(attempt.effectBarrier.updatedAt) &&
    isFiniteTimestamp(attempt.createdAt) &&
    isFiniteTimestamp(attempt.updatedAt) &&
    attempt.failureCategory === undefined &&
    attempt.zeroEffectEvidence === undefined
  );
}

function transportEvidenceMatches(
  run: JarvisRun,
  attempt: JarvisTransportAttemptV1,
  failure: JarvisPreEffectTransportFailureEvidence,
): boolean {
  return (
    failure.schemaVersion === 1 &&
    failure.accountId === run.accountId &&
    failure.runId === run.id &&
    failure.requestId === attempt.requestId &&
    failure.attemptNumber === attempt.attemptNumber &&
    failure.providerId === run.model.providerId &&
    failure.modelId === run.model.modelId &&
    failure.boundary === 'before_first_response_byte' &&
    failure.responseStarted === false &&
    failure.chunkCount === 0 &&
    failure.actionDispatchCount === 0 &&
    isStableText(failure.failureCategory) &&
    isStableText(failure.evidenceRef) &&
    isFiniteTimestamp(failure.verifiedAt)
  );
}

function zeroEffectEvidenceMatches(
  run: JarvisRun,
  attempt: JarvisTransportAttemptV1,
  failure: JarvisPreEffectTransportFailureEvidence,
  evidence: JarvisZeroConsequentialEffectEvidenceV1,
): boolean {
  return (
    evidence.schemaVersion === 1 &&
    evidence.accountId === run.accountId &&
    evidence.runId === run.id &&
    evidence.requestId === attempt.requestId &&
    evidence.attemptNumber === attempt.attemptNumber &&
    valuesEqual(evidence.providerBoundary, failure) &&
    evidence.effectBarrier.state === 'open' &&
    evidence.effectBarrier.version === 0 &&
    evidence.approvals.count === 0 &&
    evidence.artifacts.count === 0 &&
    evidence.executorClaims.count === 0 &&
    Number.isSafeInteger(evidence.executorClaims.throughSeq) &&
    evidence.executorClaims.throughSeq >= 0 &&
    isFiniteTimestamp(evidence.assessedAt)
  );
}

function zeroEffectEvidenceExtends(
  run: JarvisRun,
  attempt: JarvisTransportAttemptV1,
  previous: JarvisZeroConsequentialEffectEvidenceV1,
  candidate: JarvisZeroConsequentialEffectEvidenceV1,
): boolean {
  return (
    zeroEffectEvidenceMatches(run, attempt, previous.providerBoundary, previous) &&
    zeroEffectEvidenceMatches(run, attempt, candidate.providerBoundary, candidate) &&
    valuesEqual(candidate.providerBoundary, previous.providerBoundary) &&
    valuesEqual(candidate.effectBarrier, previous.effectBarrier) &&
    valuesEqual(candidate.approvals, previous.approvals) &&
    valuesEqual(candidate.artifacts, previous.artifacts) &&
    candidate.executorClaims.throughSeq >= previous.executorClaims.throughSeq
  );
}

function transportEventInput(input: {
  runId: string;
  seq: number;
  idempotencyKey: string;
  type: 'run_state' | 'warning';
  status: string;
  title: string;
  safeSummary: string;
  createdAt: number;
  producerSourceEvidence?: NonNullable<JarvisEvent['producerSourceEvidence']>;
  canonicalResultEvidence?: NonNullable<JarvisEvent['canonicalResultEvidence']>;
}): JarvisEvent {
  return {
    ...input,
    sourceRefs: [],
    artifactIds: [],
  };
}

function scheduledTransportSettlementEvidence(
  run: Readonly<JarvisRun>,
  attempt: Readonly<JarvisTransportAttemptV1>,
  observedAt: number,
): NonNullable<JarvisEvent['canonicalResultEvidence']> {
  return {
    schemaVersion: 1,
    kind: 'scheduled_transport_settled',
    accountId: run.accountId,
    runId: run.id,
    requestId: attempt.requestId,
    attemptNumber: attempt.attemptNumber,
    state: 'degraded',
    resultRef: `jresult_${run.id}_${attempt.requestId}_${attempt.attemptNumber}_transport`,
    observedAt,
  };
}

function scheduleAttemptStartSource(
  run: Readonly<JarvisRun>,
  snapshot: Readonly<JarvisScheduledRetrySnapshotV1>,
  attempt: Readonly<Omit<JarvisTransportAttemptV1, 'startedEventSeq'>>,
  observedAt: number,
): NonNullable<JarvisEvent['producerSourceEvidence']> {
  return {
    schemaVersion: 1,
    accountId: run.accountId,
    runId: run.id,
    requestId: attempt.requestId,
    attemptNumber: attempt.attemptNumber,
    producerKind: 'schedule',
    producerIdentity: {
      producerKind: 'schedule',
      eventId: snapshot.eventId,
      occurrenceId: snapshot.occurrenceId,
    },
    resultRef: `jstart_${run.id}_${attempt.requestId}_${attempt.attemptNumber}`,
    observedAt,
    phase: 'start',
    state: 'started',
  };
}

function attemptEffectClaimIdempotencyKey(input: JarvisAttemptEffectClaimInput): string {
  return `${JARVIS_ATTEMPT_EFFECT_IDEMPOTENCY_PREFIX}${input.runId}:${input.requestId}:${input.attemptNumber}:${encodeURIComponent(input.ownerKind)}:${encodeURIComponent(input.ownerId)}:${encodeURIComponent(input.evidenceRef)}`;
}

function attemptEffectClaimEvent(input: JarvisAttemptEffectClaimInput, seq: number): JarvisEvent {
  return {
    runId: input.runId,
    seq,
    idempotencyKey: attemptEffectClaimIdempotencyKey(input),
    type: 'tool',
    status: 'consequential_effect_claimed',
    title: 'Consequential effect claimed',
    safeSummary: 'An execution owner claimed the current attempt barrier.',
    sourceRefs: [],
    artifactIds: [],
    createdAt: input.claimedAt,
    executionEvidence: {
      schemaVersion: 1,
      requestId: input.requestId,
      attemptNumber: input.attemptNumber,
      kind: 'consequential_effect_claimed',
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      evidenceRef: input.evidenceRef,
      observedAt: input.claimedAt,
    },
  };
}

async function lastEventForRun(database: JarvisDexie, runId: string) {
  return database.jarvis_events
    .where('[run_id+seq]')
    .between([runId, Dexie.minKey], [runId, Dexie.maxKey], true, true)
    .last();
}

export type CreatePendingApprovalInContextInput = Readonly<{
  accountId: string;
  approval: JarvisApprovalV1;
  expectedEventTailSeq: number;
}>;

export type DecideApprovalInContextInput = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  approvalId: string;
  decision: 'approve' | 'deny' | 'expire';
  decidedAt: number;
  expectedEventTailSeq: number;
}>;

export type ClaimApprovedExecutionInContextInput = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  approvalId: string;
  producerKind: 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp';
  ownerId: string;
  evidenceRef: string;
  startedAt: number;
  expectedEventTailSeq: number;
}>;

export type ClaimSafeAutoExecutionInContextInput = Readonly<{
  accountId: string;
  approval: JarvisApprovalV1;
  producerKind: 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp';
  ownerId: string;
  evidenceRef: string;
  startedAt: number;
  expectedEventTailSeq: number;
}>;

type ApprovalAttemptPhase = 'create' | 'pending' | 'claim' | 'safe_auto';

function requireApprovalInputText(value: string): void {
  if (!isStableText(value)) repositoryError('approval_integrity_error');
}

function approvalLifecycleIsCoherent(approval: JarvisApprovalV1): boolean {
  const decidedAt = approval.decidedAt;
  const consumedAt = approval.consumedAt;
  if (approval.status === 'pending') {
    return decidedAt === undefined && consumedAt === undefined;
  }
  if (
    approval.status === 'approved' ||
    approval.status === 'denied' ||
    approval.status === 'expired'
  ) {
    return (
      decidedAt !== undefined &&
      isFiniteTimestamp(decidedAt) &&
      decidedAt >= approval.createdAt &&
      consumedAt === undefined
    );
  }
  return (
    decidedAt !== undefined &&
    consumedAt !== undefined &&
    isFiniteTimestamp(decidedAt) &&
    isFiniteTimestamp(consumedAt) &&
    decidedAt >= approval.createdAt &&
    consumedAt >= decidedAt
  );
}

async function openApprovalsForRun(context: KernelApprovalTransactionContext, runId: string) {
  return context.jarvis_approvals
    .where('run_id')
    .equals(runId)
    .filter((row) => row.status === 'pending' || row.status === 'approved')
    .toArray();
}

function hasOnlyOpenApproval(
  rows: readonly Readonly<{ id: string }>[],
  approvalId: string,
): boolean {
  return rows.length === 1 && rows[0]?.id === approvalId;
}

async function requireApprovalOwnedRun(
  context: KernelApprovalTransactionContext,
  accountId: string,
  runId: string,
): Promise<JarvisRun> {
  requireApprovalInputText(accountId);
  requireApprovalInputText(runId);
  const row = await context.jarvis_runs.get(runId);
  if (!row || row.account_id !== accountId) repositoryError('approval_scope_mismatch');
  return fromJarvisRunRow(row);
}

function currentApprovalAttempts(
  run: JarvisRun,
  requestId: string,
  attemptNumber: number,
  phase: ApprovalAttemptPhase,
): readonly JarvisTransportAttemptV1[] | undefined {
  requireApprovalInputText(requestId);
  if (!isPositiveSafeInteger(attemptNumber)) repositoryError('approval_integrity_error');
  const attempts = run.transportAttempts;
  if (!attempts || attempts.length === 0) {
    if (run.source === 'schedule' || attemptNumber !== 1) {
      repositoryError('approval_scope_mismatch');
    }
    return undefined;
  }
  if (run.source !== 'schedule') repositoryError('approval_scope_mismatch');
  const latest = attempts.at(-1);
  if (
    !latest ||
    latest.state !== 'provider_in_flight' ||
    latest.requestId !== requestId ||
    latest.attemptNumber !== attemptNumber
  ) {
    repositoryError('approval_scope_mismatch');
  }
  if (phase === 'create' || phase === 'safe_auto') {
    if (latest.effectBarrier.state !== 'open' || latest.effectBarrier.version !== 0) {
      repositoryError('approval_status_conflict');
    }
  } else if (
    latest.effectBarrier.state !== 'dirty' ||
    !Number.isSafeInteger(latest.effectBarrier.version) ||
    latest.effectBarrier.version < 1
  ) {
    repositoryError('approval_status_conflict');
  }
  return attempts;
}

function dirtyApprovalAttempt(
  attempts: readonly JarvisTransportAttemptV1[] | undefined,
  updatedAt: number,
): readonly JarvisTransportAttemptV1[] | undefined {
  if (!attempts) return undefined;
  const updated = structuredClone([...attempts]);
  const latest = updated.at(-1)!;
  updated[updated.length - 1] = {
    ...latest,
    effectBarrier: {
      state: 'dirty',
      version: latest.effectBarrier.version + 1,
      updatedAt,
    },
    updatedAt,
  };
  return updated;
}

async function lastApprovalContextEvent(context: KernelApprovalTransactionContext, runId: string) {
  return context.jarvis_events
    .where('[run_id+seq]')
    .between([runId, Dexie.minKey], [runId, Dexie.maxKey], true, true)
    .last();
}

function approvalEvent(input: {
  runId: string;
  seq: number;
  idempotencyKey: string;
  status: string;
  title: string;
  safeSummary: string;
  createdAt: number;
}): JarvisEvent {
  return {
    ...input,
    type: 'approval',
    sourceRefs: [],
    artifactIds: [],
  };
}

function approvalRunEvent(input: {
  runId: string;
  seq: number;
  idempotencyKey: string;
  status: 'awaiting_approval' | 'running';
  title: string;
  safeSummary: string;
  createdAt: number;
}): JarvisEvent {
  return {
    ...input,
    type: 'run_state',
    sourceRefs: [],
    artifactIds: [],
  };
}

function approvalProducerIdentity(
  producerKind: ClaimApprovedExecutionInContextInput['producerKind'],
  approval: JarvisApprovalV1,
  ownerId: string,
): JarvisLiveProducerIdentity {
  if (producerKind === 'action') {
    return {
      producerKind,
      actionId: approval.actionId,
      actionVersion: approval.actionVersion,
      executionId: ownerId,
    };
  }
  if (producerKind === 'file_action') {
    return {
      producerKind,
      actionId: approval.actionId,
      actionVersion: approval.actionVersion,
      resultId: ownerId,
    };
  }
  if (producerKind === 'terminal') {
    return { producerKind, sessionId: `jterm_${approval.id}`, executionId: ownerId };
  }
  if (producerKind === 'plugin') {
    return { producerKind, pluginId: approval.actionId, invocationId: ownerId };
  }
  return {
    producerKind,
    serverId: approval.capabilityId,
    toolName: approval.actionId,
    invocationId: ownerId,
  };
}

function approvalClaimEvent(input: {
  approval: JarvisApprovalV1;
  producerKind: ClaimApprovedExecutionInContextInput['producerKind'];
  ownerId: string;
  evidenceRef: string;
  startedAt: number;
  seq: number;
}): JarvisEvent {
  const ownerKind = input.producerKind === 'file_action' ? 'file' : input.producerKind;
  return {
    runId: input.approval.runId,
    seq: input.seq,
    idempotencyKey: `${JARVIS_ATTEMPT_EFFECT_IDEMPOTENCY_PREFIX}${input.approval.runId}:${input.approval.requestId}:${input.approval.attemptNumber}:${encodeURIComponent(ownerKind)}:${encodeURIComponent(input.ownerId)}:${encodeURIComponent(input.evidenceRef)}`,
    type: 'tool',
    status: 'consequential_effect_claimed',
    title: 'Approved action execution claimed',
    safeSummary: 'The approved execution claimed the current attempt barrier.',
    sourceRefs: [],
    artifactIds: [],
    createdAt: input.startedAt,
    executionEvidence: {
      schemaVersion: 1,
      requestId: input.approval.requestId,
      attemptNumber: input.approval.attemptNumber,
      kind: 'consequential_effect_claimed',
      ownerKind,
      ownerId: input.ownerId,
      evidenceRef: input.evidenceRef,
      observedAt: input.startedAt,
    },
    producerSourceEvidence: {
      schemaVersion: 1,
      accountId: '',
      runId: input.approval.runId,
      requestId: input.approval.requestId,
      attemptNumber: input.approval.attemptNumber,
      producerKind: input.producerKind,
      producerIdentity: approvalProducerIdentity(input.producerKind, input.approval, input.ownerId),
      resultRef: input.evidenceRef,
      observedAt: input.startedAt,
      phase: 'start',
      state: 'ready',
    } as JarvisEvent['producerSourceEvidence'],
  };
}

function withClaimAccount(event: JarvisEvent, accountId: string): JarvisEvent {
  return {
    ...event,
    producerSourceEvidence: event.producerSourceEvidence
      ? { ...event.producerSourceEvidence, accountId }
      : undefined,
  };
}

function requireExpectedApprovalTail(expectedEventTailSeq: number, actualTailSeq: number): void {
  if (!Number.isSafeInteger(expectedEventTailSeq) || expectedEventTailSeq < 0) {
    repositoryError('approval_integrity_error');
  }
  if (actualTailSeq !== expectedEventTailSeq) repositoryError('approval_scope_mismatch');
}

async function hasCommittedCancellationIntent(
  context: KernelApprovalTransactionContext,
  runId: string,
): Promise<boolean> {
  return Boolean(
    await context.jarvis_events
      .where('run_id')
      .equals(runId)
      .filter((row) => row.status === 'cancellation_requested')
      .first(),
  );
}

async function readBackApprovalCommit(
  context: KernelApprovalTransactionContext,
  expectedRunRow: ReturnType<typeof toJarvisRunRow>,
  expectedApprovalRow: ReturnType<typeof toJarvisApprovalRow>,
  expectedEventRows: readonly ReturnType<typeof toJarvisEventRow>[],
) {
  const [runRow, approvalRow, eventRows] = await Promise.all([
    context.jarvis_runs.get(expectedRunRow.id),
    context.jarvis_approvals.get(expectedApprovalRow.id),
    Promise.all(expectedEventRows.map((row) => context.jarvis_events.get([row.run_id, row.seq]))),
  ]);
  if (
    !runRow ||
    !approvalRow ||
    !valuesEqual(runRow, expectedRunRow) ||
    !valuesEqual(approvalRow, expectedApprovalRow) ||
    eventRows.some((row, index) => !row || !valuesEqual(row, expectedEventRows[index]))
  ) {
    repositoryError('approval_integrity_error');
  }
  return {
    run: fromJarvisRunRow(runRow),
    approval: fromJarvisApprovalRow(approvalRow),
    events: eventRows.map((row) => fromJarvisEventRow(row!)),
  };
}

function replayRunMatches(
  run: JarvisRun,
  input: {
    status: 'awaiting_approval' | 'running';
    updatedAt: number;
    requestId: string;
    attemptNumber: number;
    minimumBarrierVersion?: number;
  },
): boolean {
  if (run.status !== input.status || run.updatedAt !== input.updatedAt) return false;
  const attempts = run.transportAttempts;
  if (!attempts || attempts.length === 0) {
    return run.source !== 'schedule' && input.attemptNumber === 1;
  }
  const latest = attempts.at(-1);
  return Boolean(
    run.source === 'schedule' &&
    latest &&
    latest.state === 'provider_in_flight' &&
    latest.requestId === input.requestId &&
    latest.attemptNumber === input.attemptNumber &&
    latest.effectBarrier.state === 'dirty' &&
    latest.effectBarrier.version >= (input.minimumBarrierVersion ?? 1) &&
    latest.effectBarrier.updatedAt <= input.updatedAt,
  );
}

/** @internal Requires the caller's already-open exact three-table transaction. */
export async function createPendingApprovalInContext(
  context: KernelApprovalTransactionContext,
  input: CreatePendingApprovalInContextInput,
) {
  const desiredRow = toJarvisApprovalRow(input.approval);
  if (
    input.approval.status !== 'pending' ||
    !approvalLifecycleIsCoherent(input.approval) ||
    input.approval.expiresAt <= input.approval.createdAt
  ) {
    repositoryError('approval_integrity_error');
  }
  const run = await requireApprovalOwnedRun(context, input.accountId, input.approval.runId);
  const [existing, open, cancellation, tail] = await Promise.all([
    context.jarvis_approvals.get(input.approval.id),
    openApprovalsForRun(context, run.id),
    context.jarvis_events
      .where('run_id')
      .equals(run.id)
      .filter((row) => row.status === 'cancellation_requested')
      .first(),
    lastApprovalContextEvent(context, run.id),
  ]);
  requireExpectedApprovalTail(input.expectedEventTailSeq, input.expectedEventTailSeq);
  const eventSeq = input.expectedEventTailSeq + 1;
  const events = [
    approvalRunEvent({
      runId: run.id,
      seq: eventSeq,
      idempotencyKey: `japproval:${input.approval.id}:awaiting`,
      status: 'awaiting_approval',
      title: 'Approval required',
      safeSummary: 'The protected run is waiting for an approval decision.',
      createdAt: input.approval.createdAt,
    }),
    approvalEvent({
      runId: run.id,
      seq: eventSeq + 1,
      idempotencyKey: input.approval.id,
      status: 'pending',
      title: 'Approval pending',
      safeSummary: 'A scoped action approval is pending.',
      createdAt: input.approval.createdAt,
    }),
  ];
  const eventRows = events.map(toJarvisEventRow);
  if (existing) {
    if (
      cancellation ||
      !hasOnlyOpenApproval(open, existing.id) ||
      !valuesEqual(existing, desiredRow) ||
      (tail?.seq ?? 0) !== input.expectedEventTailSeq + eventRows.length ||
      !replayRunMatches(run, {
        status: 'awaiting_approval',
        updatedAt: input.approval.createdAt,
        requestId: input.approval.requestId,
        attemptNumber: input.approval.attemptNumber,
      })
    ) {
      repositoryError('approval_status_conflict');
    }
    return readBackApprovalCommit(context, toJarvisRunRow(run), desiredRow, eventRows);
  }
  requireExpectedApprovalTail(input.expectedEventTailSeq, tail?.seq ?? 0);
  const openApprovals = open.map((row) => fromJarvisApprovalRow(row));
  const canExtendFileActionBatch =
    (input.approval.actionId === 'files.create' || input.approval.actionId === 'files.read') &&
    !cancellation &&
    openApprovals.length + 1 <= 10 &&
    openApprovals.every(
      (existing) =>
        existing.actionId === input.approval.actionId &&
        existing.status === 'pending' &&
        existing.requestId === input.approval.requestId &&
        existing.attemptNumber === input.approval.attemptNumber,
    ) &&
    (run.status === 'running' || run.status === 'awaiting_approval');
  if (run.status !== 'running' && !canExtendFileActionBatch) {
    repositoryError('approval_status_conflict');
  }
  if (input.approval.createdAt < run.updatedAt) repositoryError('approval_integrity_error');
  const attempts = currentApprovalAttempts(
    run,
    input.approval.requestId,
    input.approval.attemptNumber,
    'create',
  );
  if ((open.length > 0 || cancellation) && !canExtendFileActionBatch) {
    repositoryError('approval_status_conflict');
  }
  const updatedRun: JarvisRun = {
    ...run,
    status: 'awaiting_approval',
    updatedAt: input.approval.createdAt,
    ...(attempts
      ? { transportAttempts: dirtyApprovalAttempt(attempts, input.approval.createdAt) }
      : {}),
  };
  const runRow = toJarvisRunRow(updatedRun);
  await context.jarvis_runs.put(runRow);
  await context.jarvis_approvals.add(desiredRow);
  await context.jarvis_events.bulkAdd(eventRows);
  return readBackApprovalCommit(context, runRow, desiredRow, eventRows);
}

/** @internal Requires the caller's already-open exact three-table transaction. */
export async function decideApprovalInContext(
  context: KernelApprovalTransactionContext,
  input: DecideApprovalInContextInput,
) {
  if (
    !isFiniteTimestamp(input.decidedAt) ||
    (input.decision !== 'approve' && input.decision !== 'deny' && input.decision !== 'expire')
  ) {
    repositoryError('approval_integrity_error');
  }
  requireApprovalInputText(input.approvalId);
  requireExpectedApprovalTail(input.expectedEventTailSeq, input.expectedEventTailSeq);
  const run = await requireApprovalOwnedRun(context, input.accountId, input.runId);
  const [row, open, tail, cancellation] = await Promise.all([
    context.jarvis_approvals.get(input.approvalId),
    openApprovalsForRun(context, run.id),
    lastApprovalContextEvent(context, run.id),
    hasCommittedCancellationIntent(context, run.id),
  ]);
  if (!row || row.run_id !== run.id) repositoryError('approval_scope_mismatch');
  const approval = fromJarvisApprovalRow(row);
  if (approval.requestId !== input.requestId || approval.attemptNumber !== input.attemptNumber) {
    repositoryError('approval_scope_mismatch');
  }
  if (!approvalLifecycleIsCoherent(approval)) repositoryError('approval_status_conflict');
  if (
    input.decidedAt < approval.createdAt ||
    (input.decision === 'approve' && approval.expiresAt <= input.decidedAt) ||
    (input.decision === 'expire' && approval.expiresAt > input.decidedAt)
  ) {
    repositoryError('approval_status_conflict');
  }
  const status =
    input.decision === 'approve'
      ? ('approved' as const)
      : input.decision === 'deny'
        ? ('denied' as const)
        : ('expired' as const);
  const updatedApproval: JarvisApprovalV1 = {
    ...approval,
    status,
    decidedAt: input.decidedAt,
  };
  const approvalRow = toJarvisApprovalRow(updatedApproval);
  const seq = input.expectedEventTailSeq + 1;
  const events: JarvisEvent[] = [
    approvalEvent({
      runId: run.id,
      seq,
      idempotencyKey: `japproval:${approval.id}:${status}`,
      status,
      title:
        status === 'approved'
          ? 'Approval granted'
          : status === 'denied'
            ? 'Approval denied'
            : 'Approval expired',
      safeSummary: `The scoped action approval was ${status}.`,
      createdAt: input.decidedAt,
    }),
  ];
  if (status !== 'approved') {
    events.push(
      approvalRunEvent({
        runId: run.id,
        seq: seq + 1,
        idempotencyKey: `japproval:${approval.id}:resume`,
        status: 'running',
        title: 'Approval wait ended',
        safeSummary: 'The protected run resumed after the approval decision.',
        createdAt: input.decidedAt,
      }),
    );
  }
  const eventRows = events.map(toJarvisEventRow);
  const nextRunStatus = status === 'approved' ? 'awaiting_approval' : 'running';
  if (approval.status === status) {
    if (
      (status === 'approved' && !hasOnlyOpenApproval(open, approval.id)) ||
      (status !== 'approved' && open.length > 0)
    ) {
      repositoryError('approval_status_conflict');
    }
    currentApprovalAttempts(run, input.requestId, input.attemptNumber, 'pending');
    if (
      cancellation ||
      (tail?.seq ?? 0) !== input.expectedEventTailSeq + eventRows.length ||
      !replayRunMatches(run, {
        status: nextRunStatus,
        updatedAt: input.decidedAt,
        requestId: input.requestId,
        attemptNumber: input.attemptNumber,
      })
    ) {
      repositoryError('approval_status_conflict');
    }
    return readBackApprovalCommit(context, toJarvisRunRow(run), approvalRow, eventRows);
  }
  requireExpectedApprovalTail(input.expectedEventTailSeq, tail?.seq ?? 0);
  const filesCreateBatchOpen =
    (approval.actionId === 'files.create' || approval.actionId === 'files.read') &&
    open.length >= 1 &&
    open.length <= 10 &&
    open.every((row) => {
      const existing = fromJarvisApprovalRow(row);
      return (
        existing.actionId === approval.actionId &&
        existing.status === 'pending' &&
        existing.requestId === input.requestId &&
        existing.attemptNumber === input.attemptNumber
      );
    });
  if (
    cancellation ||
    (!hasOnlyOpenApproval(open, approval.id) && !filesCreateBatchOpen) ||
    run.status !== 'awaiting_approval' ||
    approval.status !== 'pending' ||
    input.decidedAt < run.updatedAt
  ) {
    repositoryError('approval_status_conflict');
  }
  currentApprovalAttempts(run, input.requestId, input.attemptNumber, 'pending');
  const updatedRun: JarvisRun = {
    ...run,
    status: nextRunStatus,
    updatedAt: input.decidedAt,
  };
  const runRow = toJarvisRunRow(updatedRun);
  await context.jarvis_runs.put(runRow);
  await context.jarvis_approvals.put(approvalRow);
  await context.jarvis_events.bulkAdd(eventRows);
  return readBackApprovalCommit(context, runRow, approvalRow, eventRows);
}

function buildApprovalClaimRows(
  input: ClaimApprovedExecutionInContextInput,
  approval: JarvisApprovalV1,
  run: JarvisRun,
  attempts: readonly JarvisTransportAttemptV1[] | undefined,
  keepAwaitingApproval = false,
) {
  const consumed: JarvisApprovalV1 = {
    ...approval,
    status: 'consumed',
    consumedAt: input.startedAt,
  };
  const updatedRun: JarvisRun = {
    ...run,
    status: keepAwaitingApproval ? 'awaiting_approval' : 'running',
    updatedAt: input.startedAt,
    ...(attempts ? { transportAttempts: dirtyApprovalAttempt(attempts, input.startedAt) } : {}),
  };
  const event = withClaimAccount(
    approvalClaimEvent({
      ...input,
      approval: consumed,
      seq: input.expectedEventTailSeq + 1,
    }),
    input.accountId,
  );
  return {
    approvalRow: toJarvisApprovalRow(consumed),
    runRow: toJarvisRunRow(updatedRun),
    eventRow: toJarvisEventRow(event),
  };
}

async function commitApprovalClaim(
  context: KernelApprovalTransactionContext,
  rows: ReturnType<typeof buildApprovalClaimRows>,
  addApproval: boolean,
) {
  const { approvalRow, runRow, eventRow } = rows;
  await context.jarvis_runs.put(runRow);
  if (addApproval) await context.jarvis_approvals.add(approvalRow);
  else await context.jarvis_approvals.put(approvalRow);
  await context.jarvis_events.add(eventRow);
  const readback = await readBackApprovalCommit(context, runRow, approvalRow, [eventRow]);
  return {
    run: readback.run,
    approval: readback.approval,
    startEvent: readback.events[0]!,
  };
}

/** @internal Requires the caller's already-open exact three-table transaction. */
export async function claimApprovedExecutionInContext(
  context: KernelApprovalTransactionContext,
  input: ClaimApprovedExecutionInContextInput,
) {
  if (!isFiniteTimestamp(input.startedAt)) repositoryError('approval_integrity_error');
  requireApprovalInputText(input.ownerId);
  requireApprovalInputText(input.evidenceRef);
  requireExpectedApprovalTail(input.expectedEventTailSeq, input.expectedEventTailSeq);
  const run = await requireApprovalOwnedRun(context, input.accountId, input.runId);
  const [row, open, tail, cancellation] = await Promise.all([
    context.jarvis_approvals.get(input.approvalId),
    openApprovalsForRun(context, run.id),
    lastApprovalContextEvent(context, run.id),
    hasCommittedCancellationIntent(context, run.id),
  ]);
  if (!row || row.run_id !== run.id) repositoryError('approval_scope_mismatch');
  const approval = fromJarvisApprovalRow(row);
  if (approval.requestId !== input.requestId || approval.attemptNumber !== input.attemptNumber) {
    repositoryError('approval_scope_mismatch');
  }
  if (
    !approvalLifecycleIsCoherent(approval) ||
    (approval.decidedAt !== undefined && approval.decidedAt > input.startedAt)
  ) {
    repositoryError('approval_status_conflict');
  }
  if (input.startedAt < approval.createdAt || approval.expiresAt <= input.startedAt) {
    repositoryError('approval_status_conflict');
  }
  const consumed: JarvisApprovalV1 = {
    ...approval,
    status: 'consumed',
    consumedAt: input.startedAt,
  };
  const approvalRow = toJarvisApprovalRow(consumed);
  const eventRow = toJarvisEventRow(
    withClaimAccount(
      approvalClaimEvent({
        ...input,
        approval: consumed,
        seq: input.expectedEventTailSeq + 1,
      }),
      input.accountId,
    ),
  );
  if (approval.status === 'consumed') {
    const committedEvent = await context.jarvis_events.get([eventRow.run_id, eventRow.seq]);
    currentApprovalAttempts(run, input.requestId, input.attemptNumber, 'claim');
    if (
      cancellation ||
      open.length > 0 ||
      !committedEvent ||
      !valuesEqual(committedEvent, eventRow) ||
      (tail?.seq ?? 0) !== input.expectedEventTailSeq + 1 ||
      !replayRunMatches(run, {
        status: 'running',
        updatedAt: input.startedAt,
        requestId: input.requestId,
        attemptNumber: input.attemptNumber,
        minimumBarrierVersion: 2,
      })
    ) {
      repositoryError('approval_status_conflict');
    }
    const readback = await readBackApprovalCommit(context, toJarvisRunRow(run), approvalRow, [
      eventRow,
    ]);
    return {
      run: readback.run,
      approval: readback.approval,
      startEvent: readback.events[0]!,
    };
  }
  requireExpectedApprovalTail(input.expectedEventTailSeq, tail?.seq ?? 0);
  const filesCreateBatchClaim =
    (approval.actionId === 'files.create' || approval.actionId === 'files.read') &&
    open.length >= 1 &&
    open.length <= 10 &&
    open.every((row) => {
      const existing = fromJarvisApprovalRow(row);
      return (
        existing.actionId === approval.actionId &&
        existing.requestId === input.requestId &&
        existing.attemptNumber === input.attemptNumber &&
        (existing.status === 'pending' || existing.id === approval.id)
      );
    });
  if (
    cancellation ||
    (!hasOnlyOpenApproval(open, approval.id) && !filesCreateBatchClaim) ||
    run.status !== 'awaiting_approval' ||
    approval.status !== 'approved' ||
    input.startedAt < run.updatedAt
  ) {
    repositoryError('approval_status_conflict');
  }
  const attempts = currentApprovalAttempts(run, input.requestId, input.attemptNumber, 'claim');
  const remainingPending = open.filter(
    (row) => row.id !== approval.id && row.status === 'pending',
  ).length;
  return commitApprovalClaim(
    context,
    buildApprovalClaimRows(input, approval, run, attempts, remainingPending > 0),
    false,
  );
}

/** @internal Requires the caller's already-open exact three-table transaction. */
export async function claimSafeAutoExecutionInContext(
  context: KernelApprovalTransactionContext,
  input: ClaimSafeAutoExecutionInContextInput,
) {
  if (
    input.approval.status !== 'pending' ||
    input.approval.risk !== 'safe' ||
    !approvalLifecycleIsCoherent(input.approval)
  ) {
    repositoryError('approval_integrity_error');
  }
  if (input.approval.expiresAt <= input.startedAt) {
    repositoryError('approval_status_conflict');
  }
  if (!isFiniteTimestamp(input.startedAt)) repositoryError('approval_integrity_error');
  requireApprovalInputText(input.ownerId);
  requireApprovalInputText(input.evidenceRef);
  requireExpectedApprovalTail(input.expectedEventTailSeq, input.expectedEventTailSeq);
  toJarvisApprovalRow(input.approval);
  const run = await requireApprovalOwnedRun(context, input.accountId, input.approval.runId);
  const [existing, open, tail, cancellation] = await Promise.all([
    context.jarvis_approvals.get(input.approval.id),
    openApprovalsForRun(context, run.id),
    lastApprovalContextEvent(context, run.id),
    hasCommittedCancellationIntent(context, run.id),
  ]);
  if (input.startedAt < input.approval.createdAt) {
    repositoryError('approval_status_conflict');
  }
  const claimInput: ClaimApprovedExecutionInContextInput = {
    accountId: input.accountId,
    runId: input.approval.runId,
    requestId: input.approval.requestId,
    attemptNumber: input.approval.attemptNumber,
    approvalId: input.approval.id,
    producerKind: input.producerKind,
    ownerId: input.ownerId,
    evidenceRef: input.evidenceRef,
    startedAt: input.startedAt,
    expectedEventTailSeq: input.expectedEventTailSeq,
  };
  const consumed: JarvisApprovalV1 = {
    ...input.approval,
    status: 'consumed',
    consumedAt: input.startedAt,
    decidedAt: input.startedAt,
  };
  const approvalRow = toJarvisApprovalRow(consumed);
  const eventRow = toJarvisEventRow(
    withClaimAccount(
      approvalClaimEvent({
        ...claimInput,
        approval: consumed,
        seq: input.expectedEventTailSeq + 1,
      }),
      input.accountId,
    ),
  );
  if (existing) {
    const committedEvent = await context.jarvis_events.get([eventRow.run_id, eventRow.seq]);
    if (
      cancellation ||
      open.length > 0 ||
      !valuesEqual(existing, approvalRow) ||
      !committedEvent ||
      !valuesEqual(committedEvent, eventRow) ||
      (tail?.seq ?? 0) !== input.expectedEventTailSeq + 1 ||
      !replayRunMatches(run, {
        status: 'running',
        updatedAt: input.startedAt,
        requestId: input.approval.requestId,
        attemptNumber: input.approval.attemptNumber,
      })
    ) {
      repositoryError('approval_status_conflict');
    }
    const readback = await readBackApprovalCommit(context, toJarvisRunRow(run), approvalRow, [
      eventRow,
    ]);
    return {
      run: readback.run,
      approval: readback.approval,
      startEvent: readback.events[0]!,
    };
  }
  requireExpectedApprovalTail(input.expectedEventTailSeq, tail?.seq ?? 0);
  if (
    cancellation ||
    open.length > 0 ||
    run.status !== 'running' ||
    input.startedAt < run.updatedAt
  ) {
    repositoryError('approval_status_conflict');
  }
  const attempts = currentApprovalAttempts(
    run,
    input.approval.requestId,
    input.approval.attemptNumber,
    'safe_auto',
  );
  return commitApprovalClaim(
    context,
    buildApprovalClaimRows(claimInput, consumed, run, attempts),
    true,
  );
}

/** @internal Ordinary non-kernel transaction owner that delegates to the same cores. */
export function createJarvisApprovalMutationRepository(database: JarvisDexie) {
  const transaction = <T>(
    body: (context: KernelApprovalTransactionContext) => Promise<T>,
  ): Promise<T> =>
    database.transaction(
      'rw',
      database.jarvis_runs,
      database.jarvis_events,
      database.jarvis_approvals,
      () =>
        body(
          Object.freeze({
            jarvis_runs: database.jarvis_runs,
            jarvis_events: database.jarvis_events,
            jarvis_approvals: database.jarvis_approvals,
          }),
        ),
    );
  return Object.freeze({
    createPending: (input: CreatePendingApprovalInContextInput) =>
      transaction((context) => createPendingApprovalInContext(context, input)),
    decide: (input: DecideApprovalInContextInput) =>
      transaction((context) => decideApprovalInContext(context, input)),
    claimApprovedExecution: (input: ClaimApprovedExecutionInContextInput) =>
      transaction((context) => claimApprovedExecutionInContext(context, input)),
    claimSafeAutoExecution: (input: ClaimSafeAutoExecutionInContextInput) =>
      transaction((context) => claimSafeAutoExecutionInContext(context, input)),
  });
}

export function createJarvisRepositories(
  database: JarvisDexie,
  dependencies: {
    now?: () => number;
    newProfileRevisionId?: () => string;
  } = {},
): JarvisRepositories {
  const now = dependencies.now ?? Date.now;
  const newProfileRevision = dependencies.newProfileRevisionId ?? newJarvisProfileRevisionId;

  const identity: JarvisIdentityRepository = {
    async getVersion(identityId, version) {
      const row = await database.jarvis_identity_revisions
        .where('[identity_id+version]')
        .equals([identityId, version])
        .first();
      return row ? fromJarvisIdentityRevisionRow(row) : undefined;
    },

    async putIfAbsent(revision) {
      const desired = toJarvisIdentityRevisionRow(revision);
      return database.transaction('rw', database.jarvis_identity_revisions, async () => {
        const [byId, byVersion] = await Promise.all([
          database.jarvis_identity_revisions.get(desired.id),
          database.jarvis_identity_revisions
            .where('[identity_id+version]')
            .equals([desired.identity_id, desired.version])
            .first(),
        ]);
        const existing = byId ?? byVersion;
        if (existing) {
          if (
            !valuesEqual(existing, desired) ||
            (byId !== undefined && !valuesEqual(byId, desired)) ||
            (byVersion !== undefined && !valuesEqual(byVersion, desired))
          ) {
            repositoryError('profile_integrity_error');
          }
          return fromJarvisIdentityRevisionRow(existing);
        }
        await database.jarvis_identity_revisions.add(desired);
        return fromJarvisIdentityRevisionRow(desired);
      });
    },
  };

  const profile: JarvisProfileRepository = {
    async getById(accountId, profileId) {
      assertAccountId(accountId);
      const row = await database.jarvis_profiles.get(profileId);
      if (!row || row.account_id !== accountId) return undefined;
      return fromJarvisProfileRow(row).profile;
    },

    async getActive(accountId) {
      assertAccountId(accountId);
      const rows = await database.jarvis_profiles
        .where('[account_id+active]')
        .equals([accountId, 1])
        .toArray();
      if (rows.length > 1) repositoryError('profile_integrity_error');
      return rows[0] ? fromJarvisProfileRow(rows[0]).profile : undefined;
    },

    async putForAccount(accountId, input) {
      assertAccountId(accountId);
      if (input.profile.accountId !== accountId) repositoryError('account_scope_mismatch');
      const desired = toJarvisProfileRow(input);
      return database.transaction('rw', database.jarvis_profiles, async () => {
        const existing = await database.jarvis_profiles.get(desired.id);
        if (existing && existing.account_id !== accountId) {
          repositoryError('account_scope_mismatch');
        }
        if (desired.active === 1) {
          const activeRows = await database.jarvis_profiles
            .where('[account_id+active]')
            .equals([accountId, 1])
            .toArray();
          if (activeRows.some((row) => row.id !== desired.id)) {
            repositoryError('profile_integrity_error');
          }
        }
        await database.jarvis_profiles.put(desired);
        return fromJarvisProfileRow(desired).profile;
      });
    },

    async updateCustomInstructions(accountId, profileId, customInstructions) {
      assertAccountId(accountId);
      const normalized = normalizeCustomInstructions(customInstructions);
      return database.transaction('rw', database.jarvis_profiles, async () => {
        const row = await database.jarvis_profiles.get(profileId);
        if (!row || row.account_id !== accountId) repositoryError('profile_integrity_error');
        const current = fromJarvisProfileRow(row);
        if (normalizeCustomInstructions(current.profile.customInstructions) === normalized) {
          return current.profile;
        }

        const { sourcePromptHash: _sourcePromptHash, ...profileWithoutSourceHash } =
          current.profile;
        const updated: JarvisProfile = {
          ...profileWithoutSourceHash,
          revisionId: newProfileRevision(),
          customInstructions: normalized,
          instructionSource: normalized.length === 0 ? 'none' : 'user',
          updatedAt: now(),
        };
        const updatedRow = toJarvisProfileRow({ profile: updated, migration: current.migration });
        await database.jarvis_profiles.put(updatedRow);
        return fromJarvisProfileRow(updatedRow).profile;
      });
    },
  };

  const run: JarvisRunRepository = {
    async createIdempotent(value) {
      assertAccountId(value.accountId);
      const desired = toJarvisRunRow(value);
      return database.transaction('rw', database.jarvis_runs, async () => {
        if (value.parentRunId !== undefined) {
          await requireOwnedRun(database, value.accountId, value.parentRunId);
        }
        const existing = await database.jarvis_runs.get(value.id);
        if (existing) {
          if (!valuesEqual(existing, desired)) repositoryError('run_id_conflict');
          return fromJarvisRunRow(existing);
        }
        await database.jarvis_runs.add(desired);
        return fromJarvisRunRow(desired);
      });
    },

    async getById(accountId, runId) {
      assertAccountId(accountId);
      const row = await database.jarvis_runs.get(runId);
      if (!row || row.account_id !== accountId) return undefined;
      return fromJarvisRunRow(row);
    },

    async listByAccount(accountId, options = {}) {
      assertAccountId(accountId);
      const limit = normalizedLimit(options.limit);
      const statuses = options.statuses ? new Set(options.statuses) : undefined;
      if (statuses?.size === 0) return [];
      let collection = database.jarvis_runs
        .where('[account_id+updated_at]')
        .between([accountId, Dexie.minKey], [accountId, Dexie.maxKey], true, true)
        .reverse();
      if (statuses) collection = collection.filter((row) => statuses.has(row.status));
      const rows = await collection.limit(limit).toArray();
      return rows.map(fromJarvisRunRow);
    },

    async compareAndAppendTransitionEvent(input) {
      assertAccountId(input.accountId);
      return database.transaction('rw', database.jarvis_runs, database.jarvis_events, async () => {
        const row = await requireOwnedRun(database, input.accountId, input.runId);
        const current = fromJarvisRunRow(row);
        if (current.status !== input.expectedStatus) {
          return { applied: false as const, current };
        }
        assertIdempotencyKey(input.event.idempotencyKey);

        const { completedAt: _completedAt, ...withoutCompletedAt } = current;
        const updated: JarvisRun = {
          ...withoutCompletedAt,
          status: input.nextStatus,
          updatedAt: input.updatedAt,
          ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
        };
        const updatedRow = toJarvisRunRow(updated);
        const lastEvent = await database.jarvis_events
          .where('[run_id+seq]')
          .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
          .last();
        const event: JarvisEvent = {
          ...input.event,
          runId: input.runId,
          seq: nextSequence(lastEvent?.seq),
          type: 'run_state',
          status: input.nextStatus,
        };
        const eventRow = toJarvisEventRow(event);
        await database.jarvis_runs.put(updatedRow);
        await database.jarvis_events.add(eventRow);
        return {
          applied: true as const,
          run: fromJarvisRunRow(updatedRow),
          event: fromJarvisEventRow(eventRow),
        };
      });
    },

    async compareAndMutateTransportAttempt(input) {
      assertAccountId(input.accountId);
      const snapshot = structuredClone(
        input.kind === 'begin_initial' ? input.snapshot : input.expectedSnapshot,
      );
      return database.transaction('rw', database.jarvis_runs, database.jarvis_events, async () => {
        const row = await requireOwnedRun(database, input.accountId, input.runId);
        const current = fromJarvisRunRow(row);
        if (current.status !== input.expectedStatus) {
          return { applied: false as const, current, reason: 'status_conflict' as const };
        }
        if (!isFiniteTimestamp(input.updatedAt)) {
          repositoryError('transport_attempt_integrity_error');
        }

        const attempts = structuredClone([...(current.transportAttempts ?? [])]);
        const tail = await lastEventForRun(database, input.runId);
        let updated: JarvisRun;
        let eventValue: JarvisEvent;

        if (input.kind === 'begin_initial') {
          if (
            current.source !== 'schedule' ||
            current.scheduledRetrySnapshot !== undefined ||
            !scheduledRetrySnapshotMatchesRun(snapshot, current) ||
            attempts.length !== 0 ||
            !transportAttemptInputIsValid(input.attempt, { number: 1, kind: 'initial' })
          ) {
            return { applied: false as const, current, reason: 'attempt_conflict' as const };
          }
          const seq = nextSequence(tail?.seq);
          const attempt: JarvisTransportAttemptV1 = {
            ...structuredClone(input.attempt),
            startedEventSeq: seq,
          };
          const { completedAt: _completedAt, ...withoutCompletedAt } = current;
          updated = {
            ...withoutCompletedAt,
            status: 'running',
            updatedAt: input.updatedAt,
            scheduledRetrySnapshot: snapshot,
            transportAttempts: [attempt],
          };
          eventValue = transportEventInput({
            runId: input.runId,
            seq,
            idempotencyKey: `jtransport:${input.runId}:${attempt.requestId}:initial_started`,
            type: 'run_state',
            status: 'running',
            title: 'Scheduled transport started',
            safeSummary: 'The scheduled provider attempt is in flight.',
            createdAt: input.updatedAt,
            producerSourceEvidence: scheduleAttemptStartSource(
              current,
              snapshot,
              attempt,
              input.updatedAt,
            ),
          });
        } else if (input.kind === 'begin_retry') {
          const latest = attempts.at(-1);
          const proof = latest?.zeroEffectEvidence;
          const availabilityKey = latest
            ? `jtransport:${input.runId}:${latest.requestId}:${latest.attemptNumber}:retry_available`
            : '';
          const availabilityRow = availabilityKey
            ? await database.jarvis_events
                .where('[run_id+idempotency_key]')
                .equals([input.runId, availabilityKey])
                .first()
            : undefined;
          const expectedAvailabilityRow =
            latest && proof
              ? toJarvisEventRow(
                  transportEventInput({
                    runId: input.runId,
                    seq: proof.executorClaims.throughSeq + 1,
                    idempotencyKey: availabilityKey,
                    type: 'warning',
                    status: 'transport_retry_available',
                    title: 'Scheduled transport retry available',
                    safeSummary: 'The failed attempt has verified zero consequential effect.',
                    createdAt: latest.updatedAt,
                    canonicalResultEvidence: scheduledTransportSettlementEvidence(
                      current,
                      latest,
                      latest.updatedAt,
                    ),
                  }),
                )
              : undefined;
          if (
            current.source !== 'schedule' ||
            current.scheduledRetrySnapshot === undefined ||
            !valuesEqual(current.scheduledRetrySnapshot, snapshot) ||
            attempts.length >= MAX_TRANSPORT_ATTEMPTS ||
            !latest ||
            latest.state !== 'retryable_failed' ||
            latest.attemptNumber !== input.expectedLatestAttemptNumber ||
            latest.effectBarrier.state !== 'open' ||
            latest.effectBarrier.version !== input.expectedBarrierVersion ||
            !proof ||
            !zeroEffectEvidenceExtends(current, latest, proof, input.revalidatedEvidence) ||
            !availabilityRow ||
            !expectedAvailabilityRow ||
            !valuesEqual(availabilityRow, expectedAvailabilityRow) ||
            tail?.seq !== input.expectedEventTailSeq ||
            input.expectedEventTailSeq !== input.revalidatedEvidence.executorClaims.throughSeq ||
            attempts.some((attempt) => attempt.requestId === input.attempt.requestId) ||
            !transportAttemptInputIsValid(input.attempt, {
              number: latest.attemptNumber + 1,
              kind: 'transport_retry',
            })
          ) {
            return { applied: false as const, current, reason: 'attempt_conflict' as const };
          }
          attempts[attempts.length - 1] = {
            ...latest,
            effectBarrier: {
              state: 'sealed_for_retry',
              version: latest.effectBarrier.version,
              updatedAt: input.updatedAt,
            },
            zeroEffectEvidence: structuredClone(input.revalidatedEvidence),
            updatedAt: input.updatedAt,
          };
          const seq = nextSequence(tail.seq);
          const attempt: JarvisTransportAttemptV1 = {
            ...structuredClone(input.attempt),
            startedEventSeq: seq,
          };
          attempts.push(attempt);
          updated = { ...current, updatedAt: input.updatedAt, transportAttempts: attempts };
          eventValue = transportEventInput({
            runId: input.runId,
            seq,
            idempotencyKey: `jtransport:${input.runId}:${attempt.requestId}:${attempt.attemptNumber}:retry_started`,
            type: 'warning',
            status: 'transport_retry_started',
            title: 'Scheduled transport retry started',
            safeSummary: 'A verified transport retry is in flight.',
            createdAt: input.updatedAt,
            producerSourceEvidence: scheduleAttemptStartSource(
              current,
              snapshot,
              attempt,
              input.updatedAt,
            ),
          });
        } else if (input.kind === 'settle_retryable') {
          const latest = attempts.at(-1);
          if (
            current.source !== 'schedule' ||
            current.scheduledRetrySnapshot === undefined ||
            !valuesEqual(current.scheduledRetrySnapshot, snapshot) ||
            !latest ||
            latest.state !== 'provider_in_flight' ||
            latest.attemptNumber !== input.expectedAttemptNumber ||
            latest.effectBarrier.state !== 'open' ||
            latest.effectBarrier.version !== input.expectedBarrierVersion ||
            tail?.seq !== input.expectedEventTailSeq ||
            input.zeroEffectEvidence.executorClaims.throughSeq !== input.expectedEventTailSeq ||
            !transportEvidenceMatches(current, latest, input.providerFailure) ||
            !zeroEffectEvidenceMatches(
              current,
              latest,
              input.providerFailure,
              input.zeroEffectEvidence,
            )
          ) {
            return { applied: false as const, current, reason: 'attempt_conflict' as const };
          }
          attempts[attempts.length - 1] = {
            ...latest,
            state: 'retryable_failed',
            failureCategory: input.providerFailure.failureCategory,
            zeroEffectEvidence: structuredClone(input.zeroEffectEvidence),
            updatedAt: input.updatedAt,
          };
          updated = { ...current, updatedAt: input.updatedAt, transportAttempts: attempts };
          const seq = nextSequence(tail.seq);
          eventValue = transportEventInput({
            runId: input.runId,
            seq,
            idempotencyKey: `jtransport:${input.runId}:${latest.requestId}:${latest.attemptNumber}:retry_available`,
            type: 'warning',
            status: 'transport_retry_available',
            title: 'Scheduled transport retry available',
            safeSummary: 'The failed attempt has verified zero consequential effect.',
            createdAt: input.updatedAt,
            canonicalResultEvidence: scheduledTransportSettlementEvidence(
              current,
              latest,
              input.updatedAt,
            ),
          });
        } else {
          const latest = attempts.at(-1);
          if (
            !isFiniteTimestamp(input.completedAt) ||
            current.source !== 'schedule' ||
            current.scheduledRetrySnapshot === undefined ||
            !valuesEqual(current.scheduledRetrySnapshot, snapshot) ||
            !latest ||
            latest.state !== 'provider_in_flight' ||
            latest.attemptNumber !== input.expectedAttemptNumber ||
            !transportEvidenceMatches(current, latest, input.providerFailure)
          ) {
            return { applied: false as const, current, reason: 'attempt_conflict' as const };
          }
          attempts[attempts.length - 1] = {
            ...latest,
            state: 'effect_uncertain',
            failureCategory: input.providerFailure.failureCategory,
            updatedAt: input.updatedAt,
          };
          updated = {
            ...current,
            status: 'failed',
            updatedAt: input.updatedAt,
            completedAt: input.completedAt,
            transportAttempts: attempts,
          };
          const seq = nextSequence(tail?.seq);
          eventValue = transportEventInput({
            runId: input.runId,
            seq,
            idempotencyKey: `jtransport:${input.runId}:${latest.requestId}:${latest.attemptNumber}:uncertain_failed`,
            type: 'run_state',
            status: 'failed',
            title: 'Scheduled transport failed',
            safeSummary: 'The provider attempt ended with uncertain effect state.',
            createdAt: input.updatedAt,
            canonicalResultEvidence: scheduledTransportSettlementEvidence(
              current,
              latest,
              input.updatedAt,
            ),
          });
        }

        const updatedRow = toJarvisRunRow(updated);
        const eventRow = toJarvisEventRow(eventValue);
        await database.jarvis_runs.put(updatedRow);
        await database.jarvis_events.add(eventRow);
        return {
          applied: true as const,
          run: fromJarvisRunRow(updatedRow),
          event: fromJarvisEventRow(eventRow),
        };
      });
    },

    async claimAttemptEffect(input) {
      const claim = detachRepositoryInput(input, 'attempt_effect_integrity_error');
      assertAccountId(claim.accountId);
      if (
        !isPositiveSafeInteger(claim.attemptNumber) ||
        !isStableText(claim.requestId) ||
        !isStableText(claim.ownerId) ||
        !isStableText(claim.evidenceRef) ||
        !isFiniteTimestamp(claim.claimedAt)
      ) {
        repositoryError('attempt_effect_integrity_error');
      }
      if (!validateJarvisEvent(attemptEffectClaimEvent(claim, 1)).ok) {
        repositoryError('attempt_effect_integrity_error');
      }
      return database.transaction('rw', database.jarvis_runs, database.jarvis_events, async () => {
        const row = await requireOwnedRun(database, claim.accountId, claim.runId);
        const current = fromJarvisRunRow(row);
        if (current.status !== 'running') {
          return { applied: false as const, current, reason: 'status_conflict' as const };
        }
        const attempts = structuredClone([...(current.transportAttempts ?? [])]);
        if (attempts.length === 0) {
          if (current.source === 'schedule') {
            return { applied: false as const, current, reason: 'attempt_conflict' as const };
          }
          return { applied: true as const, kind: 'not_applicable' as const, run: current };
        }
        const latest = attempts.at(-1)!;
        if (
          latest.state !== 'provider_in_flight' ||
          latest.attemptNumber !== claim.attemptNumber ||
          latest.requestId !== claim.requestId
        ) {
          return { applied: false as const, current, reason: 'attempt_conflict' as const };
        }
        if (latest.effectBarrier.state === 'sealed_for_retry') {
          return { applied: false as const, current, reason: 'attempt_sealed' as const };
        }
        if (
          !Number.isSafeInteger(latest.effectBarrier.version) ||
          latest.effectBarrier.version < 0
        ) {
          repositoryError('attempt_effect_integrity_error');
        }

        const idempotencyKey = attemptEffectClaimIdempotencyKey(claim);
        const existing = await database.jarvis_events
          .where('[run_id+idempotency_key]')
          .equals([claim.runId, idempotencyKey])
          .first();
        if (existing) {
          const expectedRow = toJarvisEventRow(attemptEffectClaimEvent(claim, existing.seq));
          if (latest.effectBarrier.state !== 'dirty' || !valuesEqual(existing, expectedRow)) {
            repositoryError('attempt_effect_integrity_error');
          }
          return {
            applied: true as const,
            kind: 'barrier_claimed' as const,
            run: current,
            event: fromJarvisEventRow(existing),
          };
        }

        const tail = await lastEventForRun(database, claim.runId);
        const updatedAttempt: JarvisTransportAttemptV1 = {
          ...latest,
          effectBarrier: {
            state: 'dirty',
            version: latest.effectBarrier.version + 1,
            updatedAt: claim.claimedAt,
          },
          updatedAt: claim.claimedAt,
        };
        attempts[attempts.length - 1] = updatedAttempt;
        const updated: JarvisRun = {
          ...current,
          updatedAt: claim.claimedAt,
          transportAttempts: attempts,
        };
        const eventValue = attemptEffectClaimEvent(claim, nextSequence(tail?.seq));
        const updatedRow = toJarvisRunRow(updated);
        const eventRow = toJarvisEventRow(eventValue);
        await database.jarvis_runs.put(updatedRow);
        await database.jarvis_events.add(eventRow);
        return {
          applied: true as const,
          kind: 'barrier_claimed' as const,
          run: fromJarvisRunRow(updatedRow),
          event: fromJarvisEventRow(eventRow),
        };
      });
    },
  };

  const event: JarvisEventRepository = {
    async appendIdempotent(accountId, runId, input) {
      const eventInput = detachRepositoryInput(input, 'event_idempotency_conflict');
      assertAccountId(accountId);
      if ((eventInput as { type: JarvisEvent['type'] }).type === 'run_state') {
        repositoryError('transition_event_requires_atomic_run_update');
      }
      assertIdempotencyKey(eventInput.idempotencyKey);
      if (
        eventInput.idempotencyKey.startsWith(JARVIS_ATTEMPT_EFFECT_IDEMPOTENCY_PREFIX) ||
        eventInput.executionEvidence?.kind === 'consequential_effect_claimed'
      ) {
        repositoryError('attempt_effect_integrity_error');
      }
      return database.transaction('rw', database.jarvis_runs, database.jarvis_events, async () => {
        await requireOwnedRun(database, accountId, runId);
        const existing = await database.jarvis_events
          .where('[run_id+idempotency_key]')
          .equals([runId, eventInput.idempotencyKey])
          .first();
        if (existing) {
          const desired = { ...eventInput, runId, seq: existing.seq };
          if (!validateJarvisEvent(desired).ok) {
            repositoryError('event_idempotency_conflict');
          }
          const desiredRetry = toJarvisEventRow(desired);
          if (!valuesEqual(existing, desiredRetry)) {
            repositoryError('event_idempotency_conflict');
          }
          return fromJarvisEventRow(existing);
        }

        const lastEvent = await database.jarvis_events
          .where('[run_id+seq]')
          .between([runId, Dexie.minKey], [runId, Dexie.maxKey], true, true)
          .last();
        const value: JarvisEvent = {
          ...eventInput,
          runId,
          seq: nextSequence(lastEvent?.seq),
        };
        if (!validateJarvisEvent(value).ok) {
          repositoryError('event_idempotency_conflict');
        }
        const row = toJarvisEventRow(value);
        await database.jarvis_events.add(row);
        return fromJarvisEventRow(row);
      });
    },

    async listByRun(accountId, runId, options = {}) {
      assertAccountId(accountId);
      const limit = normalizedLimit(options.limit);
      assertAfterSeq(options.afterSeq);
      await requireOwnedRun(database, accountId, runId);
      if (options.afterSeq !== undefined) {
        const rows = await database.jarvis_events
          .where('[run_id+seq]')
          .between([runId, options.afterSeq], [runId, Dexie.maxKey], false, true)
          .limit(limit)
          .toArray();
        return rows.map(fromJarvisEventRow);
      }

      const rows = await database.jarvis_events
        .where('[run_id+seq]')
        .between([runId, Dexie.minKey], [runId, Dexie.maxKey], true, true)
        .reverse()
        .limit(limit)
        .toArray();
      rows.reverse();
      return rows.map(fromJarvisEventRow);
    },

    async getBySeq(accountId, runId, seq) {
      assertAccountId(accountId);
      if (!Number.isSafeInteger(seq) || seq < 1) repositoryError('invalid_limit');
      await requireOwnedRun(database, accountId, runId);
      const row = await database.jarvis_events.get([runId, seq]);
      return row ? fromJarvisEventRow(row) : undefined;
    },
  };

  const approval: JarvisApprovalRepository = {
    async getById(accountId, approvalId) {
      assertAccountId(accountId);
      const row = await database.jarvis_approvals.get(approvalId);
      if (!row) return undefined;
      const parent = await database.jarvis_runs.get(row.run_id);
      if (!parent || parent.account_id !== accountId) return undefined;
      return fromJarvisApprovalRow(row);
    },

    async listByRun(accountId, runId, options = {}) {
      assertAccountId(accountId);
      const limit = normalizedLimit(options.limit);
      if (options.requestId !== undefined && !options.requestId.trim()) {
        repositoryError('account_scope_mismatch');
      }
      if (
        options.attemptNumber !== undefined &&
        (!Number.isSafeInteger(options.attemptNumber) || options.attemptNumber < 1)
      ) {
        repositoryError('invalid_limit');
      }
      if (options.createdAtOrAfter !== undefined && !Number.isFinite(options.createdAtOrAfter)) {
        repositoryError('invalid_limit');
      }
      await requireOwnedRun(database, accountId, runId);
      const rows = await database.jarvis_approvals.where('run_id').equals(runId).toArray();
      return rows
        .filter(
          (row) =>
            (options.requestId === undefined || row.request_id === options.requestId) &&
            (options.attemptNumber === undefined || row.attempt_number === options.attemptNumber) &&
            (options.createdAtOrAfter === undefined || row.created_at >= options.createdAtOrAfter),
        )
        .sort(
          (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
        )
        .slice(0, limit)
        .map(fromJarvisApprovalRow);
    },
  };

  const artifact: JarvisArtifactRepository = {
    async getById(accountId, artifactId) {
      assertAccountId(accountId);
      const row = await database.jarvis_artifacts.get(artifactId);
      if (!row) return undefined;
      const parent = await database.jarvis_runs.get(row.run_id);
      if (!parent || parent.account_id !== accountId) return undefined;
      return fromJarvisArtifactRow(row);
    },

    async listByRun(accountId, runId, inputLimit) {
      assertAccountId(accountId);
      const limit = normalizedLimit(inputLimit);
      await requireOwnedRun(database, accountId, runId);
      const rows = await database.jarvis_artifacts
        .where('run_id')
        .equals(runId)
        .limit(limit)
        .toArray();
      return rows.map(fromJarvisArtifactRow);
    },
  };

  return { identity, profile, run, event, approval, artifact };
}

/** @internal Constructed only by the trusted artifact composition and focused tests. */
export function createJarvisArtifactCommitAuthority(
  database: JarvisDexie,
  capability: JarvisArtifactRuntimeInternals,
): JarvisArtifactCommitAuthority {
  assertJarvisArtifactCommitCapabilityInternal(capability);
  return Object.freeze({
    async putForRun(accountId: string, value: JarvisArtifactV1): Promise<JarvisArtifactV1> {
      assertAccountId(accountId);
      const row = toJarvisArtifactRow(value);
      return database.transaction(
        'rw',
        database.jarvis_runs,
        database.jarvis_artifacts,
        async () => {
          await requireOwnedRun(database, accountId, value.runId);
          const existing = await database.jarvis_artifacts.get(value.id);
          if (existing) {
            if (existing.run_id !== value.runId) repositoryError('parent_run_not_found');
            const existingValue = fromJarvisArtifactRow(existing);
            if (!valuesEqual(existingValue, value)) repositoryError('artifact_integrity_error');
            return existingValue;
          }
          capability.consumePendingForCommit({
            accountId,
            runId: value.runId,
            requestId: value.requestId,
            attemptNumber: value.attemptNumber,
            artifacts: [value],
          });
          await database.jarvis_artifacts.add(row);
          return fromJarvisArtifactRow(row);
        },
      );
    },
  });
}

/** @internal Closed Task 18 test harness only; production modules must not import this factory. */
export function createJarvisLiveEvidenceEventCommitAuthority(
  database: JarvisDexie,
): JarvisLiveEvidenceEventCommitAuthority {
  return {
    async appendLiveEvidence(input) {
      assertAccountId(input.accountId);
      const validated = validateJarvisDurableLiveEvidence(input.evidence);
      if (!validated.ok) repositoryError('live_evidence_integrity_error');
      const evidence = structuredClone(validated.value);
      if (
        evidence.producerIdentity.producerKind !== evidence.producerKind ||
        !isPositiveSafeInteger(evidence.attemptNumber) ||
        !isPositiveSafeInteger(evidence.resultEventSeq) ||
        !isStableText(evidence.registrationId) ||
        !isStableText(evidence.resultRef) ||
        !isFiniteTimestamp(evidence.observedAt) ||
        !liveEvidenceOperationsAreClosed(evidence)
      ) {
        repositoryError('live_evidence_integrity_error');
      }
      const idempotencyKey = `jlive-event:${await sha256Hex(evidence)}`;

      return database.transaction('rw', database.jarvis_runs, database.jarvis_events, async () => {
        await requireOwnedRun(database, input.accountId, input.runId);
        if (evidence.accountId !== input.accountId || evidence.runId !== input.runId) {
          repositoryError('live_evidence_integrity_error');
        }
        const occurrence = await database.jarvis_events
          .where('[run_id+seq]')
          .between([input.runId, Dexie.minKey], [input.runId, Dexie.maxKey], true, true)
          .filter((row) => {
            const existingEvidence = row.live_evidence;
            return (
              existingEvidence !== undefined &&
              sameLiveEvidenceOccurrence(existingEvidence, evidence)
            );
          })
          .first();
        if (occurrence && !valuesEqual(occurrence.live_evidence, evidence)) {
          repositoryError('event_idempotency_conflict');
        }
        const sourceRow = await database.jarvis_events.get([input.runId, evidence.resultEventSeq]);
        if (!sourceRow) repositoryError('live_evidence_integrity_error');
        const source = fromJarvisEventRow(sourceRow).producerSourceEvidence;
        const phaseMatches =
          evidence.transition === 'completed' || evidence.transition === 'degraded'
            ? source?.phase === 'result' && source.state === evidence.transition
            : source?.phase === 'start' && source.state === evidence.transition;
        if (
          !source ||
          source.accountId !== evidence.accountId ||
          source.runId !== evidence.runId ||
          source.requestId !== evidence.requestId ||
          source.attemptNumber !== evidence.attemptNumber ||
          source.producerKind !== evidence.producerKind ||
          !valuesEqual(source.producerIdentity, evidence.producerIdentity) ||
          source.resultRef !== evidence.resultRef ||
          source.observedAt !== evidence.observedAt ||
          !phaseMatches
        ) {
          repositoryError('live_evidence_integrity_error');
        }

        const existing = await database.jarvis_events
          .where('[run_id+idempotency_key]')
          .equals([input.runId, idempotencyKey])
          .first();
        const eventType = evidence.kind === 'model' ? ('model' as const) : ('tool' as const);
        const title =
          evidence.kind === 'model'
            ? 'Model live evidence committed'
            : 'Capability live evidence committed';
        if (existing) {
          const desired = toJarvisEventRow({
            runId: input.runId,
            seq: existing.seq,
            idempotencyKey,
            type: eventType,
            status: evidence.transition,
            title,
            safeSummary: 'Canonical live evidence was recorded.',
            sourceRefs: [],
            artifactIds: [],
            createdAt: evidence.observedAt,
            liveEvidence: evidence,
          });
          if (!valuesEqual(existing, desired)) repositoryError('live_evidence_integrity_error');
          return fromJarvisEventRow(existing);
        }

        if (occurrence) repositoryError('event_idempotency_conflict');

        const tail = await lastEventForRun(database, input.runId);
        const eventValue: JarvisEvent = {
          runId: input.runId,
          seq: nextSequence(tail?.seq),
          idempotencyKey,
          type: eventType,
          status: evidence.transition,
          title,
          safeSummary: 'Canonical live evidence was recorded.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: evidence.observedAt,
          liveEvidence: evidence,
        };
        const eventRow = toJarvisEventRow(eventValue);
        await database.jarvis_events.add(eventRow);
        return fromJarvisEventRow(eventRow);
      });
    },
  };
}

const globalRepositories = createJarvisRepositories(db);

export const jarvisIdentityRepo: JarvisIdentityRepository = globalRepositories.identity;
export const jarvisProfileRepo: JarvisProfileRepository = globalRepositories.profile;
export const jarvisRunRepo: JarvisRunRepository = globalRepositories.run;
export const jarvisEventRepo: JarvisEventRepository = globalRepositories.event;
export const jarvisApprovalRepo: JarvisApprovalRepository = globalRepositories.approval;
export const jarvisArtifactRepo: JarvisArtifactRepository = globalRepositories.artifact;
