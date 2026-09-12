import type {
  ActionResult,
  ActionRunContext,
  RegisteredActionExecutionContext,
} from '@/lib/actions/types';
import type {
  JarvisApprovalRepository,
  JarvisArtifactRepository,
  JarvisEventRepository,
  JarvisRunRepository,
} from '@/lib/db/jarvisRepositories';
import type { JarvisProviderAttemptEvidenceAuthority } from '@/lib/ai/providerAttemptEvidence';
import type { JarvisEntitlementSnapshotProvider } from '@/lib/admin';
import type {
  JarvisApprovalV1,
  JarvisAuthorityBoundResult,
  JarvisCancellationRequestResult,
  JarvisCanonicalLiveProducerEvidence,
  JarvisCapabilitySnapshot,
  JarvisConsequentialEffectSafetyAuthority,
  JarvisEntitlementSnapshot,
  JarvisEvent,
  JarvisLiveProducerIdentity,
  JarvisPreEffectTransportFailureEvidence,
  JarvisRecoveryApprovalVerifier,
  JarvisRun,
  JarvisTransportAttemptV1,
  JarvisZeroConsequentialEffectEvidenceV1,
} from '@/lib/jarvis/contracts';
import type {
  JarvisCanonicalLiveProducerVerifier,
  JarvisProducerSourceEvidenceV1,
} from '@/lib/jarvis/contracts/execution';
import {
  canonicalizeJarvisApprovalJson,
  validateJarvisCanonicalResultEvidence,
  validateJarvisDurableLiveEvidence,
  validateJarvisProducerSourceEvidence,
  validateJarvisZeroConsequentialEffectEvidence,
} from '@/lib/jarvis/contracts';
import type { JarvisLiveEvidenceProof } from '@/lib/jarvis/contracts/execution';
import type { JarvisCapabilitySnapshotProvider } from '@/lib/jarvis/capabilitySnapshot';
import type {
  JarvisActionCatalog,
  JarvisCanonicalActionTarget,
  JarvisRegisteredActionDefinition,
} from '@/lib/jarvis/actions/catalog';
import {
  validateJarvisRequestAttempt,
  type JarvisRequestAttempt,
} from '@/lib/jarvis/requestEnvelope';
import type { JarvisSecretHandlePort } from '@/lib/jarvis/secretHandlePort';

export interface JarvisApprovalBindingSelectors {
  loadCapabilitySnapshot(accountId: string): Promise<Readonly<JarvisCapabilitySnapshot>>;
  loadEntitlementSnapshot(accountId: string): Promise<Readonly<JarvisEntitlementSnapshot>>;
  deriveTargetSnapshot(input: {
    accountId: string;
    actionId: string;
    actionVersion: number;
    params: Readonly<Record<string, unknown>>;
  }): Promise<JarvisCanonicalActionTarget>;
}

export function createJarvisApprovalBindingSelectors(input: {
  catalog: JarvisActionCatalog;
  capabilitySnapshots: JarvisCapabilitySnapshotProvider;
  entitlementSnapshots: JarvisEntitlementSnapshotProvider;
}): JarvisApprovalBindingSelectors {
  return Object.freeze({
    async loadCapabilitySnapshot(accountId: string) {
      return structuredClone(await input.capabilitySnapshots.getForAccount(accountId));
    },
    async loadEntitlementSnapshot(accountId: string) {
      return structuredClone(await input.entitlementSnapshots.getForAccount(accountId));
    },
    async deriveTargetSnapshot(targetInput: {
      accountId: string;
      actionId: string;
      actionVersion: number;
      params: Readonly<Record<string, unknown>>;
    }) {
      const registration = input.catalog.resolve(targetInput.actionId);
      if (!registration) approvalError('action_unavailable');
      if (registration.version !== targetInput.actionVersion) {
        approvalError('action_version_changed');
      }

      // Both account-scoped providers must still recognize the same account at
      // the target-derivation boundary. Their returned values are intentionally
      // discarded here; the engine hashes fresh detached copies separately.
      await Promise.all([
        input.capabilitySnapshots.getForAccount(targetInput.accountId),
        input.entitlementSnapshots.getForAccount(targetInput.accountId),
      ]);
      return structuredClone(
        registration.deriveTarget({
          accountId: targetInput.accountId,
          params: structuredClone(targetInput.params),
        }),
      );
    },
  });
}

export type JarvisCanonicalActionExecutionResult =
  | { kind: 'settled'; result: ActionResult }
  | {
      kind: 'handoff_pending';
      executorKind: 'terminal';
      ownerId: string;
      result: Extract<ActionResult, { ok: true }>;
    };

export type JarvisApprovalErrorCode =
  | 'run_scope_mismatch'
  | 'action_unavailable'
  | 'action_version_changed'
  | 'invalid_parameters'
  | 'secret_value_rejected'
  | 'params_changed'
  | 'target_changed'
  | 'risk_changed'
  | 'capability_changed'
  | 'entitlement_changed'
  | 'expired'
  | 'not_pending'
  | 'not_approved'
  | 'already_consumed'
  | 'secret_handle_invalid'
  | 'secret_handle_scope_mismatch'
  | 'secret_handle_duplicate_field'
  | 'credential_account_unbound'
  | 'credential_account_mismatch'
  | 'credential_grant_stale'
  | 'credential_grant_unavailable'
  | 'credential_grant_storage_conflict'
  | 'credential_grant_storage_failed'
  | 'caller_secret_resolver_rejected';

export class JarvisApprovalError extends Error {
  readonly code: JarvisApprovalErrorCode;

  constructor(code: JarvisApprovalErrorCode) {
    super(`JARVIS approval rejected: ${code}.`);
    this.name = 'JarvisApprovalError';
    this.code = code;
  }
}

class JarvisApprovalAuthorityRevokedError extends Error {
  readonly code = 'account_authority_revoked' as const;

  constructor() {
    super('JARVIS approval account authority was revoked.');
    this.name = 'JarvisApprovalAuthorityRevokedError';
  }
}

function approvalError(code: JarvisApprovalErrorCode): never {
  throw new JarvisApprovalError(code);
}

export type CreateJarvisApprovalInput = {
  parentRun: JarvisRun;
  attempt: JarvisRequestAttempt;
  actionId: string;
  actionVersion: number;
  params: Record<string, unknown>;
  expiresAt: number;
};

type CreateJarvisApprovalEngineInput = CreateJarvisApprovalInput & {
  secretHandleRefs: readonly { field: string; handleId: string }[];
};

type PreparedJarvisApprovalInput = CreateJarvisApprovalEngineInput & {
  approvalId: `jappr_${string}`;
  paramsHash: string;
  targetSnapshot: JarvisCanonicalActionTarget;
  risk: JarvisApprovalV1['risk'];
  capabilityId: string;
  capabilitySnapshotHash: string;
  expectedEffect: string;
  createdAt: number;
};

export type ExecuteJarvisApprovalInput = {
  parentRun: JarvisRun;
  approvalId: string;
  context: ActionRunContext;
};

export interface JarvisApprovalActionCapability {
  create(input: CreateJarvisApprovalInput): Promise<JarvisApprovalV1>;
  decide(input: {
    parentRun: JarvisRun;
    approvalId: string;
    decision: 'approve' | 'deny';
  }): Promise<JarvisApprovalV1>;
  execute(input: ExecuteJarvisApprovalInput): Promise<JarvisCanonicalActionExecutionResult>;
  executeAutoApprovedSafe(
    input: CreateJarvisApprovalInput & { context: ActionRunContext },
  ): Promise<JarvisCanonicalActionExecutionResult>;
}

/** Narrow feature-facing contract. Task 16B supplies the sole production implementation. */
export interface JarvisKernelActionPort {
  create(
    input: Readonly<CreateJarvisApprovalInput>,
  ): Promise<JarvisAuthorityBoundResult<JarvisApprovalV1>>;
  decide(input: {
    parentRun: JarvisRun;
    approvalId: string;
    decision: 'approve' | 'deny';
  }): Promise<JarvisAuthorityBoundResult<JarvisApprovalV1>>;
  execute(
    input: Readonly<ExecuteJarvisApprovalInput>,
  ): Promise<JarvisAuthorityBoundResult<JarvisCanonicalActionExecutionResult>>;
  executeAutoApprovedSafe(
    input: Readonly<CreateJarvisApprovalInput & { context: ActionRunContext }>,
  ): Promise<JarvisAuthorityBoundResult<JarvisCanonicalActionExecutionResult>>;
}

export const jarvisIssuedApprovalLifecycleBrand: unique symbol = Symbol(
  'jarvis.approval-issued-lifecycle',
);

