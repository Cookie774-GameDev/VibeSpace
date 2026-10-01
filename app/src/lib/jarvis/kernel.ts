import type { LLMMessage } from '@/lib/ai';
import type { Agent, ChatId, Message, MessageId, Part } from '@/types';
import type {
  JarvisAbortKind,
  JarvisAbortRegistration,
  JarvisArtifactDraft,
  JarvisArtifactV1,
  JarvisApprovalV1,
  JarvisAuthorityBoundResult,
  JarvisEvent,
  JarvisExecutionJournal,
  JarvisLiveEvidenceProof,
  JarvisProducerSourceEvidenceV1,
  JarvisRun,
  JarvisRunStatus,
  JarvisRunTransitionEventInput,
} from './contracts/execution';
import { canonicalizeJarvisApprovalJson } from './contracts/execution';
import type { JarvisCapabilitySnapshot, JarvisModelSnapshot } from './contracts/capability';
import type { JarvisContextPack } from './contracts/source';
import type { JarvisRequestEnvelope } from './contracts/request';
import type { JarvisOutputContract, JarvisResponseEnvelope } from './contracts/response';
import type { CompiledJarvisPrompt } from './contracts/prompt';
import type { JarvisIdentitySnapshot } from './identity';
import type { JarvisProfileSnapshot } from './profiles/types';
import {
  createJarvisRequestEnvelope,
  deepFreezeJarvisCopy,
  type JarvisRequestAttempt,
  validateJarvisRequestAttempt,
} from './requestEnvelope';
import { compileJarvisPrompt, JarvisPromptCompilationError } from './promptCompiler';
import type { RawProviderResponse } from './response/pipeline';
import { isProtectedJarvisAgent } from './identity';
import { projectJarvisEnvelopeToMessageParts } from './kernelMessageProjection';
import type {
  CanonicalPluginEvidence,
  CanonicalProviderEvidence,
  JarvisArtifactEffectClaimCapability,
} from './artifactProducerAdapters';
import type { JarvisArtifactKernelComposition } from './artifactRuntime';
import type {
  CreateJarvisApprovalInput,
  JarvisCanonicalActionExecutionResult,
  JarvisKernelActionPort,
} from './approvalEngine';
import { JarvisApprovalError } from './approvalEngine';
import type { JarvisRegisteredActionDefinition } from './actions/catalog';
import { isJarvisAutoApprovableRegistration } from './actions/catalog';
import { createTaskApprovalCallId } from '@/features/jarvis-runs/approvalBridge';
import type {
  ActionResponseReadyCommitInput,
  ActionResponseReadyCommitResult,
  KernelTurnCommitInput,
  KernelTurnCommitResult,
  KernelTurnTerminalStatus,
} from './kernelTurnCommit';

export interface JarvisKernelTurnInput {
  run: Readonly<JarvisRun>;
  attempt: JarvisRequestAttempt;
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  chatId: string;
  parentRunId?: string;
  userMessageId: string;
  agent: Agent;
  surface: JarvisRequestEnvelope['surface'];
  interactionMode: JarvisRequestEnvelope['interactionMode'];
  userText: string;
  messageHistory: readonly LLMMessage[];
  model: JarvisModelSnapshot;
  identity: JarvisIdentitySnapshot;
  profile: JarvisProfileSnapshot;
  capabilities: JarvisCapabilitySnapshot;
  context: JarvisContextPack;
  outputContract: JarvisOutputContract;
  workingDirectory?: string;
}

export interface JarvisKernelTurnResult {
  request: Readonly<JarvisRequestEnvelope>;
  compiled: Readonly<CompiledJarvisPrompt>;
  response: Readonly<JarvisResponseEnvelope>;
  messageParts: readonly Part[];
}

/** @internal Returned only to the closed kernel runtime for voice persistence. */
export interface JarvisDeferredVoiceKernelTurnResult extends JarvisKernelTurnResult {
  assistantMessage: Readonly<Message>;
  artifacts: readonly JarvisArtifactV1[];
  terminalStatus: KernelTurnTerminalStatus;
  providerResultSource: Readonly<JarvisProducerSourceEvidenceV1>;
  completeProviderEvidence(): Promise<JarvisAuthorityBoundResult<JarvisLiveEvidenceProof>>;
  rematerializeForRetry(): Promise<JarvisDeferredVoiceKernelTurnResult>;
  dispose(): void;
}

export type JarvisProviderStartedReceipt = Readonly<{
  providerId: string;
  modelId: string;
  modelSnapshotRef: string;
  operations: readonly ('generate' | 'stream' | 'embed')[];
  startedAt: number;
}>;

export type JarvisStartedProviderDispatch = Readonly<{
  receipt: JarvisProviderStartedReceipt;
  response: Promise<Readonly<RawProviderResponse>>;
  abortAfterStart(reason: 'authority_revoked' | 'evidence_commit_failed'): void;
}>;

export type JarvisResolvedProviderDispatch = Readonly<{
  start(signal: AbortSignal): JarvisStartedProviderDispatch;
  dispose(): void;
}>;

export type JarvisPreparedProviderDispatch = Readonly<{
  resolveConfiguration(): Promise<JarvisResolvedProviderDispatch>;
  dispose(): void;
}>;

