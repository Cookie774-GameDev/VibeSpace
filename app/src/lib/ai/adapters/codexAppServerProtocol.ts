export interface CodexBackendIdentity {
  modelProvider: string;
  model: string;
  effort: string | null;
  serviceTier: string | null;
  cwd: string;
}

export type CodexExecutionMode =
  | { kind: 'ask' | 'plan' }
  | {
      kind: 'agent';
      approvalPolicy: 'on-request' | 'never';
      sandbox:
        | {
            kind: 'workspace-write';
            writableRoots: readonly string[];
            networkAccess: boolean;
          }
        | { kind: 'danger-full-access' };
    };

export interface CodexThreadRequestInput {
  requestId: string;
  identity: Readonly<CodexBackendIdentity>;
  mode: CodexExecutionMode;
  developerInstructions?: string;
  dynamicTools?: readonly { type: 'function'; name: string; description: string; inputSchema: Record<string, unknown> }[];
}

export interface CodexThreadResumeRequestInput extends CodexThreadRequestInput {
  threadId: string;
}

export interface CodexTurnStartRequestInput extends CodexThreadResumeRequestInput {
  clientUserMessageId: string;
  text: string;
}

export type CodexThreadStartValidation =
  | { ok: true; threadId: string }
  | {
      ok: false;
      reason: 'invalid_response' | 'request_mismatch' | 'identity_mismatch';
      field: string;
    };

export type CodexSimpleApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexApprovalResponseInput {
  responseHandle: string;
  kind: 'command' | 'file_change';
  decision: CodexSimpleApprovalDecision;
  availableDecisions: readonly CodexSimpleApprovalDecision[];
  mode: CodexExecutionMode;
}

export interface CodexQuestionResponseInput {
  responseHandle: string;
  questionIds: readonly string[];
  answers: Readonly<Record<string, readonly string[]>>;
}

export interface CodexTurnInterruptRequestInput {
  requestId: string;
  threadId: string;
  turnId: string;
}

export interface CodexModelListRequestInput {
  requestId: string;
  cursor?: string;
}

export type CodexModelCapabilityValidation =
  | {
      ok: true;
      model: string;
      reasoningEffort: string | null;
      serviceTier: string | null;
    }
  | {
      ok: false;
      reason: 'invalid_response' | 'request_mismatch' | 'capability_mismatch';
      field: string;
    }
  | { ok: false; reason: 'next_page'; field: 'cursor'; cursor: string };

const MAX_IDENTIFIER = 256;
const MAX_TEXT = 1_048_576;
const MAX_WRITABLE_ROOTS = 16;
const MAX_QUESTIONS = 16;
const MAX_ANSWERS_PER_QUESTION = 8;
const MAX_ANSWER_TEXT = 32_768;
const MAX_MODEL_PAGE = 100;
const MAX_MODEL_OPTIONS = 32;
const MAX_CURSOR = 1_024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/u;
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u;
const UNSAFE_ANSWER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

type ApprovalPolicy = 'on-request' | 'never';
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: false }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    }
  | { type: 'dangerFullAccess' };

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireIdentifier(value: string, label: string): string {
  if (
    !value ||
    value.length > MAX_IDENTIFIER ||
    UNSAFE_CONTROL.test(value) ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    throw new Error(`Codex ${label} identifier is invalid.`);
  }
  return value;
}