export interface JarvisIssuedApprovalLifecycle {
  readonly accountId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly attemptNumber: number;
  /** Aborted synchronously by dispose(), including for frozen lifecycle objects. */
  readonly revocationSignal: AbortSignal;
  readonly [jarvisIssuedApprovalLifecycleBrand]: true;
  putPreparedApproval(
    input: CreateJarvisApprovalEngineInput,
  ): Promise<JarvisAuthorityBoundResult<JarvisApprovalV1>>;
  decidePreparedApproval(input: {
    approvalId: string;
    decision: 'approve' | 'deny';
  }): Promise<JarvisAuthorityBoundResult<JarvisApprovalV1>>;
  claimApprovedExecution(input: {
    approvalId: string;
    producerKind: 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp';
    ownerId: string;
    evidenceRef: string;
    startedAt: number;
  }): Promise<JarvisAuthorityBoundResult<JarvisIssuedActionExecution>>;
  claimAutoApprovedExecution(input: {
    approval: CreateJarvisApprovalEngineInput;
    producerKind: 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp';
    ownerId: string;
    evidenceRef: string;
    startedAt: number;
  }): Promise<JarvisAuthorityBoundResult<JarvisIssuedActionExecution>>;
  dispose(): void;
}

export const jarvisIssuedActionExecutionBrand: unique symbol = Symbol(
  'jarvis.approval-issued-execution',
);
export const jarvisTerminalHandoffReceiptBrand: unique symbol = Symbol(
  'jarvis.approval-terminal-handoff-receipt',
);

export interface JarvisTerminalHandoffReceipt {
  readonly executionId: string;
  readonly ownerId: string;
  readonly [jarvisTerminalHandoffReceiptBrand]: true;
}

export interface JarvisTerminalOwnedExecution {
  recordResult(input: {
    state: 'completed' | 'degraded';
    resultRef: string;
    completedAt: number;
  }): Promise<JarvisAuthorityBoundResult<JarvisLiveEvidenceProof>>;
  recordCancellationVerified(input: {
    cancellationRequestId: string;
    resultRef: string;
    verifiedAt: number;
  }): Promise<JarvisAuthorityBoundResult<Readonly<{ run: JarvisRun; event: JarvisEvent }>>>;
  requestCancellation(): Promise<JarvisCancellationRequestResult>;
  dispose(): void;
}

export interface JarvisTerminalExecutionAcceptor {
  acceptIssuedExecution(input: {
    executionId: string;
    ownerId: string;
    execution: JarvisTerminalOwnedExecution;
  }): JarvisTerminalHandoffReceipt;
}

export type JarvisStartedExternalEffect<T> = Readonly<{ completion: Promise<T> }>;

export interface JarvisIssuedActionExecution {
  readonly approval: JarvisApprovalV1;
  readonly producerKind: 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp';
  readonly ownerId: string;
  readonly startEvent: JarvisEvent;
  readonly initialLiveProof: JarvisLiveEvidenceProof;
  readonly [jarvisIssuedActionExecutionBrand]: true;
  beginExternalEffect<T>(
    begin: (signal: AbortSignal) => JarvisStartedExternalEffect<T>,
  ): JarvisAuthorityBoundResult<JarvisStartedExternalEffect<T>>;
  transferTerminalOwnership(input: {
    executionId: string;
    acceptor: JarvisTerminalExecutionAcceptor;
  }): JarvisAuthorityBoundResult<JarvisTerminalHandoffReceipt>;
  recordResult(input: {
    state: 'completed' | 'degraded';
    resultRef: string;
    completedAt: number;
    /** Only a narrowly validated result may be projected into the response message. */
    responseResult?: ActionResult;
  }): Promise<JarvisAuthorityBoundResult<JarvisLiveEvidenceProof>>;
  recordCancellationVerified(input: {
    cancellationRequestId: string;
    resultRef: string;
    verifiedAt: number;
  }): Promise<
    JarvisAuthorityBoundResult<
      Readonly<{ run: JarvisRun; event: JarvisEvent; proof: JarvisLiveEvidenceProof }>
    >
  >;
  requestCancellation(): Promise<JarvisCancellationRequestResult>;
  dispose(): void;
}

export type JarvisApprovalActionBinder = (
  lifecycle: JarvisIssuedApprovalLifecycle,
) => JarvisApprovalActionCapability;

export type JarvisRegisteredActionDispatchOutcome =
  | { kind: 'executor_returned'; result: ActionResult }
  | {
      kind: 'terminal_handoff_accepted';
      executorKind: 'terminal';
      result: Extract<ActionResult, { ok: true }>;
      ownerId: string;
      receipt: JarvisTerminalHandoffReceipt;
    };

export interface JarvisApprovalEngine {
  readonly recoveryVerifier: JarvisRecoveryApprovalVerifier;
  bindIssuedLifecycle(lifecycle: JarvisIssuedApprovalLifecycle): JarvisApprovalActionCapability;
}

export type JarvisApprovalEngineDependencies = Readonly<{
  runs: Pick<JarvisRunRepository, 'getById'>;
  approvals: Pick<JarvisApprovalRepository, 'getById' | 'listByRun'>;
  catalog: JarvisActionCatalog;
  bindingSelectors: JarvisApprovalBindingSelectors;
  secretHandles: JarvisSecretHandlePort;
  executeRegisteredAction(input: {
    registration: Readonly<JarvisRegisteredActionDefinition>;
    params: Readonly<Record<string, unknown>>;
    context: RegisteredActionExecutionContext;
    execution: JarvisIssuedActionExecution;
  }): Promise<JarvisRegisteredActionDispatchOutcome>;
  newApprovalId(): `jappr_${string}`;
  now(): number;
  canonicalizeJson(value: unknown): string;
  hashCanonicalJson(value: unknown): Promise<string>;
}>;

const CREDENTIAL_KEY =
  /(?:password|passphrase|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|bearer)/i;
const RAW_SECRET_VALUE =
  /^(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{6,}$|^Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function assertNoSecretValues(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (RAW_SECRET_VALUE.test(value.trim())) approvalError('secret_value_rejected');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) approvalError('invalid_parameters');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretValues(item, seen);
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(key)) approvalError('secret_value_rejected');
      assertNoSecretValues(item, seen);
    }
  }
  seen.delete(value);
}

function sameCanonical(
  left: unknown,
  right: unknown,
  canonicalize: (value: unknown) => string,
): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
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

function riskFor(registration: JarvisRegisteredActionDefinition): JarvisApprovalV1['risk'] {
  if (registration.risk === 'read-only') return 'safe';
  if (registration.risk === 'safe-write') return 'confirm';
  return 'dangerous';
}

function producerFor(
  registration: JarvisRegisteredActionDefinition,
): 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp' {
  if (registration.executor.kind === 'plugin_tool') return 'plugin';
  const id = registration.executor.registryActionId.toLowerCase();
  if (id.startsWith('terminal.') || id.includes('.terminal.')) return 'terminal';
  if (id.startsWith('file.') || id.includes('.file.')) return 'file_action';
  if (id.startsWith('mcp.') || id.includes('.mcp.')) return 'mcp';
  return 'action';
}

function findCapability(snapshot: JarvisCapabilitySnapshot, id: string) {
  return [
    ...snapshot.tools,
    ...snapshot.plugins,
    ...snapshot.mcps,
    ...snapshot.terminals,
    ...snapshot.agents,
  ].find((entry) => entry.id === id);
}

function authorizationSlice(input: {
  registration: JarvisRegisteredActionDefinition;
  capabilitySnapshot: JarvisCapabilitySnapshot;
  entitlementSnapshot: JarvisEntitlementSnapshot;
  target: JarvisCanonicalActionTarget;
  now: number;
}): unknown {
  const capabilities = input.registration.requiredCapabilities.map((id) => {
    const ref = findCapability(input.capabilitySnapshot, id);
    if (!ref || ref.state === 'unavailable' || ref.state === 'planned') {
      approvalError('capability_changed');
    }
    if (!ref.operations.includes('execute')) approvalError('capability_changed');
    return {
      ref: ref.id,
      state: ref.state,
      operations: [...ref.operations].sort(),
      evidence: {
        ...(ref.evidenceRef === undefined ? {} : { evidenceRef: ref.evidenceRef }),
        ...(ref.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: ref.lastVerifiedAt }),
      },
    };
  });

  const entitlement = input.entitlementSnapshot;
  if (
    entitlement.source === 'unavailable' ||
    !Number.isFinite(entitlement.verifiedAt) ||
    !Number.isFinite(entitlement.expiresAt) ||
    entitlement.expiresAt! <= input.now
  ) {
    approvalError('entitlement_changed');
  }
  const granted = new Set(entitlement.capabilities);
  if (input.registration.requiredEntitlements.some((id) => !granted.has(id))) {
    approvalError('entitlement_changed');
  }

  return {
    primaryCapability: input.registration.requiredCapabilities[0],
    capabilities,
    target: input.target,
    entitlements: {
      source: entitlement.source,
      ...(entitlement.planId === undefined ? {} : { planId: entitlement.planId }),
      capabilities: [...entitlement.capabilities].sort(),
      verifiedAt: entitlement.verifiedAt,
      expiresAt: entitlement.expiresAt,
    },
  };
}

