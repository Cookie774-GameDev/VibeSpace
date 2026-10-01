import Dexie from 'dexie';

import { resolveAccountIdentity, type AccountIdentity } from '@/lib/accountIdentity';
import {
  captureSyncQueueOwner,
  getCurrentSyncQueueAuthorityScope,
  subscribeSyncQueueAuthorityScope,
  type SyncQueueAuthorityScope,
  type SyncQueueOwnerSnapshot,
} from '@/lib/cloudSyncQueueOwner';
import type { JarvisDexie } from '@/lib/db';
import {
  fromJarvisArtifactRow,
  fromJarvisEventRow,
  fromJarvisRunRow,
  toJarvisEventRow,
  toJarvisRunRow,
} from '@/lib/db/jarvisMappers';
import {
  claimApprovedExecutionInContext,
  claimSafeAutoExecutionInContext,
  createJarvisRepositories,
  createPendingApprovalInContext,
  decideApprovalInContext,
} from '@/lib/db/jarvisRepositories';
import {
  createKernelTurnTransactionAuthority,
  type KernelApprovalTransactionContext,
  type KernelLifecycleTransactionContext,
} from '@/lib/db/kernelTurnTransactionAuthority';
import { useAuthStore } from '@/stores/auth';
import type { Agent, Message } from '@/types';
import {
  JarvisProviderAttemptFailureError,
  type JarvisProviderAttemptEvidenceAuthority,
} from '@/lib/ai/providerAttemptEvidence';
import type { JarvisHiveWorkerExecutor } from '@/lib/ai/stacks/hiveWorkerExecutor';
import type {
  CancellationDelivery,
  JarvisAbortRegistrationAuthority,
  JarvisApprovalV1,
  JarvisArtifactV1,
  JarvisArtifactDraft,
  JarvisAuthorityBoundResult,
  JarvisCanonicalLiveProducerEvidence,
  JarvisCancellationAggregate,
  JarvisCancellationDeliveryAuthority,
  JarvisCancellationOwnerOutcome,
  JarvisCancellationRequestResult,
  JarvisDurableLiveEvidenceV1,
  JarvisEvent,
  JarvisExecutionJournal,
  JarvisHiveStackPlanV1,
  JarvisLiveEvidenceAppendCapability,
  JarvisLiveEvidencePrimaryHostAccountSession,
  JarvisLiveEvidencePrimaryHostLifecycle,
  JarvisLiveEvidenceProof,
  JarvisLiveEvidenceRegistration,
  JarvisLiveEvidenceVerifierSlot,
  JarvisProducerSourceEvidenceV1,
  JarvisPreEffectTransportFailureEvidence,
  JarvisRun,
  JarvisRunStatus,
  JarvisRunTransitionEventInput,
  JarvisScheduledAttemptLease,
  JarvisScheduledRetrySnapshotV1,
  JarvisTransportAttemptCoordinator,
  JarvisTransportAttemptV1,
} from './contracts/execution';
import { canonicalizeJarvisApprovalJson } from './contracts/execution';
import {
  createJarvisConsequentialEffectSafetyAuthority,
  jarvisIssuedActionExecutionBrand,
  jarvisIssuedApprovalLifecycleBrand,
  jarvisTerminalHandoffReceiptBrand,
} from './approvalEngine';
import type { JarvisActionCatalog } from './actions/catalog';
import type { JarvisRegisteredActionExecutor } from './actions/catalog';
import type { ActionResult } from '@/lib/actions/types';
import type {
  JarvisApprovalActionBinder,
  JarvisApprovalActionCapability,
  JarvisIssuedActionExecution,
  JarvisIssuedApprovalLifecycle,
  JarvisKernelActionPort,
} from './approvalEngine';
import type {
  CanonicalArtifactEvidenceAuthorities,
  CanonicalPluginEvidence,
  JarvisArtifactEffectClaimCapability,
} from './artifactProducerAdapters';
import { createJarvisArtifactKernelComposition } from './artifactRuntime';
import { createJarvisLiveEvidenceKernelComposition } from './executionJournal/liveEvidenceAuthority';
import {
  createJarvisAttemptEffectBarrierAuthority,
  createJarvisTransportAttemptCoordinator,
} from './executionJournal/transportAttempts';
import { createKernelTurnCommit } from './kernelTurnCommit';
import {
  runJarvisKernelTurn,
  runJarvisKernelScheduledTurn,
  runJarvisKernelVoiceTurn,
  type JarvisBoundKernelLifecycle,
  type JarvisDeferredVoiceKernelTurnResult,
  type JarvisKernelPrepareProvider,
  type JarvisKernelProcessResponse,
  type JarvisKernelTurnInput,
  type JarvisKernelTurnResult,
  type JarvisKernelResponseActionPort,
  type JarvisProviderStartedReceipt,
} from './kernel';
import type { VoiceResponseReadyCommitResult } from './kernelTurnCommit';
import { createJarvisRequestEnvelope, deepFreezeJarvisCopy } from './requestEnvelope';
import { compileJarvisPrompt } from './promptCompiler';

const jarvisKernelAccountBindingBrand: unique symbol = Symbol('jarvis.kernel.account-binding');
const jarvisVoiceTurnHandleBrand: unique symbol = Symbol('jarvis.voice-turn-handle');

/** @internal Issued only by the closed kernel runtime binding authority. */
export interface JarvisKernelAccountBinding {
  readonly identity: Readonly<AccountIdentity>;
  readonly syncOwnerSnapshot: SyncQueueOwnerSnapshot;
  readonly revocationSignal: AbortSignal;
  readonly [jarvisKernelAccountBindingBrand]: true;
  assertCurrent(): void;
  dispose(): void;
}

const preparedJarvisScheduledAttemptBrand: unique symbol = Symbol(
  'jarvis.prepared-scheduled-attempt',
);
const jarvisScheduledPreparationSeedBrand: unique symbol = Symbol(
  'jarvis.kernel.schedule-preparation-seed',
);
const jarvisAllocatedScheduledOccurrenceBrand: unique symbol = Symbol(
  'jarvis.allocated-scheduled-occurrence',
);
const jarvisScheduledKernelHandleBrand: unique symbol = Symbol('jarvis.kernel.schedule-handle');
const jarvisHiveWorkerHandleBrand: unique symbol = Symbol('jarvis.hive-worker-handle');
const jarvisHiveWorkerOutcomeBrand: unique symbol = Symbol('jarvis.hive-worker-outcome');

export type JarvisScheduledPreparationSeed = Readonly<{
  [jarvisScheduledPreparationSeedBrand]: true;
}>;

export type JarvisAllocatedScheduledOccurrence = JarvisScheduledPreparationSeed &
  Readonly<{
    [jarvisAllocatedScheduledOccurrenceBrand]: true;
  }>;

export type PreparedJarvisScheduledKernelAttempt = Readonly<{
  [preparedJarvisScheduledAttemptBrand]: true;
}>;

export type JarvisScheduledKernelAttemptOutcome =
  | { kind: 'committed'; result: JarvisKernelTurnResult }
  | { kind: 'pre_effect_transport_failure' };

export type JarvisScheduledKernelAttemptHandle = Readonly<{
  requestCancellation(): Promise<JarvisCancellationRequestResult>;
  dispose(): void;
  [jarvisScheduledKernelHandleBrand]: true;
}>;

export type JarvisScheduledTurnBasis = Readonly<{
  workspaceId?: string;
  projectId?: string;
  chatId: string;
  userMessageId: string;
  agent: Agent;
  interactionMode: JarvisKernelTurnInput['interactionMode'];
  userText: string;
  messageHistory: JarvisKernelTurnInput['messageHistory'];
  model: JarvisKernelTurnInput['model'];
  identity: JarvisKernelTurnInput['identity'];
  profile: JarvisKernelTurnInput['profile'];
  capabilities: JarvisKernelTurnInput['capabilities'];
  context: JarvisKernelTurnInput['context'];
  outputContract: JarvisKernelTurnInput['outputContract'];
  workingDirectory?: string;
}>;

export type JarvisHiveFinalTurnBasis = Readonly<
  Pick<
    JarvisKernelTurnInput,
    | 'run'
    | 'attempt'
    | 'userMessageId'
    | 'interactionMode'
    | 'agent'
    | 'userText'
    | 'messageHistory'
    | 'identity'
    | 'profile'
    | 'model'
    | 'capabilities'
    | 'context'
    | 'outputContract'
    | 'workingDirectory'
  >
>;

export interface HiveWorkerResult {
  workerId: string;
  stepId: string;
  label: string;
  agentId: string;
  providerId: string;
  modelId: string;
  text?: string;
  status: 'completed' | 'failed' | 'cancelled';
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  errorCategory?: string;
}

export type JarvisHiveWorkerOutcome = Readonly<{
  result: Readonly<HiveWorkerResult>;
  [jarvisHiveWorkerOutcomeBrand]: true;
}>;

export interface JarvisHiveWorkerHandle {
  readonly [jarvisHiveWorkerHandleBrand]: true;
  execute(): Promise<JarvisAuthorityBoundResult<JarvisHiveWorkerOutcome>>;
  requestCancellation(): Promise<JarvisCancellationRequestResult>;
  dispose(): void;
}

export type JarvisVoicePlaybackCommitResult =
  | { committed: true; run: JarvisRun; event: JarvisEvent }
  | { committed: false; reason: 'status_conflict'; actualStatus: JarvisRunStatus };

export interface JarvisVoiceTurnHandle {
  readonly [jarvisVoiceTurnHandleBrand]: true;
  requestCancellation(): Promise<JarvisCancellationRequestResult>;
  commitResponseReady(): Promise<JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult>>;
  runValidatedPlayback(): Promise<JarvisAuthorityBoundResult<JarvisVoicePlaybackCommitResult>>;
  dispose(): void;
}

export type JarvisVoicePlaybackEngineResult = Readonly<
  | { state: 'completed'; resultRef: string; observedAt: number }
  | {
      state: 'degraded';
      reason: 'unavailable' | 'failed' | 'stopped';
      resultRef: string;
      observedAt: number;
    }
>;

export type JarvisVoicePlaybackAdapterResult = Readonly<{
  tts: JarvisVoicePlaybackEngineResult;
  playback: JarvisVoicePlaybackEngineResult;
  terminalStatus: 'completed' | 'partial';
}>;

export type JarvisVoicePlaybackController = Readonly<{
  receipt: Readonly<{
    sessionId: string;
    engineId: string;
    ttsExecutionId: string;
    playbackExecutionId: string;
    ttsStartedAt: number;
    playbackStartedAt: number;
  }>;
  start(): Promise<JarvisVoicePlaybackAdapterResult>;
  verify(result: JarvisVoicePlaybackAdapterResult): boolean;
  abort():
    | 'signal_delivered'
    | 'handoff_pending'
    | 'already_exited'
    | 'unsupported'
    | 'delivery_rejected';
  dispose(): void;
}>;

export type JarvisVoicePlaybackAdapter = Readonly<{
  prepare(
    input: Readonly<{
      accountId: string;
      runId: string;
      requestId: string;
      attemptNumber: number;
      spokenText: string;
    }>,
  ): JarvisVoicePlaybackController | null;
}>;

export interface JarvisVoiceRecoveryHandle {
  commitRecoveredPartial(): Promise<JarvisAuthorityBoundResult<JarvisVoicePlaybackCommitResult>>;
  dispose(): void;
}

export interface JarvisKernelRuntime {
  readonly actions: JarvisKernelActionPort;
  runInitialTurn(
    input: Readonly<JarvisKernelTurnInput>,
  ): Promise<JarvisAuthorityBoundResult<JarvisKernelTurnResult>>;
  startVoiceTurn(input: Readonly<JarvisKernelTurnInput> & { surface: 'voice' }): Promise<
    JarvisAuthorityBoundResult<{
      result: JarvisKernelTurnResult;
      handle: JarvisVoiceTurnHandle;
    }>
  >;
  openVoiceRecovery(input: {
    accountId: string;
    runId: string;
  }): Promise<JarvisAuthorityBoundResult<JarvisVoiceRecoveryHandle>>;
  requestCancellation(input: {
    accountId: string;
    runId: string;
  }): Promise<JarvisCancellationRequestResult>;
  allocateScheduledOccurrence(input: {
    accountId: string;
    eventId: string;
    dueAt: number;
  }): Promise<JarvisAuthorityBoundResult<JarvisAllocatedScheduledOccurrence>>;
  loadScheduledRun(input: {
    accountId: string;
    runId: string;
  }): Promise<JarvisAuthorityBoundResult<JarvisAllocatedScheduledOccurrence | undefined>>;
  allocateScheduledLogicalRetry(input: {
    accountId: string;
    previousRunId: string;
  }): Promise<JarvisAuthorityBoundResult<JarvisAllocatedScheduledOccurrence>>;
  prepareScheduledAttempt(input: {
    allocation: JarvisAllocatedScheduledOccurrence;
  }): Promise<PreparedJarvisScheduledKernelAttempt>;
  beginPreparedScheduledAttempt(input: {
    prepared: PreparedJarvisScheduledKernelAttempt;
  }): Promise<JarvisAuthorityBoundResult<JarvisScheduledKernelAttemptHandle>>;
  dispatchPreparedScheduledAttempt(input: {
    prepared: PreparedJarvisScheduledKernelAttempt;
    handle: JarvisScheduledKernelAttemptHandle;
  }): Promise<JarvisAuthorityBoundResult<JarvisScheduledKernelAttemptOutcome>>;
  settleScheduledTransportFailure(input: {
    handle: JarvisScheduledKernelAttemptHandle;
  }): Promise<
    JarvisAuthorityBoundResult<
      { kind: 'retryable'; run: JarvisRun } | { kind: 'terminal_failed'; run: JarvisRun }
    >
  >;
  disposeScheduledAttempt(handle: JarvisScheduledKernelAttemptHandle): void;
  bindHiveStackPlan(input: {
    plan: Readonly<JarvisHiveStackPlanV1>;
  }): Promise<JarvisAuthorityBoundResult<JarvisRun>>;
  openHiveWorker(input: {
    parentRunId: string;
    stepId: string;
  }): Promise<JarvisAuthorityBoundResult<JarvisHiveWorkerHandle>>;
  runHiveFinalTurn(
    input: Readonly<JarvisHiveFinalTurnBasis> & {
      workers: readonly JarvisHiveWorkerOutcome[];
    },
  ): Promise<JarvisAuthorityBoundResult<JarvisKernelTurnResult>>;
}

/** @internal Full composition received only by app/src/lib/ai/runtime.ts. */
export type JarvisKernelRuntimeComposition = Readonly<{
  kernel: JarvisKernelRuntime;
  liveEvidenceHost: JarvisLiveEvidencePrimaryHostLifecycle;
}>;

type VerifierSlots = Readonly<{
  provider: JarvisLiveEvidenceVerifierSlot<'provider'>;
  action: JarvisLiveEvidenceVerifierSlot<'action'>;
  fileAction: JarvisLiveEvidenceVerifierSlot<'file_action'>;
  terminal: JarvisLiveEvidenceVerifierSlot<'terminal'>;
  plugin: JarvisLiveEvidenceVerifierSlot<'plugin'>;
  mcp: JarvisLiveEvidenceVerifierSlot<'mcp'>;
  voice: JarvisLiveEvidenceVerifierSlot<'voice'>;
  schedule: JarvisLiveEvidenceVerifierSlot<'schedule'>;
  hive: JarvisLiveEvidenceVerifierSlot<'hive'>;
}>;

type KernelRuntimeInput = Readonly<{
  db: JarvisDexie;
  artifactEvidenceAuthorities: CanonicalArtifactEvidenceAuthorities;
  journal: Pick<JarvisExecutionJournal, 'allocateRun' | 'getRun'> &
    Partial<Pick<JarvisExecutionJournal, 'appendEvent' | 'transitionRun'>>;
  cancellationDeliveryAuthority: JarvisCancellationDeliveryAuthority;
  abortRegistrationAuthority: JarvisAbortRegistrationAuthority;
  bindKernelActions: JarvisApprovalActionBinder;
  actionCatalog?: JarvisActionCatalog;
  pluginArtifactResults?: Readonly<{
    consumeCanonicalResult(input: {
      evidence: CanonicalPluginEvidence;
      registration: Extract<JarvisRegisteredActionExecutor, { kind: 'plugin_tool' }>;
      result: Extract<ActionResult, { ok: true }>;
    }): Promise<readonly JarvisArtifactDraft[] | null>;
  }>;
  liveEvidenceVerifiers: VerifierSlots;
  voiceLiveEvidenceStartAuthority?: Readonly<{
    authorizeStart(
      source: Readonly<Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }>>,
    ): () => void;
  }>;
  voicePlaybackAdapter?: JarvisVoicePlaybackAdapter;
  onVoiceTurnHandleIssued?(input: { runId: string; handle: JarvisVoiceTurnHandle }): () => void;
  resolveScheduledOccurrence?(input: {
    accountId: string;
    eventId: string;
    dueAt: number;
    logicalAttempt: number;
    previousRunId?: string;
  }): Promise<JarvisScheduledTurnBasis | undefined>;
  providerAttemptEvidence?: Pick<JarvisProviderAttemptEvidenceAuthority, 'revalidateFailure'>;
  hiveWorkerExecutor?: JarvisHiveWorkerExecutor;
  prepareProvider: JarvisKernelPrepareProvider;
  processResponse: JarvisKernelProcessResponse;
  takeProviderArtifactDrafts(
    raw: Parameters<JarvisKernelProcessResponse>[0],
  ): readonly JarvisArtifactDraft[] | undefined;
  randomUUID: () => string;
  now: () => number;
}>;

function failNotReady(): never {
  throw new Error('kernel_mode_not_ready');
}

async function sha256Canonical(value: unknown): Promise<string> {
  const canonical = canonicalizeJarvisApprovalJson(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function scheduledOccurrenceId(input: {
  accountId: string;
  eventId: string;
  dueAt: number;
}): Promise<`jocc_${string}`> {
  const digest = await sha256Text(
    `schedule-occurrence-v1\u0000${input.accountId}\u0000${input.eventId}\u0000${input.dueAt}`,
  );
  return `jocc_${digest.slice(0, 32)}`;
}

async function scheduledRunId(input: {
  accountId: string;
  occurrenceId: `jocc_${string}`;
  logicalAttempt: number;
}): Promise<string> {
  const digest = await sha256Text(
    `schedule-run-v1\u0000${input.accountId}\u0000${input.occurrenceId}\u0000${input.logicalAttempt}`,
  );
  return `jrun_${digest.slice(0, 32)}`;
}

function sameIdentity(
  left: Readonly<AccountIdentity> | null,
  right: Readonly<AccountIdentity> | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.accountId === right.accountId &&
    left.source === right.source
  );
}

function immutableRunIdentity(run: JarvisRun): unknown {
  return {
    id: run.id,
    accountId: run.accountId,
    ...(run.workspaceId === undefined ? {} : { workspaceId: run.workspaceId }),
    ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
    ...(run.chatId === undefined ? {} : { chatId: run.chatId }),
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    source: run.source,
    agentId: run.agentId,
    identityVersion: run.identityVersion,
    profileRevisionId: run.profileRevisionId,
    model: run.model,
    createdAt: run.createdAt,
  };
}

function sameImmutableRun(left: JarvisRun, right: JarvisRun): boolean {
  try {
    return (
      canonicalizeJarvisApprovalJson(immutableRunIdentity(left)) ===
      canonicalizeJarvisApprovalJson(immutableRunIdentity(right))
    );
  } catch {
    return false;
  }
}

function canonicalValuesMatch(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
  } catch {
    return false;
  }
}

function scopeMatchesOwner(
  scope: Readonly<SyncQueueAuthorityScope>,
  owner: Readonly<SyncQueueOwnerSnapshot>,
): boolean {
  return owner.state === 'cloud'
    ? scope.state === 'cloud' && scope.userId === owner.userId
    : scope.state === 'unbound';
}

function terminalEventSequence(last: { seq: number } | undefined): number {
  const next = (last?.seq ?? 0) + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error('kernel_event_sequence_invalid');
  }
  return next;
}