function isAbsolutePath(value: string): boolean {
  if (!value || UNSAFE_CONTROL.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (!/^([A-Za-z]:\/|\/\/[^/]+\/|\/)/u.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

function comparablePath(value: unknown): unknown {
  if (typeof value !== 'string' || !isAbsolutePath(value)) return undefined;
  // Windows callers and Codex use different separators for the same directory.
  // Preserve component case and reject traversal; never equate different roots.
  if (!/^[A-Za-z]:[\\/]/u.test(value)) return value;
  const path = value.replaceAll('\\', '/');
  return path[0]!.toUpperCase() + (path.length === 3 ? path.slice(1) : path.slice(1).replace(/\/+$/u, ''));
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolutePath(value)) throw new Error(`Codex ${label} must be an absolute safe path.`);
  return value;
}

function requireCursor(value: string): string {
  if (!value || value.length > MAX_CURSOR || UNSAFE_CONTROL.test(value)) {
    throw new Error('Codex model cursor is invalid.');
  }
  return value;
}

function codexServiceTier(value: string | null): string | null {
  if (value === null) return null;
  const tier = requireIdentifier(value, 'service tier');
  return tier.toLocaleLowerCase('en-US') === 'fast' ? 'priority' : tier;
}

function requireIdentity(identity: Readonly<CodexBackendIdentity>): CodexBackendIdentity {
  return {
    modelProvider: requireIdentifier(identity.modelProvider, 'model provider'),
    model: requireIdentifier(identity.model, 'model'),
    effort:
      identity.effort === null ? null : requireIdentifier(identity.effort, 'reasoning effort'),
    serviceTier: codexServiceTier(identity.serviceTier),
    cwd: requireAbsolutePath(identity.cwd, 'working directory'),
  };
}

function modePolicy(mode: CodexExecutionMode): {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  sandboxPolicy: SandboxPolicy;
} {
  if (!('sandbox' in mode)) {
    return {
      approvalPolicy: 'never',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    };
  }
  if (mode.sandbox.kind === 'danger-full-access') {
    return {
      approvalPolicy: mode.approvalPolicy,
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
  }
  if (
    mode.sandbox.writableRoots.length === 0 ||
    mode.sandbox.writableRoots.length > MAX_WRITABLE_ROOTS
  ) {
    throw new Error('Codex Agent writable root count is invalid.');
  }
  const writableRoots = mode.sandbox.writableRoots.map((root) =>
    requireAbsolutePath(root, 'writable root'),
  );
  const uniqueRoots = new Set(
    writableRoots.map((root) =>
      /^[A-Za-z]:[\\/]/u.test(root) ? root.replaceAll('\\', '/').toLowerCase() : root,
    ),
  );
  if (uniqueRoots.size !== writableRoots.length) {
    throw new Error('Codex Agent writable roots must be unique.');
  }
  return {
    approvalPolicy: mode.approvalPolicy,
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots,
      networkAccess: mode.sandbox.networkAccess,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

function configFor(
  identity: Readonly<CodexBackendIdentity>,
  sandbox: SandboxPolicy,
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (identity.effort !== null) config.model_reasoning_effort = identity.effort;
  if (sandbox.type === 'workspaceWrite') {
    config.sandbox_workspace_write = {
      writable_roots: sandbox.writableRoots,
      network_access: sandbox.networkAccess,
      exclude_tmpdir_env_var: sandbox.excludeTmpdirEnvVar,
      exclude_slash_tmp: sandbox.excludeSlashTmp,
    };
  }
  return Object.keys(config).length ? config : undefined;
}

export function buildCodexThreadStartRequest(input: Readonly<CodexThreadRequestInput>) {
  const requestId = requireIdentifier(input.requestId, 'request');
  const identity = requireIdentity(input.identity);
  const policy = modePolicy(input.mode);
  return {
    id: requestId,
    method: 'thread/start' as const,
    params: {
      model: identity.model,
      modelProvider: identity.modelProvider,
      serviceTier: identity.serviceTier,
      cwd: identity.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: 'user' as const,
      sandbox: policy.sandbox,
      ...(configFor(identity, policy.sandboxPolicy)
        ? { config: configFor(identity, policy.sandboxPolicy) }
        : {}),
      ephemeral: false,
      threadSource: 'vibespace',
      ...(input.dynamicTools?.length ? { dynamicTools: input.dynamicTools } : {}),
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
    },
  };
}

export function buildCodexThreadResumeRequest(input: Readonly<CodexThreadResumeRequestInput>) {
  const requestId = requireIdentifier(input.requestId, 'request');
  const threadId = requireIdentifier(input.threadId, 'thread');
  const identity = requireIdentity(input.identity);
  const policy = modePolicy(input.mode);
  return {
    id: requestId,
    method: 'thread/resume' as const,
    params: {
      threadId,
      model: identity.model,
      modelProvider: identity.modelProvider,
      serviceTier: identity.serviceTier,
      cwd: identity.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: 'user' as const,
      sandbox: policy.sandbox,
      ...(configFor(identity, policy.sandboxPolicy)
        ? { config: configFor(identity, policy.sandboxPolicy) }
        : {}),
      excludeTurns: true,
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
    },
  };
}

export function buildCodexThreadPolicyUpdateRequest(input: {
  requestId: string;
  threadId: string;
  developerInstructions: string;
}) {
  const requestId = requireIdentifier(input.requestId, 'request');
  const threadId = requireIdentifier(input.threadId, 'thread');
  if (!input.developerInstructions.trim() || input.developerInstructions.length > MAX_TEXT ||
      UNSAFE_ANSWER_CONTROL.test(input.developerInstructions)) {
    throw new Error('Codex current-turn policy is invalid.');
  }
  return {
    id: requestId,
    method: 'thread/inject_items' as const,
    params: { threadId, items: [{
      type: 'message' as const,
      role: 'developer' as const,
      content: [{ type: 'input_text' as const, text:
        'Current VibeSpace turn policy: the following replaces earlier VibeSpace turn-specific capability, mode, preference, and output settings. Preserve higher authority and verified conversation history.\n\n' + input.developerInstructions }],
    }] },
  };
}

export function buildCodexTurnStartRequest(input: Readonly<CodexTurnStartRequestInput>) {
  const requestId = requireIdentifier(input.requestId, 'request');
  const threadId = requireIdentifier(input.threadId, 'thread');
  const clientUserMessageId = requireIdentifier(input.clientUserMessageId, 'message');
  const identity = requireIdentity(input.identity);
  const policy = modePolicy(input.mode);
  if (!input.text || input.text.length > MAX_TEXT || UNSAFE_ANSWER_CONTROL.test(input.text)) {
    throw new Error('Codex user text is invalid.');
  }
  return {
    id: requestId,
    method: 'turn/start' as const,
    params: {
      threadId,
      clientUserMessageId,
      input: [{ type: 'text' as const, text: input.text, text_elements: [] }],
      turnTrigger: 'user',
      cwd: identity.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: 'user' as const,
      sandboxPolicy: policy.sandboxPolicy,
      model: identity.model,
      serviceTierForTurn: identity.serviceTier,
      effort: identity.effort,
      // Collaboration mode enables Codex's native planning/question tools;
      // sandbox policy alone does not switch it out of Default mode.
      collaborationMode: {
        mode: input.mode.kind === 'plan' ? 'plan' as const : 'default' as const,
        settings: {
          model: identity.model,
          reasoning_effort: identity.effort,
          developer_instructions: null,
        },
      },
      summary: 'concise' as const,
    },
  };
}

export function buildCodexModelListRequest(input: Readonly<CodexModelListRequestInput>) {
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'model/list' as const,
    params: {
      ...(input.cursor === undefined ? {} : { cursor: requireCursor(input.cursor) }),
      limit: MAX_MODEL_PAGE,
      includeHidden: true,
    },
  };
}

export function validateCodexModelListResponse(
  value: unknown,
  expectedRequestId: string,
  expectedIdentity: Readonly<CodexBackendIdentity>,
): CodexModelCapabilityValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  const identity = requireIdentity(expectedIdentity);
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) {
    return { ok: false, reason: 'request_mismatch', field: 'id' };
  }
  const result = recordOf(envelope.result);
  if (!result || !Array.isArray(result.data) || result.data.length > MAX_MODEL_PAGE) {
    return { ok: false, reason: 'invalid_response', field: 'data' };
  }
  let nextCursor: string | null;
  if (result.nextCursor === null) {
    nextCursor = null;
  } else if (typeof result.nextCursor === 'string') {
    try {
      nextCursor = requireCursor(result.nextCursor);
    } catch {
      return { ok: false, reason: 'invalid_response', field: 'cursor' };
    }
  } else {
    return { ok: false, reason: 'invalid_response', field: 'cursor' };
  }
  const records = result.data.map(recordOf);
  if (
    records.some(
      (record) =>
        !record || typeof record.model !== 'string' || !SAFE_IDENTIFIER.test(record.model),
    )
  ) {
    return { ok: false, reason: 'invalid_response', field: 'model' };
  }
  const matching = records.filter((record) => record?.model === identity.model);
  if (matching.length > 1) {
    return { ok: false, reason: 'invalid_response', field: 'model' };
  }
  if (matching.length === 0) {
    return nextCursor
      ? { ok: false, reason: 'next_page', field: 'cursor', cursor: nextCursor }
      : { ok: false, reason: 'capability_mismatch', field: 'model' };
  }
  const selected = matching[0]!;
  if (
    !Array.isArray(selected.supportedReasoningEfforts) ||
    selected.supportedReasoningEfforts.length > MAX_MODEL_OPTIONS
  ) {
    return { ok: false, reason: 'invalid_response', field: 'reasoningEffort' };
  }
  const efforts = selected.supportedReasoningEfforts.map(recordOf);
  if (efforts.some((effort) => !effort || typeof effort.reasoningEffort !== 'string')) {
    return { ok: false, reason: 'invalid_response', field: 'reasoningEffort' };
  }
  if (
    identity.effort !== null &&
    !efforts.some((effort) => effort?.reasoningEffort === identity.effort)
  ) {
    return { ok: false, reason: 'capability_mismatch', field: 'reasoningEffort' };
  }
  const serviceTiers = selected.serviceTiers === undefined ? [] : selected.serviceTiers;
  if (!Array.isArray(serviceTiers) || serviceTiers.length > MAX_MODEL_OPTIONS) {
    return { ok: false, reason: 'invalid_response', field: 'serviceTier' };
  }
  const tiers = serviceTiers.map(recordOf);
  if (tiers.some((tier) => !tier || typeof tier.id !== 'string')) {
    return { ok: false, reason: 'invalid_response', field: 'serviceTier' };
  }
  const tier = identity.serviceTier;
  if (tier !== null && tier !== 'default' && !tiers.some((candidate) => candidate?.id === tier)) {
    return { ok: false, reason: 'capability_mismatch', field: 'serviceTier' };
  }
  return {
    ok: true,
    model: identity.model,
    reasoningEffort: identity.effort,
    serviceTier: tier,
  };
}

function sandboxMatches(
  observed: Record<string, unknown> | undefined,
  expected: SandboxPolicy,
  cwd: string,
) {
  // Codex can reduce an untrusted Windows workspace to read-only. Respect that
  // stricter policy instead of rejecting an otherwise usable chat session.
  if (expected.type === 'workspaceWrite' && observed?.type === 'readOnly') {
    return observed.networkAccess === false;
  }
  if (!observed || observed.type !== expected.type) return false;
  if (expected.type === 'readOnly') return observed.networkAccess === false;
  if (expected.type === 'dangerFullAccess') return true;
  const roots = observed.writableRoots;
  return (
    observed.networkAccess === expected.networkAccess &&
    observed.excludeTmpdirEnvVar === true &&
    observed.excludeSlashTmp === true &&
    Array.isArray(roots) &&
    // Codex makes cwd writable implicitly and can omit it from writableRoots.
    roots.every((root) => typeof root === 'string' && expected.writableRoots.some((expectedRoot) => comparablePath(root) === comparablePath(expectedRoot))) &&
    expected.writableRoots.every((root) => comparablePath(root) === comparablePath(cwd) || roots.some((observedRoot) => comparablePath(root) === comparablePath(observedRoot)))
  );
}

export function validateCodexThreadStartResponse(
  value: unknown,
  expectedRequestId: string,
  expectedIdentity: Readonly<CodexBackendIdentity>,
  expectedMode: CodexExecutionMode,
): CodexThreadStartValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  const identity = requireIdentity(expectedIdentity);
  const policy = modePolicy(expectedMode);
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) {
    return { ok: false, reason: 'request_mismatch', field: 'id' };
  }
  const result = recordOf(envelope.result);
  const thread = recordOf(result?.thread);
  const threadId = typeof thread?.id === 'string' ? thread.id : '';
  if (!result || !threadId || !SAFE_IDENTIFIER.test(threadId)) {
    return { ok: false, reason: 'invalid_response', field: 'threadId' };
  }
  const sandbox = recordOf(result.sandbox);
  if (!sandboxMatches(sandbox, policy.sandboxPolicy, identity.cwd)) {
    return { ok: false, reason: 'identity_mismatch', field: 'sandbox' };
  }
  const comparisons: readonly (readonly [string, unknown, unknown])[] = [
    ['model', result.model, identity.model],
    ['modelProvider', result.modelProvider, identity.modelProvider],
    [
      'serviceTier',
      result.serviceTier === 'default' ? null : (result.serviceTier ?? null),
      identity.serviceTier === 'default' ? null : identity.serviceTier,
    ],
    ['cwd', comparablePath(result.cwd), comparablePath(identity.cwd)],
    ['approvalPolicy', result.approvalPolicy, policy.approvalPolicy],
    ['approvalsReviewer', result.approvalsReviewer, 'user'],
    // Auto lets Codex select its model default. Explicit effort still must match.
    ...(identity.effort !== null
      ? [['reasoningEffort', result.reasoningEffort, identity.effort] as const]
      : []),
  ];
  for (const [field, observed, expected] of comparisons) {
    if (observed !== expected) {
      return { ok: false, reason: 'identity_mismatch', field };
    }
  }
  return { ok: true, threadId };
}