function assertLifecycleBinding(
  lifecycle: JarvisIssuedApprovalLifecycle,
  parentRun: JarvisRun,
  attempt?: JarvisRequestAttempt,
): void {
  if (
    lifecycle[jarvisIssuedApprovalLifecycleBrand] !== true ||
    !lifecycle.accountId ||
    lifecycle.accountId !== parentRun.accountId ||
    lifecycle.runId !== parentRun.id ||
    !lifecycle.requestId ||
    !Number.isSafeInteger(lifecycle.attemptNumber) ||
    lifecycle.attemptNumber <= 0 ||
    !lifecycle.revocationSignal ||
    typeof lifecycle.revocationSignal.aborted !== 'boolean'
  ) {
    approvalError('run_scope_mismatch');
  }
  if (
    attempt &&
    (attempt.runId !== parentRun.id ||
      attempt.requestId !== lifecycle.requestId ||
      attempt.attemptNumber !== lifecycle.attemptNumber ||
      !Number.isSafeInteger(attempt.attemptNumber) ||
      attempt.attemptNumber <= 0)
  ) {
    approvalError('run_scope_mismatch');
  }
}

function assertExactOwnKeys(value: object, allowed: readonly string[]): void {
  const accepted = new Set<PropertyKey>(allowed);
  if (Reflect.ownKeys(value).some((key) => !accepted.has(key))) {
    approvalError('caller_secret_resolver_rejected');
  }
}

function exactRequestAttempt(attempt: JarvisRequestAttempt): JarvisRequestAttempt {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    approvalError('run_scope_mismatch');
  }
  const common = ['kind', 'requestId', 'runId', 'attemptNumber'];
  const retry = ['previousRequestId', 'previousRunId', 'previousAttemptNumber'];
  assertExactOwnKeys(
    attempt,
    attempt.kind === 'transport_retry' || attempt.kind === 'logical_retry'
      ? [...common, ...retry]
      : common,
  );
  try {
    validateJarvisRequestAttempt(attempt);
  } catch {
    approvalError('run_scope_mismatch');
  }
  if (attempt.kind === 'initial') {
    return {
      kind: 'initial',
      requestId: attempt.requestId,
      runId: attempt.runId,
      attemptNumber: 1,
    };
  }
  if (attempt.kind === 'transport_retry' || attempt.kind === 'logical_retry') {
    return {
      kind: attempt.kind,
      requestId: attempt.requestId,
      runId: attempt.runId,
      attemptNumber: attempt.attemptNumber,
      previousRequestId: attempt.previousRequestId,
      previousRunId: attempt.previousRunId,
      previousAttemptNumber: attempt.previousAttemptNumber,
    } as JarvisRequestAttempt;
  }
  approvalError('run_scope_mismatch');
}

function assertExactRunInput(run: JarvisRun): void {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    approvalError('run_scope_mismatch');
  }
  assertExactOwnKeys(run, [
    'id',
    'accountId',
    'workspaceId',
    'projectId',
    'chatId',
    'parentRunId',
    'source',
    'status',
    'agentId',
    'identityVersion',
    'profileRevisionId',
    'model',
    'createdAt',
    'updatedAt',
    'completedAt',
    'transportAttempts',
  ]);
}

function createInputOnly(input: CreateJarvisApprovalInput): CreateJarvisApprovalInput {
  return {
    parentRun: input.parentRun,
    attempt: input.attempt,
    actionId: input.actionId,
    actionVersion: input.actionVersion,
    params: input.params,
    expiresAt: input.expiresAt,
  };
}

function assertContextBinding(
  context: ActionRunContext,
  lifecycle: JarvisIssuedApprovalLifecycle,
  approvalId: string,
): RegisteredActionExecutionContext {
  const record = context as unknown as Record<string, unknown>;
  assertExactOwnKeys(record, [
    'source',
    'chatId',
    'messageId',
    'callId',
    'accountId',
    'runId',
    'approvalId',
    'requestId',
    'attemptNumber',
    'signal',
  ]);
  const expected = {
    accountId: lifecycle.accountId,
    runId: lifecycle.runId,
    approvalId,
    requestId: lifecycle.requestId,
    attemptNumber: lifecycle.attemptNumber,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== undefined && record[key] !== value) approvalError('run_scope_mismatch');
  }
  if (context.source !== 'user' && context.source !== 'ai') approvalError('run_scope_mismatch');
  if (
    context.signal !== undefined &&
    (typeof context.signal !== 'object' ||
      typeof context.signal.aborted !== 'boolean' ||
      typeof context.signal.addEventListener !== 'function')
  ) {
    approvalError('run_scope_mismatch');
  }
  return Object.freeze({
    source: context.source,
    ...(context.chatId === undefined ? {} : { chatId: context.chatId }),
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...(context.callId === undefined ? {} : { callId: context.callId }),
    ...expected,
  });
}

function committed<T>(result: JarvisAuthorityBoundResult<T>): T {
  if (result.kind !== 'committed') throw new JarvisApprovalAuthorityRevokedError();
  return result.value;
}

function mapSecretValidationReason(reason: string): JarvisApprovalErrorCode {
  if (
    reason === 'credential_account_unbound' ||
    reason === 'credential_account_mismatch' ||
    reason === 'credential_grant_stale' ||
    reason === 'credential_grant_unavailable' ||
    reason === 'credential_grant_storage_failed'
  ) {
    return reason;
  }
  if (
    reason === 'account_mismatch' ||
    reason === 'action_mismatch' ||
    reason === 'version_mismatch' ||
    reason === 'field_mismatch' ||
    reason === 'boot_mismatch'
  ) {
    return 'secret_handle_scope_mismatch';
  }
  return 'secret_handle_invalid';
}