export type JarvisKernelPrepareProvider = (input: {
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  interactionMode: JarvisRequestEnvelope['interactionMode'];
  compiledPrompt: Readonly<CompiledJarvisPrompt>;
  agent: Agent;
  model: Readonly<JarvisModelSnapshot>;
  messages: readonly LLMMessage[];
  workingDirectory?: string;
}) => Promise<JarvisPreparedProviderDispatch>;

export type JarvisKernelProcessResponse = (
  raw: Readonly<RawProviderResponse>,
  request: Readonly<JarvisRequestEnvelope>,
) => Promise<Readonly<JarvisResponseEnvelope>>;

type JarvisBoundLiveEvidenceRegistration = Readonly<{
  readonly initialProof: unknown;
  dispose(): void;
}>;

export interface JarvisBoundKernelLifecycle {
  readonly revocationSignal: AbortSignal;
  assertCurrent(): void;
  transition(input: {
    expectedStatus: JarvisRunStatus;
    nextStatus: JarvisRunStatus;
    event: JarvisRunTransitionEventInput;
    completedAt?: number;
  }): Promise<JarvisAuthorityBoundResult<Readonly<{ run: JarvisRun; event: JarvisEvent }>>>;
  recordProviderStarted(
    receipt: JarvisProviderStartedReceipt,
  ): Promise<JarvisAuthorityBoundResult<JarvisBoundLiveEvidenceRegistration>>;
  recordProviderResult(observation: {
    state: 'completed' | 'degraded';
    resultRef: string;
    observedAt: number;
  }): Promise<JarvisAuthorityBoundResult<JarvisLiveEvidenceProof>>;
  registerAbortOwner(
    input: Readonly<{
      registrationId: string;
      kind: JarvisAbortKind;
      abort: JarvisAbortRegistration['abort'];
    }>,
  ): () => void;
}

type BoundKernelTurnCommitInput = Omit<KernelTurnCommitInput, 'accountBinding'>;
type BoundActionResponseReadyCommitInput = Omit<ActionResponseReadyCommitInput, 'accountBinding'>;

/** @internal Closed response-action adapter assembled only by kernelRuntime.ts. */
export type JarvisKernelResponseActionPort = Readonly<{
  resolveRegistration(
    actionId: string,
  ):
    | (Pick<JarvisRegisteredActionDefinition, 'id' | 'version' | 'risk' | 'approval'> &
        Partial<Pick<JarvisRegisteredActionDefinition, 'executor'>>)
    | undefined;
  create: JarvisKernelActionPort['create'];
  executeAutoApprovedSafe(
    input: Readonly<
      CreateJarvisApprovalInput & { context: import('@/lib/actions/types').ActionRunContext }
    >,
  ): Promise<
    JarvisAuthorityBoundResult<
      Readonly<{
        approval: JarvisApprovalV1;
        execution: JarvisCanonicalActionExecutionResult;
        pluginArtifacts?: readonly Readonly<{
          evidence: CanonicalPluginEvidence;
          drafts: readonly JarvisArtifactDraft[];
        }>[];
      }>
    >
  >;
}>;

export type JarvisKernelDeps = Readonly<{
  journal: Pick<JarvisExecutionJournal, 'allocateRun' | 'getRun'>;
  issueBoundLifecycle(
    scope: Readonly<{
      accountId: string;
      runId: string;
      requestId: string;
      attemptNumber: number;
    }>,
  ): JarvisBoundKernelLifecycle;
  issueBoundArtifactPipeline: JarvisArtifactKernelComposition<unknown>['issueBoundArtifactPipeline'];
  artifactEffectClaims: JarvisArtifactEffectClaimCapability;
  takeProviderArtifactDrafts(
    raw: Readonly<RawProviderResponse>,
  ): readonly JarvisArtifactDraft[] | undefined;
  commitKernelTurn(input: BoundKernelTurnCommitInput): Promise<KernelTurnCommitResult>;
  commitActionResponseReady?(
    input: BoundActionResponseReadyCommitInput,
  ): Promise<ActionResponseReadyCommitResult>;
  responseActions?: JarvisKernelResponseActionPort;
  prepareProvider: JarvisKernelPrepareProvider;
  processResponse: JarvisKernelProcessResponse;
  now: () => number;
}>;

type ActionProposalPart = Extract<Part, { kind: 'action_proposal' }>;