function cancellationAggregate(delivery: CancellationDelivery): JarvisCancellationAggregate {
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

function isCancellationTerminalStatus(
  status: JarvisRunStatus,
): status is Extract<
  JarvisRunStatus,
  'partial' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
> {
  return (
    status === 'partial' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out'
  );
}

type CancellationIntentCommitOutcome =
  | Readonly<{ kind: 'intent_committed' }>
  | Readonly<{ kind: 'authority_revoked_before_intent' }>
  | Readonly<{
      kind: 'already_terminal';
      terminalStatus: Extract<
        JarvisRunStatus,
        'partial' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
      >;
    }>;

async function lastEvent(context: KernelLifecycleTransactionContext, runId: string) {
  return context.jarvis_events
    .where('[run_id+seq]')
    .between([runId, Dexie.minKey], [runId, Dexie.maxKey], true, true)
    .last();
}

function createPrimaryHostLifecycle(
  liveEvidence: ReturnType<typeof createJarvisLiveEvidenceKernelComposition>,
): JarvisLiveEvidencePrimaryHostLifecycle {
  type SessionState = {
    readonly accountId: string;
    readonly epoch: number;
    readonly subscriptions: Set<() => void>;
    disposed: boolean;
  };

  let disposed = false;
  let nextEpoch = 0;
  let active: SessionState | undefined;
  let serial: Promise<void> = Promise.resolve();

  const assertCurrent = (state: SessionState): void => {
    if (disposed || state.disposed || active !== state) {
      throw new Error('kernel_host_session_stale');
    }
  };

  const revoke = (state: SessionState): void => {
    if (state.disposed) return;
    state.disposed = true;
    for (const unsubscribe of [...state.subscriptions]) unsubscribe();
    state.subscriptions.clear();
    if (active === state) {
      active = undefined;
      liveEvidence.ownerMaintenance.invalidateAccount(state.accountId);
    }
  };

  const openAccount = (accountId: string): Promise<JarvisLiveEvidencePrimaryHostAccountSession> => {
    const operation = serial.then(async () => {
      if (disposed) throw new Error('kernel_host_disposed');
      if (typeof accountId !== 'string' || !accountId || accountId.trim() !== accountId) {
        throw new TypeError('kernel_host_account_invalid');
      }
      if (active) revoke(active);
      const epoch = ++nextEpoch;
      await liveEvidence.ownerMaintenance.reconstructAccount(accountId);
      if (disposed || epoch !== nextEpoch) {
        liveEvidence.ownerMaintenance.invalidateAccount(accountId);
        throw new Error('kernel_host_session_stale');
      }

      const state: SessionState = {
        accountId,
        epoch,
        subscriptions: new Set(),
        disposed: false,
      };
      active = state;
      const read = Object.freeze({
        accountId,
        async snapshot(runId: string) {
          assertCurrent(state);
          const snapshot = await liveEvidence.read.snapshot(accountId, runId);
          assertCurrent(state);
          return snapshot;
        },
        subscribe(runId: string, listener: () => void) {
          assertCurrent(state);
          const unsubscribeSource = liveEvidence.read.subscribe(accountId, runId, () => {
            if (!state.disposed && active === state) listener();
          });
          let subscriptionDisposed = false;
          const unsubscribe = () => {
            if (subscriptionDisposed) return;
            subscriptionDisposed = true;
            state.subscriptions.delete(unsubscribe);
            unsubscribeSource();
          };
          state.subscriptions.add(unsubscribe);
          return unsubscribe;
        },
      });
      return Object.freeze({
        accountId,
        read,
        assertCurrent: () => assertCurrent(state),
        dispose: () => revoke(state),
      });
    });
    serial = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return Object.freeze({
    openAccount,
    dispose() {
      if (disposed) return;
      disposed = true;
      nextEpoch += 1;
      if (active) revoke(active);
      liveEvidence.ownerMaintenance.invalidateAll();
    },
  });
}

export function createJarvisKernelRuntime(
  input: KernelRuntimeInput,
): JarvisKernelRuntimeComposition {
  const repositories = createJarvisRepositories(input.db);
  const liveEvidence = createJarvisLiveEvidenceKernelComposition({
    runs: repositories.run,
    events: repositories.event,
    verifiers: input.liveEvidenceVerifiers,
    sha256Canonical,
    now: input.now,
  });
  const issuedBindings = new WeakSet<JarvisKernelAccountBinding>();
  const issuedApprovalLifecycles = new WeakSet<JarvisIssuedApprovalLifecycle>();
  const issuedActionExecutions = new WeakSet<JarvisIssuedActionExecution>();
  const issuedVoiceHandles = new WeakSet<JarvisVoiceTurnHandle>();
  const issuedVoiceRecoveryHandles = new WeakSet<JarvisVoiceRecoveryHandle>();
  const issuedScheduledAllocations = new WeakSet<JarvisAllocatedScheduledOccurrence>();
  const issuedScheduledPreparations = new WeakSet<PreparedJarvisScheduledKernelAttempt>();
  const issuedScheduledHandles = new WeakSet<JarvisScheduledKernelAttemptHandle>();
  type ScheduledAllocationMode =
    | Readonly<{ kind: 'initial' }>
    | Readonly<{
        kind: 'transport_retry';
        previousAttempt: JarvisTransportAttemptV1;
        revalidatedEvidence: NonNullable<JarvisTransportAttemptV1['zeroEffectEvidence']>;
      }>
    | Readonly<{
        kind: 'logical_retry';
        previousRun: JarvisRun;
        previousAttempt: JarvisTransportAttemptV1;
      }>;
  type ScheduledAllocationState = {
    readonly binding: JarvisKernelAccountBinding;
    readonly run: JarvisRun;
    readonly basis: JarvisScheduledTurnBasis;
    readonly eventId: string;
    readonly occurrenceId: `jocc_${string}`;
    readonly dueAt: number;
    readonly logicalAttempt: number;
    readonly requestId: string;
    readonly createdAt: number;
    readonly mode: ScheduledAllocationMode;
    allocation: JarvisAllocatedScheduledOccurrence | undefined;
    consumed: boolean;
    disposed: boolean;
  };
  type ScheduledPreparationState = {
    readonly allocation: JarvisAllocatedScheduledOccurrence;
    readonly allocationState: ScheduledAllocationState;
    readonly turnInput: Readonly<JarvisKernelTurnInput> & { surface: 'schedule' };
    readonly snapshot: Readonly<JarvisScheduledRetrySnapshotV1>;
    begun: boolean;
    handle: JarvisScheduledKernelAttemptHandle | undefined;
  };
  type ScheduledHandleState = {
    readonly prepared: PreparedJarvisScheduledKernelAttempt;
    readonly preparationState: ScheduledPreparationState;
    readonly binding: JarvisKernelAccountBinding;
    readonly lease: JarvisScheduledAttemptLease;
    readonly snapshot: Readonly<JarvisScheduledRetrySnapshotV1>;
    readonly turnInput: Readonly<JarvisKernelTurnInput> & { surface: 'schedule' };
    readonly liveRegistration: JarvisLiveEvidenceRegistration<'schedule'>;
    providerFailure: JarvisPreEffectTransportFailureEvidence | undefined;
    dispatched: boolean;
    settled: boolean;
    disposed: boolean;
  };
  const scheduledAllocationStates = new WeakMap<
    JarvisAllocatedScheduledOccurrence,
    ScheduledAllocationState
  >();
  const scheduledPreparationStates = new WeakMap<
    PreparedJarvisScheduledKernelAttempt,
    ScheduledPreparationState
  >();
  const scheduledHandleStates = new WeakMap<
    JarvisScheduledKernelAttemptHandle,
    ScheduledHandleState
  >();
  const scheduledAllocationsByRun = new Map<string, JarvisAllocatedScheduledOccurrence>();
  type HiveWorkerHandleState = {
    readonly binding: JarvisKernelAccountBinding;
    readonly parentRun: JarvisRun;
    readonly plan: Readonly<JarvisHiveStackPlanV1>;
    readonly step: Readonly<JarvisHiveStackPlanV1['steps'][number]>;
    readonly childRun: JarvisRun;
    readonly requestId: string;
    readonly controller: AbortController;
    releaseAbortOwner: (() => void) | undefined;
    executed: boolean;
    disposed: boolean;
  };
  type HiveWorkerOutcomeState = {
    readonly binding: JarvisKernelAccountBinding;
    readonly accountId: string;
    readonly parentRunId: string;
    readonly stepId: string;
    readonly childRunId: string;
    readonly childResultEventSeq: number;
    readonly parentResultEventSeq: number;
    readonly resultRef: `jresult_${string}`;
    readonly plan: Readonly<JarvisHiveStackPlanV1>;
    readonly step: Readonly<JarvisHiveStackPlanV1['steps'][number]>;
    readonly childRun: Readonly<JarvisRun>;
    readonly childResultEvent: Readonly<JarvisEvent>;
    readonly parentResultEvent: Readonly<JarvisEvent>;
    readonly result: Readonly<HiveWorkerResult>;
    releaseBinding: (() => void) | undefined;
    releaseRevocationListener: (() => void) | undefined;
    revoked: boolean;
    consumed: boolean;
  };
  const issuedHiveWorkerHandles = new WeakSet<JarvisHiveWorkerHandle>();
  const issuedHiveWorkerOutcomes = new WeakSet<JarvisHiveWorkerOutcome>();
  const hiveWorkerHandleStates = new WeakMap<JarvisHiveWorkerHandle, HiveWorkerHandleState>();
  const hiveWorkerOutcomeStates = new WeakMap<JarvisHiveWorkerOutcome, HiveWorkerOutcomeState>();
  const claimedHiveSteps = new Set<string>();
  const hiveWorkerResults = new Map<string, Readonly<HiveWorkerResult>>();
  type VoiceHandlePhase =
    | 'starting'
    | 'response_pending'
    | 'response_commit_in_flight'
    | 'response_ready_committed'
    | 'playback_in_flight'
    | 'disposed';
  type VoiceHandleState = {
    readonly binding: JarvisKernelAccountBinding;
    readonly turnInput: Readonly<JarvisKernelTurnInput> & { surface: 'voice' };
    releaseBinding: (() => void) | undefined;
    releaseExternal: (() => void) | undefined;
    deferred: JarvisDeferredVoiceKernelTurnResult | undefined;
    phase: VoiceHandlePhase;
    disposeRequested: boolean;
    responseCommit: JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult> | undefined;
    responseCommitOperation:
      | Promise<JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult>>
      | undefined;
    activeOperations: Set<Promise<unknown>>;
    cancellationRequested: boolean;
    cancellationOperation: Promise<JarvisCancellationRequestResult> | undefined;
    cancellationResult: JarvisCancellationRequestResult | undefined;
    playbackResultSource:
      | Readonly<Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }>>
      | undefined;
  };
  const voiceHandleStates = new WeakMap<JarvisVoiceTurnHandle, VoiceHandleState>();
  type VoiceRecoverySnapshot = Readonly<{
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    event: JarvisEvent;
    message: Message;
    artifacts: readonly JarvisArtifactV1[];
  }>;
  type VoiceRecoveryHandleState = {
    readonly binding: JarvisKernelAccountBinding;
    readonly snapshot: VoiceRecoverySnapshot;
    releaseBinding: (() => void) | undefined;
    disposed: boolean;
    activeOperation: Promise<unknown> | undefined;
  };
  const voiceRecoveryHandleStates = new WeakMap<
    JarvisVoiceRecoveryHandle,
    VoiceRecoveryHandleState
  >();
  const bindingLeaseStates = new WeakMap<
    JarvisKernelAccountBinding,
    { count: number; rootReleased: boolean; terminate(): void }
  >();
  const transactionAuthority = createKernelTurnTransactionAuthority(input.db);
  const artifactEffectClaims = createJarvisAttemptEffectBarrierAuthority(repositories.run);
  const assertIssuedAccountBinding = (binding: JarvisKernelAccountBinding): void => {
    if (!issuedBindings.has(binding)) throw new Error('kernel_account_binding_invalid');
  };
  const artifacts = createJarvisArtifactKernelComposition({
    randomUUID: input.randomUUID,
    now: input.now,
    authorities: input.artifactEvidenceAuthorities,
    bindKernelCommit: ({ consumeArtifactsForCommit }) =>
      createKernelTurnCommit({
        transactionAuthority,
        assertIssuedAccountBinding,
        consumeArtifactsForCommit,
      }),
  });
  const providerAttemptEvidence =
    input.providerAttemptEvidence ??
    Object.freeze({
      async revalidateFailure() {
        return null;
      },
    });
  const consequentialEffectSafety = createJarvisConsequentialEffectSafetyAuthority({
    approvals: repositories.approval,
    artifacts: repositories.artifact,
    events: repositories.event,
    providerAttemptEvidence,
    now: input.now,
  });
  const transportAttempts: JarvisTransportAttemptCoordinator =
    createJarvisTransportAttemptCoordinator({
      repository: repositories.run,
      safetyAuthority: consequentialEffectSafety,
    });

  const issueAccountBinding = (accountId: string): JarvisKernelAccountBinding => {
    if (!accountId || accountId.trim() !== accountId) {
      throw new Error('kernel_account_binding_invalid');
    }
    const controller = new AbortController();
    let disposed = false;
    let binding: JarvisKernelAccountBinding | undefined;
    let identity: Readonly<AccountIdentity> | undefined;
    let owner: SyncQueueOwnerSnapshot | undefined;

    const revoke = (reason: string): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const unsubscribeAuth = useAuthStore.subscribe((state) => {
      if (identity && !sameIdentity(resolveAccountIdentity(state), identity)) {
        revoke('account_identity_changed');
      }
    });
    const unsubscribeScope = subscribeSyncQueueAuthorityScope((scope) => {
      if (owner && !scopeMatchesOwner(scope, owner)) revoke('sync_authority_changed');
    });
    const disposeSubscriptions = (): void => {
      unsubscribeAuth();
      unsubscribeScope();
    };

    try {
      const capturedIdentity = resolveAccountIdentity(useAuthStore.getState());
      const capturedOwner = captureSyncQueueOwner(input.now());
      const capturedScope = getCurrentSyncQueueAuthorityScope();
      if (
        !capturedIdentity ||
        capturedIdentity.accountId !== accountId ||
        (capturedIdentity.source === 'supabase'
          ? capturedOwner.state !== 'cloud' || capturedOwner.userId !== accountId
          : capturedOwner.state !== 'unbound') ||
        !scopeMatchesOwner(capturedScope, capturedOwner)
      ) {
        throw new Error('kernel_account_binding_invalid');
      }
      identity = Object.freeze({ ...capturedIdentity });
      owner = capturedOwner;

      const assertCurrent = (): void => {
        if (
          disposed ||
          !binding ||
          !issuedBindings.has(binding) ||
          controller.signal.aborted ||
          !sameIdentity(resolveAccountIdentity(useAuthStore.getState()), identity!) ||
          !scopeMatchesOwner(getCurrentSyncQueueAuthorityScope(), owner!)
        ) {
          throw new Error('kernel_account_authority_revoked');
        }
      };
      const dispose = (): void => {
        const state = binding ? bindingLeaseStates.get(binding) : undefined;
        if (!state || state.rootReleased) return;
        state.rootReleased = true;
        state.count -= 1;
        if (state.count === 0) state.terminate();
      };
      binding = Object.freeze({
        identity,
        syncOwnerSnapshot: owner,
        revocationSignal: controller.signal,
        [jarvisKernelAccountBindingBrand]: true as const,
        assertCurrent,
        dispose,
      });
      issuedBindings.add(binding);
      bindingLeaseStates.set(binding, {
        count: 1,
        rootReleased: false,
        terminate() {
          if (disposed) return;
          disposed = true;
          if (binding) {
            issuedBindings.delete(binding);
            bindingLeaseStates.delete(binding);
          }
          revoke('kernel_account_binding_disposed');
          disposeSubscriptions();
        },
      });
      binding.assertCurrent();
      return binding;
    } catch (error) {
      disposed = true;
      if (binding) {
        issuedBindings.delete(binding);
        bindingLeaseStates.delete(binding);
      }
      revoke('kernel_account_binding_rejected');
      disposeSubscriptions();
      throw error;
    }
  };

  const retainAccountBinding = (binding: JarvisKernelAccountBinding): (() => void) => {
    assertIssuedAccountBinding(binding);
    binding.assertCurrent();
    const state = bindingLeaseStates.get(binding);
    if (!state) throw new Error('kernel_account_binding_invalid');
    state.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const currentState = bindingLeaseStates.get(binding);
      if (!currentState) return;
      currentState.count -= 1;
      if (currentState.count === 0) currentState.terminate();
    };
  };

  const assertScheduledInput = (value: string, field: string): void => {
    if (!value || value.trim() !== value) throw new Error(`kernel_schedule_${field}_invalid`);
  };

  const scheduledBasisFromSnapshot = (
    snapshot: Readonly<JarvisScheduledRetrySnapshotV1>,
  ): JarvisScheduledTurnBasis => {
    const request = snapshot.request;
    if (!request.chatId) throw new Error('kernel_schedule_snapshot_chat_missing');
    const capturedAt = request.model.capturedAt;
    const agent = Object.freeze({
      id: request.agent.id as Agent['id'],
      slug: request.agent.slug,
      name: 'Jarvis',
      description: 'Protected scheduled Jarvis runtime',
      system_prompt: '',
      model: {
        provider: request.model.providerId as Agent['model']['provider'],
        model: request.model.modelId,
      },
      tools_allowed: request.capabilities.tools.map((tool) => tool.id),
      memory_scope: 'workspace' as const,
      capabilities: [],
      builtin: request.agent.builtin,
      created_at: capturedAt,
      updated_at: capturedAt,
    }) satisfies Agent;
    return deepFreezeJarvisCopy({
      ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      chatId: request.chatId,
      userMessageId: `msg_schedule_${request.runId}`,
      agent,
      interactionMode: request.interactionMode,
      userText: request.userText,
      messageHistory: request.messageHistory,
      model: request.model,
      identity: request.identity,
      profile: request.profile,
      capabilities: request.capabilities,
      context: request.context,
      outputContract: request.outputContract,
    });
  };

  const scheduledSnapshotFromRequest = (
    eventId: string,
    occurrenceId: `jocc_${string}`,
    dueAt: number,
    logicalAttempt: number,
    request: Awaited<ReturnType<typeof createJarvisRequestEnvelope>>,
  ): Readonly<JarvisScheduledRetrySnapshotV1> => {
    const { requestId: _requestId, createdAt: _createdAt, ...retryRequest } = request;
    return deepFreezeJarvisCopy({
      schemaVersion: 1 as const,
      accountId: request.accountId,
      eventId,
      occurrenceId,
      dueAt,
      logicalAttempt,
      request: retryRequest,
    });
  };

  const disposeScheduledAllocation = (state: ScheduledAllocationState): void => {
    if (state.disposed) return;
    state.disposed = true;
    const key = JSON.stringify([state.run.accountId, state.run.id]);
    if (state.allocation && scheduledAllocationsByRun.get(key) === state.allocation) {
      scheduledAllocationsByRun.delete(key);
    }
    state.binding.dispose();
  };

  const disposeScheduledHandleState = (
    handle: JarvisScheduledKernelAttemptHandle,
    state: ScheduledHandleState,
  ): void => {
    if (state.disposed) return;
    state.disposed = true;
    issuedScheduledHandles.delete(handle);
    state.liveRegistration.dispose();
    disposeScheduledAllocation(state.preparationState.allocationState);
  };

  const issueScheduledAllocation = (state: ScheduledAllocationState) => {
    const allocation = Object.freeze({
      [jarvisScheduledPreparationSeedBrand]: true as const,
      [jarvisAllocatedScheduledOccurrenceBrand]: true as const,
    });
    state.allocation = allocation;
    issuedScheduledAllocations.add(allocation);
    scheduledAllocationStates.set(allocation, state);
    scheduledAllocationsByRun.set(JSON.stringify([state.run.accountId, state.run.id]), allocation);
    return allocation;
  };

  const currentScheduledAllocation = (inputValue: {
    accountId: string;
    runId: string;
    eventId: string;
    dueAt: number;
    logicalAttempt: number;
  }): JarvisAllocatedScheduledOccurrence | undefined => {
    const key = JSON.stringify([inputValue.accountId, inputValue.runId]);
    const allocation = scheduledAllocationsByRun.get(key);
    const state = allocation ? scheduledAllocationStates.get(allocation) : undefined;
    if (!allocation || !state || state.disposed || state.consumed) {
      if (allocation) scheduledAllocationsByRun.delete(key);
      return undefined;
    }
    try {
      state.binding.assertCurrent();
    } catch {
      scheduledAllocationsByRun.delete(key);
      return undefined;
    }
    if (
      state.run.accountId !== inputValue.accountId ||
      state.run.id !== inputValue.runId ||
      state.eventId !== inputValue.eventId ||
      state.dueAt !== inputValue.dueAt ||
      state.logicalAttempt !== inputValue.logicalAttempt ||
      state.mode.kind !== 'initial'
    ) {
      throw new Error('kernel_schedule_allocation_conflict');
    }
    return allocation;
  };

  const allocateResolvedScheduledOccurrence = async (inputValue: {
    binding: JarvisKernelAccountBinding;
    eventId: string;
    dueAt: number;
    logicalAttempt: number;
    basis: JarvisScheduledTurnBasis;
    mode: ScheduledAllocationMode;
    parentRunId?: string;
  }): Promise<JarvisAllocatedScheduledOccurrence> => {
    inputValue.binding.assertCurrent();
    const accountId = inputValue.binding.identity.accountId;
    const occurrenceId = await scheduledOccurrenceId({
      accountId,
      eventId: inputValue.eventId,
      dueAt: inputValue.dueAt,
    });
    const runId = await scheduledRunId({
      accountId,
      occurrenceId,
      logicalAttempt: inputValue.logicalAttempt,
    });
    const createdAt = input.now();
    const requestId = `jreq_${input.randomUUID()}`;
    const allocation = await transactionAuthority.lifecycleTransaction(
      ['jarvis_runs', 'jarvis_events'],
      inputValue.binding.revocationSignal,
      async (context) => {
        inputValue.binding.assertCurrent();
        const existing = await context.jarvis_runs.get(runId);
        if (existing) {
          return { created: false as const, run: fromJarvisRunRow(existing) };
        }
        const run: JarvisRun = {
          id: runId,
          accountId,
          ...(inputValue.basis.workspaceId === undefined
            ? {}
            : { workspaceId: inputValue.basis.workspaceId }),
          ...(inputValue.basis.projectId === undefined
            ? {}
            : { projectId: inputValue.basis.projectId }),
          chatId: inputValue.basis.chatId,
          ...(inputValue.parentRunId === undefined ? {} : { parentRunId: inputValue.parentRunId }),
          source: 'schedule',
          status: 'queued',
          agentId: inputValue.basis.agent.id,
          identityVersion: inputValue.basis.identity.identityVersion,
          profileRevisionId: inputValue.basis.profile.revisionId,
          model: deepFreezeJarvisCopy(inputValue.basis.model),
          createdAt,
          updatedAt: createdAt,
        };
        const row = toJarvisRunRow(run);
        await context.jarvis_runs.add(row);
        const persisted = await context.jarvis_runs.get(runId);
        if (!persisted || !canonicalValuesMatch(persisted, row)) {
          throw new Error('kernel_schedule_allocation_readback_mismatch');
        }
        return { created: true as const, run: fromJarvisRunRow(persisted) };
      },
    );
    if (allocation.kind === 'cancelled') {
      throw new Error('kernel_account_authority_revoked');
    }
    if (!allocation.value.created) {
      const current = currentScheduledAllocation({
        accountId,
        runId,
        eventId: inputValue.eventId,
        dueAt: inputValue.dueAt,
        logicalAttempt: inputValue.logicalAttempt,
      });
      if (current) {
        inputValue.binding.dispose();
        return current;
      }
      if (
        allocation.value.run.source === 'schedule' &&
        allocation.value.run.status === 'queued' &&
        allocation.value.run.scheduledRetrySnapshot === undefined &&
        (allocation.value.run.transportAttempts?.length ?? 0) === 0
      ) {
        throw new Error('kernel_schedule_unbound_restart');
      }
      throw new Error('kernel_schedule_allocation_conflict');
    }
    const run = allocation.value.run;
    inputValue.binding.assertCurrent();
    const readback = await input.journal.getRun(accountId, runId);
    if (
      !readback ||
      !sameImmutableRun(readback, run) ||
      readback.source !== 'schedule' ||
      readback.status !== 'queued' ||
      readback.scheduledRetrySnapshot !== undefined ||
      (readback.transportAttempts?.length ?? 0) !== 0
    ) {
      throw new Error('kernel_schedule_allocation_readback_mismatch');
    }
    inputValue.binding.assertCurrent();
    return issueScheduledAllocation({
      binding: inputValue.binding,
      run: readback,
      basis: deepFreezeJarvisCopy(inputValue.basis),
      eventId: inputValue.eventId,
      occurrenceId,
      dueAt: inputValue.dueAt,
      logicalAttempt: inputValue.logicalAttempt,
      requestId,
      createdAt,
      mode: inputValue.mode,
      allocation: undefined,
      consumed: false,
      disposed: false,
    });
  };

  const appendCapabilityLiveEvidence = async (
    binding: JarvisKernelAccountBinding,
    scope: Readonly<{
      accountId: string;
      runId: string;
      requestId: string;
      attemptNumber: number;
    }>,
    evidence: JarvisDurableLiveEvidenceV1,
    title: string,
  ): Promise<JarvisEvent> => {
    binding.assertCurrent();
    const transaction = await transactionAuthority.lifecycleTransaction(
      ['jarvis_runs', 'jarvis_events'],
      binding.revocationSignal,
      async (context) => {
        binding.assertCurrent();
        const runRow = await context.jarvis_runs.get(scope.runId);
        if (!runRow || runRow.account_id !== scope.accountId) {
          throw new Error('kernel_live_evidence_scope_mismatch');
        }
        const tail = await lastEvent(context, scope.runId);
        binding.assertCurrent();
        const event: JarvisEvent = {
          runId: scope.runId,
          seq: terminalEventSequence(tail),
          idempotencyKey: `kernel-live:${evidence.registrationId}:${evidence.transition}:${evidence.resultRef}`,
          type: 'tool',
          status: evidence.transition,
          title,
          safeSummary: 'Verified capability execution evidence was updated.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: evidence.observedAt,
          liveEvidence: evidence,
        };
        const row = toJarvisEventRow(event);
        await context.jarvis_events.add(row);
        return fromJarvisEventRow(row);
      },
    );
    if (transaction.kind === 'cancelled') {
      throw new Error('kernel_account_authority_revoked');
    }
    return transaction.value;
  };

  const appendScheduleResultSource = async (
    state: ScheduledHandleState,
    authorityEvent: Readonly<JarvisEvent>,
  ): Promise<JarvisEvent> => {
    const authority = authorityEvent.canonicalResultEvidence;
    if (
      !input.journal.appendEvent ||
      !authority ||
      authority.accountId !== state.turnInput.accountId ||
      authority.runId !== state.turnInput.run.id ||
      authority.requestId !== state.turnInput.attempt.requestId ||
      authority.attemptNumber !== state.turnInput.attempt.attemptNumber ||
      authority.resultRef.trim().length === 0 ||
      authorityEvent.runId !== state.turnInput.run.id
    ) {
      throw new Error('kernel_schedule_result_authority_invalid');
    }
    state.binding.assertCurrent();
    const event = await input.journal.appendEvent(
      state.turnInput.accountId,
      state.turnInput.run.id,
      {
        idempotencyKey: `schedule:${state.turnInput.run.id}:${authority.requestId}:${authority.attemptNumber}:result`,
        type: 'tool',
        status: authority.state,
        title: 'Scheduled dispatch result linked',
        safeSummary: 'A verified scheduled result was linked to its canonical authority.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: authority.observedAt,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: state.turnInput.accountId,
          runId: state.turnInput.run.id,
          requestId: authority.requestId,
          attemptNumber: authority.attemptNumber,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: state.snapshot.eventId,
            occurrenceId: state.snapshot.occurrenceId,
          },
          resultRef: authority.resultRef,
          observedAt: authority.observedAt,
          phase: 'result',
          state: authority.state,
          resultAuthority: {
            runId: authorityEvent.runId,
            eventSeq: authorityEvent.seq,
            evidenceRef: authority.resultRef,
          },
        },
      },
    );
    state.binding.assertCurrent();
    const readback = await repositories.event.getBySeq(
      state.turnInput.accountId,
      state.turnInput.run.id,
      event.seq,
    );
    if (!readback || !canonicalValuesMatch(readback, event)) {
      throw new Error('kernel_schedule_result_readback_mismatch');
    }
    return readback;
  };

  const loadScheduleResultAuthority = async (
    state: ScheduledHandleState,
    kind: 'kernel_turn_committed' | 'scheduled_transport_settled',
  ): Promise<JarvisEvent> => {
    const events = await repositories.event.listByRun(
      state.turnInput.accountId,
      state.turnInput.run.id,
      { limit: 500 },
    );
    state.binding.assertCurrent();
    const authority = [...events].reverse().find((event) => {
      const evidence = event.canonicalResultEvidence;
      return (
        evidence?.kind === kind &&
        evidence.accountId === state.turnInput.accountId &&
        evidence.runId === state.turnInput.run.id &&
        evidence.requestId === state.turnInput.attempt.requestId &&
        evidence.attemptNumber === state.turnInput.attempt.attemptNumber
      );
    });
    if (!authority) throw new Error('kernel_schedule_result_authority_missing');
    return authority;
  };

  const completeScheduleLiveEvidence = async (
    state: ScheduledHandleState,
    resultEvent: Readonly<JarvisEvent>,
  ): Promise<void> => {
    const source = resultEvent.producerSourceEvidence;
    if (
      source?.producerKind !== 'schedule' ||
      source.phase !== 'result' ||
      (source.state !== 'completed' && source.state !== 'degraded')
    ) {
      throw new Error('kernel_schedule_result_source_invalid');
    }
    const completed = await state.liveRegistration.complete({
      evidence: Object.freeze({
        schemaVersion: 1,
        producerKind: 'schedule',
        producerIdentity: source.producerIdentity,
        accountId: source.accountId,
        runId: source.runId,
        requestId: source.requestId,
        attemptNumber: source.attemptNumber,
        resultRef: source.resultRef,
        resultEventSeq: resultEvent.seq,
        state: source.state,
        verifiedAt: source.observedAt,
      }),
      state: source.state,
    });
    state.binding.assertCurrent();
    if (
      completed.accountId !== source.accountId ||
      completed.runId !== source.runId ||
      completed.resultEventSeq !== resultEvent.seq ||
      completed.transition !== source.state
    ) {
      throw new Error('kernel_schedule_live_evidence_mismatch');
    }
  };

  const hiveStepKey = (accountId: string, parentRunId: string, stepId: string): string =>
    JSON.stringify([accountId, parentRunId, stepId]);

  const hiveAgentFromStep = (step: Readonly<JarvisHiveStackPlanV1['steps'][number]>): Agent => ({
    id: step.agent.id as Agent['id'],
    slug: step.agent.slug,
    name: step.agent.name,
    description: step.agent.description,
    system_prompt: step.agent.systemPrompt,
    model: {
      provider: step.model.providerId as Agent['model']['provider'],
      model: step.model.modelId,
    },
    tools_allowed: [...step.agent.toolsAllowed],
    memory_scope: step.agent.memoryScope,
    capabilities: [...step.agent.capabilities] as Agent['capabilities'],
    builtin: step.agent.builtin,
    created_at: step.agent.createdAt,
    updated_at: step.agent.updatedAt,
  });

  const disposeHiveWorkerHandleState = (
    handle: JarvisHiveWorkerHandle,
    state: HiveWorkerHandleState,
  ): void => {
    if (state.disposed) return;
    state.disposed = true;
    issuedHiveWorkerHandles.delete(handle);
    state.releaseAbortOwner?.();
    state.releaseAbortOwner = undefined;
    if (!state.executed) {
      claimedHiveSteps.delete(
        hiveStepKey(state.parentRun.accountId, state.parentRun.id, state.step.stepId),
      );
    }
    state.binding.dispose();
  };

  const consumeHiveWorkerOutcomeState = (
    outcome: JarvisHiveWorkerOutcome,
    state: HiveWorkerOutcomeState,
  ): void => {
    if (state.consumed) return;
    state.consumed = true;
    issuedHiveWorkerOutcomes.delete(outcome);
    hiveWorkerOutcomeStates.delete(outcome);
    state.releaseRevocationListener?.();
    state.releaseRevocationListener = undefined;
    state.releaseBinding?.();
    state.releaseBinding = undefined;
  };

  const requestCancellationWithBinding = async (
    binding: JarvisKernelAccountBinding,
    cancelInput: Readonly<{ accountId: string; runId: string }>,
  ): Promise<JarvisCancellationRequestResult> => {
    const current = (): boolean => {
      try {
        binding.assertCurrent();
        return true;
      } catch {
        return false;
      }
    };
    if (!current()) return { kind: 'authority_revoked_before_intent' };
    const preparation = await input.cancellationDeliveryAuthority.prepare(
      cancelInput.accountId,
      cancelInput.runId,
    );
    if (preparation.kind === 'already_terminal') return preparation;
    if (preparation.kind === 'already_pending') {
      return {
        kind: 'intent_committed',
        requestState: 'already_pending',
        authorityState: current() ? 'current' : 'revoked_after_intent',
        cancellationRequestId: preparation.cancellationRequestId,
        aggregate: cancellationAggregate(preparation.currentDelivery),
      };
    }

    const { plan } = preparation;
    if (!current()) {
      input.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
      return { kind: 'authority_revoked_before_intent' };
    }
    const intent = await (async () => {
      try {
        return await transactionAuthority.lifecycleTransaction<CancellationIntentCommitOutcome>(
          ['jarvis_runs', 'jarvis_events'],
          binding.revocationSignal,
          async (context) => {
            if (!current()) return { kind: 'authority_revoked_before_intent' as const };
            const runRow = await context.jarvis_runs.get(cancelInput.runId);
            if (!runRow || runRow.account_id !== cancelInput.accountId) {
              throw new Error('kernel_cancellation_scope_mismatch');
            }
            const run = fromJarvisRunRow(runRow);
            if (isCancellationTerminalStatus(run.status)) {
              return { kind: 'already_terminal' as const, terminalStatus: run.status };
            }
            const tail = await lastEvent(context, cancelInput.runId);
            if (!current()) return { kind: 'authority_revoked_before_intent' as const };
            const row = toJarvisEventRow({
              runId: cancelInput.runId,
              seq: terminalEventSequence(tail),
              idempotencyKey: plan.cancellationRequestId,
              type: 'warning',
              status: 'cancellation_requested',
              title: 'Cancellation requested',
              safeSummary: 'Cancellation delivery is pending.',
              sourceRefs: [],
              artifactIds: [],
              createdAt: input.now(),
            });
            await context.jarvis_events.add(row);
            return { kind: 'intent_committed' as const };
          },
        );
      } catch (error) {
        input.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
        throw error;
      }
    })();
    if (intent.kind === 'cancelled' || intent.value.kind === 'authority_revoked_before_intent') {
      input.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
      return { kind: 'authority_revoked_before_intent' };
    }
    if (intent.value.kind === 'already_terminal') {
      input.cancellationDeliveryAuthority.abandonBeforeDelivery(plan);
      return intent.value;
    }

    let delivery: CancellationDelivery;
    try {
      delivery = await input.cancellationDeliveryAuthority.deliver(plan);
    } catch {
      return {
        kind: 'intent_committed',
        requestState: 'new',
        authorityState: current() ? 'current' : 'revoked_after_intent',
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
      authorityState: current() ? 'current' : 'revoked_after_intent',
      cancellationRequestId: plan.cancellationRequestId,
      aggregate: cancellationAggregate(delivery),
    };
  };

  type CanonicalActionScope = Readonly<{
    parentRun: JarvisRun;
    requestId: string;
    attemptNumber: number;
  }>;

  const loadCanonicalActionScope = async (
    suppliedParent: JarvisRun,
    suppliedAttempt?: Readonly<{ runId: string; requestId: string; attemptNumber: number }>,
    responseBackedApprovalId?: string,
  ): Promise<CanonicalActionScope> => {
    const canonicalParent = await repositories.run.getById(
      suppliedParent.accountId,
      suppliedParent.id,
    );
    if (!canonicalParent || !sameImmutableRun(canonicalParent, suppliedParent)) {
      throw new Error('kernel_action_scope_mismatch');
    }
    const currentAttempt = canonicalParent.transportAttempts?.at(-1);
    if (currentAttempt) {
      if (
        currentAttempt.state !== 'provider_in_flight' ||
        !currentAttempt.requestId ||
        !Number.isSafeInteger(currentAttempt.attemptNumber) ||
        currentAttempt.attemptNumber < 1 ||
        (suppliedAttempt !== undefined &&
          (suppliedAttempt.runId !== canonicalParent.id ||
            suppliedAttempt.requestId !== currentAttempt.requestId ||
            suppliedAttempt.attemptNumber !== currentAttempt.attemptNumber))
      ) {
        throw new Error('kernel_action_scope_mismatch');
      }
      return Object.freeze({
        parentRun: canonicalParent,
        requestId: currentAttempt.requestId,
        attemptNumber: currentAttempt.attemptNumber,
      });
    }

    if (canonicalParent.source === 'schedule') throw new Error('kernel_action_scope_mismatch');
    const runEvents = (
      await input.db.jarvis_events.where('run_id').equals(canonicalParent.id).toArray()
    ).map(fromJarvisEventRow);
    const providerStarts = runEvents.filter((event) => {
      const source = event.producerSourceEvidence;
      return (
        event.type === 'model' &&
        event.status === 'started' &&
        source?.producerKind === 'provider' &&
        source.phase === 'start' &&
        source.state === 'started' &&
        source.accountId === canonicalParent.accountId &&
        source.runId === canonicalParent.id
      );
    });
    if (providerStarts.length !== 1) throw new Error('kernel_action_scope_mismatch');
    const providerScope = providerStarts[0]!.producerSourceEvidence!;
    if (
      providerScope.producerKind !== 'provider' ||
      !providerScope.requestId ||
      !Number.isSafeInteger(providerScope.attemptNumber) ||
      providerScope.attemptNumber < 1 ||
      (suppliedAttempt !== undefined &&
        (suppliedAttempt.runId !== canonicalParent.id ||
          suppliedAttempt.requestId !== providerScope.requestId ||
          suppliedAttempt.attemptNumber !== providerScope.attemptNumber))
    ) {
      throw new Error('kernel_action_scope_mismatch');
    }
    if (responseBackedApprovalId) {
      if (canonicalParent.status !== 'awaiting_approval') {
        throw new Error('kernel_action_scope_mismatch');
      }
      const approval = await repositories.approval.getById(
        canonicalParent.accountId,
        responseBackedApprovalId,
      );
      if (
        !approval ||
        !['pending', 'approved'].includes(approval.status) ||
        approval.runId !== canonicalParent.id ||
        approval.requestId !== providerScope.requestId ||
        approval.attemptNumber !== providerScope.attemptNumber ||
        approval.expiresAt <= input.now()
      ) {
        throw new Error('kernel_action_scope_mismatch');
      }
      const providerResultEvents = runEvents.filter(
        (event) =>
          event.runId === canonicalParent.id &&
          event.producerSourceEvidence?.producerKind === 'provider' &&
          event.producerSourceEvidence.phase === 'result',
      );
      const isCompletedResponseCheckpoint = (event: (typeof runEvents)[number]): boolean =>
        event.type === 'message' &&
        event.status === 'approval_required' &&
        event.producerSourceEvidence?.producerKind === 'provider' &&
        event.producerSourceEvidence.phase === 'result' &&
        event.producerSourceEvidence.state === 'completed';
      let responseCheckpoints = runEvents.filter(
        (event) =>
          event.idempotencyKey === `action-response-ready:${responseBackedApprovalId}` &&
          isCompletedResponseCheckpoint(event),
      );
      if (
        responseCheckpoints.length !== 1 &&
        (approval.actionId === 'files.create' || approval.actionId === 'files.read')
      ) {
        const siblings = await repositories.approval.listByRun(
          canonicalParent.accountId,
          canonicalParent.id,
          {
            requestId: providerScope.requestId,
            attemptNumber: providerScope.attemptNumber,
            limit: 10,
          },
        );
        const filesCreateBatch = siblings.filter(
          (candidate) =>
            candidate.actionId === approval.actionId &&
            (candidate.status === 'pending' ||
              candidate.status === 'approved' ||
              candidate.status === 'consumed'),
        );
        if (
          filesCreateBatch.length >= 2 &&
          filesCreateBatch.length <= 10 &&
          filesCreateBatch.some((candidate) => candidate.id === approval.id)
        ) {
          const checkpointKeys = new Set(
            filesCreateBatch.map((candidate) => `action-response-ready:${candidate.id}`),
          );
          responseCheckpoints = runEvents.filter(
            (event) =>
              checkpointKeys.has(event.idempotencyKey) && isCompletedResponseCheckpoint(event),
          );
        }
      }
      const checkpoint = responseCheckpoints.length === 1 ? responseCheckpoints[0] : undefined;
      const matchedProviderResult = checkpoint
        ? providerResultEvents.find((event) => event.seq === checkpoint.seq)
        : providerResultEvents.length === 1
          ? providerResultEvents[0]
          : undefined;
      const matchedEvidence = matchedProviderResult?.producerSourceEvidence;
      if (
        !checkpoint ||
        !matchedProviderResult ||
        matchedEvidence?.producerKind !== 'provider' ||
        matchedEvidence.state !== 'completed' ||
        matchedEvidence.accountId !== canonicalParent.accountId ||
        matchedEvidence.runId !== canonicalParent.id ||
        matchedEvidence.requestId !== providerScope.requestId ||
        matchedEvidence.attemptNumber !== providerScope.attemptNumber ||
        matchedEvidence.producerIdentity.providerId !== providerScope.producerIdentity.providerId ||
        matchedEvidence.producerIdentity.modelId !== providerScope.producerIdentity.modelId
      ) {
        throw new Error('kernel_action_scope_mismatch');
      }
    }
    return Object.freeze({
      parentRun: canonicalParent,
      requestId: providerScope.requestId,
      attemptNumber: providerScope.attemptNumber,
    });
  };

  const hasActionResponseCheckpoint = async (
    scope: CanonicalActionScope,
    approvalId: string,
  ): Promise<boolean> => {
    const responseKey = `action-response-ready:${approvalId}`;
    const matches = await input.db.jarvis_events
      .where('run_id')
      .equals(scope.parentRun.id)
      .filter((row) => row.idempotency_key === responseKey)
      .toArray();
    if (matches.length > 1) throw new Error('kernel_action_response_checkpoint_conflict');
    if (matches.length === 1) return true;
    const siblings = await repositories.approval.listByRun(
      scope.parentRun.accountId,
      scope.parentRun.id,
      {
        requestId: scope.requestId,
        attemptNumber: scope.attemptNumber,
        limit: 10,
      },
    );
    const self = siblings.find((candidate) => candidate.id === approvalId);
    if (
      !self ||
      (self.actionId !== 'files.create' && self.actionId !== 'files.read')
    ) {
      return false;
    }
    const fileBatch = siblings.filter(
      (candidate) =>
        candidate.actionId === self.actionId &&
        (candidate.status === 'pending' ||
          candidate.status === 'approved' ||
          candidate.status === 'consumed'),
    );
    if (fileBatch.length < 2 || fileBatch.length > 10) {
      return false;
    }
    const checkpointKeys = new Set(
      fileBatch.map((candidate) => `action-response-ready:${candidate.id}`),
    );
    const siblingMatches = await input.db.jarvis_events
      .where('run_id')
      .equals(scope.parentRun.id)
      .filter((row) => checkpointKeys.has(row.idempotency_key))
      .toArray();
    if (siblingMatches.length > 1) throw new Error('kernel_action_response_checkpoint_conflict');
    return siblingMatches.length === 1;
  };

  const issueApprovalLifecycle = (
    binding: JarvisKernelAccountBinding,
    scope: CanonicalActionScope,
  ): JarvisIssuedApprovalLifecycle => {
    assertIssuedAccountBinding(binding);
    binding.assertCurrent();
    if (scope.parentRun.accountId !== binding.identity.accountId) {
      throw new Error('kernel_action_scope_mismatch');
    }

    const controller = new AbortController();
    let lifecycle: JarvisIssuedApprovalLifecycle | undefined;
    let disposed = false;
    const onBindingRevoked = (): void => controller.abort(binding.revocationSignal.reason);
    binding.revocationSignal.addEventListener('abort', onBindingRevoked, { once: true });
    if (binding.revocationSignal.aborted) onBindingRevoked();

    const current = (): boolean => {
      try {
        if (
          disposed ||
          !lifecycle ||
          !issuedApprovalLifecycles.has(lifecycle) ||
          controller.signal.aborted
        ) {
          return false;
        }
        binding.assertCurrent();
        return true;
      } catch {
        return false;
      }
    };

    const approvalWrite = async <T>(
      body: (context: KernelApprovalTransactionContext) => Promise<T>,
    ): Promise<JarvisAuthorityBoundResult<T>> => {
      if (!current()) return { kind: 'account_authority_revoked' };
      const transaction = await transactionAuthority.approvalTransaction(
        ['jarvis_runs', 'jarvis_events', 'jarvis_approvals'],
        controller.signal,
        async (context) => {
          if (!current()) throw new Error('kernel_account_authority_revoked');
          const value = await body(context);
          if (!current()) throw new Error('kernel_account_authority_revoked');
          return value;
        },
      );
      return transaction.kind === 'cancelled'
        ? { kind: 'account_authority_revoked' }
        : { kind: 'committed', value: transaction.value };
    };

    const captureEventTailSeq = async (): Promise<number> => {
      if (!current()) throw new Error('kernel_account_authority_revoked');
      const tail = await input.db.jarvis_events
        .where('[run_id+seq]')
        .between([scope.parentRun.id, Dexie.minKey], [scope.parentRun.id, Dexie.maxKey], true, true)
        .last();
      if (!current()) throw new Error('kernel_account_authority_revoked');
      return tail?.seq ?? 0;
    };

    type PreparedApprovalInput = Parameters<
      JarvisIssuedApprovalLifecycle['putPreparedApproval']
    >[0] & {
      approvalId: string;
      paramsHash: string;
      targetSnapshot: unknown;
      risk: JarvisApprovalV1['risk'];
      capabilityId: string;
      capabilitySnapshotHash: string;
      expectedEffect: string;
      createdAt: number;
    };

    const approvalFromPrepared = (
      preparedInput: Parameters<JarvisIssuedApprovalLifecycle['putPreparedApproval']>[0],
    ): JarvisApprovalV1 => {
      const prepared = preparedInput as PreparedApprovalInput;
      if (
        prepared.parentRun.id !== scope.parentRun.id ||
        prepared.parentRun.accountId !== scope.parentRun.accountId ||
        prepared.attempt.runId !== scope.parentRun.id ||
        prepared.attempt.requestId !== scope.requestId ||
        prepared.attempt.attemptNumber !== scope.attemptNumber
      ) {
        throw new Error('kernel_action_scope_mismatch');
      }
      return {
        id: prepared.approvalId,
        runId: scope.parentRun.id,
        actionId: prepared.actionId,
        actionVersion: prepared.actionVersion,
        params: structuredClone(prepared.params),
        secretHandleRefs: structuredClone([...prepared.secretHandleRefs]),
        paramsHash: prepared.paramsHash,
        targetSnapshot: structuredClone(prepared.targetSnapshot),
        risk: prepared.risk,
        status: 'pending',
        createdAt: prepared.createdAt,
        schemaVersion: 1,
        requestId: scope.requestId,
        attemptNumber: scope.attemptNumber,
        capabilityId: prepared.capabilityId,
        capabilitySnapshotHash: prepared.capabilitySnapshotHash,
        expectedEffect: prepared.expectedEffect,
        expiresAt: prepared.expiresAt,
      };
    };

    type ClaimedApprovalMutation = Awaited<ReturnType<typeof claimApprovedExecutionInContext>>;

    const issueActionExecution = async (
      claimed: ClaimedApprovalMutation,
      finalizeResponseOnResult: boolean,
    ): Promise<JarvisAuthorityBoundResult<JarvisIssuedActionExecution>> => {
      const startSource = claimed.startEvent.producerSourceEvidence;
      const startExecution = claimed.startEvent.executionEvidence;
      if (
        !startSource ||
        startSource.phase !== 'start' ||
        !startExecution ||
        startExecution.kind !== 'consequential_effect_claimed' ||
        startSource.accountId !== scope.parentRun.accountId ||
        startSource.runId !== scope.parentRun.id ||
        startSource.requestId !== scope.requestId ||
        startSource.attemptNumber !== scope.attemptNumber ||
        startExecution.requestId !== scope.requestId ||
        startExecution.attemptNumber !== scope.attemptNumber ||
        startSource.resultRef !== startExecution.evidenceRef ||
        startSource.observedAt !== startExecution.observedAt ||
        (startSource.producerKind !== 'action' &&
          startSource.producerKind !== 'file_action' &&
          startSource.producerKind !== 'terminal' &&
          startSource.producerKind !== 'plugin' &&
          startSource.producerKind !== 'mcp')
      ) {
        throw new Error('kernel_action_claim_readback_mismatch');
      }

      let releaseBinding: (() => void) | undefined;
      try {
        releaseBinding = retainAccountBinding(binding);
      } catch {
        return { kind: 'account_authority_revoked' };
      }
      const producerKind = startSource.producerKind;
      const registrationId = `action:${claimed.approval.id}:${startExecution.ownerId}`;
      let disposedExecution = false;
      let transferred = false;
      let effectStarted = false;
      let resultSettled = false;
      let execution: JarvisIssuedActionExecution | undefined;
      let registration: JarvisLiveEvidenceRegistration<typeof producerKind> | undefined;

      const childCurrent = (): boolean => {
        try {
          if (
            disposedExecution ||
            (execution !== undefined && !issuedActionExecutions.has(execution)) ||
            binding.revocationSignal.aborted
          ) {
            return false;
          }
          binding.assertCurrent();
          return true;
        } catch {
          return false;
        }
      };

      const appendChildEvent = async (
        event: Omit<JarvisEvent, 'runId' | 'seq'>,
      ): Promise<JarvisAuthorityBoundResult<JarvisEvent>> => {
        if (!childCurrent()) return { kind: 'account_authority_revoked' };
        const transaction = await transactionAuthority.lifecycleTransaction(
          ['jarvis_runs', 'jarvis_events'],
          binding.revocationSignal,
          async (context) => {
            binding.assertCurrent();
            const runRow = await context.jarvis_runs.get(scope.parentRun.id);
            if (!runRow || runRow.account_id !== scope.parentRun.accountId) {
              throw new Error('kernel_action_scope_mismatch');
            }
            const tail = await lastEvent(context, scope.parentRun.id);
            binding.assertCurrent();
            const row = toJarvisEventRow({
              ...event,
              runId: scope.parentRun.id,
              seq: terminalEventSequence(tail),
            });
            await context.jarvis_events.add(row);
            return fromJarvisEventRow(row);
          },
        );
        return transaction.kind === 'cancelled'
          ? { kind: 'account_authority_revoked' }
          : { kind: 'committed', value: transaction.value };
      };

      const appendLiveEvidence: JarvisLiveEvidenceAppendCapability = Object.freeze({
        async append({ evidence }: { evidence: JarvisDurableLiveEvidenceV1 }) {
          const result = await appendChildEvent({
            idempotencyKey: `kernel-live:${evidence.registrationId}:${evidence.transition}:${evidence.resultRef}`,
            type: 'tool',
            status: evidence.transition,
            title: 'Capability evidence updated',
            safeSummary: 'Verified live execution evidence was updated.',
            sourceRefs: [],
            artifactIds: [],
            createdAt: evidence.observedAt,
            liveEvidence: evidence,
          });
          if (result.kind !== 'committed') throw new Error('kernel_account_authority_revoked');
          return result.value;
        },
      });
      const liveOwner = liveEvidence.bindLifecycle({
        scope: {
          accountId: scope.parentRun.accountId,
          runId: scope.parentRun.id,
          requestId: scope.requestId,
          attemptNumber: scope.attemptNumber,
        },
        append: appendLiveEvidence,
      });
      const initialEvidence = {
        schemaVersion: 1 as const,
        producerKind,
        producerIdentity: structuredClone(startSource.producerIdentity),
        accountId: scope.parentRun.accountId,
        runId: scope.parentRun.id,
        requestId: scope.requestId,
        attemptNumber: scope.attemptNumber,
        resultRef: startSource.resultRef,
        resultEventSeq: claimed.startEvent.seq,
        state: startSource.state,
        verifiedAt: startSource.observedAt,
      } as JarvisCanonicalLiveProducerEvidence<typeof producerKind>;
      const startInput = {
        evidence: initialEvidence,
        registrationId,
        category:
          producerKind === 'plugin'
            ? ('plugin' as const)
            : producerKind === 'mcp'
              ? ('mcp' as const)
              : producerKind === 'terminal'
                ? ('terminal' as const)
                : ('tool' as const),
        capabilityId: claimed.approval.capabilityId,
        operations: ['execute', 'cancel', 'inspect'] as const,
        state: startSource.state as 'ready' | 'busy' | 'degraded',
      };

      try {
        registration = (producerKind === 'action'
          ? await liveOwner.action.startCapability({
              ...startInput,
              evidence: initialEvidence as JarvisCanonicalLiveProducerEvidence<'action'>,
            })
          : producerKind === 'file_action'
            ? await liveOwner.fileAction.startCapability({
                ...startInput,
                evidence: initialEvidence as JarvisCanonicalLiveProducerEvidence<'file_action'>,
              })
            : producerKind === 'terminal'
              ? await liveOwner.terminal.startCapability({
                  ...startInput,
                  evidence: initialEvidence as JarvisCanonicalLiveProducerEvidence<'terminal'>,
                })
              : producerKind === 'plugin'
                ? await liveOwner.plugin.startCapability({
                    ...startInput,
                    evidence: initialEvidence as JarvisCanonicalLiveProducerEvidence<'plugin'>,
                  })
                : await liveOwner.mcp.startCapability({
                    ...startInput,
                    evidence: initialEvidence as JarvisCanonicalLiveProducerEvidence<'mcp'>,
                  })) as unknown as JarvisLiveEvidenceRegistration<typeof producerKind>;
      } catch (error) {
        releaseBinding();
        if (!childCurrent()) return { kind: 'account_authority_revoked' };
        throw error;
      }
      const activeRegistration = registration;
      if (!activeRegistration) throw new Error('kernel_action_live_registration_missing');

      const disposeChild = (): void => {
        if (disposedExecution) return;
        disposedExecution = true;
        if (execution) issuedActionExecutions.delete(execution);
        activeRegistration.dispose();
        releaseBinding?.();
        releaseBinding = undefined;
      };

      const recordResult: JarvisIssuedActionExecution['recordResult'] = async (result) => {
        if (!childCurrent()) return { kind: 'account_authority_revoked' };
        if (resultSettled) throw new Error('kernel_action_result_already_settled');
        resultSettled = true;
        const completed = await appendChildEvent({
          idempotencyKey: `action-result:${claimed.approval.id}:${result.resultRef}`,
          type: 'tool',
          status: result.state,
          title: result.state === 'completed' ? 'Action completed' : 'Action degraded',
          safeSummary: 'The protected action produced a canonical result.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: result.completedAt,
          executionEvidence: {
            schemaVersion: 1,
            requestId: scope.requestId,
            attemptNumber: scope.attemptNumber,
            kind: 'consequential_effect_completed',
            ownerKind: startExecution.ownerKind,
            ownerId: startExecution.ownerId,
            evidenceRef: result.resultRef,
            observedAt: result.completedAt,
          },
          producerSourceEvidence: {
            schemaVersion: 1,
            accountId: scope.parentRun.accountId,
            runId: scope.parentRun.id,
            requestId: scope.requestId,
            attemptNumber: scope.attemptNumber,
            producerKind,
            producerIdentity: structuredClone(startSource.producerIdentity),
            phase: 'result',
            state: result.state,
            resultRef: result.resultRef,
            observedAt: result.completedAt,
          } as JarvisEvent['producerSourceEvidence'],
        });
        if (completed.kind !== 'committed') return completed;
        const proof = await activeRegistration.complete({
          evidence: {
            ...initialEvidence,
            resultRef: result.resultRef,
            resultEventSeq: completed.value.seq,
            state: result.state,
            verifiedAt: result.completedAt,
          },
          state: result.state,
        });
        if (!childCurrent()) return { kind: 'account_authority_revoked' };
        if (finalizeResponseOnResult) {
          const finalized = await artifacts.commitKernelTurn.finalizeActionResponse({
            accountId: scope.parentRun.accountId,
            runId: scope.parentRun.id,
            requestId: scope.requestId,
            attemptNumber: scope.attemptNumber,
            approvalId: claimed.approval.id,
            messageId: `msg_${scope.requestId}`,
            accountBinding: binding,
            outcome: result.state,
            resultRef: result.resultRef,
            ...(result.responseResult === undefined ? {} : { result: result.responseResult }),
            completedAt: result.completedAt,
          });
          if (!finalized.committed) {
            if (finalized.reason === 'account_authority_revoked') {
              return { kind: 'account_authority_revoked' };
            }
            throw new Error(`kernel_action_response_finalize_${finalized.reason}`);
          }
        }
        return { kind: 'committed', value: proof };
      };

      const recordCancellationVerified: JarvisIssuedActionExecution['recordCancellationVerified'] =
        async (cancellation) => {
          if (!childCurrent()) return { kind: 'account_authority_revoked' };
          if (producerKind !== 'terminal') throw new Error('kernel_terminal_cancellation_invalid');
          if (
            resultSettled ||
            !cancellation.cancellationRequestId.trim() ||
            !cancellation.resultRef.trim() ||
            !Number.isFinite(cancellation.verifiedAt)
          ) {
            throw new Error('kernel_terminal_cancellation_invalid');
          }
          resultSettled = true;
          const transaction = await transactionAuthority.lifecycleTransaction(
            ['jarvis_runs', 'jarvis_events'],
            binding.revocationSignal,
            async (context) => {
              binding.assertCurrent();
              const runRow = await context.jarvis_runs.get(scope.parentRun.id);
              if (!runRow || runRow.account_id !== scope.parentRun.accountId) {
                throw new Error('kernel_action_scope_mismatch');
              }
              const run = fromJarvisRunRow(runRow);
              const [intent, tail] = await Promise.all([
                context.jarvis_events
                  .where('run_id')
                  .equals(scope.parentRun.id)
                  .filter(
                    (row) =>
                      row.status === 'cancellation_requested' &&
                      row.idempotency_key === cancellation.cancellationRequestId,
                  )
                  .first(),
                lastEvent(context, scope.parentRun.id),
              ]);
              if (!intent || run.status !== 'running' || cancellation.verifiedAt < run.updatedAt) {
                throw new Error('kernel_terminal_cancellation_conflict');
              }
              binding.assertCurrent();
              const resultEvent: JarvisEvent = {
                runId: scope.parentRun.id,
                seq: terminalEventSequence(tail),
                idempotencyKey: `terminal-cancellation-result:${claimed.approval.id}:${cancellation.cancellationRequestId}`,
                type: 'tool',
                status: 'degraded',
                title: 'Terminal cancellation verified',
                safeSummary: 'The native terminal owner verified cancellation.',
                sourceRefs: [],
                artifactIds: [],
                createdAt: cancellation.verifiedAt,
                executionEvidence: {
                  schemaVersion: 1,
                  requestId: scope.requestId,
                  attemptNumber: scope.attemptNumber,
                  kind: 'consequential_effect_completed',
                  ownerKind: startExecution.ownerKind,
                  ownerId: startExecution.ownerId,
                  evidenceRef: cancellation.resultRef,
                  observedAt: cancellation.verifiedAt,
                },
                producerSourceEvidence: {
                  schemaVersion: 1,
                  accountId: scope.parentRun.accountId,
                  runId: scope.parentRun.id,
                  requestId: scope.requestId,
                  attemptNumber: scope.attemptNumber,
                  producerKind,
                  producerIdentity: structuredClone(startSource.producerIdentity),
                  phase: 'result',
                  state: 'degraded',
                  resultRef: cancellation.resultRef,
                  observedAt: cancellation.verifiedAt,
                } as JarvisEvent['producerSourceEvidence'],
              };
              const cancelledRun: JarvisRun = {
                ...run,
                status: 'cancelled',
                updatedAt: cancellation.verifiedAt,
                completedAt: cancellation.verifiedAt,
              };
              const transitionEvent: JarvisEvent = {
                runId: scope.parentRun.id,
                seq: resultEvent.seq + 1,
                idempotencyKey: `terminal-cancelled:${cancellation.cancellationRequestId}`,
                type: 'run_state',
                status: 'cancelled',
                title: 'Terminal run cancelled',
                safeSummary: 'Cancellation was verified by the native terminal owner.',
                sourceRefs: [],
                artifactIds: [],
                createdAt: cancellation.verifiedAt,
              };
              const cancelledRow = toJarvisRunRow(cancelledRun);
              const resultRow = toJarvisEventRow(resultEvent);
              const transitionRow = toJarvisEventRow(transitionEvent);
              await context.jarvis_runs.put(cancelledRow);
              await context.jarvis_events.bulkAdd([resultRow, transitionRow]);
              const [readRun, readResult, readTransition] = await Promise.all([
                context.jarvis_runs.get(cancelledRow.id),
                context.jarvis_events.get([resultRow.run_id, resultRow.seq]),
                context.jarvis_events.get([transitionRow.run_id, transitionRow.seq]),
              ]);
              if (
                !readRun ||
                !readResult ||
                !readTransition ||
                canonicalizeJarvisApprovalJson(readRun) !==
                  canonicalizeJarvisApprovalJson(cancelledRow) ||
                canonicalizeJarvisApprovalJson(readResult) !==
                  canonicalizeJarvisApprovalJson(resultRow) ||
                canonicalizeJarvisApprovalJson(readTransition) !==
                  canonicalizeJarvisApprovalJson(transitionRow)
              ) {
                throw new Error('kernel_terminal_cancellation_readback_mismatch');
              }
              return {
                run: fromJarvisRunRow(readRun),
                resultEvent: fromJarvisEventRow(readResult),
                event: fromJarvisEventRow(readTransition),
              };
            },
          );
          if (transaction.kind === 'cancelled') {
            return { kind: 'account_authority_revoked' };
          }
          const proof = await activeRegistration.complete({
            evidence: {
              ...initialEvidence,
              resultRef: cancellation.resultRef,
              resultEventSeq: transaction.value.resultEvent.seq,
              state: 'degraded',
              verifiedAt: cancellation.verifiedAt,
            },
            state: 'degraded',
          });
          if (!childCurrent()) return { kind: 'account_authority_revoked' };
          return {
            kind: 'committed',
            value: { run: transaction.value.run, event: transaction.value.event, proof },
          };
        };

      const requestChildCancellation = (): Promise<JarvisCancellationRequestResult> => {
        if (!childCurrent()) {
          return Promise.resolve({ kind: 'authority_revoked_before_intent' });
        }
        return requestCancellationWithBinding(binding, {
          accountId: scope.parentRun.accountId,
          runId: scope.parentRun.id,
        });
      };

      execution = Object.freeze({
        approval: structuredClone(claimed.approval),
        producerKind,
        ownerId: startExecution.ownerId,
        startEvent: structuredClone(claimed.startEvent),
        initialLiveProof: activeRegistration.initialProof,
        [jarvisIssuedActionExecutionBrand]: true as const,
        beginExternalEffect<T>(
          begin: (signal: AbortSignal) => Readonly<{ completion: Promise<T> }>,
        ) {
          if (!childCurrent()) return { kind: 'account_authority_revoked' as const };
          if (effectStarted) throw new Error('kernel_action_effect_already_started');
          effectStarted = true;
          return { kind: 'committed' as const, value: begin(binding.revocationSignal) };
        },
        transferTerminalOwnership(
          transfer: Parameters<JarvisIssuedActionExecution['transferTerminalOwnership']>[0],
        ) {
          if (!childCurrent()) return { kind: 'account_authority_revoked' as const };
          if (producerKind !== 'terminal' || transferred) {
            throw new Error('kernel_terminal_handoff_invalid');
          }
          const receipt = transfer.acceptor.acceptIssuedExecution({
            executionId: transfer.executionId,
            ownerId: startExecution.ownerId,
            execution: Object.freeze({
              recordResult,
              recordCancellationVerified,
              requestCancellation: requestChildCancellation,
              dispose: disposeChild,
            }),
          });
          if (
            receipt[jarvisTerminalHandoffReceiptBrand] !== true ||
            receipt.executionId !== transfer.executionId ||
            receipt.ownerId !== startExecution.ownerId
          ) {
            throw new Error('kernel_terminal_handoff_invalid');
          }
          transferred = true;
          return { kind: 'committed' as const, value: receipt };
        },
        recordResult,
        recordCancellationVerified,
        requestCancellation: requestChildCancellation,
        dispose() {
          if (transferred) return;
          disposeChild();
        },
      });
      const issuedExecution = execution;
      if (!issuedExecution) throw new Error('kernel_action_execution_missing');
      issuedActionExecutions.add(issuedExecution);
      if (!childCurrent()) {
        disposeChild();
        return { kind: 'account_authority_revoked' };
      }
      return { kind: 'committed', value: issuedExecution };
    };

    const claimExecution = async (
      claim:
        | Parameters<JarvisIssuedApprovalLifecycle['claimApprovedExecution']>[0]
        | Parameters<JarvisIssuedApprovalLifecycle['claimAutoApprovedExecution']>[0],
    ): Promise<JarvisAuthorityBoundResult<JarvisIssuedActionExecution>> => {
      const expectedEventTailSeq = await captureEventTailSeq();
      const mutation =
        'approvalId' in claim
          ? await approvalWrite((context) =>
              claimApprovedExecutionInContext(context, {
                accountId: scope.parentRun.accountId,
                runId: scope.parentRun.id,
                requestId: scope.requestId,
                attemptNumber: scope.attemptNumber,
                approvalId: claim.approvalId,
                producerKind: claim.producerKind,
                ownerId: claim.ownerId,
                evidenceRef: claim.evidenceRef,
                startedAt: claim.startedAt,
                expectedEventTailSeq,
              }),
            )
          : await approvalWrite((context) =>
              claimSafeAutoExecutionInContext(context, {
                accountId: scope.parentRun.accountId,
                approval: approvalFromPrepared(claim.approval),
                producerKind: claim.producerKind,
                ownerId: claim.ownerId,
                evidenceRef: claim.evidenceRef,
                startedAt: claim.startedAt,
                expectedEventTailSeq,
              }),
            );
      if (mutation.kind !== 'committed') return mutation;
      const finalizeResponseOnResult =
        'approvalId' in claim && (await hasActionResponseCheckpoint(scope, claim.approvalId));
      return issueActionExecution(mutation.value, finalizeResponseOnResult);
    };

    lifecycle = Object.freeze({
      accountId: scope.parentRun.accountId,
      runId: scope.parentRun.id,
      requestId: scope.requestId,
      attemptNumber: scope.attemptNumber,
      revocationSignal: controller.signal,
      [jarvisIssuedApprovalLifecycleBrand]: true as const,
      async putPreparedApproval(
        preparedInput: Parameters<JarvisIssuedApprovalLifecycle['putPreparedApproval']>[0],
      ) {
        const approval = approvalFromPrepared(preparedInput);
        const expectedEventTailSeq = await captureEventTailSeq();
        return approvalWrite(async (context) => {
          const result = await createPendingApprovalInContext(context, {
            accountId: scope.parentRun.accountId,
            approval,
            expectedEventTailSeq,
          });
          return result.approval;
        });
      },
      decidePreparedApproval(
        decision: Parameters<JarvisIssuedApprovalLifecycle['decidePreparedApproval']>[0],
      ) {
        return (async () => {
          const expectedEventTailSeq = await captureEventTailSeq();
          return approvalWrite(async (context) => {
            const result = await decideApprovalInContext(context, {
              accountId: scope.parentRun.accountId,
              runId: scope.parentRun.id,
              requestId: scope.requestId,
              attemptNumber: scope.attemptNumber,
              approvalId: decision.approvalId,
              decision: decision.decision,
              decidedAt: input.now(),
              expectedEventTailSeq,
            });
            return result.approval;
          });
        })();
      },
      claimApprovedExecution(
        claim: Parameters<JarvisIssuedApprovalLifecycle['claimApprovedExecution']>[0],
      ) {
        return claimExecution(claim);
      },
      claimAutoApprovedExecution(
        claim: Parameters<JarvisIssuedApprovalLifecycle['claimAutoApprovedExecution']>[0],
      ) {
        return claimExecution(claim);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (lifecycle) issuedApprovalLifecycles.delete(lifecycle);
        binding.revocationSignal.removeEventListener('abort', onBindingRevoked);
        if (!controller.signal.aborted) controller.abort('kernel_action_lifecycle_disposed');
      },
    });
    issuedApprovalLifecycles.add(lifecycle);
    if (!current()) {
      lifecycle.dispose();
      throw new Error('kernel_account_authority_revoked');
    }
    return lifecycle;
  };

  const invokeActionCapability = async <T>(
    scope: CanonicalActionScope,
    invoke: (
      capability: JarvisApprovalActionCapability,
      parentRun: JarvisRun,
      binding: JarvisKernelAccountBinding,
    ) => Promise<T>,
  ): Promise<JarvisAuthorityBoundResult<T>> => {
    let binding: JarvisKernelAccountBinding;
    try {
      binding = issueAccountBinding(scope.parentRun.accountId);
    } catch {
      return { kind: 'account_authority_revoked' };
    }
    let lifecycle: JarvisIssuedApprovalLifecycle | undefined;
    try {
      lifecycle = issueApprovalLifecycle(binding, scope);
      const capability = input.bindKernelActions(lifecycle);
      const value = await invoke(capability, scope.parentRun, binding);
      binding.assertCurrent();
      if (lifecycle.revocationSignal.aborted) {
        return { kind: 'account_authority_revoked' };
      }
      return { kind: 'committed', value };
    } catch (error) {
      let authorityCurrent = false;
      try {
        binding.assertCurrent();
        authorityCurrent = lifecycle !== undefined && !lifecycle.revocationSignal.aborted;
      } catch {
        authorityCurrent = false;
      }
      if (!authorityCurrent) return { kind: 'account_authority_revoked' };
      throw error;
    } finally {
      lifecycle?.dispose();
      binding.dispose();
    }
  };

  const issueLifecycle = (
    binding: JarvisKernelAccountBinding,
    scope: Readonly<{
      accountId: string;
      runId: string;
      requestId: string;
      attemptNumber: number;
    }>,
  ): JarvisBoundKernelLifecycle => {
    assertIssuedAccountBinding(binding);
    binding.assertCurrent();
    if (scope.accountId !== binding.identity.accountId) {
      throw new Error('kernel_lifecycle_scope_mismatch');
    }
    const frozenScope = Object.freeze({ ...scope });
    let providerRegistration: JarvisLiveEvidenceRegistration<'provider'> | undefined;
    let providerReceipt: JarvisProviderStartedReceipt | undefined;

    const current = (): boolean => {
      try {
        assertIssuedAccountBinding(binding);
        binding.assertCurrent();
        return true;
      } catch {
        return false;
      }
    };

    const appendInTransaction = async (
      event: Omit<JarvisEvent, 'runId' | 'seq'>,
    ): Promise<JarvisAuthorityBoundResult<JarvisEvent>> => {
      if (!current()) return { kind: 'account_authority_revoked' as const };
      const transaction = await transactionAuthority.lifecycleTransaction(
        ['jarvis_runs', 'jarvis_events'],
        binding.revocationSignal,
        async (context) => {
          if (!current()) return { kind: 'account_authority_revoked' as const };
          const runRow = await context.jarvis_runs.get(frozenScope.runId);
          if (!runRow || runRow.account_id !== frozenScope.accountId) {
            throw new Error('kernel_lifecycle_scope_mismatch');
          }
          const tail = await lastEvent(context, frozenScope.runId);
          if (!current()) return { kind: 'account_authority_revoked' as const };
          const row = toJarvisEventRow({
            ...event,
            runId: frozenScope.runId,
            seq: terminalEventSequence(tail),
          });
          await context.jarvis_events.add(row);
          return { kind: 'committed' as const, value: fromJarvisEventRow(row) };
        },
      );
      return transaction.kind === 'cancelled'
        ? { kind: 'account_authority_revoked' as const }
        : transaction.value;
    };

    const appendLiveEvidence: JarvisLiveEvidenceAppendCapability = Object.freeze({
      async append({ evidence }: { evidence: JarvisDurableLiveEvidenceV1 }) {
        const result = await appendInTransaction({
          idempotencyKey: `kernel-live:${evidence.registrationId}:${evidence.transition}:${evidence.resultRef}`,
          type: evidence.kind === 'model' ? 'model' : 'tool',
          status: evidence.transition,
          title:
            evidence.kind === 'model' ? 'Provider evidence updated' : 'Capability evidence updated',
          safeSummary: 'Verified live execution evidence was updated.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: evidence.observedAt,
          liveEvidence: evidence,
        });
        if (result.kind === 'account_authority_revoked') {
          throw new Error('kernel_account_authority_revoked');
        }
        return result.value;
      },
    });
    const liveOwner = liveEvidence.bindLifecycle({
      scope: frozenScope,
      append: appendLiveEvidence,
    });

    const lifecycle: JarvisBoundKernelLifecycle = Object.freeze({
      revocationSignal: binding.revocationSignal,
      assertCurrent() {
        assertIssuedAccountBinding(binding);
        binding.assertCurrent();
      },
      async transition(
        transition: Parameters<JarvisBoundKernelLifecycle['transition']>[0],
      ): ReturnType<JarvisBoundKernelLifecycle['transition']> {
        if (!current()) return { kind: 'account_authority_revoked' as const };
        const transaction = await transactionAuthority.lifecycleTransaction(
          ['jarvis_runs', 'jarvis_events'],
          binding.revocationSignal,
          async (context) => {
            if (!current()) return { kind: 'account_authority_revoked' as const };
            const runRow = await context.jarvis_runs.get(frozenScope.runId);
            if (!runRow || runRow.account_id !== frozenScope.accountId) {
              throw new Error('kernel_lifecycle_scope_mismatch');
            }
            const run = fromJarvisRunRow(runRow);
            if (run.status !== transition.expectedStatus) {
              throw new Error('kernel_lifecycle_status_conflict');
            }
            const tail = await lastEvent(context, frozenScope.runId);
            if (!current()) return { kind: 'account_authority_revoked' as const };
            const updated: JarvisRun = {
              ...run,
              status: transition.nextStatus,
              updatedAt: transition.event.createdAt,
              ...(transition.completedAt === undefined
                ? {}
                : { completedAt: transition.completedAt }),
            };
            const updatedRow = toJarvisRunRow(updated);
            const eventRow = toJarvisEventRow({
              ...transition.event,
              runId: frozenScope.runId,
              seq: terminalEventSequence(tail),
              type: 'run_state',
              status: transition.nextStatus,
            });
            await context.jarvis_runs.put(updatedRow);
            await context.jarvis_events.add(eventRow);
            return {
              kind: 'committed' as const,
              value: {
                run: fromJarvisRunRow(updatedRow),
                event: fromJarvisEventRow(eventRow),
              },
            };
          },
        );
        return transaction.kind === 'cancelled'
          ? { kind: 'account_authority_revoked' as const }
          : transaction.value;
      },
      async recordProviderStarted(
        receipt: Parameters<JarvisBoundKernelLifecycle['recordProviderStarted']>[0],
      ): ReturnType<JarvisBoundKernelLifecycle['recordProviderStarted']> {
        if (!current()) return { kind: 'account_authority_revoked' as const };
        const resultRef = `jprovider_start_${frozenScope.requestId}`;
        const source = {
          schemaVersion: 1 as const,
          accountId: frozenScope.accountId,
          runId: frozenScope.runId,
          requestId: frozenScope.requestId,
          attemptNumber: frozenScope.attemptNumber,
          producerKind: 'provider' as const,
          producerIdentity: {
            producerKind: 'provider' as const,
            providerId: receipt.providerId,
            modelId: receipt.modelId,
            modelSnapshotRef: receipt.modelSnapshotRef,
          },
          resultRef,
          observedAt: receipt.startedAt,
          phase: 'start' as const,
          state: 'started' as const,
        };
        const sourceEvent = await appendInTransaction({
          idempotencyKey: `kernel-provider-start:${frozenScope.requestId}:${frozenScope.attemptNumber}`,
          type: 'model',
          status: 'started',
          title: 'Provider started',
          safeSummary: 'The protected provider dispatch started.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: receipt.startedAt,
          producerSourceEvidence: source,
        });
        if (sourceEvent.kind === 'account_authority_revoked') return sourceEvent;
        const evidence: JarvisCanonicalLiveProducerEvidence<'provider'> = Object.freeze({
          schemaVersion: 1,
          producerKind: 'provider',
          producerIdentity: source.producerIdentity,
          accountId: frozenScope.accountId,
          runId: frozenScope.runId,
          requestId: frozenScope.requestId,
          attemptNumber: frozenScope.attemptNumber,
          resultRef,
          resultEventSeq: sourceEvent.value.seq,
          state: 'started',
          verifiedAt: receipt.startedAt,
        });
        try {
          providerReceipt = receipt;
          providerRegistration = await liveOwner.provider.startProvider({
            evidence,
            registrationId: `${frozenScope.runId}:provider`,
            operations: receipt.operations,
          });
          const registration = providerRegistration;
          return {
            kind: 'committed' as const,
            value: Object.freeze({
              initialProof: registration.initialProof,
              dispose: () => registration.dispose(),
            }),
          };
        } catch (error) {
          if (!current()) return { kind: 'account_authority_revoked' as const };
          throw error;
        }
      },
      async recordProviderResult(
        observation: Parameters<JarvisBoundKernelLifecycle['recordProviderResult']>[0],
      ): ReturnType<JarvisBoundKernelLifecycle['recordProviderResult']> {
        if (!current()) return { kind: 'account_authority_revoked' as const };
        if (!providerRegistration || !providerReceipt) {
          throw new Error('kernel_provider_registration_missing');
        }
        const rows = await repositories.event.listByRun(frozenScope.accountId, frozenScope.runId, {
          limit: 500,
        });
        if (!current()) return { kind: 'account_authority_revoked' as const };
        const resultEvent = [...rows].reverse().find((event) => {
          const source = event.producerSourceEvidence;
          return (
            source?.producerKind === 'provider' &&
            source.phase === 'result' &&
            source.requestId === frozenScope.requestId &&
            source.attemptNumber === frozenScope.attemptNumber &&
            source.resultRef === observation.resultRef &&
            source.state === observation.state
          );
        });
        if (!resultEvent) throw new Error('kernel_provider_result_source_missing');
        const evidence: JarvisCanonicalLiveProducerEvidence<'provider'> = Object.freeze({
          schemaVersion: 1,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider' as const,
            providerId: providerReceipt.providerId,
            modelId: providerReceipt.modelId,
            modelSnapshotRef: providerReceipt.modelSnapshotRef,
          },
          accountId: frozenScope.accountId,
          runId: frozenScope.runId,
          requestId: frozenScope.requestId,
          attemptNumber: frozenScope.attemptNumber,
          resultRef: observation.resultRef,
          resultEventSeq: resultEvent.seq,
          state: observation.state,
          verifiedAt: observation.observedAt,
        });
        try {
          const proof = await providerRegistration.complete({
            evidence,
            state: observation.state,
          });
          if (!current()) return { kind: 'account_authority_revoked' as const };
          return { kind: 'committed' as const, value: proof as JarvisLiveEvidenceProof };
        } catch (error) {
          if (!current()) return { kind: 'account_authority_revoked' as const };
          throw error;
        }
      },
      registerAbortOwner(
        registration: Parameters<JarvisBoundKernelLifecycle['registerAbortOwner']>[0],
      ): ReturnType<JarvisBoundKernelLifecycle['registerAbortOwner']> {
        assertIssuedAccountBinding(binding);
        binding.assertCurrent();
        return input.abortRegistrationAuthority.registerIssuedOwner({
          accountId: frozenScope.accountId,
          runId: frozenScope.runId,
          registrationId: registration.registrationId,
          kind: registration.kind,
          abort: registration.abort,
        });
      },
    });
    return lifecycle;
  };

  const voiceHandleState = (receiver: JarvisVoiceTurnHandle): VoiceHandleState => {
    const state = voiceHandleStates.get(receiver);
    if (!state) throw new Error('voice_handle_invalid');
    if (state.phase === 'disposed' || !issuedVoiceHandles.has(receiver)) {
      throw new Error('voice_handle_phase_conflict');
    }
    try {
      state.binding.assertCurrent();
    } catch {
      throw new Error('kernel_account_authority_revoked');
    }
    return state;
  };

  const finishVoiceHandleDisposal = (
    handle: JarvisVoiceTurnHandle,
    state: VoiceHandleState,
  ): void => {
    if (state.phase === 'disposed') return;
    if (state.activeOperations.size > 0) {
      state.disposeRequested = true;
      return;
    }
    state.phase = 'disposed';
    issuedVoiceHandles.delete(handle);
    state.deferred?.dispose();
    state.releaseExternal?.();
    state.releaseExternal = undefined;
    state.releaseBinding?.();
    state.releaseBinding = undefined;
  };

  const voiceResponseReadbackMatches = async (
    state: VoiceHandleState,
    committed = state.responseCommit,
  ): Promise<boolean> => {
    if (committed?.kind !== 'committed' || !committed.value.committed || !state.deferred) {
      return false;
    }
    const expected = committed.value;
    const [runRow, message, artifactRows, eventRows] = await Promise.all([
      input.db.jarvis_runs.get(state.turnInput.run.id),
      input.db.messages.get(expected.message.id),
      input.db.jarvis_artifacts.bulkGet(expected.artifacts.map((artifact) => artifact.id)),
      input.db.jarvis_events
        .where('[run_id+seq]')
        .between(
          [state.turnInput.run.id, Dexie.minKey],
          [state.turnInput.run.id, Dexie.maxKey],
          true,
          true,
        )
        .toArray(),
    ]);
    if (!runRow || !message || artifactRows.some((row) => row === undefined)) return false;
    const run = fromJarvisRunRow(runRow);
    const responseEvents = eventRows.filter(
      (row) =>
        row.idempotency_key ===
        `voice-response-ready:${state.turnInput.run.id}:${expected.message.id}`,
    );
    if (
      run.accountId !== state.turnInput.accountId ||
      run.source !== 'voice' ||
      run.status !== 'running' ||
      responseEvents.length !== 1
    ) {
      return false;
    }
    try {
      return (
        canonicalizeJarvisApprovalJson(message) ===
          canonicalizeJarvisApprovalJson(expected.message) &&
        canonicalizeJarvisApprovalJson(artifactRows.map((row) => fromJarvisArtifactRow(row!))) ===
          canonicalizeJarvisApprovalJson(expected.artifacts) &&
        canonicalizeJarvisApprovalJson(fromJarvisEventRow(responseEvents[0]!)) ===
          canonicalizeJarvisApprovalJson(expected.event)
      );
    } catch {
      return false;
    }
  };

  const voiceResponseRetryEvidenceMatches = async (state: VoiceHandleState): Promise<boolean> => {
    const deferred = state.deferred;
    if (!deferred) return false;
    const [runRow, eventRows] = await Promise.all([
      input.db.jarvis_runs.get(state.turnInput.run.id),
      input.db.jarvis_events
        .where('[run_id+seq]')
        .between(
          [state.turnInput.run.id, Dexie.minKey],
          [state.turnInput.run.id, Dexie.maxKey],
          true,
          true,
        )
        .toArray(),
    ]);
    if (!runRow) return false;
    const run = fromJarvisRunRow(runRow);
    if (
      run.accountId !== state.turnInput.accountId ||
      run.source !== 'voice' ||
      run.status !== 'running' ||
      eventRows.some((row) => row.type === 'message' && row.status === 'response_ready')
    ) {
      return false;
    }
    const expected = deferred.providerResultSource;
    const matchingStarts = eventRows.filter((row) => {
      const source = row.producer_source_evidence;
      return (
        source?.producerKind === 'provider' &&
        source.phase === 'start' &&
        source.accountId === expected.accountId &&
        source.runId === expected.runId &&
        source.requestId === expected.requestId &&
        source.attemptNumber === expected.attemptNumber &&
        canonicalizeJarvisApprovalJson(source.producerIdentity) ===
          canonicalizeJarvisApprovalJson(expected.producerIdentity)
      );
    });
    return matchingStarts.length === 1;
  };

  const loadVoiceRecoverySnapshot = async (
    accountId: string,
    runId: string,
  ): Promise<VoiceRecoverySnapshot | null> => {
    const run = await repositories.run.getById(accountId, runId);
    if (!run || run.accountId !== accountId || run.source !== 'voice' || run.status !== 'running') {
      return null;
    }
    const events = await repositories.event.listByRun(accountId, runId, { limit: 500 });
    const responseEvents = events.filter(
      (event) => event.type === 'message' && event.status === 'response_ready',
    );
    if (responseEvents.length !== 1) return null;
    const event = responseEvents[0]!;
    const source = event.producerSourceEvidence;
    const prefix = `voice-response-ready:${runId}:`;
    if (
      !event.idempotencyKey.startsWith(prefix) ||
      !source ||
      source.producerKind !== 'provider' ||
      source.phase !== 'result' ||
      source.accountId !== accountId ||
      source.runId !== runId ||
      source.requestId.length === 0 ||
      source.attemptNumber < 1 ||
      (source.state !== 'completed' && source.state !== 'degraded')
    ) {
      return null;
    }
    const providerStarts = events.filter((candidate) => {
      const candidateSource = candidate.producerSourceEvidence;
      return (
        candidate.seq < event.seq &&
        candidate.type === 'model' &&
        candidate.status === 'started' &&
        candidateSource?.producerKind === 'provider' &&
        candidateSource.phase === 'start'
      );
    });
    const latestProviderStart = providerStarts.at(-1)?.producerSourceEvidence;
    if (
      !latestProviderStart ||
      latestProviderStart.producerKind !== 'provider' ||
      latestProviderStart.accountId !== accountId ||
      latestProviderStart.runId !== runId ||
      latestProviderStart.requestId !== source.requestId ||
      latestProviderStart.attemptNumber !== source.attemptNumber ||
      canonicalizeJarvisApprovalJson(latestProviderStart.producerIdentity) !==
        canonicalizeJarvisApprovalJson(source.producerIdentity)
    ) {
      return null;
    }
    const messageId = event.idempotencyKey.slice(prefix.length);
    if (!messageId || messageId.trim() !== messageId || run.chatId === undefined) return null;
    const [message, artifactRows] = await Promise.all([
      input.db.messages.get(messageId as Message['id']),
      input.db.jarvis_artifacts.bulkGet(event.artifactIds),
    ]);
    if (
      !message ||
      message.role !== 'assistant' ||
      message.chat_id !== run.chatId ||
      artifactRows.some((row) => row === undefined)
    ) {
      return null;
    }
    const artifacts = artifactRows.map((row) => fromJarvisArtifactRow(row!));
    if (
      artifacts.some(
        (artifact) =>
          artifact.runId !== runId ||
          artifact.requestId !== source.requestId ||
          artifact.attemptNumber !== source.attemptNumber,
      )
    ) {
      return null;
    }
    return Object.freeze({
      accountId,
      runId,
      requestId: source.requestId,
      attemptNumber: source.attemptNumber,
      event: Object.freeze(structuredClone(event)),
      message: Object.freeze(structuredClone(message)),
      artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze(artifact))),
    });
  };

  const sameVoiceRecoverySnapshot = (
    left: VoiceRecoverySnapshot,
    right: VoiceRecoverySnapshot | null,
  ): boolean => {
    if (!right) return false;
    try {
      return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
    } catch {
      return false;
    }
  };

  const finishVoiceRecoveryDisposal = (
    handle: JarvisVoiceRecoveryHandle,
    state: VoiceRecoveryHandleState,
  ): void => {
    if (state.disposed) return;
    state.disposed = true;
    issuedVoiceRecoveryHandles.delete(handle);
    state.releaseBinding?.();
    state.releaseBinding = undefined;
  };

  const issueVoiceRecoveryHandle = (
    binding: JarvisKernelAccountBinding,
    snapshot: VoiceRecoverySnapshot,
  ): JarvisVoiceRecoveryHandle => {
    const releaseBinding = retainAccountBinding(binding);
    let handle: JarvisVoiceRecoveryHandle;
    handle = Object.freeze({
      async commitRecoveredPartial(
        this: JarvisVoiceRecoveryHandle,
      ): Promise<JarvisAuthorityBoundResult<JarvisVoicePlaybackCommitResult>> {
        const state = voiceRecoveryHandleStates.get(this);
        if (!state || !issuedVoiceRecoveryHandles.has(this)) {
          throw new Error('voice_recovery_handle_invalid');
        }
        if (state.disposed || state.activeOperation) {
          throw new Error('voice_recovery_handle_phase_conflict');
        }
        const operation = (async (): Promise<
          JarvisAuthorityBoundResult<JarvisVoicePlaybackCommitResult>
        > => {
          state.binding.assertCurrent();
          const fresh = await loadVoiceRecoverySnapshot(
            state.snapshot.accountId,
            state.snapshot.runId,
          );
          state.binding.assertCurrent();
          if (!sameVoiceRecoverySnapshot(state.snapshot, fresh)) {
            throw new Error('voice_recovery_evidence_invalid');
          }
          const commit = await artifacts.commitKernelTurn.commitVoicePlayback({
            accountId: state.snapshot.accountId,
            runId: state.snapshot.runId,
            requestId: state.snapshot.requestId,
            attemptNumber: state.snapshot.attemptNumber,
            accountBinding: state.binding,
            terminalStatus: 'partial',
            terminalKind: 'recovery',
            createdAt: input.now(),
          });
          if (!commit.committed && commit.reason === 'account_authority_revoked') {
            return { kind: 'account_authority_revoked' };
          }
          return { kind: 'committed', value: commit };
        })();
        state.activeOperation = operation;
        try {
          return await operation;
        } catch (error) {
          if (state.binding.revocationSignal.aborted) {
            return { kind: 'account_authority_revoked' };
          }
          throw error;
        } finally {
          state.activeOperation = undefined;
          finishVoiceRecoveryDisposal(this, state);
        }
      },
      dispose(this: JarvisVoiceRecoveryHandle) {
        const state = voiceRecoveryHandleStates.get(this);
        if (!state) throw new Error('voice_recovery_handle_invalid');
        if (state.disposed) return;
        if (!issuedVoiceRecoveryHandles.has(this)) {
          throw new Error('voice_recovery_handle_invalid');
        }
        if (state.activeOperation) return;
        finishVoiceRecoveryDisposal(this, state);
      },
    });
    issuedVoiceRecoveryHandles.add(handle);
    voiceRecoveryHandleStates.set(handle, {
      binding,
      snapshot,
      releaseBinding,
      disposed: false,
      activeOperation: undefined,
    });
    return handle;
  };

  const appendVoiceRuntimeEvent = async (
    state: VoiceHandleState,
    event: Omit<JarvisEvent, 'runId' | 'seq'>,
  ): Promise<JarvisEvent> => {
    state.binding.assertCurrent();
    const transaction = await transactionAuthority.lifecycleTransaction(
      ['jarvis_runs', 'jarvis_events'],
      state.binding.revocationSignal,
      async (context) => {
        state.binding.assertCurrent();
        const runRow = await context.jarvis_runs.get(state.turnInput.run.id);
        if (!runRow || runRow.account_id !== state.turnInput.accountId) {
          throw new Error('voice_playback_run_scope_mismatch');
        }
        const run = fromJarvisRunRow(runRow);
        if (run.status !== 'running' || run.source !== 'voice') {
          throw new Error('voice_handle_phase_conflict');
        }
        const tail = await lastEvent(context, state.turnInput.run.id);
        state.binding.assertCurrent();
        const candidate = {
          ...event,
          runId: state.turnInput.run.id,
          seq: terminalEventSequence(tail),
        };
        const row = toJarvisEventRow(candidate);
        await context.jarvis_events.add(row);
        return fromJarvisEventRow(row);
      },
    );
    if (transaction.kind === 'cancelled') {
      throw new Error('kernel_account_authority_revoked');
    }
    return transaction.value;
  };

  const executeConfiguredVoicePlayback = async (
    state: VoiceHandleState,
    spokenText: string,
  ): Promise<JarvisVoicePlaybackAdapterResult | null> => {
    const adapter = input.voicePlaybackAdapter;
    const startAuthority = input.voiceLiveEvidenceStartAuthority;
    if (!adapter || !startAuthority) return null;
    let controller: JarvisVoicePlaybackController | null;
    try {
      controller = adapter.prepare({
        accountId: state.turnInput.accountId,
        runId: state.turnInput.run.id,
        requestId: state.turnInput.attempt.requestId,
        attemptNumber: state.turnInput.attempt.attemptNumber,
        spokenText,
      });
    } catch {
      return null;
    }
    if (!controller) return null;
    const receipt = controller.receipt;
    const stable = (value: string): boolean =>
      value.length > 0 && value.trim() === value && !value.includes('\u0000');
    if (
      !Object.isFrozen(controller) ||
      !Object.isFrozen(receipt) ||
      !stable(receipt.sessionId) ||
      !stable(receipt.engineId) ||
      !stable(receipt.ttsExecutionId) ||
      !stable(receipt.playbackExecutionId) ||
      !Number.isFinite(receipt.ttsStartedAt) ||
      !Number.isFinite(receipt.playbackStartedAt) ||
      receipt.playbackStartedAt < receipt.ttsStartedAt
    ) {
      controller.dispose();
      return null;
    }

    let sharedAbortAccepted = false;
    const ownerOutcome = (ownerId: string) => {
      const kind = sharedAbortAccepted ? ('signal_delivered' as const) : controller!.abort();
      if (kind === 'signal_delivered') sharedAbortAccepted = true;
      return kind === 'signal_delivered'
        ? ({ kind, ownerId } as const)
        : kind === 'handoff_pending'
          ? ({ kind, ownerId } as const)
          : kind === 'unsupported'
            ? ({ kind, ownerId } as const)
            : kind === 'delivery_rejected'
              ? ({ kind, ownerId } as const)
              : ({ kind: 'already_exited' as const, ownerId } as const);
    };
    const ttsOwnerId = `${state.turnInput.run.id}:tts`;
    const playbackOwnerId = `${state.turnInput.run.id}:playback`;
    const unregisterTts = input.abortRegistrationAuthority.registerIssuedOwner({
      accountId: state.turnInput.accountId,
      runId: state.turnInput.run.id,
      registrationId: ttsOwnerId,
      kind: 'tts_generation',
      abort: () => ownerOutcome(ttsOwnerId),
    });
    const unregisterPlayback = input.abortRegistrationAuthority.registerIssuedOwner({
      accountId: state.turnInput.accountId,
      runId: state.turnInput.run.id,
      registrationId: playbackOwnerId,
      kind: 'audio_playback',
      abort: () => ownerOutcome(playbackOwnerId),
    });
    const registrations: JarvisLiveEvidenceRegistration<'voice'>[] = [];
    const activeReceiptReleases: Array<() => void> = [];
    try {
      const scope = {
        accountId: state.turnInput.accountId,
        runId: state.turnInput.run.id,
        requestId: state.turnInput.attempt.requestId,
        attemptNumber: state.turnInput.attempt.attemptNumber,
      };
      const liveOwner = liveEvidence.bindLifecycle({
        scope,
        append: Object.freeze({
          async append({ evidence }: { evidence: JarvisDurableLiveEvidenceV1 }) {
            return appendVoiceRuntimeEvent(state, {
              idempotencyKey: `kernel-live:${evidence.registrationId}:${evidence.transition}:${evidence.resultRef}`,
              type: 'tool',
              status: evidence.transition,
              title: 'Voice evidence updated',
              safeSummary: 'Verified voice execution evidence was updated.',
              sourceRefs: [],
              artifactIds: [],
              createdAt: evidence.observedAt,
              liveEvidence: evidence,
            });
          },
        }),
      });

      const startEngine = async (engineKind: 'tts' | 'playback') => {
        const executionId =
          engineKind === 'tts' ? receipt.ttsExecutionId : receipt.playbackExecutionId;
        const observedAt = engineKind === 'tts' ? receipt.ttsStartedAt : receipt.playbackStartedAt;
        const resultRef = `voice-${engineKind}-start:${executionId}`;
        const producerIdentity = {
          producerKind: 'voice' as const,
          sessionId: receipt.sessionId,
          engineKind,
          executionId,
        };
        const source: Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }> = {
          schemaVersion: 1,
          ...scope,
          producerKind: 'voice',
          producerIdentity,
          resultRef,
          observedAt,
          phase: 'start',
          state: 'started',
        };
        const releaseActiveReceipt = startAuthority.authorizeStart(source);
        activeReceiptReleases.push(releaseActiveReceipt);
        const event = await appendVoiceRuntimeEvent(state, {
          idempotencyKey: `voice-${engineKind}-start:${state.turnInput.run.id}:${executionId}`,
          type: engineKind === 'tts' ? 'model' : 'terminal',
          status: 'running',
          title: engineKind === 'tts' ? 'Voice synthesis started' : 'Voice playback started',
          safeSummary: 'A voice response phase started.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: observedAt,
          producerSourceEvidence: source,
        });
        const evidence: JarvisCanonicalLiveProducerEvidence<'voice'> = Object.freeze({
          schemaVersion: 1,
          producerKind: 'voice',
          producerIdentity,
          ...scope,
          resultRef,
          resultEventSeq: event.seq,
          state: 'busy',
          verifiedAt: observedAt,
        });
        const registration = await liveOwner.voice.startCapability({
          evidence,
          registrationId: `${state.turnInput.run.id}:${engineKind}`,
          category: 'tool',
          capabilityId: `voice.${engineKind}`,
          operations: ['execute', 'cancel', 'inspect'],
          state: 'busy',
        });
        registrations.push(registration);
        return { registration, producerIdentity };
      };

      const tts = await startEngine('tts');
      const playback = await startEngine('playback');
      const result = await controller.start();
      const validEngineResult = (engineResult: JarvisVoicePlaybackEngineResult): boolean =>
        engineResult.state === 'completed'
          ? !('reason' in engineResult)
          : engineResult.reason === 'unavailable' ||
            engineResult.reason === 'failed' ||
            engineResult.reason === 'stopped';
      if (
        !Object.isFrozen(result) ||
        !Object.isFrozen(result.tts) ||
        !Object.isFrozen(result.playback) ||
        !controller.verify(result) ||
        !stable(result.tts.resultRef) ||
        !stable(result.playback.resultRef) ||
        !Number.isFinite(result.tts.observedAt) ||
        !Number.isFinite(result.playback.observedAt) ||
        !validEngineResult(result.tts) ||
        !validEngineResult(result.playback) ||
        result.tts.observedAt < receipt.ttsStartedAt ||
        result.playback.observedAt < receipt.playbackStartedAt ||
        (result.terminalStatus === 'completed' &&
          (result.tts.state !== 'completed' || result.playback.state !== 'completed')) ||
        (result.terminalStatus === 'partial' &&
          result.tts.state === 'completed' &&
          result.playback.state === 'completed')
      ) {
        throw new Error('voice_playback_result_invalid');
      }

      const finishEngine = async (
        engineKind: 'tts' | 'playback',
        engine: typeof tts,
        engineResult: JarvisVoicePlaybackAdapterResult['tts'],
      ): Promise<Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }>> => {
        const source: Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }> = {
          schemaVersion: 1,
          ...scope,
          producerKind: 'voice',
          producerIdentity: engine.producerIdentity,
          resultRef: engineResult.resultRef,
          observedAt: engineResult.observedAt,
          phase: 'result',
          state: engineResult.state,
        };
        const event = await appendVoiceRuntimeEvent(state, {
          idempotencyKey: `voice-${engineKind}-result:${state.turnInput.run.id}:${engineResult.resultRef}`,
          type: engineKind === 'tts' ? 'model' : 'terminal',
          status: engineResult.state,
          title:
            engineKind === 'tts'
              ? engineResult.state === 'completed'
                ? 'Voice synthesis completed'
                : 'Voice synthesis degraded'
              : engineResult.state === 'completed'
                ? 'Voice playback completed'
                : 'Voice playback degraded',
          safeSummary: 'A voice response phase reached a verified outcome.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: engineResult.observedAt,
          producerSourceEvidence: source,
        });
        const evidence: JarvisCanonicalLiveProducerEvidence<'voice'> = Object.freeze({
          schemaVersion: 1,
          producerKind: 'voice',
          producerIdentity: engine.producerIdentity,
          ...scope,
          resultRef: engineResult.resultRef,
          resultEventSeq: event.seq,
          state: engineResult.state,
          verifiedAt: engineResult.observedAt,
        });
        await engine.registration.complete({ evidence, state: engineResult.state });
        return Object.freeze(structuredClone(source));
      };
      await finishEngine('tts', tts, result.tts);
      state.playbackResultSource = await finishEngine('playback', playback, result.playback);
      return result;
    } finally {
      for (const registration of registrations) registration.dispose();
      for (const release of activeReceiptReleases) release();
      unregisterPlayback();
      unregisterTts();
      controller.dispose();
    }
  };

  const voicePlaybackCancellationVerified = async (
    state: VoiceHandleState,
    playback: JarvisVoicePlaybackAdapterResult | null,
  ): Promise<boolean> => {
    const cancellation = state.cancellationResult;
    if (
      cancellation?.kind !== 'intent_committed' ||
      cancellation.aggregate.kind !== 'signal_delivered' ||
      !playback ||
      playback.terminalStatus !== 'partial'
    ) {
      return false;
    }
    let seal: Awaited<ReturnType<JarvisCancellationDeliveryAuthority['sealWorkflowQuiescence']>>;
    try {
      seal = await input.cancellationDeliveryAuthority.sealWorkflowQuiescence(
        state.turnInput.accountId,
        state.turnInput.run.id,
        cancellation.cancellationRequestId,
      );
    } catch {
      return false;
    }
    const requiredOwnerIds = [
      `${state.turnInput.run.id}:tts`,
      `${state.turnInput.run.id}:playback`,
    ];
    if (
      seal.kind !== 'sealed' ||
      seal.ownerIds.length !== requiredOwnerIds.length ||
      requiredOwnerIds.some((ownerId) => !seal.ownerIds.includes(ownerId))
    ) {
      return false;
    }
    const outcomes = [playback.tts, playback.playback];
    return (
      outcomes.some((outcome) => outcome.state === 'degraded' && outcome.reason === 'stopped') &&
      outcomes.every((outcome) => outcome.state === 'completed' || outcome.reason === 'stopped')
    );
  };

  const issueVoiceHandle = (
    binding: JarvisKernelAccountBinding,
    turnInput: Readonly<JarvisKernelTurnInput> & { surface: 'voice' },
  ): JarvisVoiceTurnHandle => {
    const releaseBinding = retainAccountBinding(binding);
    let handle: JarvisVoiceTurnHandle;
    handle = Object.freeze({
      [jarvisVoiceTurnHandleBrand]: true as const,
      async requestCancellation(
        this: JarvisVoiceTurnHandle,
      ): Promise<JarvisCancellationRequestResult> {
        const state = voiceHandleState(this);
        if (state.cancellationResult) return state.cancellationResult;
        if (state.cancellationOperation) return state.cancellationOperation;
        state.cancellationRequested = true;
        const operation = requestCancellationWithBinding(state.binding, {
          accountId: state.turnInput.accountId,
          runId: state.turnInput.run.id,
        }).then((result) => {
          state.cancellationResult = Object.freeze(result);
          return state.cancellationResult;
        });
        state.cancellationOperation = operation;
        state.activeOperations.add(operation);
        try {
          return await operation;
        } finally {
          if (state.cancellationOperation === operation) state.cancellationOperation = undefined;
          state.activeOperations.delete(operation);
          if (state.disposeRequested && state.activeOperations.size === 0) {
            finishVoiceHandleDisposal(this, state);
          }
        }
      },
      async commitResponseReady(
        this: JarvisVoiceTurnHandle,
      ): Promise<JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult>> {
        const state = voiceHandleState(this);
        if (state.phase === 'response_ready_committed' && state.responseCommit) {
          return state.responseCommit;
        }
        if (state.responseCommitOperation) return state.responseCommitOperation;
        if (state.phase !== 'response_pending' || !state.deferred) {
          throw new Error('voice_handle_phase_conflict');
        }
        state.phase = 'response_commit_in_flight';
        const operation = (async (): Promise<
          JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult>
        > => {
          const commitDeferred = async (
            deferred: JarvisDeferredVoiceKernelTurnResult,
          ): Promise<JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult>> => {
            const commit = await artifacts.commitKernelTurn.commitVoiceResponseReady({
              accountId: state.turnInput.accountId,
              runId: state.turnInput.run.id,
              requestId: state.turnInput.attempt.requestId,
              attemptNumber: state.turnInput.attempt.attemptNumber,
              accountBinding: state.binding,
              assistantMessage: structuredClone(deferred.assistantMessage),
              artifacts: deferred.artifacts,
              providerResultSource: deferred.providerResultSource,
              createdAt: deferred.response.completedAt,
            });
            return !commit.committed && commit.reason === 'account_authority_revoked'
              ? { kind: 'account_authority_revoked' }
              : { kind: 'committed', value: commit };
          };
          let commitOutcome: JarvisAuthorityBoundResult<VoiceResponseReadyCommitResult>;
          try {
            commitOutcome = await commitDeferred(state.deferred!);
          } catch (error) {
            state.binding.assertCurrent();
            if (!(await voiceResponseRetryEvidenceMatches(state))) throw error;
            state.deferred = await state.deferred!.rematerializeForRetry();
            state.binding.assertCurrent();
            commitOutcome = await commitDeferred(state.deferred);
          }
          if (commitOutcome.kind === 'account_authority_revoked') return commitOutcome;
          const commit = commitOutcome.value;
          if (!commit.committed) {
            return { kind: 'committed', value: commit };
          }
          const providerEvidence = await state.deferred!.completeProviderEvidence();
          if (providerEvidence.kind === 'account_authority_revoked') return providerEvidence;
          const result = Object.freeze({ kind: 'committed' as const, value: commit });
          if (!(await voiceResponseReadbackMatches(state, result))) {
            throw new Error('voice_response_ready_readback_mismatch');
          }
          return result;
        })();
        state.responseCommitOperation = operation;
        state.activeOperations.add(operation);
        try {
          const result = await operation;
          if (result.kind === 'committed' && result.value.committed) {
            state.phase = 'response_ready_committed';
            state.responseCommit = Object.freeze(result);
            return state.responseCommit;
          }
          state.disposeRequested = true;
          finishVoiceHandleDisposal(this, state);
          return result;
        } catch (error) {
          const authorityWasRevoked = state.binding.revocationSignal.aborted;
          state.disposeRequested = true;
          finishVoiceHandleDisposal(this, state);
          if (authorityWasRevoked) {
            return { kind: 'account_authority_revoked' };
          }
          throw error;
        } finally {
          if (state.responseCommitOperation === operation) {
            state.responseCommitOperation = undefined;
          }
          state.activeOperations.delete(operation);
          if (state.disposeRequested && state.activeOperations.size === 0) {
            finishVoiceHandleDisposal(this, state);
          }
        }
      },
      async runValidatedPlayback(
        this: JarvisVoiceTurnHandle,
      ): Promise<JarvisAuthorityBoundResult<JarvisVoicePlaybackCommitResult>> {
        const state = voiceHandleState(this);
        if (state.phase !== 'response_ready_committed') {
          throw new Error('voice_handle_phase_conflict');
        }
        state.phase = 'playback_in_flight';
        const operation = (async (): Promise<
          JarvisAuthorityBoundResult<JarvisVoicePlaybackCommitResult>
        > => {
          if (!(await voiceResponseReadbackMatches(state))) {
            throw new Error('voice_handle_phase_conflict');
          }
          if (state.cancellationRequested) {
            if (state.cancellationOperation) await state.cancellationOperation;
            throw new Error('voice_cancellation_unverified');
          }
          state.binding.assertCurrent();
          const spokenText = state.deferred?.response.spokenText;
          const playback =
            typeof spokenText === 'string' && spokenText.trim().length > 0
              ? await executeConfiguredVoicePlayback(state, spokenText)
              : null;
          if (state.cancellationOperation) await state.cancellationOperation;
          const cancellationVerified = await voicePlaybackCancellationVerified(state, playback);
          if (
            state.cancellationRequested &&
            !cancellationVerified &&
            playback?.terminalStatus !== 'completed'
          ) {
            throw new Error('voice_cancellation_unverified');
          }
          const terminalStatus = cancellationVerified
            ? ('cancelled' as const)
            : (playback?.terminalStatus ?? 'partial');
          state.binding.assertCurrent();
          const commit = await artifacts.commitKernelTurn.commitVoicePlayback({
            accountId: state.turnInput.accountId,
            runId: state.turnInput.run.id,
            requestId: state.turnInput.attempt.requestId,
            attemptNumber: state.turnInput.attempt.attemptNumber,
            accountBinding: state.binding,
            terminalStatus,
            ...(state.playbackResultSource === undefined
              ? {}
              : { playbackResultSource: state.playbackResultSource }),
            createdAt: input.now(),
          });
          if (!commit.committed && commit.reason === 'account_authority_revoked') {
            return { kind: 'account_authority_revoked' };
          }
          return { kind: 'committed', value: commit };
        })();
        state.activeOperations.add(operation);
        try {
          return await operation;
        } catch (error) {
          if (state.binding.revocationSignal.aborted) {
            return { kind: 'account_authority_revoked' };
          }
          throw error;
        } finally {
          state.disposeRequested = true;
          state.activeOperations.delete(operation);
          if (state.activeOperations.size === 0) finishVoiceHandleDisposal(this, state);
        }
      },
      dispose(this: JarvisVoiceTurnHandle) {
        const state = voiceHandleStates.get(this);
        if (!state) throw new Error('voice_handle_invalid');
        if (state.phase === 'disposed') return;
        if (!issuedVoiceHandles.has(this)) throw new Error('voice_handle_invalid');
        if (state.activeOperations.size > 0) {
          state.disposeRequested = true;
          return;
        }
        finishVoiceHandleDisposal(this, state);
      },
    });
    issuedVoiceHandles.add(handle);
    const state: VoiceHandleState = {
      binding,
      turnInput,
      releaseBinding,
      releaseExternal: undefined,
      deferred: undefined,
      phase: 'starting',
      disposeRequested: false,
      responseCommit: undefined,
      responseCommitOperation: undefined,
      activeOperations: new Set(),
      cancellationRequested: false,
      cancellationOperation: undefined,
      cancellationResult: undefined,
      playbackResultSource: undefined,
    };
    voiceHandleStates.set(handle, state);
    try {
      state.releaseExternal = input.onVoiceTurnHandleIssued?.({
        runId: turnInput.run.id,
        handle,
      });
    } catch (error) {
      finishVoiceHandleDisposal(handle, state);
      throw error;
    }
    return handle;
  };

  const actions: JarvisKernelActionPort = Object.freeze({
    async create(actionInput: Parameters<JarvisKernelActionPort['create']>[0]) {
      const scope = await loadCanonicalActionScope(actionInput.parentRun, actionInput.attempt);
      return invokeActionCapability(scope, (capability, parentRun) =>
        capability.create({ ...actionInput, parentRun }),
      );
    },
    async decide(actionInput: Parameters<JarvisKernelActionPort['decide']>[0]) {
      const scope = await loadCanonicalActionScope(
        actionInput.parentRun,
        undefined,
        actionInput.approvalId,
      );
      return invokeActionCapability(scope, async (capability, parentRun, binding) => {
        const responseBacked = await hasActionResponseCheckpoint(scope, actionInput.approvalId);
        const value = await capability.decide({ ...actionInput, parentRun });
        if (responseBacked && actionInput.decision === 'deny' && value.status === 'denied') {
          const current = await repositories.run.getById(parentRun.accountId, parentRun.id);
          if (!current) throw new Error('kernel_action_scope_mismatch');
          const finalized = await artifacts.commitKernelTurn.finalizeActionResponse({
            accountId: parentRun.accountId,
            runId: parentRun.id,
            requestId: scope.requestId,
            attemptNumber: scope.attemptNumber,
            approvalId: actionInput.approvalId,
            messageId: `msg_${scope.requestId}`,
            accountBinding: binding,
            outcome: 'denied',
            resultRef: `japproval_denied:${actionInput.approvalId}`,
            completedAt: Math.max(input.now(), current.updatedAt),
          });
          if (!finalized.committed) {
            if (finalized.reason === 'account_authority_revoked') {
              throw new Error('kernel_account_authority_revoked');
            }
            throw new Error(`kernel_action_response_finalize_${finalized.reason}`);
          }
        }
        return value;
      });
    },
    async execute(actionInput: Parameters<JarvisKernelActionPort['execute']>[0]) {
      const scope = await loadCanonicalActionScope(
        actionInput.parentRun,
        undefined,
        actionInput.approvalId,
      );
      return invokeActionCapability(scope, async (capability, parentRun, binding) => {
        const responseBacked = await hasActionResponseCheckpoint(scope, actionInput.approvalId);
        const value = await capability.execute({ ...actionInput, parentRun });
        if (responseBacked && value.kind === 'handoff_pending') {
          const current = await repositories.run.getById(parentRun.accountId, parentRun.id);
          if (!current) throw new Error('kernel_action_scope_mismatch');
          const finalized = await artifacts.commitKernelTurn.finalizeActionResponse({
            accountId: parentRun.accountId,
            runId: parentRun.id,
            requestId: scope.requestId,
            attemptNumber: scope.attemptNumber,
            approvalId: actionInput.approvalId,
            messageId: `msg_${scope.requestId}`,
            accountBinding: binding,
            outcome: 'handoff',
            resultRef: `jhandoff:${actionInput.approvalId}:${value.ownerId}`,
            completedAt: Math.max(input.now(), current.updatedAt),
          });
          if (!finalized.committed) {
            if (finalized.reason === 'account_authority_revoked') {
              throw new Error('kernel_account_authority_revoked');
            }
            throw new Error(`kernel_action_response_finalize_${finalized.reason}`);
          }
        }
        return value;
      });
    },
    async executeAutoApprovedSafe(
      actionInput: Parameters<JarvisKernelActionPort['executeAutoApprovedSafe']>[0],
    ) {
      const scope = await loadCanonicalActionScope(actionInput.parentRun, actionInput.attempt);
      return invokeActionCapability(scope, (capability, parentRun) =>
        capability.executeAutoApprovedSafe({ ...actionInput, parentRun }),
      );
    },
  });
  const responseActions: JarvisKernelResponseActionPort = Object.freeze({
    resolveRegistration: (actionId) => input.actionCatalog?.resolve(actionId),
    create: (actionInput) => actions.create(actionInput),
    async executeAutoApprovedSafe(actionInput) {
      const execution = await actions.executeAutoApprovedSafe(actionInput);
      if (execution.kind !== 'committed') return execution;
      const approvals = await repositories.approval.listByRun(
        actionInput.parentRun.accountId,
        actionInput.parentRun.id,
        {
          requestId: actionInput.attempt.requestId,
          attemptNumber: actionInput.attempt.attemptNumber,
          limit: 2,
        },
      );
      const matching = approvals.filter(
        (approval) =>
          approval.actionId === actionInput.actionId &&
          approval.actionVersion === actionInput.actionVersion &&
          approval.status === 'consumed',
      );
      if (matching.length !== 1) throw new Error('kernel_safe_action_approval_readback_mismatch');
      const approval = matching[0]!;
      let pluginArtifacts:
        | readonly Readonly<{
            evidence: CanonicalPluginEvidence;
            drafts: readonly JarvisArtifactDraft[];
          }>[]
        | undefined;
      const registration = input.actionCatalog?.resolve(actionInput.actionId);
      if (
        input.pluginArtifactResults &&
        registration?.executor.kind === 'plugin_tool' &&
        execution.value.kind === 'settled' &&
        execution.value.result.ok
      ) {
        const events = await repositories.event.listByRun(
          actionInput.parentRun.accountId,
          actionInput.parentRun.id,
          { limit: 500 },
        );
        const resultEvents = events.filter((event) => {
          const source = event.producerSourceEvidence;
          return (
            source?.phase === 'result' &&
            source.producerKind === 'plugin' &&
            source.producerIdentity.producerKind === 'plugin' &&
            source.accountId === actionInput.parentRun.accountId &&
            source.runId === actionInput.parentRun.id &&
            source.requestId === actionInput.attempt.requestId &&
            source.attemptNumber === actionInput.attempt.attemptNumber &&
            source.state === 'completed' &&
            source.producerIdentity.pluginId === approval.actionId &&
            source.producerIdentity.invocationId === `approval:${approval.id}`
          );
        });
        if (resultEvents.length !== 1) {
          throw new Error('kernel_plugin_result_evidence_mismatch');
        }
        const source = resultEvents[0]!.producerSourceEvidence;
        if (
          !source ||
          source.phase !== 'result' ||
          source.producerKind !== 'plugin' ||
          source.producerIdentity.producerKind !== 'plugin'
        ) {
          throw new Error('kernel_plugin_result_evidence_mismatch');
        }
        const evidence: CanonicalPluginEvidence = Object.freeze({
          producerId: 'plugin_result',
          accountId: source.accountId,
          runId: source.runId,
          requestId: source.requestId,
          attemptNumber: source.attemptNumber,
          resultRef: source.resultRef,
          state: 'succeeded',
          verifiedAt: source.observedAt,
          pluginId: registration.executor.pluginId,
          invocationId: source.producerIdentity.invocationId,
        });
        const drafts = await input.pluginArtifactResults.consumeCanonicalResult({
          evidence,
          registration: registration.executor,
          result: execution.value.result,
        });
        if (!drafts || drafts.length === 0) {
          throw new Error('kernel_plugin_result_artifact_unavailable');
        }
        pluginArtifacts = Object.freeze([
          Object.freeze({
            evidence,
            drafts,
          }),
        ]);
      }
      return {
        kind: 'committed',
        value: Object.freeze({
          approval: Object.freeze(structuredClone(approval)),
          execution: execution.value,
          ...(pluginArtifacts === undefined ? {} : { pluginArtifacts }),
        }),
      };
    },
  });
  const kernel: JarvisKernelRuntime = Object.freeze({
    actions,
    async openVoiceRecovery(recoveryInput: {
      accountId: string;
      runId: string;
    }): Promise<JarvisAuthorityBoundResult<JarvisVoiceRecoveryHandle>> {
      if (
        !recoveryInput.accountId ||
        recoveryInput.accountId.trim() !== recoveryInput.accountId ||
        !recoveryInput.runId ||
        recoveryInput.runId.trim() !== recoveryInput.runId
      ) {
        throw new TypeError('voice_recovery_scope_invalid');
      }
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(recoveryInput.accountId);
      } catch {
        return { kind: 'account_authority_revoked' };
      }
      try {
        const snapshot = await loadVoiceRecoverySnapshot(
          recoveryInput.accountId,
          recoveryInput.runId,
        );
        binding.assertCurrent();
        if (!snapshot) throw new Error('voice_recovery_evidence_invalid');
        return {
          kind: 'committed',
          value: issueVoiceRecoveryHandle(binding, snapshot),
        };
      } catch (error) {
        if (binding.revocationSignal.aborted) {
          return { kind: 'account_authority_revoked' };
        }
        throw error;
      } finally {
        binding.dispose();
      }
    },
    async startVoiceTurn(
      turnInput: Readonly<JarvisKernelTurnInput> & { surface: 'voice' },
    ): Promise<
      JarvisAuthorityBoundResult<{
        result: JarvisKernelTurnResult;
        handle: JarvisVoiceTurnHandle;
      }>
    > {
      if (turnInput.surface !== 'voice' || turnInput.run.source !== 'voice') {
        throw new Error('kernel_voice_turn_scope_mismatch');
      }
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(turnInput.accountId);
      } catch {
        return { kind: 'account_authority_revoked' };
      }
      let handle: JarvisVoiceTurnHandle | undefined;
      try {
        handle = issueVoiceHandle(binding, turnInput);
        const boundArtifactEffectClaims: JarvisArtifactEffectClaimCapability = Object.freeze({
          async claim(claim: Parameters<JarvisArtifactEffectClaimCapability['claim']>[0]) {
            binding.assertCurrent();
            if (
              claim.accountId !== turnInput.accountId ||
              claim.runId !== turnInput.run.id ||
              claim.requestId !== turnInput.attempt.requestId ||
              claim.attemptNumber !== turnInput.attempt.attemptNumber
            ) {
              throw new Error('kernel_artifact_effect_scope_mismatch');
            }
            const result = await artifactEffectClaims.claim(claim);
            binding.assertCurrent();
            return result;
          },
        });
        const result = await runJarvisKernelVoiceTurn(turnInput, {
          journal: input.journal,
          issueBoundLifecycle(scope) {
            if (
              scope.accountId !== turnInput.accountId ||
              scope.runId !== turnInput.run.id ||
              scope.requestId !== turnInput.attempt.requestId ||
              scope.attemptNumber !== turnInput.attempt.attemptNumber
            ) {
              throw new Error('kernel_lifecycle_scope_mismatch');
            }
            return issueLifecycle(binding, scope);
          },
          issueBoundArtifactPipeline: artifacts.issueBoundArtifactPipeline,
          artifactEffectClaims: boundArtifactEffectClaims,
          takeProviderArtifactDrafts: input.takeProviderArtifactDrafts,
          responseActions,
          commitActionResponseReady(commitInput) {
            return artifacts.commitKernelTurn.commitActionResponseReady({
              ...commitInput,
              accountBinding: binding,
            });
          },
          commitKernelTurn(commitInput) {
            return artifacts.commitKernelTurn.commitKernelTurn({
              ...commitInput,
              accountBinding: binding,
            });
          },
          prepareProvider: input.prepareProvider,
          processResponse: input.processResponse,
          now: input.now,
        });
        const state = voiceHandleStates.get(handle);
        if (!state) throw new Error('voice_handle_invalid');
        if (result.kind === 'account_authority_revoked') {
          finishVoiceHandleDisposal(handle, state);
          return result;
        }
        state.deferred = result.value;
        state.phase = 'response_pending';
        const { request, compiled, response, messageParts } = result.value;
        return {
          kind: 'committed',
          value: Object.freeze({
            result: Object.freeze({ request, compiled, response, messageParts }),
            handle,
          }),
        };
      } catch (error) {
        const authorityWasRevoked = binding.revocationSignal.aborted;
        if (handle) {
          const state = voiceHandleStates.get(handle);
          if (state) finishVoiceHandleDisposal(handle, state);
        }
        if (authorityWasRevoked) {
          return { kind: 'account_authority_revoked' };
        }
        throw error;
      } finally {
        binding.dispose();
      }
    },
    async runInitialTurn(
      turnInput: Readonly<JarvisKernelTurnInput>,
    ): Promise<JarvisAuthorityBoundResult<JarvisKernelTurnResult>> {
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(turnInput.accountId);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      try {
        const boundArtifactEffectClaims: JarvisArtifactEffectClaimCapability = Object.freeze({
          async claim(claim: Parameters<JarvisArtifactEffectClaimCapability['claim']>[0]) {
            binding.assertCurrent();
            if (
              claim.accountId !== turnInput.accountId ||
              claim.runId !== turnInput.run.id ||
              claim.requestId !== turnInput.attempt.requestId ||
              claim.attemptNumber !== turnInput.attempt.attemptNumber
            ) {
              throw new Error('kernel_artifact_effect_scope_mismatch');
            }
            const result = await artifactEffectClaims.claim(claim);
            binding.assertCurrent();
            return result;
          },
        });
        return await runJarvisKernelTurn(turnInput, {
          journal: input.journal,
          issueBoundLifecycle(scope) {
            if (
              scope.accountId !== turnInput.accountId ||
              scope.runId !== turnInput.run.id ||
              scope.requestId !== turnInput.attempt.requestId ||
              scope.attemptNumber !== turnInput.attempt.attemptNumber
            ) {
              throw new Error('kernel_lifecycle_scope_mismatch');
            }
            return issueLifecycle(binding, scope);
          },
          issueBoundArtifactPipeline: artifacts.issueBoundArtifactPipeline,
          artifactEffectClaims: boundArtifactEffectClaims,
          takeProviderArtifactDrafts: input.takeProviderArtifactDrafts,
          responseActions,
          commitActionResponseReady(commitInput) {
            return artifacts.commitKernelTurn.commitActionResponseReady({
              ...commitInput,
              accountBinding: binding,
            });
          },
          commitKernelTurn(commitInput) {
            return artifacts.commitKernelTurn.commitKernelTurn({
              ...commitInput,
              accountBinding: binding,
            });
          },
          prepareProvider: input.prepareProvider,
          processResponse: input.processResponse,
          now: input.now,
        });
      } finally {
        binding.dispose();
      }
    },
    async requestCancellation(cancelInput: {
      accountId: string;
      runId: string;
    }): Promise<JarvisCancellationRequestResult> {
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(cancelInput.accountId);
      } catch {
        return { kind: 'authority_revoked_before_intent' };
      }
      try {
        return await requestCancellationWithBinding(binding, cancelInput);
      } finally {
        binding.dispose();
      }
    },
    async allocateScheduledOccurrence(allocationInput: {
      accountId: string;
      eventId: string;
      dueAt: number;
    }) {
      assertScheduledInput(allocationInput.accountId, 'account');
      assertScheduledInput(allocationInput.eventId, 'event');
      if (!Number.isFinite(allocationInput.dueAt) || allocationInput.dueAt < 0) {
        throw new Error('kernel_schedule_due_at_invalid');
      }
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(allocationInput.accountId);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      try {
        const occurrenceId = await scheduledOccurrenceId(allocationInput);
        const runId = await scheduledRunId({
          accountId: allocationInput.accountId,
          occurrenceId,
          logicalAttempt: 0,
        });
        const existing = await repositories.run.getById(allocationInput.accountId, runId);
        binding.assertCurrent();
        if (existing) {
          const current = currentScheduledAllocation({
            accountId: allocationInput.accountId,
            runId,
            eventId: allocationInput.eventId,
            dueAt: allocationInput.dueAt,
            logicalAttempt: 0,
          });
          if (current) {
            binding.dispose();
            return { kind: 'committed' as const, value: current };
          }
          if (
            existing.source === 'schedule' &&
            existing.status === 'queued' &&
            existing.scheduledRetrySnapshot === undefined &&
            (existing.transportAttempts?.length ?? 0) === 0
          ) {
            throw new Error('kernel_schedule_unbound_restart');
          }
          throw new Error('kernel_schedule_allocation_conflict');
        }
        if (!input.resolveScheduledOccurrence)
          throw new Error('kernel_schedule_source_unavailable');
        const basis = await input.resolveScheduledOccurrence({
          ...allocationInput,
          logicalAttempt: 0,
        });
        binding.assertCurrent();
        if (!basis) throw new Error('kernel_schedule_source_unavailable');
        const allocation = await allocateResolvedScheduledOccurrence({
          binding,
          eventId: allocationInput.eventId,
          dueAt: allocationInput.dueAt,
          logicalAttempt: 0,
          basis,
          mode: { kind: 'initial' },
        });
        return { kind: 'committed' as const, value: allocation };
      } catch (error) {
        const revoked = binding.revocationSignal.aborted;
        binding.dispose();
        if (revoked) return { kind: 'account_authority_revoked' as const };
        throw error;
      }
    },
    async loadScheduledRun(loadInput: { accountId: string; runId: string }) {
      assertScheduledInput(loadInput.accountId, 'account');
      assertScheduledInput(loadInput.runId, 'run');
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(loadInput.accountId);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      try {
        const run = await repositories.run.getById(loadInput.accountId, loadInput.runId);
        binding.assertCurrent();
        if (!run) {
          binding.dispose();
          return { kind: 'committed' as const, value: undefined };
        }
        const snapshot = run.scheduledRetrySnapshot;
        const previousAttempt = run.transportAttempts?.at(-1);
        if (
          run.source !== 'schedule' ||
          run.status !== 'running' ||
          !snapshot ||
          snapshot.accountId !== run.accountId ||
          snapshot.request.runId !== run.id ||
          !previousAttempt ||
          previousAttempt.state !== 'retryable_failed' ||
          previousAttempt.effectBarrier.state !== 'open' ||
          previousAttempt.effectBarrier.version !== 0 ||
          !previousAttempt.zeroEffectEvidence
        ) {
          throw new Error('kernel_schedule_transport_retry_unavailable');
        }
        const revalidatedEvidence =
          await consequentialEffectSafety.revalidateZeroConsequentialEffect({
            run,
            attempt: previousAttempt,
            evidence: previousAttempt.zeroEffectEvidence,
          });
        binding.assertCurrent();
        if (!revalidatedEvidence) {
          throw new Error('kernel_schedule_transport_retry_safety_denied');
        }
        const allocation = issueScheduledAllocation({
          binding,
          run,
          basis: scheduledBasisFromSnapshot(snapshot),
          eventId: snapshot.eventId,
          occurrenceId: snapshot.occurrenceId,
          dueAt: snapshot.dueAt,
          logicalAttempt: snapshot.logicalAttempt,
          requestId: `jreq_${input.randomUUID()}`,
          createdAt: input.now(),
          mode: { kind: 'transport_retry', previousAttempt, revalidatedEvidence },
          allocation: undefined,
          consumed: false,
          disposed: false,
        });
        return { kind: 'committed' as const, value: allocation };
      } catch (error) {
        const revoked = binding.revocationSignal.aborted;
        binding.dispose();
        if (revoked) return { kind: 'account_authority_revoked' as const };
        throw error;
      }
    },
    async allocateScheduledLogicalRetry(logicalInput: {
      accountId: string;
      previousRunId: string;
    }) {
      assertScheduledInput(logicalInput.accountId, 'account');
      assertScheduledInput(logicalInput.previousRunId, 'previous_run');
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(logicalInput.accountId);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      try {
        const previousRun = await repositories.run.getById(
          logicalInput.accountId,
          logicalInput.previousRunId,
        );
        const snapshot = previousRun?.scheduledRetrySnapshot;
        const previousAttempt = previousRun?.transportAttempts?.at(-1);
        if (
          !previousRun ||
          previousRun.source !== 'schedule' ||
          !['failed', 'timed_out', 'cancelled'].includes(previousRun.status) ||
          !snapshot ||
          !previousAttempt ||
          snapshot.accountId !== previousRun.accountId ||
          snapshot.request.runId !== previousRun.id
        ) {
          throw new Error('kernel_schedule_logical_retry_unavailable');
        }
        if (!input.resolveScheduledOccurrence)
          throw new Error('kernel_schedule_source_unavailable');
        const logicalAttempt = snapshot.logicalAttempt + 1;
        const basis = await input.resolveScheduledOccurrence({
          accountId: logicalInput.accountId,
          eventId: snapshot.eventId,
          dueAt: snapshot.dueAt,
          logicalAttempt,
          previousRunId: previousRun.id,
        });
        binding.assertCurrent();
        if (!basis) throw new Error('kernel_schedule_source_unavailable');
        const allocation = await allocateResolvedScheduledOccurrence({
          binding,
          eventId: snapshot.eventId,
          dueAt: snapshot.dueAt,
          logicalAttempt,
          basis,
          mode: { kind: 'logical_retry', previousRun, previousAttempt },
          parentRunId: previousRun.id,
        });
        return { kind: 'committed' as const, value: allocation };
      } catch (error) {
        const revoked = binding.revocationSignal.aborted;
        binding.dispose();
        if (revoked) return { kind: 'account_authority_revoked' as const };
        throw error;
      }
    },
    async prepareScheduledAttempt({
      allocation,
    }: {
      allocation: JarvisAllocatedScheduledOccurrence;
    }) {
      if (!issuedScheduledAllocations.has(allocation)) {
        throw new Error('kernel_schedule_allocation_invalid');
      }
      const state = scheduledAllocationStates.get(allocation);
      if (!state || state.consumed || state.disposed) {
        throw new Error('kernel_schedule_allocation_invalid');
      }
      try {
        state.binding.assertCurrent();
        const attempt: JarvisKernelTurnInput['attempt'] =
          state.mode.kind === 'transport_retry'
            ? {
                kind: 'transport_retry',
                requestId: state.requestId,
                runId: state.run.id,
                attemptNumber: state.mode.previousAttempt.attemptNumber + 1,
                previousRequestId: state.mode.previousAttempt.requestId,
                previousRunId: state.run.id,
                previousAttemptNumber: state.mode.previousAttempt.attemptNumber,
              }
            : state.mode.kind === 'logical_retry'
              ? {
                  kind: 'logical_retry',
                  requestId: state.requestId,
                  runId: state.run.id,
                  attemptNumber: 1,
                  previousRequestId: state.mode.previousAttempt.requestId,
                  previousRunId: state.mode.previousRun.id,
                  previousAttemptNumber: state.mode.previousAttempt.attemptNumber,
                }
              : {
                  kind: 'initial',
                  requestId: state.requestId,
                  runId: state.run.id,
                  attemptNumber: 1,
                };
        const turnInput = deepFreezeJarvisCopy({
          run: state.run,
          attempt,
          accountId: state.run.accountId,
          ...(state.basis.workspaceId === undefined
            ? {}
            : { workspaceId: state.basis.workspaceId }),
          ...(state.basis.projectId === undefined ? {} : { projectId: state.basis.projectId }),
          chatId: state.basis.chatId,
          ...(state.run.parentRunId === undefined ? {} : { parentRunId: state.run.parentRunId }),
          userMessageId: state.basis.userMessageId,
          agent: state.basis.agent,
          surface: 'schedule' as const,
          interactionMode: state.basis.interactionMode,
          userText: state.basis.userText,
          messageHistory: state.basis.messageHistory,
          model: state.basis.model,
          identity: state.basis.identity,
          profile: state.basis.profile,
          capabilities: state.basis.capabilities,
          context: state.basis.context,
          outputContract: state.basis.outputContract,
          ...(state.basis.workingDirectory === undefined
            ? {}
            : { workingDirectory: state.basis.workingDirectory }),
        }) as Readonly<JarvisKernelTurnInput> & { surface: 'schedule' };
        const request = await createJarvisRequestEnvelope({
          attempt: turnInput.attempt,
          accountId: turnInput.accountId,
          ...(turnInput.workspaceId === undefined ? {} : { workspaceId: turnInput.workspaceId }),
          ...(turnInput.projectId === undefined ? {} : { projectId: turnInput.projectId }),
          chatId: turnInput.chatId,
          ...(turnInput.parentRunId === undefined ? {} : { parentRunId: turnInput.parentRunId }),
          agent: {
            id: turnInput.agent.id,
            slug: turnInput.agent.slug,
            builtin: turnInput.agent.builtin === true,
          },
          surface: 'schedule',
          interactionMode: turnInput.interactionMode,
          identity: turnInput.identity,
          profile: turnInput.profile,
          model: turnInput.model,
          capabilities: turnInput.capabilities,
          context: turnInput.context,
          outputContract: turnInput.outputContract,
          userText: turnInput.userText,
          messageHistory: turnInput.messageHistory,
          createdAt: state.createdAt,
        });
        compileJarvisPrompt(request);
        const snapshot = scheduledSnapshotFromRequest(
          state.eventId,
          state.occurrenceId,
          state.dueAt,
          state.logicalAttempt,
          request,
        );
        if (
          state.mode.kind === 'transport_retry' &&
          !canonicalValuesMatch(snapshot, state.run.scheduledRetrySnapshot)
        ) {
          throw new Error('kernel_schedule_retry_snapshot_mismatch');
        }
        const prepared = Object.freeze({
          [preparedJarvisScheduledAttemptBrand]: true as const,
        });
        state.consumed = true;
        issuedScheduledPreparations.add(prepared);
        scheduledPreparationStates.set(prepared, {
          allocation,
          allocationState: state,
          turnInput,
          snapshot,
          begun: false,
          handle: undefined,
        });
        return prepared;
      } catch (error) {
        disposeScheduledAllocation(state);
        throw error;
      }
    },
    async beginPreparedScheduledAttempt({
      prepared,
    }: {
      prepared: PreparedJarvisScheduledKernelAttempt;
    }) {
      if (!issuedScheduledPreparations.has(prepared)) {
        throw new Error('kernel_schedule_preparation_invalid');
      }
      const preparation = scheduledPreparationStates.get(prepared);
      if (
        !preparation ||
        preparation.begun ||
        preparation.allocationState.disposed ||
        preparation.handle
      ) {
        throw new Error('kernel_schedule_preparation_invalid');
      }
      const state = preparation.allocationState;
      try {
        state.binding.assertCurrent();
        const lease =
          state.mode.kind === 'transport_retry'
            ? await transportAttempts.beginScheduledTransportRetry({
                accountId: state.run.accountId,
                runId: state.run.id,
                previousAttemptNumber: state.mode.previousAttempt.attemptNumber,
                requestId: state.requestId,
                expectedSnapshot: preparation.snapshot,
                createdAt: state.createdAt,
                revalidatedEvidence: state.mode.revalidatedEvidence,
              })
            : await transportAttempts.beginInitialScheduledAttempt({
                accountId: state.run.accountId,
                runId: state.run.id,
                requestId: state.requestId,
                snapshot: preparation.snapshot,
                createdAt: state.createdAt,
              });
        state.binding.assertCurrent();
        const persisted = await transportAttempts.verifyLease(lease, preparation.snapshot);
        state.binding.assertCurrent();
        const turnInput = deepFreezeJarvisCopy({
          ...preparation.turnInput,
          run: persisted,
        }) as Readonly<JarvisKernelTurnInput> & { surface: 'schedule' };
        const attempt = persisted.transportAttempts?.at(-1);
        if (
          !attempt ||
          attempt.requestId !== turnInput.attempt.requestId ||
          attempt.attemptNumber !== turnInput.attempt.attemptNumber
        ) {
          throw new Error('kernel_schedule_start_attempt_mismatch');
        }
        const startEvent = await repositories.event.getBySeq(
          persisted.accountId,
          persisted.id,
          attempt.startedEventSeq,
        );
        const startSource = startEvent?.producerSourceEvidence;
        if (
          !startEvent ||
          startSource?.producerKind !== 'schedule' ||
          startSource.phase !== 'start' ||
          startSource.state !== 'started' ||
          startSource.accountId !== persisted.accountId ||
          startSource.runId !== persisted.id ||
          startSource.requestId !== attempt.requestId ||
          startSource.attemptNumber !== attempt.attemptNumber ||
          startSource.producerIdentity.eventId !== preparation.snapshot.eventId ||
          startSource.producerIdentity.occurrenceId !== preparation.snapshot.occurrenceId
        ) {
          throw new Error('kernel_schedule_start_source_mismatch');
        }
        const liveScope = {
          accountId: persisted.accountId,
          runId: persisted.id,
          requestId: attempt.requestId,
          attemptNumber: attempt.attemptNumber,
        };
        const liveOwner = liveEvidence.bindLifecycle({
          scope: liveScope,
          append: Object.freeze({
            append: ({ evidence }: { evidence: JarvisDurableLiveEvidenceV1 }) =>
              appendCapabilityLiveEvidence(
                state.binding,
                liveScope,
                evidence,
                'Schedule evidence updated',
              ),
          }),
        });
        const liveRegistration = await liveOwner.schedule.startCapability({
          evidence: Object.freeze({
            schemaVersion: 1,
            producerKind: 'schedule',
            producerIdentity: startSource.producerIdentity,
            ...liveScope,
            resultRef: startSource.resultRef,
            resultEventSeq: startEvent.seq,
            state: 'busy',
            verifiedAt: startSource.observedAt,
          }),
          registrationId: `${persisted.id}:schedule:${attempt.attemptNumber}`,
          category: 'agent',
          capabilityId: 'schedule.dispatch',
          operations: ['execute', 'cancel', 'inspect'],
          state: 'busy',
        });
        let handle: JarvisScheduledKernelAttemptHandle;
        handle = Object.freeze({
          [jarvisScheduledKernelHandleBrand]: true as const,
          requestCancellation: () =>
            requestCancellationWithBinding(state.binding, {
              accountId: persisted.accountId,
              runId: persisted.id,
            }),
          dispose: () => {
            const current = scheduledHandleStates.get(handle);
            if (current) disposeScheduledHandleState(handle, current);
          },
        });
        const handleState: ScheduledHandleState = {
          prepared,
          preparationState: preparation,
          binding: state.binding,
          lease,
          snapshot: preparation.snapshot,
          turnInput,
          liveRegistration,
          providerFailure: undefined,
          dispatched: false,
          settled: false,
          disposed: false,
        };
        preparation.begun = true;
        preparation.handle = handle;
        issuedScheduledHandles.add(handle);
        scheduledHandleStates.set(handle, handleState);
        return { kind: 'committed' as const, value: handle };
      } catch (error) {
        const revoked = state.binding.revocationSignal.aborted;
        disposeScheduledAllocation(state);
        if (revoked) return { kind: 'account_authority_revoked' as const };
        throw error;
      }
    },
    async dispatchPreparedScheduledAttempt({
      prepared,
      handle,
    }: {
      prepared: PreparedJarvisScheduledKernelAttempt;
      handle: JarvisScheduledKernelAttemptHandle;
    }) {
      const preparation = scheduledPreparationStates.get(prepared);
      const state = scheduledHandleStates.get(handle);
      if (
        !issuedScheduledPreparations.has(prepared) ||
        !issuedScheduledHandles.has(handle) ||
        !preparation ||
        !state ||
        state.prepared !== prepared ||
        preparation.handle !== handle ||
        state.disposed ||
        state.dispatched
      ) {
        throw new Error('kernel_schedule_handle_invalid');
      }
      state.dispatched = true;
      const turnInput = state.turnInput;
      const boundArtifactEffectClaims: JarvisArtifactEffectClaimCapability = Object.freeze({
        async claim(claim: Parameters<JarvisArtifactEffectClaimCapability['claim']>[0]) {
          state.binding.assertCurrent();
          if (
            claim.accountId !== turnInput.accountId ||
            claim.runId !== turnInput.run.id ||
            claim.requestId !== turnInput.attempt.requestId ||
            claim.attemptNumber !== turnInput.attempt.attemptNumber
          ) {
            throw new Error('kernel_artifact_effect_scope_mismatch');
          }
          const result = await artifactEffectClaims.claim(claim);
          state.binding.assertCurrent();
          return result;
        },
      });
      try {
        state.binding.assertCurrent();
        const result = await runJarvisKernelScheduledTurn(turnInput, {
          journal: input.journal,
          issueBoundLifecycle(scope) {
            if (
              scope.accountId !== turnInput.accountId ||
              scope.runId !== turnInput.run.id ||
              scope.requestId !== turnInput.attempt.requestId ||
              scope.attemptNumber !== turnInput.attempt.attemptNumber
            ) {
              throw new Error('kernel_lifecycle_scope_mismatch');
            }
            return issueLifecycle(state.binding, scope);
          },
          issueBoundArtifactPipeline: artifacts.issueBoundArtifactPipeline,
          artifactEffectClaims: boundArtifactEffectClaims,
          takeProviderArtifactDrafts: input.takeProviderArtifactDrafts,
          responseActions,
          commitActionResponseReady(commitInput) {
            return artifacts.commitKernelTurn.commitActionResponseReady({
              ...commitInput,
              accountBinding: state.binding,
            });
          },
          commitKernelTurn(commitInput) {
            return artifacts.commitKernelTurn.commitKernelTurn({
              ...commitInput,
              accountBinding: state.binding,
            });
          },
          prepareProvider: input.prepareProvider,
          processResponse: input.processResponse,
          now: input.now,
        });
        if (result.kind === 'account_authority_revoked') return result;
        const scheduleResultEvent = await appendScheduleResultSource(
          state,
          await loadScheduleResultAuthority(state, 'kernel_turn_committed'),
        );
        await completeScheduleLiveEvidence(state, scheduleResultEvent);
        state.settled = true;
        disposeScheduledHandleState(handle, state);
        return {
          kind: 'committed' as const,
          value: { kind: 'committed' as const, result: result.value },
        };
      } catch (error) {
        if (state.binding.revocationSignal.aborted) {
          disposeScheduledHandleState(handle, state);
          return { kind: 'account_authority_revoked' as const };
        }
        if (
          error instanceof JarvisProviderAttemptFailureError &&
          error.classification.kind === 'pre_effect_transport_failure'
        ) {
          state.providerFailure = error.classification.evidence;
          return {
            kind: 'committed' as const,
            value: { kind: 'pre_effect_transport_failure' as const },
          };
        }
        disposeScheduledHandleState(handle, state);
        throw error;
      }
    },
    async settleScheduledTransportFailure({
      handle,
    }: {
      handle: JarvisScheduledKernelAttemptHandle;
    }) {
      const state = scheduledHandleStates.get(handle);
      if (
        !issuedScheduledHandles.has(handle) ||
        !state ||
        state.disposed ||
        !state.dispatched ||
        state.settled ||
        !state.providerFailure
      ) {
        throw new Error('kernel_schedule_settlement_invalid');
      }
      try {
        state.binding.assertCurrent();
        const run = await transportAttempts.verifyLease(state.lease, state.snapshot);
        const attempt = run.transportAttempts?.at(-1);
        if (
          !attempt ||
          attempt.requestId !== state.lease.requestId ||
          attempt.attemptNumber !== state.lease.attemptNumber
        ) {
          throw new Error('kernel_schedule_settlement_attempt_mismatch');
        }
        const zeroEffectEvidence = await consequentialEffectSafety.proveZeroConsequentialEffect({
          run,
          attempt,
          providerFailure: state.providerFailure,
        });
        state.binding.assertCurrent();
        const settled = await transportAttempts.settleScheduledTransportFailure({
          lease: state.lease,
          expectedSnapshot: state.snapshot,
          providerFailure: state.providerFailure,
          zeroEffectEvidence,
          settledAt: input.now(),
        });
        state.binding.assertCurrent();
        const scheduleResultEvent = await appendScheduleResultSource(
          state,
          await loadScheduleResultAuthority(state, 'scheduled_transport_settled'),
        );
        await completeScheduleLiveEvidence(state, scheduleResultEvent);
        state.settled = true;
        disposeScheduledHandleState(handle, state);
        return { kind: 'committed' as const, value: settled };
      } catch (error) {
        const revoked = state.binding.revocationSignal.aborted;
        disposeScheduledHandleState(handle, state);
        if (revoked) return { kind: 'account_authority_revoked' as const };
        throw error;
      }
    },
    disposeScheduledAttempt(handle: JarvisScheduledKernelAttemptHandle) {
      const state = scheduledHandleStates.get(handle);
      if (!state || !issuedScheduledHandles.has(handle)) return;
      disposeScheduledHandleState(handle, state);
    },
    async bindHiveStackPlan({ plan }: { plan: Readonly<JarvisHiveStackPlanV1> }) {
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(plan.accountId);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      try {
        const detachedPlan = deepFreezeJarvisCopy(plan);
        const transaction = await transactionAuthority.lifecycleTransaction(
          ['jarvis_runs', 'jarvis_events'],
          binding.revocationSignal,
          async (context) => {
            binding.assertCurrent();
            const row = await context.jarvis_runs.get(detachedPlan.parentRunId);
            if (!row || row.account_id !== detachedPlan.accountId) {
              throw new Error('kernel_hive_parent_missing');
            }
            const current = fromJarvisRunRow(row);
            if (
              current.source !== 'hive_final' ||
              current.status !== 'queued' ||
              detachedPlan.parentRunId !== current.id ||
              detachedPlan.accountId !== current.accountId
            ) {
              throw new Error('kernel_hive_plan_scope_mismatch');
            }
            if (current.hiveStackPlan) {
              if (!canonicalValuesMatch(current.hiveStackPlan, detachedPlan)) {
                throw new Error('kernel_hive_plan_conflict');
              }
              return current;
            }
            const updated: JarvisRun = {
              ...current,
              hiveStackPlan: detachedPlan,
              updatedAt: input.now(),
            };
            await context.jarvis_runs.put(toJarvisRunRow(updated));
            binding.assertCurrent();
            return updated;
          },
        );
        if (transaction.kind === 'cancelled') {
          return { kind: 'account_authority_revoked' as const };
        }
        const readback = await repositories.run.getById(plan.accountId, plan.parentRunId);
        binding.assertCurrent();
        if (!readback || !canonicalValuesMatch(readback.hiveStackPlan, detachedPlan)) {
          throw new Error('kernel_hive_plan_readback_mismatch');
        }
        return { kind: 'committed' as const, value: readback };
      } finally {
        binding.dispose();
      }
    },
    async openHiveWorker({ parentRunId, stepId }: { parentRunId: string; stepId: string }) {
      assertScheduledInput(parentRunId, 'hive_parent_run');
      assertScheduledInput(stepId, 'hive_step');
      const identity = resolveAccountIdentity(useAuthStore.getState());
      if (!identity) return { kind: 'account_authority_revoked' as const };
      let binding: JarvisKernelAccountBinding;
      try {
        binding = issueAccountBinding(identity.accountId);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      let claimKey: string | undefined;
      try {
        const parentRun = await repositories.run.getById(identity.accountId, parentRunId);
        const plan = parentRun?.hiveStackPlan;
        if (
          !parentRun ||
          parentRun.source !== 'hive_final' ||
          parentRun.status !== 'queued' ||
          !plan ||
          plan.accountId !== parentRun.accountId ||
          plan.parentRunId !== parentRun.id
        ) {
          throw new Error('kernel_hive_parent_invalid');
        }
        const matching = plan.steps.filter((candidate) => candidate.stepId === stepId);
        if (matching.length !== 1) throw new Error('kernel_hive_step_invalid');
        const step = matching[0]!;
        claimKey = hiveStepKey(parentRun.accountId, parentRun.id, step.stepId);
        if (claimedHiveSteps.has(claimKey)) throw new Error('kernel_hive_step_consumed');
        claimedHiveSteps.add(claimKey);
        const digest = await sha256Text(
          `hive-child-run-v1\u0000${parentRun.accountId}\u0000${parentRun.id}\u0000${plan.stackId}\u0000${step.stepId}`,
        );
        const childRunId = `jrun_${digest.slice(0, 32)}`;
        const requestId = `jreq_${input.randomUUID()}`;
        const childRun = await input.journal.allocateRun({
          id: childRunId,
          accountId: parentRun.accountId,
          ...(parentRun.workspaceId === undefined ? {} : { workspaceId: parentRun.workspaceId }),
          ...(parentRun.projectId === undefined ? {} : { projectId: parentRun.projectId }),
          ...(parentRun.chatId === undefined ? {} : { chatId: parentRun.chatId }),
          parentRunId: parentRun.id,
          source: 'hive_final',
          agentId: step.agent.id,
          identityVersion: parentRun.identityVersion,
          profileRevisionId: parentRun.profileRevisionId,
          model: step.model,
        });
        binding.assertCurrent();
        const readback = await input.journal.getRun(parentRun.accountId, childRunId);
        if (
          !readback ||
          !sameImmutableRun(childRun, readback) ||
          readback.status !== 'queued' ||
          readback.parentRunId !== parentRun.id ||
          readback.agentId !== step.agent.id ||
          !canonicalValuesMatch(readback.model, step.model)
        ) {
          throw new Error('kernel_hive_child_readback_mismatch');
        }
        const controller = new AbortController();
        let handle: JarvisHiveWorkerHandle;
        handle = Object.freeze({
          [jarvisHiveWorkerHandleBrand]: true as const,
          execute: async () => {
            const state = hiveWorkerHandleStates.get(handle);
            if (
              !state ||
              state.disposed ||
              state.executed ||
              !issuedHiveWorkerHandles.has(handle)
            ) {
              throw new Error('kernel_hive_worker_handle_invalid');
            }
            if (
              !input.hiveWorkerExecutor ||
              !input.journal.transitionRun ||
              !input.journal.appendEvent
            ) {
              throw new Error('kernel_hive_worker_executor_unavailable');
            }
            state.executed = true;
            let liveRegistration: JarvisLiveEvidenceRegistration<'hive'> | undefined;
            try {
              state.binding.assertCurrent();
              const startedAt = input.now();
              const liveScope = {
                accountId: state.parentRun.accountId,
                runId: state.parentRun.id,
                requestId: state.requestId,
                attemptNumber: 1,
              };
              const producerIdentity = {
                producerKind: 'hive' as const,
                stackId: state.plan.stackId,
                stepId: state.step.stepId,
                workerId: state.step.workerId,
              };
              const startResultRef = `jstart_${state.childRun.id}`;
              const parentStartEvent = await input.journal.appendEvent(
                state.parentRun.accountId,
                state.parentRun.id,
                {
                  idempotencyKey: `hive:${state.parentRun.id}:${state.step.stepId}:parent-start`,
                  type: 'model',
                  status: 'running',
                  title: 'Hive worker execution started',
                  safeSummary: 'A persisted Hive worker execution started.',
                  sourceRefs: [],
                  artifactIds: [],
                  createdAt: startedAt,
                  producerSourceEvidence: {
                    schemaVersion: 1,
                    ...liveScope,
                    producerKind: 'hive',
                    producerIdentity,
                    resultRef: startResultRef,
                    observedAt: startedAt,
                    phase: 'start',
                    state: 'started',
                  },
                },
              );
              state.binding.assertCurrent();
              const parentStartReadback = await repositories.event.getBySeq(
                state.parentRun.accountId,
                state.parentRun.id,
                parentStartEvent.seq,
              );
              if (
                !parentStartReadback ||
                !canonicalValuesMatch(parentStartReadback, parentStartEvent)
              ) {
                throw new Error('kernel_hive_parent_start_readback_mismatch');
              }
              const liveOwner = liveEvidence.bindLifecycle({
                scope: liveScope,
                append: Object.freeze({
                  append: ({ evidence }: { evidence: JarvisDurableLiveEvidenceV1 }) =>
                    appendCapabilityLiveEvidence(
                      state.binding,
                      liveScope,
                      evidence,
                      'Hive evidence updated',
                    ),
                }),
              });
              liveRegistration = await liveOwner.hive.startCapability({
                evidence: Object.freeze({
                  schemaVersion: 1,
                  producerKind: 'hive',
                  producerIdentity,
                  ...liveScope,
                  resultRef: startResultRef,
                  resultEventSeq: parentStartEvent.seq,
                  state: 'busy',
                  verifiedAt: startedAt,
                }),
                registrationId: `${state.parentRun.id}:hive:${state.step.stepId}`,
                category: 'agent',
                capabilityId: `hive.worker.${state.step.stepId}`,
                operations: ['execute', 'cancel', 'inspect'],
                state: 'busy',
              });
              state.binding.assertCurrent();
              await input.journal.transitionRun({
                accountId: state.parentRun.accountId,
                runId: state.childRun.id,
                expectedStatus: 'queued',
                nextStatus: 'running',
                event: {
                  idempotencyKey: `hive:${state.parentRun.id}:${state.step.stepId}:start`,
                  title: 'Hive worker started',
                  safeSummary: 'A persisted Hive worker started.',
                  sourceRefs: [],
                  artifactIds: [],
                  createdAt: startedAt,
                  producerSourceEvidence: {
                    schemaVersion: 1,
                    accountId: state.parentRun.accountId,
                    runId: state.childRun.id,
                    requestId: state.requestId,
                    attemptNumber: 1,
                    producerKind: 'hive',
                    producerIdentity,
                    resultRef: `jstart_${state.childRun.id}`,
                    observedAt: startedAt,
                    phase: 'start',
                    state: 'started',
                  },
                },
              });
              state.binding.assertCurrent();
              const stepIndex = state.plan.steps.findIndex(
                (candidate) => candidate.stepId === state.step.stepId,
              );
              if (stepIndex < 0) throw new Error('kernel_hive_step_invalid');
              const messages = state.step.messages.map((message) => structuredClone(message));
              for (let index = 0; index < stepIndex; index += 1) {
                const priorStep = state.plan.steps[index]!;
                const priorResult = hiveWorkerResults.get(
                  hiveStepKey(state.parentRun.accountId, state.parentRun.id, priorStep.stepId),
                );
                if (!priorResult) throw new Error('kernel_hive_prior_worker_missing');
                if (priorResult.status === 'completed' && priorResult.text !== undefined) {
                  messages.push({ role: 'assistant', content: priorResult.text });
                }
                const nextStep = state.plan.steps[index + 1]!;
                messages.push({
                  role: 'user',
                  content: `Continue to the next Hive step (${nextStep.label}). Use the content above as input.`,
                });
              }
              const native = await input.hiveWorkerExecutor.execute({
                agent: hiveAgentFromStep(state.step),
                messages,
                signal: state.controller.signal,
                ...(state.step.model.connectionId === undefined
                  ? {}
                  : { connectionId: state.step.model.connectionId }),
                ...(state.step.workingDirectory === undefined
                  ? {}
                  : { workingDirectory: state.step.workingDirectory }),
              });
              state.binding.assertCurrent();
              if (
                native.providerId !== state.step.model.providerId ||
                native.modelId !== state.step.model.modelId
              ) {
                throw new Error('kernel_hive_worker_provider_mismatch');
              }
              const resultRef = `jresult_${state.childRun.id}_${state.step.stepId}` as const;
              const terminalStatus =
                native.status === 'completed'
                  ? ('completed' as const)
                  : native.status === 'cancelled'
                    ? ('cancelled' as const)
                    : ('failed' as const);
              const resultState = native.status === 'completed' ? 'completed' : 'degraded';
              await input.journal.transitionRun({
                accountId: state.parentRun.accountId,
                runId: state.childRun.id,
                expectedStatus: 'running',
                nextStatus: terminalStatus,
                completedAt: native.observedAt,
                event: {
                  idempotencyKey: `hive:${state.parentRun.id}:${state.step.stepId}:child-result`,
                  title:
                    native.status === 'completed' ? 'Hive worker completed' : 'Hive worker ended',
                  safeSummary:
                    native.status === 'completed'
                      ? 'The Hive worker completed.'
                      : 'The Hive worker ended without a verified successful output.',
                  sourceRefs: [],
                  artifactIds: [],
                  createdAt: native.observedAt,
                  canonicalResultEvidence: {
                    schemaVersion: 1,
                    kind: 'hive_child_provider_result',
                    accountId: state.parentRun.accountId,
                    runId: state.childRun.id,
                    requestId: state.requestId,
                    attemptNumber: 1,
                    parentRunId: state.parentRun.id,
                    stepId: state.step.stepId,
                    state: resultState,
                    resultRef,
                    observedAt: native.observedAt,
                  },
                },
              });
              const childEvents = await repositories.event.listByRun(
                state.parentRun.accountId,
                state.childRun.id,
                { limit: 500 },
              );
              const childResultEvent = childEvents.at(-1);
              if (
                !childResultEvent?.canonicalResultEvidence ||
                childResultEvent.canonicalResultEvidence.resultRef !== resultRef
              ) {
                throw new Error('kernel_hive_child_result_readback_mismatch');
              }
              const terminalChildRun = await repositories.run.getById(
                state.parentRun.accountId,
                state.childRun.id,
              );
              if (
                !terminalChildRun ||
                !sameImmutableRun(terminalChildRun, state.childRun) ||
                terminalChildRun.status !== terminalStatus ||
                terminalChildRun.parentRunId !== state.parentRun.id ||
                terminalChildRun.agentId !== state.step.agent.id ||
                !canonicalValuesMatch(terminalChildRun.model, state.step.model)
              ) {
                throw new Error('kernel_hive_child_result_readback_mismatch');
              }
              const parentResultEvent = await input.journal.appendEvent(
                state.parentRun.accountId,
                state.parentRun.id,
                {
                  idempotencyKey: `hive:${state.parentRun.id}:${state.step.stepId}:parent-result`,
                  type: 'model',
                  status: native.status,
                  title: 'Hive worker result linked',
                  safeSummary: 'A verified Hive child result was linked to its parent.',
                  sourceRefs: [],
                  artifactIds: [],
                  createdAt: native.observedAt,
                  producerSourceEvidence: {
                    schemaVersion: 1,
                    accountId: state.parentRun.accountId,
                    runId: state.parentRun.id,
                    requestId: state.requestId,
                    attemptNumber: 1,
                    producerKind: 'hive',
                    producerIdentity,
                    resultRef,
                    observedAt: native.observedAt,
                    phase: 'result',
                    state: resultState,
                    resultAuthority: {
                      runId: state.childRun.id,
                      eventSeq: childResultEvent.seq,
                      evidenceRef: resultRef,
                    },
                  },
                },
              );
              const parentReadback = await repositories.event.getBySeq(
                state.parentRun.accountId,
                state.parentRun.id,
                parentResultEvent.seq,
              );
              if (!parentReadback || !canonicalValuesMatch(parentReadback, parentResultEvent)) {
                throw new Error('kernel_hive_parent_result_readback_mismatch');
              }
              const parentResultSource = parentReadback.producerSourceEvidence;
              if (
                parentResultSource?.producerKind !== 'hive' ||
                parentResultSource.phase !== 'result' ||
                (parentResultSource.state !== 'completed' &&
                  parentResultSource.state !== 'degraded') ||
                !liveRegistration
              ) {
                throw new Error('kernel_hive_parent_result_source_invalid');
              }
              const completedProof = await liveRegistration.complete({
                evidence: Object.freeze({
                  schemaVersion: 1,
                  producerKind: 'hive',
                  producerIdentity: parentResultSource.producerIdentity,
                  accountId: parentResultSource.accountId,
                  runId: parentResultSource.runId,
                  requestId: parentResultSource.requestId,
                  attemptNumber: parentResultSource.attemptNumber,
                  resultRef: parentResultSource.resultRef,
                  resultEventSeq: parentReadback.seq,
                  state: parentResultSource.state,
                  verifiedAt: parentResultSource.observedAt,
                }),
                state: parentResultSource.state,
              });
              state.binding.assertCurrent();
              if (
                completedProof.accountId !== state.parentRun.accountId ||
                completedProof.runId !== state.parentRun.id ||
                completedProof.resultEventSeq !== parentReadback.seq ||
                completedProof.transition !== parentResultSource.state
              ) {
                throw new Error('kernel_hive_live_evidence_mismatch');
              }
              const result: HiveWorkerResult = Object.freeze({
                workerId: state.step.workerId,
                stepId: state.step.stepId,
                label: state.step.label,
                agentId: state.step.agent.id,
                providerId: native.providerId,
                modelId: native.modelId,
                ...(native.status === 'completed' && native.text !== undefined
                  ? { text: native.text }
                  : {}),
                status: native.status,
                ...(native.inputTokens === undefined ? {} : { inputTokens: native.inputTokens }),
                ...(native.outputTokens === undefined ? {} : { outputTokens: native.outputTokens }),
                ...(native.costUsd === undefined ? {} : { costUsd: native.costUsd }),
                ...(native.errorCategory === undefined
                  ? {}
                  : { errorCategory: native.errorCategory }),
              });
              const outcome = Object.freeze({
                result,
                [jarvisHiveWorkerOutcomeBrand]: true as const,
              });
              const releaseBinding = retainAccountBinding(state.binding);
              const outcomeState: HiveWorkerOutcomeState = {
                binding: state.binding,
                accountId: state.parentRun.accountId,
                parentRunId: state.parentRun.id,
                stepId: state.step.stepId,
                childRunId: state.childRun.id,
                childResultEventSeq: childResultEvent.seq,
                parentResultEventSeq: parentResultEvent.seq,
                resultRef,
                plan: deepFreezeJarvisCopy(state.plan),
                step: deepFreezeJarvisCopy(state.step),
                childRun: deepFreezeJarvisCopy(terminalChildRun),
                childResultEvent: deepFreezeJarvisCopy(childResultEvent),
                parentResultEvent: deepFreezeJarvisCopy(parentReadback),
                result,
                releaseBinding,
                releaseRevocationListener: undefined,
                revoked: false,
                consumed: false,
              };
              hiveWorkerResults.set(
                hiveStepKey(state.parentRun.accountId, state.parentRun.id, state.step.stepId),
                result,
              );
              issuedHiveWorkerOutcomes.add(outcome);
              hiveWorkerOutcomeStates.set(outcome, outcomeState);
              const revokeOutcome = () => {
                outcomeState.revoked = true;
                outcomeState.releaseBinding?.();
                outcomeState.releaseBinding = undefined;
              };
              state.binding.revocationSignal.addEventListener('abort', revokeOutcome, {
                once: true,
              });
              outcomeState.releaseRevocationListener = () =>
                state.binding.revocationSignal.removeEventListener('abort', revokeOutcome);
              if (state.binding.revocationSignal.aborted) revokeOutcome();
              return { kind: 'committed' as const, value: outcome };
            } catch (error) {
              if (state.binding.revocationSignal.aborted) {
                return { kind: 'account_authority_revoked' as const };
              }
              throw error;
            } finally {
              liveRegistration?.dispose();
              disposeHiveWorkerHandleState(handle, state);
            }
          },
          requestCancellation: () => {
            const state = hiveWorkerHandleStates.get(handle);
            if (!state || state.disposed) {
              return Promise.resolve({ kind: 'authority_revoked_before_intent' as const });
            }
            return requestCancellationWithBinding(state.binding, {
              accountId: state.parentRun.accountId,
              runId: state.childRun.id,
            });
          },
          dispose: () => {
            const state = hiveWorkerHandleStates.get(handle);
            if (state) disposeHiveWorkerHandleState(handle, state);
          },
        });
        const handleState: HiveWorkerHandleState = {
          binding,
          parentRun,
          plan,
          step,
          childRun: readback,
          requestId,
          controller,
          releaseAbortOwner: undefined,
          executed: false,
          disposed: false,
        };
        handleState.releaseAbortOwner = input.abortRegistrationAuthority.registerIssuedOwner({
          accountId: parentRun.accountId,
          runId: readback.id,
          registrationId: `${readback.id}:hive-worker`,
          kind: 'child_run',
          parentRunId: parentRun.id,
          abort: () => {
            controller.abort('hive_worker_cancelled');
            return { kind: 'signal_delivered', ownerId: `${readback.id}:hive-worker` };
          },
        });
        issuedHiveWorkerHandles.add(handle);
        hiveWorkerHandleStates.set(handle, handleState);
        return { kind: 'committed' as const, value: handle };
      } catch (error) {
        if (claimKey) claimedHiveSteps.delete(claimKey);
        const revoked = binding.revocationSignal.aborted;
        binding.dispose();
        if (revoked) return { kind: 'account_authority_revoked' as const };
        throw error;
      }
    },
    async runHiveFinalTurn(
      finalInput: Readonly<JarvisHiveFinalTurnBasis> & {
        workers: readonly JarvisHiveWorkerOutcome[];
      },
    ) {
      const { workers, ...basis } = finalInput;
      if (workers.length === 0) throw new Error('kernel_hive_workers_required');
      const accountId = basis.run.accountId;
      const issuedOutcomes: Array<{
        outcome: JarvisHiveWorkerOutcome;
        state: HiveWorkerOutcomeState;
      }> = [];
      let binding: JarvisKernelAccountBinding | undefined;
      for (const outcome of workers) {
        const state = hiveWorkerOutcomeStates.get(outcome);
        if (state?.revoked) return { kind: 'account_authority_revoked' as const };
        if (
          !issuedHiveWorkerOutcomes.has(outcome) ||
          !state ||
          state.consumed ||
          state.accountId !== accountId
        ) {
          throw new Error('kernel_hive_worker_outcome_invalid');
        }
        binding ??= state.binding;
        issuedOutcomes.push({ outcome, state });
      }
      if (!binding) throw new Error('kernel_hive_workers_required');
      let releaseFinalBinding: (() => void) | undefined;
      try {
        releaseFinalBinding = retainAccountBinding(binding);
      } catch {
        return { kind: 'account_authority_revoked' as const };
      }
      try {
        binding.assertCurrent();
        const parent = await repositories.run.getById(accountId, basis.run.id);
        binding.assertCurrent();
        if (
          !parent ||
          !sameImmutableRun(parent, basis.run) ||
          parent.source !== 'hive_final' ||
          parent.status !== 'queued' ||
          !parent.hiveStackPlan
        ) {
          throw new Error('kernel_hive_final_parent_invalid');
        }
        const outcomeStates: Array<{
          outcome: JarvisHiveWorkerOutcome;
          state: HiveWorkerOutcomeState;
        }> = [];
        const contextItems = [...basis.context.items];
        for (const issued of issuedOutcomes) {
          const { outcome, state } = issued;
          if (
            state.revoked ||
            state.consumed ||
            state.accountId !== parent.accountId ||
            state.parentRunId !== parent.id ||
            !canonicalValuesMatch(parent.hiveStackPlan, state.plan) ||
            !canonicalValuesMatch(
              parent.hiveStackPlan.steps.find((step) => step.stepId === state.stepId),
              state.step,
            ) ||
            !canonicalValuesMatch(outcome.result, state.result)
          ) {
            throw new Error('kernel_hive_worker_outcome_invalid');
          }
          state.binding.assertCurrent();
          const childRun = await repositories.run.getById(state.accountId, state.childRunId);
          const childEvent = await repositories.event.getBySeq(
            state.accountId,
            state.childRunId,
            state.childResultEventSeq,
          );
          const parentEvent = await repositories.event.getBySeq(
            state.accountId,
            state.parentRunId,
            state.parentResultEventSeq,
          );
          state.binding.assertCurrent();
          binding.assertCurrent();
          if (
            !childRun ||
            !childEvent ||
            !parentEvent ||
            !canonicalValuesMatch(childRun, state.childRun) ||
            !canonicalValuesMatch(childEvent, state.childResultEvent) ||
            !canonicalValuesMatch(parentEvent, state.parentResultEvent)
          ) {
            throw new Error('kernel_hive_worker_authority_changed');
          }
          const canonicalResult = childEvent.canonicalResultEvidence;
          if (!canonicalResult || canonicalResult.kind !== 'hive_child_provider_result') {
            throw new Error('kernel_hive_worker_authority_changed');
          }
          outcomeStates.push(issued);
          if (outcome.result.status === 'completed' && outcome.result.text !== undefined) {
            contextItems.push({
              source: {
                id: `jsource_${state.resultRef}`,
                kind: 'agent_output',
                label: `${outcome.result.label} / ${outcome.result.agentId}`,
                accountId: state.accountId,
                ...(parent.projectId === undefined ? {} : { projectId: parent.projectId }),
                trust: 'external_untrusted',
                sensitivity: 'private',
                observedAt: canonicalResult.observedAt,
              },
              purpose: 'answer',
              excerpt: outcome.result.text,
              truncated: false,
            });
          }
        }
        for (const { outcome, state } of outcomeStates) {
          consumeHiveWorkerOutcomeState(outcome, state);
        }
        for (const step of parent.hiveStackPlan.steps) {
          hiveWorkerResults.delete(hiveStepKey(parent.accountId, parent.id, step.stepId));
        }
        if (!parent.chatId) throw new Error('kernel_hive_final_chat_missing');
        const usedChars = contextItems.reduce((total, item) => total + item.excerpt.length, 0);
        const turnInput = deepFreezeJarvisCopy({
          ...basis,
          run: parent,
          accountId: parent.accountId,
          ...(parent.workspaceId === undefined ? {} : { workspaceId: parent.workspaceId }),
          ...(parent.projectId === undefined ? {} : { projectId: parent.projectId }),
          chatId: parent.chatId,
          ...(parent.parentRunId === undefined ? {} : { parentRunId: parent.parentRunId }),
          surface: 'hive_final' as const,
          context: {
            items: contextItems,
            budget: {
              maxChars: Math.max(basis.context.budget.maxChars, usedChars),
              usedChars,
            },
            exclusions: basis.context.exclusions,
          },
        }) as Readonly<JarvisKernelTurnInput> & { surface: 'hive_final' };
        const boundArtifactEffectClaims: JarvisArtifactEffectClaimCapability = Object.freeze({
          async claim(claim: Parameters<JarvisArtifactEffectClaimCapability['claim']>[0]) {
            binding.assertCurrent();
            const result = await artifactEffectClaims.claim(claim);
            binding.assertCurrent();
            return result;
          },
        });
        return await runJarvisKernelTurn(turnInput, {
          journal: input.journal,
          issueBoundLifecycle(scope) {
            return issueLifecycle(binding, scope);
          },
          issueBoundArtifactPipeline: artifacts.issueBoundArtifactPipeline,
          artifactEffectClaims: boundArtifactEffectClaims,
          takeProviderArtifactDrafts: input.takeProviderArtifactDrafts,
          responseActions,
          commitActionResponseReady(commitInput) {
            return artifacts.commitKernelTurn.commitActionResponseReady({
              ...commitInput,
              accountBinding: binding,
            });
          },
          commitKernelTurn(commitInput) {
            return artifacts.commitKernelTurn.commitKernelTurn({
              ...commitInput,
              accountBinding: binding,
            });
          },
          prepareProvider: input.prepareProvider,
          processResponse: input.processResponse,
          now: input.now,
        });
      } finally {
        releaseFinalBinding?.();
      }
    },
  });

  return Object.freeze({
    kernel,
    liveEvidenceHost: createPrimaryHostLifecycle(liveEvidence),
  });
}