function exactPendingApprovalEvent(
  events: readonly JarvisEvent[],
  runId: string,
): JarvisEvent | undefined {
  const candidates = events.filter(
    (event) =>
      event.runId === runId &&
      event.type === 'approval' &&
      event.status === 'pending' &&
      event.title === 'Approval required' &&
      event.safeSummary === 'Review the registered action before it runs.',
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

const ZERO_EFFECT_EVENT_LIMIT = 500;

function exactProviderFailure(
  failure: JarvisPreEffectTransportFailureEvidence,
  run: Readonly<JarvisRun>,
  attempt: Readonly<JarvisTransportAttemptV1>,
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
    !!failure.failureCategory.trim() &&
    !!failure.evidenceRef.trim() &&
    Number.isFinite(failure.verifiedAt)
  );
}

function exactAttemptBinding(
  run: Readonly<JarvisRun>,
  attempt: Readonly<JarvisTransportAttemptV1>,
): boolean {
  const persisted = run.transportAttempts?.at(-1);
  if (!persisted || run.source !== 'schedule' || run.status !== 'running') return false;
  try {
    return (
      persisted.requestId === attempt.requestId &&
      persisted.attemptNumber === attempt.attemptNumber &&
      canonicalizeJarvisApprovalJson(persisted) === canonicalizeJarvisApprovalJson(attempt) &&
      attempt.effectBarrier.state === 'open' &&
      attempt.effectBarrier.version === 0 &&
      (attempt.state === 'provider_in_flight' || attempt.state === 'retryable_failed')
    );
  } catch {
    return false;
  }
}

function sameProviderFailure(
  left: JarvisPreEffectTransportFailureEvidence,
  right: JarvisPreEffectTransportFailureEvidence,
): boolean {
  try {
    return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
  } catch {
    return false;
  }
}

function exactProviderStartEvent(input: {
  event: Readonly<JarvisEvent>;
  run: Readonly<JarvisRun>;
  requestId: string;
  attemptNumber: number;
}): Extract<
  NonNullable<JarvisEvent['producerSourceEvidence']>,
  { producerKind: 'provider' }
> | null {
  const source = input.event.producerSourceEvidence;
  const expectedSnapshotRef = `jmodel_${input.run.model.providerId}_${input.run.model.modelId}_${input.run.model.capturedAt}`;
  if (
    !source ||
    source.producerKind !== 'provider' ||
    !validateJarvisProducerSourceEvidence(source).ok ||
    input.event.executionEvidence !== undefined ||
    input.event.canonicalResultEvidence !== undefined ||
    input.event.liveEvidence !== undefined ||
    input.event.runId !== input.run.id ||
    input.event.type !== 'model' ||
    input.event.status !== 'started' ||
    input.event.idempotencyKey !==
      `kernel-provider-start:${input.requestId}:${input.attemptNumber}` ||
    source.accountId !== input.run.accountId ||
    source.runId !== input.run.id ||
    source.requestId !== input.requestId ||
    source.attemptNumber !== input.attemptNumber ||
    source.producerIdentity.providerId !== input.run.model.providerId ||
    source.producerIdentity.modelId !== input.run.model.modelId ||
    source.producerIdentity.modelSnapshotRef !== expectedSnapshotRef ||
    source.phase !== 'start' ||
    source.state !== 'started' ||
    source.resultRef !== `jprovider_start_${input.requestId}` ||
    source.observedAt !== input.event.createdAt
  ) {
    return null;
  }
  return source;
}

async function inspectZeroEffectTail(input: {
  events: JarvisEventRepository;
  accountId: string;
  runId: string;
  run: Readonly<JarvisRun>;
  attempt: Readonly<JarvisTransportAttemptV1>;
  afterSeq: number;
}): Promise<number | null> {
  const rows = await input.events.listByRun(input.accountId, input.runId, {
    afterSeq: input.afterSeq,
    limit: ZERO_EFFECT_EVENT_LIMIT,
  });
  if (rows.length >= ZERO_EFFECT_EVENT_LIMIT) return null;
  let throughSeq = input.afterSeq;
  let settlementEventSeq: number | undefined;
  let settlementObservedAt: number | undefined;
  let resultSourceEventSeq: number | undefined;
  let scheduleBusyEventSeq: number | undefined;
  let scheduleDegradedEventSeq: number | undefined;
  let providerSourceEventSeq: number | undefined;
  let providerLiveEventSeq: number | undefined;
  let providerStartedAt: number | undefined;
  let providerIdentity:
    | Extract<JarvisLiveProducerIdentity, { producerKind: 'provider' }>
    | undefined;
  const snapshot = input.run.scheduledRetrySnapshot;
  const startRef = `jstart_${input.run.id}_${input.attempt.requestId}_${input.attempt.attemptNumber}`;
  const resultRef = `jresult_${input.run.id}_${input.attempt.requestId}_${input.attempt.attemptNumber}_transport`;
  const providerStartRef = `jprovider_start_${input.attempt.requestId}`;
  const exactScheduleBinding = (evidence: {
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    producerKind?: string;
    producerIdentity?: JarvisLiveProducerIdentity;
  }): boolean =>
    !!snapshot &&
    evidence.accountId === input.run.accountId &&
    evidence.runId === input.run.id &&
    evidence.requestId === input.attempt.requestId &&
    evidence.attemptNumber === input.attempt.attemptNumber &&
    evidence.producerKind === 'schedule' &&
    evidence.producerIdentity?.producerKind === 'schedule' &&
    evidence.producerIdentity.eventId === snapshot.eventId &&
    evidence.producerIdentity.occurrenceId === snapshot.occurrenceId;
  for (const row of rows) {
    if (row.runId !== input.runId || row.seq !== throughSeq + 1) return null;
    if (row.executionEvidence !== undefined) return null;
    const evidenceLaneCount =
      Number(row.canonicalResultEvidence !== undefined) +
      Number(row.producerSourceEvidence !== undefined) +
      Number(row.liveEvidence !== undefined);
    if (evidenceLaneCount > 1) return null;

    const canonical = row.canonicalResultEvidence;
    if (canonical !== undefined) {
      if (
        !validateJarvisCanonicalResultEvidence(canonical).ok ||
        settlementEventSeq !== undefined ||
        scheduleBusyEventSeq === undefined ||
        canonical.kind !== 'scheduled_transport_settled' ||
        canonical.parentRunId !== undefined ||
        canonical.stepId !== undefined ||
        canonical.accountId !== input.run.accountId ||
        canonical.runId !== input.run.id ||
        canonical.requestId !== input.attempt.requestId ||
        canonical.attemptNumber !== input.attempt.attemptNumber ||
        canonical.state !== 'degraded' ||
        canonical.resultRef !== resultRef ||
        canonical.observedAt !== row.createdAt ||
        row.type !== 'warning' ||
        row.status !== 'transport_retry_available' ||
        row.idempotencyKey !==
          `jtransport:${input.run.id}:${input.attempt.requestId}:${input.attempt.attemptNumber}:retry_available`
      ) {
        return null;
      }
      settlementEventSeq = row.seq;
      settlementObservedAt = canonical.observedAt;
    }

    const source = row.producerSourceEvidence;
    if (source !== undefined) {
      if (!validateJarvisProducerSourceEvidence(source).ok) return null;
      if (source.producerKind === 'provider') {
        const exactProvider = exactProviderStartEvent({
          event: row,
          run: input.run,
          requestId: input.attempt.requestId,
          attemptNumber: input.attempt.attemptNumber,
        });
        if (
          !exactProvider ||
          providerSourceEventSeq !== undefined ||
          scheduleBusyEventSeq === undefined ||
          settlementEventSeq !== undefined
        ) {
          return null;
        }
        providerSourceEventSeq = row.seq;
        providerIdentity = exactProvider.producerIdentity;
        providerStartedAt = exactProvider.observedAt;
      } else {
        if (
          resultSourceEventSeq !== undefined ||
          scheduleBusyEventSeq === undefined ||
          settlementEventSeq === undefined ||
          scheduleDegradedEventSeq !== undefined ||
          !exactScheduleBinding(source) ||
          source.phase !== 'result' ||
          source.state !== 'degraded' ||
          source.resultRef !== resultRef ||
          source.observedAt !== row.createdAt ||
          source.observedAt !== settlementObservedAt ||
          source.resultAuthority?.runId !== input.run.id ||
          source.resultAuthority?.eventSeq !== settlementEventSeq ||
          source.resultAuthority?.evidenceRef !== resultRef ||
          row.type !== 'tool' ||
          row.status !== 'degraded' ||
          row.idempotencyKey !==
            `schedule:${input.run.id}:${input.attempt.requestId}:${input.attempt.attemptNumber}:result`
        ) {
          return null;
        }
        resultSourceEventSeq = row.seq;
      }
    }

    const live = row.liveEvidence;
    if (live !== undefined) {
      if (!validateJarvisDurableLiveEvidence(live).ok) return null;
      if (live.producerKind === 'provider') {
        if (
          providerIdentity === undefined ||
          providerLiveEventSeq !== undefined ||
          settlementEventSeq !== undefined ||
          live.kind !== 'model' ||
          live.producerIdentity.producerKind !== 'provider' ||
          live.accountId !== input.run.accountId ||
          live.runId !== input.run.id ||
          live.requestId !== input.attempt.requestId ||
          live.attemptNumber !== input.attempt.attemptNumber ||
          live.producerIdentity.providerId !== providerIdentity.providerId ||
          live.producerIdentity.modelId !== providerIdentity.modelId ||
          live.producerIdentity.modelSnapshotRef !== providerIdentity.modelSnapshotRef ||
          live.providerId !== providerIdentity.providerId ||
          live.modelId !== providerIdentity.modelId ||
          live.modelSnapshotRef !== providerIdentity.modelSnapshotRef ||
          live.registrationId !== `${input.run.id}:provider` ||
          live.operations.length !== 1 ||
          live.operations[0] !== 'generate' ||
          live.transition !== 'started' ||
          live.resultRef !== providerStartRef ||
          live.resultEventSeq !== providerSourceEventSeq ||
          live.observedAt !== row.createdAt ||
          live.observedAt !== providerStartedAt ||
          live.previousProofRef !== undefined ||
          row.type !== 'model' ||
          row.status !== 'started' ||
          row.idempotencyKey !== `kernel-live:${input.run.id}:provider:started:${providerStartRef}`
        ) {
          return null;
        }
        providerLiveEventSeq = row.seq;
      } else {
        const commonValid =
          exactScheduleBinding(live) &&
          live.kind === 'capability' &&
          live.category === 'agent' &&
          live.capabilityId === 'schedule.dispatch' &&
          live.registrationId === `${input.run.id}:schedule:${input.attempt.attemptNumber}` &&
          live.operations.length === 3 &&
          live.operations[0] === 'execute' &&
          live.operations[1] === 'cancel' &&
          live.operations[2] === 'inspect' &&
          live.observedAt === row.createdAt &&
          row.type === 'tool' &&
          row.status === live.transition;
        const busyValid =
          live.transition === 'busy' &&
          scheduleBusyEventSeq === undefined &&
          settlementEventSeq === undefined &&
          resultSourceEventSeq === undefined &&
          scheduleDegradedEventSeq === undefined &&
          live.resultRef === startRef &&
          live.resultEventSeq === input.attempt.startedEventSeq &&
          live.previousProofRef === undefined;
        const degradedValid =
          live.transition === 'degraded' &&
          scheduleBusyEventSeq !== undefined &&
          settlementEventSeq !== undefined &&
          resultSourceEventSeq !== undefined &&
          scheduleDegradedEventSeq === undefined &&
          live.resultRef === resultRef &&
          live.resultEventSeq === resultSourceEventSeq &&
          live.observedAt === settlementObservedAt &&
          typeof live.previousProofRef === 'string' &&
          live.previousProofRef.startsWith('jlive_');
        if (!commonValid || (!busyValid && !degradedValid)) return null;
        if (busyValid) scheduleBusyEventSeq = row.seq;
        if (degradedValid) scheduleDegradedEventSeq = row.seq;
      }
    }
    throughSeq = row.seq;
  }
  if ((providerSourceEventSeq === undefined) !== (providerLiveEventSeq === undefined)) {
    return null;
  }
  if (
    input.attempt.state === 'retryable_failed' &&
    (scheduleBusyEventSeq === undefined ||
      settlementEventSeq === undefined ||
      resultSourceEventSeq === undefined ||
      scheduleDegradedEventSeq === undefined)
  ) {
    return null;
  }
  return throughSeq;
}

/** @internal Imported only by the trusted schedule/kernel runtime. */
export function createJarvisConsequentialEffectSafetyAuthority(input: {
  approvals: JarvisApprovalRepository;
  artifacts: JarvisArtifactRepository;
  events: JarvisEventRepository;
  providerAttemptEvidence: Pick<JarvisProviderAttemptEvidenceAuthority, 'revalidateFailure'>;
  now: () => number;
}): JarvisConsequentialEffectSafetyAuthority {
  async function revalidateProvider(
    run: Readonly<JarvisRun>,
    attempt: Readonly<JarvisTransportAttemptV1>,
    failure: JarvisPreEffectTransportFailureEvidence,
  ): Promise<JarvisPreEffectTransportFailureEvidence | null> {
    if (!exactAttemptBinding(run, attempt) || !exactProviderFailure(failure, run, attempt)) {
      return null;
    }
    const verified = await input.providerAttemptEvidence.revalidateFailure({
      evidence: failure,
      accountId: run.accountId,
      runId: run.id,
      requestId: attempt.requestId,
      attemptNumber: attempt.attemptNumber,
      providerId: run.model.providerId,
      modelId: run.model.modelId,
    });
    return verified && sameProviderFailure(verified, failure) ? verified : null;
  }

  async function inspectZeroState(
    run: Readonly<JarvisRun>,
    attempt: Readonly<JarvisTransportAttemptV1>,
    afterSeq: number,
  ): Promise<number | null> {
    const [approvals, artifacts, throughSeq] = await Promise.all([
      input.approvals.listByRun(run.accountId, run.id, {
        requestId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        limit: 1,
      }),
      input.artifacts.listByRun(run.accountId, run.id, 1),
      inspectZeroEffectTail({
        events: input.events,
        accountId: run.accountId,
        runId: run.id,
        run,
        attempt,
        afterSeq,
      }),
    ]);
    if (approvals.length !== 0 || artifacts.length !== 0 || throughSeq === null) return null;
    return throughSeq;
  }

  function buildProof(
    run: Readonly<JarvisRun>,
    attempt: Readonly<JarvisTransportAttemptV1>,
    providerBoundary: JarvisPreEffectTransportFailureEvidence,
    throughSeq: number,
  ): JarvisZeroConsequentialEffectEvidenceV1 | null {
    const assessedAt = input.now();
    if (!Number.isFinite(assessedAt)) return null;
    return Object.freeze({
      schemaVersion: 1,
      accountId: run.accountId,
      runId: run.id,
      requestId: attempt.requestId,
      attemptNumber: attempt.attemptNumber,
      assessedAt,
      providerBoundary: structuredClone(providerBoundary),
      effectBarrier: Object.freeze({ state: 'open', version: 0 }),
      approvals: Object.freeze({
        count: 0,
        evidenceRef: `approvals-zero:${run.id}:${attempt.requestId}:${attempt.attemptNumber}`,
      }),
      artifacts: Object.freeze({
        count: 0,
        evidenceRef: `artifacts-zero:${run.id}:${attempt.requestId}:${attempt.attemptNumber}`,
      }),
      executorClaims: Object.freeze({
        count: 0,
        throughSeq,
        evidenceRef: `claims-zero:${run.id}:${throughSeq}`,
      }),
    });
  }

  return Object.freeze({
    async proveZeroConsequentialEffect({
      run,
      attempt,
      providerFailure,
    }: Parameters<JarvisConsequentialEffectSafetyAuthority['proveZeroConsequentialEffect']>[0]) {
      try {
        const providerBoundary = await revalidateProvider(run, attempt, providerFailure);
        if (!providerBoundary || attempt.state !== 'provider_in_flight') return null;
        const throughSeq = await inspectZeroState(run, attempt, attempt.startedEventSeq);
        return throughSeq === null ? null : buildProof(run, attempt, providerBoundary, throughSeq);
      } catch {
        return null;
      }
    },
    async revalidateZeroConsequentialEffect({
      run,
      attempt,
      evidence,
    }: Parameters<
      JarvisConsequentialEffectSafetyAuthority['revalidateZeroConsequentialEffect']
    >[0]) {
      try {
        if (!validateJarvisZeroConsequentialEffectEvidence(evidence).ok) return null;
        if (
          evidence.accountId !== run.accountId ||
          evidence.runId !== run.id ||
          evidence.requestId !== attempt.requestId ||
          evidence.attemptNumber !== attempt.attemptNumber ||
          evidence.effectBarrier.state !== 'open' ||
          evidence.effectBarrier.version !== 0 ||
          evidence.approvals.count !== 0 ||
          evidence.artifacts.count !== 0 ||
          evidence.executorClaims.count !== 0 ||
          evidence.executorClaims.throughSeq < attempt.startedEventSeq ||
          evidence.approvals.evidenceRef !==
            `approvals-zero:${run.id}:${attempt.requestId}:${attempt.attemptNumber}` ||
          evidence.artifacts.evidenceRef !==
            `artifacts-zero:${run.id}:${attempt.requestId}:${attempt.attemptNumber}` ||
          evidence.executorClaims.evidenceRef !==
            `claims-zero:${run.id}:${evidence.executorClaims.throughSeq}`
        ) {
          return null;
        }
        const providerBoundary = await revalidateProvider(run, attempt, evidence.providerBoundary);
        if (!providerBoundary) return null;
        const throughSeq = await inspectZeroState(run, attempt, attempt.startedEventSeq);
        if (throughSeq === null || throughSeq < evidence.executorClaims.throughSeq) return null;
        return buildProof(run, attempt, providerBoundary, throughSeq);
      } catch {
        return null;
      }
    },
  });
}

function ownerForProducer(
  kind: 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp',
  identity: JarvisLiveProducerIdentity,
): { ownerKind: 'action' | 'file' | 'terminal' | 'plugin' | 'mcp'; ownerId: string } | null {
  if (kind === 'action' && identity.producerKind === 'action') {
    return { ownerKind: 'action', ownerId: identity.executionId };
  }
  if (kind === 'file_action' && identity.producerKind === 'file_action') {
    return { ownerKind: 'file', ownerId: identity.resultId };
  }
  if (kind === 'terminal' && identity.producerKind === 'terminal') {
    return { ownerKind: 'terminal', ownerId: identity.executionId };
  }
  if (kind === 'plugin' && identity.producerKind === 'plugin') {
    return { ownerKind: 'plugin', ownerId: identity.invocationId };
  }
  if (kind === 'mcp' && identity.producerKind === 'mcp') {
    return { ownerKind: 'mcp', ownerId: identity.invocationId };
  }
  return null;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
  } catch {
    return false;
  }
}