export function buildCodexApprovalResponse(input: Readonly<CodexApprovalResponseInput>) {
  const responseHandle = requireIdentifier(input.responseHandle, 'approval response');
  if (input.kind !== 'command' && input.kind !== 'file_change') {
    throw new Error('Codex approval kind is unsupported.');
  }
  if (!input.availableDecisions.includes(input.decision)) {
    throw new Error('Codex approval decision was not offered by the server.');
  }
  if (
    (input.mode.kind === 'ask' || input.mode.kind === 'plan') &&
    (input.decision === 'accept' || input.decision === 'acceptForSession')
  ) {
    throw new Error('Codex read-only modes cannot accept mutation approval.');
  }
  return { id: responseHandle, result: { decision: input.decision } };
}

export function buildCodexQuestionResponse(input: Readonly<CodexQuestionResponseInput>) {
  const responseHandle = requireIdentifier(input.responseHandle, 'question response');
  if (input.questionIds.length === 0 || input.questionIds.length > MAX_QUESTIONS) {
    throw new Error('Codex question set is invalid.');
  }
  const questionIds = input.questionIds.map((id) => requireIdentifier(id, 'question'));
  if (new Set(questionIds).size !== questionIds.length) {
    throw new Error('Codex question identifiers must be unique.');
  }
  const answerKeys = Object.keys(input.answers);
  if (
    answerKeys.length !== questionIds.length ||
    answerKeys.some((key) => !questionIds.includes(key))
  ) {
    throw new Error('Codex answers must match the exact question set.');
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const questionId of questionIds) {
    const values = input.answers[questionId];
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ANSWERS_PER_QUESTION) {
      throw new Error('Codex question answer count is invalid.');
    }
    const safeAnswers = values.map((answer) => {
      if (
        typeof answer !== 'string' ||
        answer.length === 0 ||
        answer.length > MAX_ANSWER_TEXT ||
        UNSAFE_ANSWER_CONTROL.test(answer)
      ) {
        throw new Error('Codex question answer text is invalid.');
      }
      return answer;
    });
    answers[questionId] = { answers: safeAnswers };
  }
  return { id: responseHandle, result: { answers } };
}

export function buildCodexTurnInterruptRequest(input: Readonly<CodexTurnInterruptRequestInput>) {
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'turn/interrupt' as const,
    params: {
      threadId: requireIdentifier(input.threadId, 'thread'),
      turnId: requireIdentifier(input.turnId, 'turn'),
    },
  };
}