function isExactFileActionBatch(actions: readonly ActionProposalPart[]): boolean {
  if (actions.length < 2 || actions.length > 10) return false;
  const actionId = actions[0]?.action_id;
  if (actionId !== 'files.create' && actionId !== 'files.read') return false;
  if (!actions.every((action) => action.action_id === actionId)) return false;
  const paths = actions.map((action) => {
    const path = (action.params as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' ? path : '';
  });
  return paths.every((path) => path.length > 0) && new Set(paths).size === paths.length;
}

function responseActionBatch(parts: readonly Part[]): readonly ActionProposalPart[] {
  const actions = parts.filter(
    (part): part is ActionProposalPart => part.kind === 'action_proposal',
  );
  if (actions.length <= 1) return actions;
  if (isExactFileActionBatch(actions)) return actions;
  throw new Error('kernel_multiple_response_actions_unsupported');
}

function soleResponseAction(parts: readonly Part[]): ActionProposalPart | undefined {
  const actions = responseActionBatch(parts);
  return actions[0];
}

function projectCanonicalResponseAction(input: {
  response: Readonly<JarvisResponseEnvelope>;
  source: ActionProposalPart;
  approvalId: string;
  status: Extract<ActionProposalPart['status'], 'pending' | 'success' | 'error'>;
  error?: string;
}): Readonly<JarvisResponseEnvelope> {
  const parts = input.response.parts.map((part): Part => {
    if (part.kind !== 'action_proposal' || part.call_id !== input.source.call_id) {
      return structuredClone(part);
    }
    return {
      ...structuredClone(part),
      call_id: createTaskApprovalCallId(input.approvalId),
      status: input.status,
      ...(input.status === 'error'
        ? { error: input.error ?? 'The protected action did not complete.' }
        : {}),
    };
  });
  return deepFreezeJarvisCopy({
    ...input.response,
    mode:
      input.status === 'pending'
        ? 'approval_required'
        : input.status === 'success'
          ? 'action_success'
          : 'action_partial',
    parts,
  }) as Readonly<JarvisResponseEnvelope>;
}

function terminalStatus(response: Readonly<JarvisResponseEnvelope>): KernelTurnTerminalStatus {
  const status = response.executionState?.status;
  if (
    status === 'completed' ||
    status === 'partial' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out'
  ) {
    return status;
  }
  return 'completed';
}

function revoked<T>(): JarvisAuthorityBoundResult<T> {
  return { kind: 'account_authority_revoked' };
}

function lifecycleIsCurrent(lifecycle: JarvisBoundKernelLifecycle): boolean {
  try {
    lifecycle.assertCurrent();
    return true;
  } catch (error) {
    if (lifecycle.revocationSignal.aborted) return false;
    throw error;
  }
}

function canonicalValuesMatch(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
  } catch {
    return false;
  }
}

type CleanupResult = Readonly<{ failed: false } | { failed: true; error: unknown }>;

function runAllCleanup(actions: readonly (() => void)[]): CleanupResult {
  let failed = false;
  let firstError: unknown;
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  return failed ? { failed: true, error: firstError } : { failed: false };
}

function snapshotProviderArtifactDrafts(
  drafts: readonly JarvisArtifactDraft[],
): readonly JarvisArtifactDraft[] {
  try {
    const detached = structuredClone(drafts) as JarvisArtifactDraft[];
    for (const draft of detached) {
      for (const sourceRef of draft.artifact.sourceRefs) Object.freeze(sourceRef);
      Object.freeze(draft.artifact.sourceRefs);
      Object.freeze(draft.artifact);
      if (draft.backing.kind === 'local_reference') {
        Object.freeze(draft.backing.localReference);
      }
      Object.freeze(draft.backing);
      Object.freeze(draft);
    }
    return Object.freeze(detached);
  } catch {
    throw new Error('kernel_provider_artifact_sidecar_invalid');
  }
}

function assertPersistedRun(
  expected: Readonly<JarvisKernelTurnInput>,
  actual: Readonly<JarvisRun> | undefined,
  expectedStatus: 'queued' | 'running',
): asserts actual is Readonly<JarvisRun> {
  if (
    !actual ||
    actual.id !== expected.run.id ||
    actual.id !== expected.attempt.runId ||
    actual.accountId !== expected.accountId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.projectId !== expected.projectId ||
    actual.chatId !== expected.chatId ||
    actual.parentRunId !== expected.parentRunId ||
    actual.source !== expected.surface ||
    actual.status !== expectedStatus ||
    expected.run.status !== expectedStatus ||
    actual.agentId !== expected.agent.id ||
    actual.identityVersion !== expected.identity.identityVersion ||
    actual.profileRevisionId !== expected.profile.revisionId ||
    !canonicalValuesMatch(actual.model, expected.model) ||
    !canonicalValuesMatch(actual.model, expected.run.model)
  ) {
    throw new Error('kernel_turn_persisted_run_mismatch');
  }
}

function transitionEvent(
  requestId: string,
  status: 'compiling' | 'running',
  createdAt: number,
): JarvisRunTransitionEventInput {
  return {
    idempotencyKey: `kernel:${requestId}:${status}`,
    title: status === 'compiling' ? 'Compiling protected request' : 'Protected request running',
    safeSummary:
      status === 'compiling'
        ? 'The protected request is being compiled.'
        : 'The protected provider request is running.',
    sourceRefs: [],
    artifactIds: [],
    createdAt,
  };
}

function deliveredCancellationEvent(
  requestId: string,
  createdAt: number,
): JarvisRunTransitionEventInput {
  return {
    idempotencyKey: `kernel:${requestId}:cancelled`,
    title: 'Protected request cancelled',
    safeSummary: 'The protected provider request stopped after cancellation was delivered.',
    sourceRefs: [],
    artifactIds: [],
    createdAt,
  };
}

function providerFailureEvent(requestId: string, createdAt: number): JarvisRunTransitionEventInput {
  return {
    idempotencyKey: `kernel:${requestId}:failed`,
    title: 'Protected request failed',
    safeSummary: 'The protected provider request failed before canonical completion.',
    sourceRefs: [],
    artifactIds: [],
    createdAt,
  };
}

function providerResultSource(input: {
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  receipt: JarvisProviderStartedReceipt;
  resultRef: string;
  observedAt: number;
  state: 'completed' | 'degraded';
}) {
  return {
    schemaVersion: 1 as const,
    accountId: input.accountId,
    runId: input.runId,
    requestId: input.requestId,
    attemptNumber: input.attemptNumber,
    producerKind: 'provider' as const,
    producerIdentity: {
      producerKind: 'provider' as const,
      providerId: input.receipt.providerId,
      modelId: input.receipt.modelId,
      modelSnapshotRef: input.receipt.modelSnapshotRef,
    },
    resultRef: input.resultRef,
    observedAt: input.observedAt,
    phase: 'result' as const,
    state: input.state,
  };
}