function sourceMatchesEvidence<K extends 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp'>(
  row: JarvisEvent,
  evidence: JarvisCanonicalLiveProducerEvidence<K>,
  phase: 'start' | 'result',
): boolean {
  const source = row.producerSourceEvidence;
  if (
    !source ||
    source.schemaVersion !== 1 ||
    source.phase !== phase ||
    source.accountId !== evidence.accountId ||
    source.runId !== evidence.runId ||
    source.requestId !== evidence.requestId ||
    source.attemptNumber !== evidence.attemptNumber ||
    source.producerKind !== evidence.producerKind ||
    !sameCanonicalValue(source.producerIdentity, evidence.producerIdentity)
  ) {
    return false;
  }
  if (phase === 'result') {
    return (
      source.resultRef === evidence.resultRef &&
      source.state === evidence.state &&
      source.observedAt === evidence.verifiedAt
    );
  }
  return source.state === 'started' || source.state === 'ready' || source.state === 'busy';
}

async function resolveActionAttemptStartSeq(input: {
  run: Readonly<JarvisRun>;
  events: JarvisEventRepository;
  evidence: Readonly<
    JarvisCanonicalLiveProducerEvidence<'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp'>
  >;
}): Promise<number | null> {
  const ledgerMatches = (input.run.transportAttempts ?? []).filter(
    (candidate) =>
      candidate.requestId === input.evidence.requestId &&
      candidate.attemptNumber === input.evidence.attemptNumber,
  );
  if (ledgerMatches.length === 1) return ledgerMatches[0]!.startedEventSeq;
  if (ledgerMatches.length > 1 || input.run.source === 'schedule') return null;

  const rows = await input.events.listByRun(input.evidence.accountId, input.evidence.runId, {
    limit: ZERO_EFFECT_EVENT_LIMIT,
  });
  if (rows.length >= ZERO_EFFECT_EVENT_LIMIT) return null;
  const starts = rows.filter((event) => {
    return (
      event.seq < input.evidence.resultEventSeq &&
      exactProviderStartEvent({
        event,
        run: input.run,
        requestId: input.evidence.requestId,
        attemptNumber: input.evidence.attemptNumber,
      }) !== null
    );
  });
  return starts.length === 1 ? starts[0]!.seq : null;
}