const KERNEL_STAGE_ERROR_CODE_RE = /^kernel_[a-z0-9_]{1,120}$/;

function throwBoundedKernelStageError(error: unknown, stageCode: string): never {
  const record =
    typeof error === 'object' && error !== null
      ? (error as Readonly<{ code?: unknown; message?: unknown; name?: unknown }>)
      : undefined;
  if (record?.name === 'AbortError') throw error;
  for (const candidate of [record?.code, record?.message]) {
    if (typeof candidate === 'string' && KERNEL_STAGE_ERROR_CODE_RE.test(candidate)) {
      throw error;
    }
  }
  throw new Error(stageCode);
}

async function runJarvisKernelExecution(
  input: Readonly<JarvisKernelTurnInput>,
  deps: JarvisKernelDeps,
  deferTerminalCommit: boolean,
  lifecycleMode: 'initial' | 'scheduled_running' = 'initial',
): Promise<JarvisAuthorityBoundResult<JarvisDeferredVoiceKernelTurnResult>> {
  if (!isProtectedJarvisAgent(input.agent)) {
    throw new JarvisPromptCompilationError(
      'not_protected_jarvis',
      'The protected JARVIS compiler is unavailable for this agent.',
    );
  }
  if (
    input.run.id !== input.attempt.runId ||
    input.run.accountId !== input.accountId ||
    input.run.chatId !== input.chatId
  ) {
    throw new Error('kernel_turn_scope_mismatch');
  }

  const validatedAttempt = validateJarvisRequestAttempt(input.attempt);
  if (
    validatedAttempt.runId !== input.run.id ||
    validatedAttempt.requestId !== input.attempt.requestId ||
    validatedAttempt.attemptNumber !== input.attempt.attemptNumber
  ) {
    throw new Error('kernel_turn_attempt_mismatch');
  }

  const persisted = await deps.journal.getRun(input.accountId, input.run.id);
  assertPersistedRun(input, persisted, lifecycleMode === 'initial' ? 'queued' : 'running');
  if (lifecycleMode === 'scheduled_running' && input.surface !== 'schedule') {
    throw new Error('kernel_scheduled_turn_scope_mismatch');
  }
  const lifecycle = deps.issueBoundLifecycle({
    accountId: input.accountId,
    runId: input.run.id,
    requestId: input.attempt.requestId,
    attemptNumber: input.attempt.attemptNumber,
  });
  if (!lifecycleIsCurrent(lifecycle)) return revoked();

  if (lifecycleMode === 'initial') {
    const compiling = await lifecycle.transition({
      expectedStatus: 'queued',
      nextStatus: 'compiling',
      event: transitionEvent(input.attempt.requestId, 'compiling', deps.now()),
    });
    if (compiling.kind === 'account_authority_revoked') return revoked();
  }

  const request = await createJarvisRequestEnvelope({
    attempt: input.attempt,
    accountId: input.accountId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    chatId: input.chatId,
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    agent: {
      id: input.agent.id,
      slug: input.agent.slug,
      builtin: input.agent.builtin === true,
    },
    surface: input.surface,
    interactionMode: input.interactionMode,
    identity: input.identity,
    profile: input.profile,
    model: input.model,
    capabilities: input.capabilities,
    context: input.context,
    outputContract: input.outputContract,
    userText: input.userText,
    messageHistory: input.messageHistory,
    createdAt: deps.now(),
  });
  const compiled = compileJarvisPrompt(request);

  if (lifecycleMode === 'initial') {
    const running = await lifecycle.transition({
      expectedStatus: 'compiling',
      nextStatus: 'running',
      event: transitionEvent(input.attempt.requestId, 'running', deps.now()),
    });
    if (running.kind === 'account_authority_revoked') return revoked();
  }

  const controller = new AbortController();
  let resolveCancellationDelivery!: () => void;
  const cancellationDelivery = new Promise<void>((resolve) => {
    resolveCancellationDelivery = resolve;
  });
  const onAuthorityRevoked = () => controller.abort(lifecycle.revocationSignal.reason);
  lifecycle.revocationSignal.addEventListener('abort', onAuthorityRevoked, { once: true });
  if (lifecycle.revocationSignal.aborted) onAuthorityRevoked();
  let unregisterAbort: (() => void) | undefined;
  let prepared: JarvisPreparedProviderDispatch | undefined;
  let resolved: JarvisResolvedProviderDispatch | undefined;
  let started: JarvisStartedProviderDispatch | undefined;
  let registration: JarvisBoundLiveEvidenceRegistration | undefined;
  let terminalCommitted = false;
  let providerFailureTerminalized = false;
  let cancellationDelivered = false;
  let providerEvidenceRetained = false;
  let providerEvidenceDisposed = false;
  let hasPrimaryFailure = false;
  const disposeProviderEvidence = (): void => {
    if (providerEvidenceDisposed) return;
    providerEvidenceDisposed = true;
    registration?.dispose();
  };
  const retainRevokedOutcome =
    (): JarvisAuthorityBoundResult<JarvisDeferredVoiceKernelTurnResult> => {
      hasPrimaryFailure = true;
      return revoked();
    };
  const throwIfCancellationDelivered = (): void => {
    if (!cancellationDelivered) return;
    if (!controller.signal.aborted) {
      throw new Error('kernel_cancellation_delivery_signal_missing');
    }
    throw controller.signal.reason;
  };
  const waitForProviderStage = async <T>(
    start: () => Promise<T>,
    disposeLate?: (value: T) => void,
  ): Promise<T> => {
    throwIfCancellationDelivered();
    let cancellationWon = false;
    const observed = start().then(
      (value) => {
        if (cancellationWon) {
          try {
            disposeLate?.(value);
          } catch {
            // Preserve cancellation after best-effort cleanup of a late stage result.
          }
        }
        return { kind: 'value' as const, value };
      },
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const outcome = await Promise.race([
      observed,
      cancellationDelivery.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (outcome.kind === 'cancelled') {
      cancellationWon = true;
      throwIfCancellationDelivered();
      throw new Error('kernel_cancellation_delivery_missing');
    }
    if (outcome.kind === 'error') throw outcome.error;
    if (cancellationDelivered) {
      try {
        disposeLate?.(outcome.value);
      } catch {
        // Preserve cancellation after best-effort cleanup of the completed stage.
      }
      throwIfCancellationDelivered();
    }
    return outcome.value;
  };

  try {
    unregisterAbort = lifecycle.registerAbortOwner({
      registrationId: `${input.run.id}:provider`,
      kind: 'provider_stream',
      abort: () => {
        cancellationDelivered = true;
        controller.abort();
        resolveCancellationDelivery();
        return { kind: 'signal_delivered', ownerId: `${input.run.id}:provider` };
      },
    });
    prepared = await waitForProviderStage(
      () =>
        deps.prepareProvider({
          accountId: input.accountId,
          runId: input.run.id,
          requestId: input.attempt.requestId,
          attemptNumber: input.attempt.attemptNumber,
          interactionMode: input.interactionMode,
          compiledPrompt: compiled,
          agent: input.agent,
          model: input.model,
          messages: input.messageHistory,
          ...(input.workingDirectory === undefined
            ? {}
            : { workingDirectory: input.workingDirectory }),
        }),
      (latePrepared) => latePrepared.dispose(),
    );
    resolved = await waitForProviderStage(
      () => prepared!.resolveConfiguration(),
      (lateResolved) => lateResolved.dispose(),
    );
    if (!lifecycleIsCurrent(lifecycle)) return retainRevokedOutcome();
    throwIfCancellationDelivered();
    if (controller.signal.aborted) return retainRevokedOutcome();
    started = resolved.start(controller.signal);

    const startedResult = await waitForProviderStage(
      () => lifecycle.recordProviderStarted(started!.receipt),
      (lateResult) => {
        if (lateResult.kind === 'committed') lateResult.value.dispose();
      },
    );
    if (startedResult.kind === 'account_authority_revoked') {
      started.abortAfterStart('authority_revoked');
      return retainRevokedOutcome();
    }
    registration = startedResult.value;
    throwIfCancellationDelivered();

    const raw = await waitForProviderStage(() => started!.response);
    const processedResponse = await waitForProviderStage(() => deps.processResponse(raw, request));
    let status = terminalStatus(processedResponse);
    const providerResultState = status === 'completed' ? 'completed' : 'degraded';
    let resultState: 'completed' | 'degraded' = providerResultState;
    const resultRef = `jresult_${input.attempt.requestId}`;
    const observedAt = processedResponse.completedAt;
    if (
      processedResponse.requestId !== request.requestId ||
      processedResponse.runId !== request.runId ||
      processedResponse.artifactIds.length !== 0 ||
      raw.completedAt !== processedResponse.completedAt ||
      raw.provider.providerId !== started.receipt.providerId ||
      raw.provider.modelId !== started.receipt.modelId ||
      !canonicalValuesMatch(raw.provider, processedResponse.provider) ||
      !canonicalValuesMatch(raw.provider, input.model)
    ) {
      throw new Error('kernel_provider_response_scope_mismatch');
    }
    const sidecarDrafts = deps.takeProviderArtifactDrafts(raw);
    if (!sidecarDrafts || !Array.isArray(sidecarDrafts)) {
      throw new Error('kernel_provider_artifact_sidecar_missing');
    }
    const drafts = snapshotProviderArtifactDrafts(sidecarDrafts);
    const providerArtifactEvidence: CanonicalProviderEvidence = Object.freeze({
      producerId: 'provider_response',
      accountId: input.accountId,
      runId: input.run.id,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      resultRef,
      state: providerResultState === 'completed' ? 'completed' : 'partial',
      verifiedAt: observedAt,
      providerId: started.receipt.providerId,
      modelId: started.receipt.modelId,
      modelSnapshotRef: started.receipt.modelSnapshotRef,
    });
    const materializeProviderArtifacts = async (): Promise<readonly JarvisArtifactV1[]> => {
      const materialized: JarvisArtifactV1[] = [];
      if (drafts.length === 0) return Object.freeze(materialized);
      const pipeline = deps.issueBoundArtifactPipeline(deps.artifactEffectClaims);
      for (const draft of drafts) {
        const artifact = await pipeline.provider.materialize({
          evidence: providerArtifactEvidence,
          draft,
        });
        if (
          artifact.runId !== input.run.id ||
          artifact.requestId !== input.attempt.requestId ||
          artifact.attemptNumber !== input.attempt.attemptNumber ||
          materialized.some((candidate) => candidate.id === artifact.id)
        ) {
          throw new Error('kernel_provider_artifact_scope_mismatch');
        }
        materialized.push(artifact);
      }
      return Object.freeze(materialized);
    };
    let artifacts = await waitForProviderStage(materializeProviderArtifacts);
    let projectedResponse = processedResponse;
    let pendingApprovalId: string | undefined;
    const responseActionList = responseActionBatch(processedResponse.parts);
    const responseAction = responseActionList[0];
    if (responseAction) {
      const responseActions = deps.responseActions;
      if (!responseActions) throw new Error('kernel_response_action_port_unavailable');
      const registration = responseActions.resolveRegistration(responseAction.action_id);
      if (!registration || registration.id !== responseAction.action_id) {
        throw new Error('kernel_response_action_unavailable');
      }
      const actionInput: CreateJarvisApprovalInput = {
        parentRun: input.run,
        attempt: input.attempt,
        actionId: registration.id,
        actionVersion: registration.version,
        params: structuredClone(responseAction.params),
        expiresAt: Math.max(deps.now(), processedResponse.completedAt) + 10 * 60_000,
      };
      const actionContext = {
        source: 'ai' as const,
        chatId: input.chatId,
        messageId: `msg_${input.attempt.requestId}`,
        callId: responseAction.call_id,
        accountId: input.accountId,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        attemptNumber: input.attempt.attemptNumber,
      };

      if (isJarvisAutoApprovableRegistration(registration)) {
        let executed: Awaited<
          ReturnType<JarvisKernelResponseActionPort['executeAutoApprovedSafe']>
        >;
        try {
          executed = await responseActions.executeAutoApprovedSafe({
            ...actionInput,
            context: actionContext,
          });
        } catch (error) {
          if (error instanceof JarvisApprovalError) {
            throw new Error(`kernel_safe_action_approval_${error.code}`);
          }
          throwBoundedKernelStageError(error, 'kernel_safe_action_execution_failed');
        }
        if (executed.kind === 'account_authority_revoked') return retainRevokedOutcome();
        const { approval, execution, pluginArtifacts } = executed.value;
        if (
          approval.runId !== input.run.id ||
          approval.requestId !== input.attempt.requestId ||
          approval.attemptNumber !== input.attempt.attemptNumber ||
          approval.actionId !== registration.id ||
          approval.actionVersion !== registration.version ||
          approval.status !== 'consumed' ||
          execution.kind !== 'settled'
        ) {
          throw new Error('kernel_safe_action_result_scope_mismatch');
        }
        const succeeded = execution.result.ok;
        if (succeeded && registration.executor?.kind === 'plugin_tool') {
          if (!pluginArtifacts || pluginArtifacts.length === 0) {
            throw new Error('kernel_plugin_result_artifact_missing');
          }
          const pipeline = deps.issueBoundArtifactPipeline(deps.artifactEffectClaims);
          const materialized = [...artifacts];
          for (const bundle of pluginArtifacts) {
            if (
              bundle.evidence.accountId !== input.accountId ||
              bundle.evidence.runId !== input.run.id ||
              bundle.evidence.requestId !== input.attempt.requestId ||
              bundle.evidence.attemptNumber !== input.attempt.attemptNumber ||
              bundle.evidence.pluginId !== registration.executor.pluginId ||
              bundle.evidence.invocationId !== `approval:${approval.id}` ||
              bundle.evidence.state !== 'succeeded' ||
              bundle.drafts.length === 0
            ) {
              throw new Error('kernel_plugin_artifact_scope_mismatch');
            }
            for (const draft of bundle.drafts) {
              const artifact = await pipeline.plugin.materialize({
                evidence: bundle.evidence,
                draft,
              });
              if (
                artifact.runId !== input.run.id ||
                artifact.requestId !== input.attempt.requestId ||
                artifact.attemptNumber !== input.attempt.attemptNumber ||
                materialized.some((candidate) => candidate.id === artifact.id)
              ) {
                throw new Error('kernel_plugin_artifact_scope_mismatch');
              }
              materialized.push(artifact);
            }
          }
          artifacts = Object.freeze(materialized);
        } else if (pluginArtifacts !== undefined) {
          throw new Error('kernel_plugin_artifact_scope_mismatch');
        }
        if (!succeeded) {
          status = 'partial';
          resultState = 'degraded';
        }
        projectedResponse = projectCanonicalResponseAction({
          response: processedResponse,
          source: responseAction,
          approvalId: approval.id,
          status: succeeded ? 'success' : 'error',
          ...(succeeded ? {} : { error: 'The protected action did not complete.' }),
        });
      } else {
        if (deferTerminalCommit) {
          throw new Error('kernel_deferred_action_approval_unsupported');
        }
        let nextResponse = processedResponse;
        for (const batchAction of responseActionList) {
          if (batchAction.action_id !== registration.id) {
            throw new Error('kernel_response_action_unavailable');
          }
          const created = await responseActions.create({
            ...actionInput,
            params: structuredClone(batchAction.params),
          });
          if (created.kind === 'account_authority_revoked') return retainRevokedOutcome();
          const approval = created.value;
          if (
            approval.runId !== input.run.id ||
            approval.requestId !== input.attempt.requestId ||
            approval.attemptNumber !== input.attempt.attemptNumber ||
            approval.actionId !== registration.id ||
            approval.actionVersion !== registration.version ||
            approval.status !== 'pending'
          ) {
            throw new Error('kernel_pending_action_scope_mismatch');
          }
          pendingApprovalId = approval.id;
          nextResponse = projectCanonicalResponseAction({
            response: nextResponse,
            source: batchAction,
            approvalId: approval.id,
            status: 'pending',
          });
        }
        projectedResponse = nextResponse;
      }
    }
    const response = deepFreezeJarvisCopy({
      ...projectedResponse,
      artifactIds: artifacts.map((artifact) => artifact.id),
    }) as Readonly<JarvisResponseEnvelope>;
    const messageParts = projectJarvisEnvelopeToMessageParts({ response, artifacts });
    const expectedProviderResultSource = providerResultSource({
      accountId: input.accountId,
      runId: input.run.id,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      receipt: started.receipt,
      resultRef,
      observedAt,
      state: providerResultState,
    });
    const assistantMessage: Message = {
      id: `msg_${input.attempt.requestId}` as MessageId,
      chat_id: input.chatId as ChatId,
      role: 'assistant',
      agent_id: input.agent.id,
      parts: [...messageParts],
      created_at: response.completedAt,
      updated_at: response.completedAt,
    };
    let providerEvidenceCompletion:
      | Promise<JarvisAuthorityBoundResult<JarvisLiveEvidenceProof>>
      | undefined;
    const completeProviderEvidence = () => {
      if (providerEvidenceDisposed) {
        throw new Error('kernel_voice_provider_evidence_disposed');
      }
      providerEvidenceCompletion ??= lifecycle.recordProviderResult({
        state: providerResultState,
        resultRef,
        observedAt,
      });
      return providerEvidenceCompletion;
    };
    const buildDeferredVoiceResult = (
      materializedArtifacts: readonly JarvisArtifactV1[],
    ): JarvisDeferredVoiceKernelTurnResult => {
      const materializedResponse = deepFreezeJarvisCopy({
        ...projectedResponse,
        artifactIds: materializedArtifacts.map((artifact) => artifact.id),
      }) as Readonly<JarvisResponseEnvelope>;
      const materializedMessageParts = projectJarvisEnvelopeToMessageParts({
        response: materializedResponse,
        artifacts: materializedArtifacts,
      });
      const materializedAssistantMessage: Message = {
        id: `msg_${input.attempt.requestId}` as MessageId,
        chat_id: input.chatId as ChatId,
        role: 'assistant',
        agent_id: input.agent.id,
        parts: [...materializedMessageParts],
        created_at: materializedResponse.completedAt,
        updated_at: materializedResponse.completedAt,
      };
      return Object.freeze({
        request,
        compiled,
        response: materializedResponse,
        messageParts: materializedMessageParts,
        assistantMessage: deepFreezeJarvisCopy(materializedAssistantMessage) as Readonly<Message>,
        artifacts: Object.freeze([...materializedArtifacts]),
        terminalStatus: status,
        providerResultSource: deepFreezeJarvisCopy(
          expectedProviderResultSource,
        ) as Readonly<JarvisProducerSourceEvidenceV1>,
        completeProviderEvidence,
        async rematerializeForRetry() {
          if (providerEvidenceDisposed || !deferTerminalCommit) {
            throw new Error('kernel_voice_rematerialization_unavailable');
          }
          return buildDeferredVoiceResult(await materializeProviderArtifacts());
        },
        dispose: disposeProviderEvidence,
      });
    };

    if (pendingApprovalId) {
      const commitActionResponseReady = deps.commitActionResponseReady;
      if (!commitActionResponseReady) {
        throw new Error('kernel_action_response_commit_unavailable');
      }
      throwIfCancellationDelivered();
      const commit = await commitActionResponseReady({
        accountId: input.accountId,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        attemptNumber: input.attempt.attemptNumber,
        approvalId: pendingApprovalId,
        assistantMessage,
        artifacts,
        providerResultSource: expectedProviderResultSource,
        createdAt: response.completedAt,
      });
      if (!commit.committed) {
        if (commit.reason === 'account_authority_revoked') return retainRevokedOutcome();
        throw new Error(`kernel_action_response_commit_${commit.reason}`);
      }
      if (
        commit.run.status !== 'awaiting_approval' ||
        !canonicalValuesMatch(commit.event.producerSourceEvidence, expectedProviderResultSource)
      ) {
        throw new Error('kernel_action_response_commit_source_mismatch');
      }
      terminalCommitted = true;
      const providerResult = await completeProviderEvidence();
      if (providerResult.kind === 'account_authority_revoked') return retainRevokedOutcome();
      return {
        kind: 'committed',
        value: buildDeferredVoiceResult(artifacts),
      };
    }

    if (!deferTerminalCommit) {
      throwIfCancellationDelivered();
      const commit = await deps.commitKernelTurn({
        accountId: input.accountId,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        attemptNumber: input.attempt.attemptNumber,
        expectedStatus: 'running',
        terminal: {
          status,
          event: {
            idempotencyKey: `kernel-terminal:${input.attempt.requestId}:${input.attempt.attemptNumber}`,
            title: status === 'completed' ? 'Kernel turn completed' : 'Kernel turn ended',
            safeSummary:
              status === 'completed'
                ? 'The protected turn completed.'
                : 'The protected turn ended with verified degraded state.',
            sourceRefs: [...response.sourceRefs],
            artifactIds: [...response.artifactIds],
            createdAt: response.completedAt,
            producerSourceEvidence: expectedProviderResultSource,
            canonicalResultEvidence: {
              schemaVersion: 1,
              kind: 'kernel_turn_committed',
              accountId: input.accountId,
              runId: input.run.id,
              requestId: input.attempt.requestId,
              attemptNumber: input.attempt.attemptNumber,
              state: resultState,
              resultRef: resultRef as `jresult_${string}`,
              observedAt,
            },
          },
        },
        assistantMessage,
        artifacts,
        ...(input.surface === 'schedule' || input.attempt.kind === 'transport_retry'
          ? {
              transportAttemptCompletion: {
                requestId: input.attempt.requestId,
                attemptNumber: input.attempt.attemptNumber,
              },
            }
          : {}),
      });
      if (!commit.committed) {
        if (commit.reason === 'account_authority_revoked') return retainRevokedOutcome();
        throw new Error(`kernel_turn_commit_${commit.reason}`);
      }
      if (
        !canonicalValuesMatch(commit.event.producerSourceEvidence, expectedProviderResultSource)
      ) {
        throw new Error('kernel_turn_commit_source_mismatch');
      }
      terminalCommitted = true;

      const providerResult = await completeProviderEvidence();
      if (providerResult.kind === 'account_authority_revoked') return retainRevokedOutcome();
    } else {
      providerEvidenceRetained = true;
    }

    return {
      kind: 'committed',
      value: buildDeferredVoiceResult(artifacts),
    };
  } catch (error) {
    if (lifecycle.revocationSignal.aborted) {
      hasPrimaryFailure = true;
      if (started && !terminalCommitted) {
        try {
          started.abortAfterStart('authority_revoked');
        } catch {
          // The revoked authority result remains authoritative during cleanup.
        }
      }
      return revoked();
    }
    hasPrimaryFailure = true;
    if (cancellationDelivered && controller.signal.aborted && !terminalCommitted) {
      const completedAt = deps.now();
      const cancelled = await lifecycle.transition({
        expectedStatus: 'running',
        nextStatus: 'cancelled',
        event: deliveredCancellationEvent(input.attempt.requestId, completedAt),
        completedAt,
      });
      if (cancelled.kind === 'account_authority_revoked') return revoked();
      terminalCommitted = true;
      throw error;
    }
    if (lifecycleMode === 'initial' && !terminalCommitted) {
      const completedAt = deps.now();
      const failed = await lifecycle.transition({
        expectedStatus: 'running',
        nextStatus: 'failed',
        event: providerFailureEvent(input.attempt.requestId, completedAt),
        completedAt,
      });
      if (failed.kind === 'account_authority_revoked') {
        if (started) {
          void started.response.catch(() => undefined);
          try {
            started.abortAfterStart('authority_revoked');
          } catch {
            // The revoked authority result remains authoritative during cleanup.
          }
        }
        return revoked();
      }
      terminalCommitted = true;
      providerFailureTerminalized = true;
    }
    if (started && (!terminalCommitted || providerFailureTerminalized)) {
      void started.response.catch(() => undefined);
      try {
        controller.abort('kernel_provider_evidence_failed');
        started.abortAfterStart('evidence_commit_failed');
      } catch {
        // Preserve the dispatcher failure that triggered provider cleanup.
      }
    }
    throw error;
  } finally {
    const cleanup = runAllCleanup([
      () => {
        if (!providerEvidenceRetained) disposeProviderEvidence();
      },
      () => unregisterAbort?.(),
      () => resolved?.dispose(),
      () => prepared?.dispose(),
      () => lifecycle.revocationSignal.removeEventListener('abort', onAuthorityRevoked),
    ]);
    if (cleanup.failed && !hasPrimaryFailure) throw cleanup.error;
  }
}

export async function runJarvisKernelTurn(
  input: Readonly<JarvisKernelTurnInput>,
  deps: JarvisKernelDeps,
): Promise<JarvisAuthorityBoundResult<JarvisKernelTurnResult>> {
  const result = await runJarvisKernelExecution(input, deps, false);
  if (result.kind === 'account_authority_revoked') return result;
  const { request, compiled, response, messageParts } = result.value;
  return {
    kind: 'committed',
    value: Object.freeze({ request, compiled, response, messageParts }),
  };
}

/** @internal Imported only by the closed scheduled kernel runtime. */
export async function runJarvisKernelScheduledTurn(
  input: Readonly<JarvisKernelTurnInput> & { surface: 'schedule' },
  deps: JarvisKernelDeps,
): Promise<JarvisAuthorityBoundResult<JarvisKernelTurnResult>> {
  if (input.run.source !== 'schedule' || input.run.status !== 'running') {
    throw new Error('kernel_scheduled_turn_scope_mismatch');
  }
  const result = await runJarvisKernelExecution(input, deps, false, 'scheduled_running');
  if (result.kind === 'account_authority_revoked') return result;
  const { request, compiled, response, messageParts } = result.value;
  return {
    kind: 'committed',
    value: Object.freeze({ request, compiled, response, messageParts }),
  };
}

/** @internal Imported in production only by the closed kernel runtime. */
export async function runJarvisKernelVoiceTurn(
  input: Readonly<JarvisKernelTurnInput> & { surface: 'voice' },
  deps: JarvisKernelDeps,
): Promise<JarvisAuthorityBoundResult<JarvisDeferredVoiceKernelTurnResult>> {
  if (input.surface !== 'voice' || input.run.source !== 'voice') {
    throw new Error('kernel_voice_turn_scope_mismatch');
  }
  return runJarvisKernelExecution(input, deps, true);
}