function createActionLiveVerifier<
  K extends 'action' | 'file_action' | 'terminal' | 'plugin' | 'mcp',
>(
  kind: K,
  input: { runs: JarvisRunRepository; events: JarvisEventRepository },
): JarvisCanonicalLiveProducerVerifier<K> {
  return Object.freeze({
    async verify(evidence: JarvisCanonicalLiveProducerEvidence<K>) {
      try {
        const producerIdentity = evidence.producerIdentity as JarvisLiveProducerIdentity;
        if (
          evidence.schemaVersion !== 1 ||
          evidence.producerKind !== kind ||
          producerIdentity.producerKind !== kind ||
          !evidence.accountId.trim() ||
          !evidence.runId.trim() ||
          !evidence.requestId.trim() ||
          !Number.isSafeInteger(evidence.attemptNumber) ||
          evidence.attemptNumber < 1 ||
          !Number.isSafeInteger(evidence.resultEventSeq) ||
          evidence.resultEventSeq < 1 ||
          !evidence.resultRef.trim() ||
          !['started', 'ready', 'busy', 'completed', 'degraded'].includes(evidence.state) ||
          !Number.isFinite(evidence.verifiedAt)
        ) {
          return null;
        }
        const owner = ownerForProducer(kind, producerIdentity);
        if (!owner) return null;
        const run = await input.runs.getById(evidence.accountId, evidence.runId);
        if (!run || run.id !== evidence.runId || run.accountId !== evidence.accountId) return null;
        const attemptStartSeq = await resolveActionAttemptStartSeq({
          run,
          events: input.events,
          evidence,
        });
        if (attemptStartSeq === null || attemptStartSeq >= evidence.resultEventSeq) return null;

        if (
          evidence.state === 'started' ||
          evidence.state === 'ready' ||
          evidence.state === 'busy'
        ) {
          const startRow = await input.events.getBySeq(
            evidence.accountId,
            evidence.runId,
            evidence.resultEventSeq,
          );
          const startExecution = startRow?.executionEvidence;
          const startSource = startRow?.producerSourceEvidence;
          if (
            !startRow ||
            startRow.type !== 'tool' ||
            (startRow.status !== 'running' && startRow.status !== 'consequential_effect_claimed') ||
            !sourceMatchesEvidence(startRow, evidence, 'start') ||
            startExecution?.kind !== 'consequential_effect_claimed' ||
            startExecution.requestId !== evidence.requestId ||
            startExecution.attemptNumber !== evidence.attemptNumber ||
            startExecution.ownerKind !== owner.ownerKind ||
            startExecution.ownerId !== owner.ownerId ||
            startExecution.evidenceRef !== evidence.resultRef ||
            startExecution.observedAt !== evidence.verifiedAt ||
            startSource?.resultRef !== startExecution.evidenceRef ||
            startSource.observedAt !== startExecution.observedAt
          ) {
            return null;
          }
          return Object.freeze(structuredClone(evidence));
        }

        const [resultRow, tail] = await Promise.all([
          input.events.getBySeq(evidence.accountId, evidence.runId, evidence.resultEventSeq),
          input.events.listByRun(evidence.accountId, evidence.runId, {
            afterSeq: attemptStartSeq,
            limit: ZERO_EFFECT_EVENT_LIMIT,
          }),
        ]);
        if (!resultRow || tail.length >= ZERO_EFFECT_EVENT_LIMIT) return null;
        let expectedSeq = attemptStartSeq + 1;
        for (const row of tail) {
          if (row.runId !== evidence.runId || row.seq !== expectedSeq) return null;
          expectedSeq += 1;
        }
        const listedResult = tail.find((row) => row.seq === evidence.resultEventSeq);
        if (!listedResult || !sameCanonicalValue(listedResult, resultRow)) return null;
        const ownerRows = tail.filter((row) => {
          const execution = row.executionEvidence;
          const source = row.producerSourceEvidence;
          const executionOwner =
            execution?.requestId === evidence.requestId &&
            execution.attemptNumber === evidence.attemptNumber &&
            execution.ownerKind === owner.ownerKind &&
            execution.ownerId === owner.ownerId;
          const sourceOwner =
            source?.accountId === evidence.accountId &&
            source.runId === evidence.runId &&
            source.requestId === evidence.requestId &&
            source.attemptNumber === evidence.attemptNumber &&
            source.producerKind === evidence.producerKind &&
            sameCanonicalValue(source.producerIdentity, evidence.producerIdentity);
          return executionOwner || sourceOwner;
        });
        if (ownerRows.length !== 2) return null;
        const [startRow, completedRow] = ownerRows;
        if (
          !startRow ||
          !completedRow ||
          startRow.seq >= completedRow.seq ||
          completedRow.seq !== evidence.resultEventSeq ||
          startRow.type !== 'tool' ||
          (startRow.status !== 'running' && startRow.status !== 'consequential_effect_claimed') ||
          completedRow.type !== 'tool' ||
          completedRow.status !== evidence.state
        ) {
          return null;
        }
        const startExecution = startRow.executionEvidence;
        const startSource = startRow.producerSourceEvidence;
        if (
          !sourceMatchesEvidence(startRow, evidence, 'start') ||
          startExecution?.kind !== 'consequential_effect_claimed' ||
          startExecution.requestId !== evidence.requestId ||
          startExecution.attemptNumber !== evidence.attemptNumber ||
          startExecution.ownerKind !== owner.ownerKind ||
          startExecution.ownerId !== owner.ownerId ||
          startSource?.resultRef !== startExecution.evidenceRef ||
          startSource.observedAt !== startExecution.observedAt
        ) {
          return null;
        }
        const resultExecution = completedRow.executionEvidence;
        const resultSource = completedRow.producerSourceEvidence;
        if (
          !sameCanonicalValue(completedRow, resultRow) ||
          !sourceMatchesEvidence(completedRow, evidence, 'result') ||
          resultExecution?.kind !== 'consequential_effect_completed' ||
          resultExecution.requestId !== evidence.requestId ||
          resultExecution.attemptNumber !== evidence.attemptNumber ||
          resultExecution.ownerKind !== owner.ownerKind ||
          resultExecution.ownerId !== owner.ownerId ||
          resultExecution.evidenceRef !== evidence.resultRef ||
          resultSource?.resultRef !== resultExecution.evidenceRef ||
          resultSource.observedAt !== resultExecution.observedAt
        ) {
          return null;
        }
        return Object.freeze(structuredClone(evidence));
      } catch {
        return null;
      }
    },
  });
}

/** @internal Imported in production only by the trusted AI runtime. */
export function createJarvisActionLiveEvidenceVerifiers(input: {
  runs: JarvisRunRepository;
  events: JarvisEventRepository;
}): Readonly<{
  action: JarvisCanonicalLiveProducerVerifier<'action'>;
  fileAction: JarvisCanonicalLiveProducerVerifier<'file_action'>;
  terminal: JarvisCanonicalLiveProducerVerifier<'terminal'>;
  plugin: JarvisCanonicalLiveProducerVerifier<'plugin'>;
  mcp: JarvisCanonicalLiveProducerVerifier<'mcp'>;
}> {
  return Object.freeze({
    action: createActionLiveVerifier('action', input),
    fileAction: createActionLiveVerifier('file_action', input),
    terminal: createActionLiveVerifier('terminal', input),
    plugin: createActionLiveVerifier('plugin', input),
    mcp: createActionLiveVerifier('mcp', input),
  });
}

export function createJarvisApprovalEngine(
  input: JarvisApprovalEngineDependencies,
): JarvisApprovalEngine {
  const lifecycleStates = new WeakMap<
    JarvisIssuedApprovalLifecycle,
    { revocationSignal: AbortSignal }
  >();

  function trackLifecycle(lifecycle: JarvisIssuedApprovalLifecycle): {
    revocationSignal: AbortSignal;
  } {
    const existing = lifecycleStates.get(lifecycle);
    if (existing) return existing;
    const state = { revocationSignal: lifecycle.revocationSignal };
    lifecycleStates.set(lifecycle, state);
    return state;
  }

  function assertLive(state: { revocationSignal: AbortSignal }): void {
    if (state.revocationSignal.aborted) throw new JarvisApprovalAuthorityRevokedError();
  }

  async function loadCanonicalParent(
    lifecycle: JarvisIssuedApprovalLifecycle,
    supplied: JarvisRun,
  ): Promise<JarvisRun> {
    assertLifecycleBinding(lifecycle, supplied);
    const current = await input.runs.getById(lifecycle.accountId, lifecycle.runId);
    if (
      !current ||
      !sameCanonical(
        immutableRunIdentity(current),
        immutableRunIdentity(supplied),
        input.canonicalizeJson,
      )
    ) {
      approvalError('run_scope_mismatch');
    }
    return current;
  }

  function resolveRegistration(actionId: string, actionVersion: number) {
    const registration = input.catalog.resolve(actionId);
    if (!registration) approvalError('action_unavailable');
    if (registration.version !== actionVersion) approvalError('action_version_changed');
    return registration;
  }

  function validateParams(
    registration: JarvisRegisteredActionDefinition,
    params: Record<string, unknown>,
  ): Readonly<Record<string, unknown>> {
    assertNoSecretValues(params);
    try {
      const validated = registration.validateParameters(structuredClone(params));
      assertNoSecretValues(validated);
      return structuredClone(validated);
    } catch (error) {
      if (error instanceof JarvisApprovalError) throw error;
      approvalError('invalid_parameters');
    }
  }

  async function currentAuthorization(inputValue: {
    accountId: string;
    registration: JarvisRegisteredActionDefinition;
    params: Readonly<Record<string, unknown>>;
  }) {
    const [target, capabilitySnapshot, entitlementSnapshot] = await Promise.all([
      input.bindingSelectors.deriveTargetSnapshot({
        accountId: inputValue.accountId,
        actionId: inputValue.registration.id,
        actionVersion: inputValue.registration.version,
        params: inputValue.params,
      }),
      input.bindingSelectors.loadCapabilitySnapshot(inputValue.accountId),
      input.bindingSelectors.loadEntitlementSnapshot(inputValue.accountId),
    ]);
    const slice = authorizationSlice({
      registration: inputValue.registration,
      capabilitySnapshot,
      entitlementSnapshot,
      target,
      now: input.now(),
    });
    return {
      target,
      hash: await input.hashCanonicalJson(slice),
    };
  }

  async function prepare(
    lifecycle: JarvisIssuedApprovalLifecycle,
    state: { revocationSignal: AbortSignal },
    createInput: CreateJarvisApprovalInput,
  ): Promise<PreparedJarvisApprovalInput> {
    assertExactOwnKeys(createInput, [
      'parentRun',
      'attempt',
      'actionId',
      'actionVersion',
      'params',
      'expiresAt',
    ]);
    assertExactRunInput(createInput.parentRun);
    const attempt = exactRequestAttempt(createInput.attempt);
    assertLive(state);
    assertLifecycleBinding(lifecycle, createInput.parentRun, attempt);
    const canonicalParent = await loadCanonicalParent(lifecycle, createInput.parentRun);
    assertLive(state);
    const registration = resolveRegistration(createInput.actionId, createInput.actionVersion);
    const params = validateParams(registration, createInput.params);
    if (!Number.isFinite(createInput.expiresAt) || createInput.expiresAt <= input.now()) {
      approvalError('expired');
    }
    const authorization = await currentAuthorization({
      accountId: lifecycle.accountId,
      registration,
      params,
    });
    assertLive(state);
    const expectedEffect = `${registration.expectedEffect} Target: ${input.canonicalizeJson(
      authorization.target,
    )}`;
    return {
      parentRun: structuredClone(canonicalParent),
      attempt: structuredClone(attempt),
      actionId: createInput.actionId,
      actionVersion: createInput.actionVersion,
      params: structuredClone(params),
      expiresAt: createInput.expiresAt,
      secretHandleRefs: [],
      approvalId: input.newApprovalId(),
      paramsHash: await input.hashCanonicalJson(params),
      targetSnapshot: structuredClone(authorization.target),
      risk: riskFor(registration),
      capabilityId: registration.requiredCapabilities[0],
      capabilitySnapshotHash: authorization.hash,
      expectedEffect,
      createdAt: input.now(),
    };
  }

  async function validateStoredApproval(
    lifecycle: Pick<
      JarvisIssuedApprovalLifecycle,
      'accountId' | 'runId' | 'requestId' | 'attemptNumber'
    >,
    approval: JarvisApprovalV1,
  ): Promise<{
    registration: Readonly<JarvisRegisteredActionDefinition>;
    params: Readonly<Record<string, unknown>>;
  }> {
    if (
      approval.schemaVersion !== 1 ||
      approval.runId !== lifecycle.runId ||
      approval.requestId !== lifecycle.requestId ||
      approval.attemptNumber !== lifecycle.attemptNumber
    ) {
      approvalError('run_scope_mismatch');
    }
    if (approval.expiresAt <= input.now()) approvalError('expired');
    const registration = resolveRegistration(approval.actionId, approval.actionVersion);
    if (!approval.params || typeof approval.params !== 'object' || Array.isArray(approval.params)) {
      approvalError('params_changed');
    }
    const params = validateParams(registration, approval.params as Record<string, unknown>);
    if ((await input.hashCanonicalJson(params)) !== approval.paramsHash) {
      approvalError('params_changed');
    }
    const authorization = await currentAuthorization({
      accountId: lifecycle.accountId,
      registration,
      params,
    });
    if (!sameCanonical(authorization.target, approval.targetSnapshot, input.canonicalizeJson)) {
      approvalError('target_changed');
    }
    if (riskFor(registration) !== approval.risk) approvalError('risk_changed');
    if (
      registration.requiredCapabilities[0] !== approval.capabilityId ||
      authorization.hash !== approval.capabilitySnapshotHash
    ) {
      approvalError('capability_changed');
    }
    const expectedEffect = `${registration.expectedEffect} Target: ${input.canonicalizeJson(
      authorization.target,
    )}`;
    if (expectedEffect !== approval.expectedEffect) approvalError('target_changed');

    const expectedFields = new Set(registration.credentialBindings.map((binding) => binding.field));
    const seenFields = new Set<string>();
    for (const reference of approval.secretHandleRefs ?? []) {
      if (seenFields.has(reference.field)) approvalError('secret_handle_duplicate_field');
      seenFields.add(reference.field);
      if (!expectedFields.has(reference.field)) approvalError('secret_handle_scope_mismatch');
      const validation = await input.secretHandles.validate({
        accountId: lifecycle.accountId,
        actionId: approval.actionId,
        actionVersion: approval.actionVersion,
        field: reference.field,
        handleId: reference.handleId,
      });
      if (!validation.valid) approvalError(mapSecretValidationReason(validation.reason));
    }
    if (seenFields.size !== expectedFields.size) approvalError('secret_handle_scope_mismatch');
    return { registration, params };
  }

  async function dispatchClaimed(inputValue: {
    lifecycle: JarvisIssuedApprovalLifecycle;
    state: { revocationSignal: AbortSignal };
    registration: Readonly<JarvisRegisteredActionDefinition>;
    params: Readonly<Record<string, unknown>>;
    context: RegisteredActionExecutionContext;
    execution: JarvisIssuedActionExecution;
  }): Promise<JarvisCanonicalActionExecutionResult> {
    assertLive(inputValue.state);
    let outcome: JarvisRegisteredActionDispatchOutcome;
    try {
      outcome = await input.executeRegisteredAction({
        registration: inputValue.registration,
        params: structuredClone(inputValue.params),
        context: inputValue.context,
        execution: inputValue.execution,
      });
    } catch {
      outcome = {
        kind: 'executor_returned',
        result: { ok: false, error: 'registered_action_failed' },
      };
    }

    if (outcome.kind === 'terminal_handoff_accepted') {
      const isTerminal = producerFor(inputValue.registration) === 'terminal';
      if (
        !isTerminal ||
        outcome.executorKind !== 'terminal' ||
        outcome.ownerId !== inputValue.execution.ownerId ||
        outcome.receipt.ownerId !== outcome.ownerId ||
        outcome.receipt[jarvisTerminalHandoffReceiptBrand] !== true
      ) {
        inputValue.execution.dispose();
        approvalError('run_scope_mismatch');
      }
      return {
        kind: 'handoff_pending',
        executorKind: 'terminal',
        ownerId: outcome.ownerId,
        result: outcome.result,
      };
    }

    try {
      const resultRefHash = await input.hashCanonicalJson({
        approvalId: inputValue.execution.approval.id,
        result: outcome.result,
      });
      committed(
        await inputValue.execution.recordResult({
          state: outcome.result.ok ? 'completed' : 'degraded',
          resultRef: `jresult_${resultRefHash}`,
          completedAt: input.now(),
          ...(inputValue.registration.id === 'files.read' && outcome.result.ok
            ? { responseResult: outcome.result }
            : {}),
        }),
      );
      return { kind: 'settled', result: outcome.result };
    } finally {
      inputValue.execution.dispose();
    }
  }

  async function executeApproval(
    lifecycle: JarvisIssuedApprovalLifecycle,
    state: { revocationSignal: AbortSignal },
    executeInput: ExecuteJarvisApprovalInput,
  ): Promise<JarvisCanonicalActionExecutionResult> {
    assertExactOwnKeys(executeInput, ['parentRun', 'approvalId', 'context']);
    const context = assertContextBinding(executeInput.context, lifecycle, executeInput.approvalId);
    assertLive(state);
    await loadCanonicalParent(lifecycle, executeInput.parentRun);
    assertLive(state);
    const approval = await input.approvals.getById(lifecycle.accountId, executeInput.approvalId);
    if (!approval) approvalError('not_approved');
    if (approval.status === 'consumed') approvalError('already_consumed');
    if (approval.status !== 'approved') approvalError('not_approved');
    const validated = await validateStoredApproval(lifecycle, approval);
    assertLive(state);
    const producerKind = producerFor(validated.registration);
    const ownerId = `approval:${approval.id}`;
    const claimed = committed(
      await lifecycle.claimApprovedExecution({
        approvalId: approval.id,
        producerKind,
        ownerId,
        evidenceRef: `approval:${approval.id}:${approval.requestId}:${approval.attemptNumber}`,
        startedAt: input.now(),
      }),
    );
    assertLive(state);
    if (
      claimed[jarvisIssuedActionExecutionBrand] !== true ||
      claimed.approval.id !== approval.id ||
      claimed.ownerId !== ownerId ||
      claimed.producerKind !== producerKind
    ) {
      claimed.dispose();
      approvalError('run_scope_mismatch');
    }
    return dispatchClaimed({
      lifecycle,
      state,
      registration: validated.registration,
      params: validated.params,
      context,
      execution: claimed,
    });
  }

  const recoveryVerifier: JarvisRecoveryApprovalVerifier = Object.freeze({
    async verifyPendingApproval({
      accountId,
      run,
      events,
    }: {
      accountId: string;
      run: JarvisRun;
      events: readonly JarvisEvent[];
    }) {
      if (accountId !== run.accountId) {
        return { valid: false as const, reason: 'approval_binding_mismatch' as const };
      }
      const currentRun = await input.runs.getById(accountId, run.id);
      if (
        !currentRun ||
        currentRun.status !== 'awaiting_approval' ||
        run.status !== currentRun.status ||
        !sameCanonical(
          immutableRunIdentity(currentRun),
          immutableRunIdentity(run),
          input.canonicalizeJson,
        ) ||
        !sameCanonical(
          currentRun.transportAttempts ?? [],
          run.transportAttempts ?? [],
          input.canonicalizeJson,
        )
      ) {
        return { valid: false as const, reason: 'approval_binding_mismatch' as const };
      }
      const event = exactPendingApprovalEvent(events, run.id);
      if (!event) return { valid: false as const, reason: 'approval_missing' as const };
      const latestAttempt = currentRun.transportAttempts?.at(-1);
      let requestId: string;
      let attemptNumber: number;
      if (latestAttempt) {
        if (
          latestAttempt.state !== 'provider_in_flight' ||
          !latestAttempt.requestId ||
          !Number.isSafeInteger(latestAttempt.attemptNumber) ||
          latestAttempt.attemptNumber <= 0
        ) {
          return { valid: false as const, reason: 'approval_binding_mismatch' as const };
        }
        requestId = latestAttempt.requestId;
        attemptNumber = latestAttempt.attemptNumber;
      } else {
        if (currentRun.source === 'schedule') {
          return { valid: false as const, reason: 'approval_binding_mismatch' as const };
        }
        const providerSources = events
          .filter((candidate) => candidate.runId === currentRun.id)
          .map((candidate) => candidate.producerSourceEvidence)
          .filter(
            (
              source,
            ): source is Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'provider' }> =>
              source?.producerKind === 'provider',
          );
        const starts = providerSources.filter((source) => source.phase === 'start');
        const results = providerSources.filter((source) => source.phase === 'result');
        if (
          starts.length !== 1 ||
          results.length !== 1 ||
          starts[0]!.state !== 'started' ||
          results[0]!.state !== 'completed' ||
          starts[0]!.accountId !== currentRun.accountId ||
          results[0]!.accountId !== currentRun.accountId ||
          starts[0]!.runId !== currentRun.id ||
          results[0]!.runId !== currentRun.id ||
          starts[0]!.producerIdentity.providerId !== currentRun.model.providerId ||
          results[0]!.producerIdentity.providerId !== currentRun.model.providerId ||
          starts[0]!.producerIdentity.modelId !== currentRun.model.modelId ||
          results[0]!.producerIdentity.modelId !== currentRun.model.modelId ||
          starts[0]!.requestId !== results[0]!.requestId ||
          starts[0]!.attemptNumber !== results[0]!.attemptNumber ||
          !starts[0]!.requestId ||
          !Number.isSafeInteger(starts[0]!.attemptNumber) ||
          starts[0]!.attemptNumber !== 1
        ) {
          return { valid: false as const, reason: 'approval_binding_mismatch' as const };
        }
        requestId = starts[0]!.requestId;
        attemptNumber = starts[0]!.attemptNumber;
      }
      const approvals = await input.approvals.listByRun(accountId, run.id, {
        requestId,
        attemptNumber,
        limit: 2,
      });
      if (approvals.length !== 1 || approvals[0]!.id !== event.idempotencyKey) {
        return { valid: false as const, reason: 'approval_binding_mismatch' as const };
      }
      const approval = approvals[0]!;
      if (approval.status === 'consumed') {
        return { valid: false as const, reason: 'approval_consumed' as const };
      }
      if (approval.status !== 'pending') {
        return { valid: false as const, reason: 'approval_not_pending' as const };
      }
      if (approval.expiresAt <= input.now()) {
        return { valid: false as const, reason: 'approval_expired' as const };
      }
      if (
        approval.schemaVersion !== 1 ||
        approval.runId !== run.id ||
        approval.requestId !== requestId ||
        approval.attemptNumber !== attemptNumber
      ) {
        return { valid: false as const, reason: 'approval_binding_mismatch' as const };
      }
      try {
        await validateStoredApproval(
          {
            accountId,
            runId: run.id,
            requestId: approval.requestId,
            attemptNumber: approval.attemptNumber,
          },
          approval,
        );
      } catch (error) {
        if (error instanceof JarvisApprovalError && error.code === 'expired') {
          return { valid: false as const, reason: 'approval_expired' as const };
        }
        return { valid: false as const, reason: 'approval_binding_mismatch' as const };
      }
      return { valid: true as const, approvalId: approval.id };
    },
  });

  const engine: JarvisApprovalEngine = Object.freeze({
    recoveryVerifier,
    bindIssuedLifecycle(lifecycle: JarvisIssuedApprovalLifecycle): JarvisApprovalActionCapability {
      assertLifecycleBinding(lifecycle, {
        id: lifecycle.runId,
        accountId: lifecycle.accountId,
      } as JarvisRun);
      const state = trackLifecycle(lifecycle);
      return Object.freeze({
        async create(createInput: CreateJarvisApprovalInput): Promise<JarvisApprovalV1> {
          const prepared = await prepare(lifecycle, state, createInput);
          assertLive(state);
          return committed(await lifecycle.putPreparedApproval(prepared));
        },
        async decide(decideInput: {
          parentRun: JarvisRun;
          approvalId: string;
          decision: 'approve' | 'deny';
        }): Promise<JarvisApprovalV1> {
          assertExactOwnKeys(decideInput, ['parentRun', 'approvalId', 'decision']);
          assertLive(state);
          await loadCanonicalParent(lifecycle, decideInput.parentRun);
          const approval = await input.approvals.getById(
            lifecycle.accountId,
            decideInput.approvalId,
          );
          if (!approval || approval.status !== 'pending') approvalError('not_pending');
          if (approval.expiresAt <= input.now()) approvalError('expired');
          await validateStoredApproval(lifecycle, approval);
          assertLive(state);
          return committed(
            await lifecycle.decidePreparedApproval({
              approvalId: approval.id,
              decision: decideInput.decision,
            }),
          );
        },
        execute(
          executeInput: ExecuteJarvisApprovalInput,
        ): Promise<JarvisCanonicalActionExecutionResult> {
          return executeApproval(lifecycle, state, executeInput);
        },
        async executeAutoApprovedSafe(
          autoInput: CreateJarvisApprovalInput & { context: ActionRunContext },
        ): Promise<JarvisCanonicalActionExecutionResult> {
          assertExactOwnKeys(autoInput, [
            'parentRun',
            'attempt',
            'actionId',
            'actionVersion',
            'params',
            'expiresAt',
            'context',
          ]);
          const context = assertContextBinding(autoInput.context, lifecycle, 'pending');
          const prepared = await prepare(lifecycle, state, createInputOnly(autoInput));
          const registration = resolveRegistration(prepared.actionId, prepared.actionVersion);
          if (registration.risk !== 'read-only' || registration.approval !== 'never') {
            approvalError('not_approved');
          }
          const producerKind = producerFor(registration);
          const ownerId = `approval:${prepared.approvalId}`;
          const boundContext = Object.freeze({ ...context, approvalId: prepared.approvalId });
          assertLive(state);
          const execution = committed(
            await lifecycle.claimAutoApprovedExecution({
              approval: prepared,
              producerKind,
              ownerId,
              evidenceRef: `approval:${prepared.approvalId}:${lifecycle.requestId}:${lifecycle.attemptNumber}`,
              startedAt: input.now(),
            }),
          );
          assertLive(state);
          return dispatchClaimed({
            lifecycle,
            state,
            registration,
            params: prepared.params,
            context: boundContext,
            execution,
          });
        },
      });
    },
  });
  return engine;
}
