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

export interface CodexDynamicTool {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodexThreadRequestInput {
  requestId: string;
  identity: Readonly<CodexBackendIdentity>;
  mode: CodexExecutionMode;
  developerInstructions?: string;
  dynamicTools?: readonly CodexDynamicTool[];
}

export interface CodexThreadResumeRequestInput extends CodexThreadRequestInput {
  threadId: string;
}

export interface CodexTurnStartRequestInput extends CodexThreadResumeRequestInput {
  clientUserMessageId: string;
  text: string;
  skills?: readonly CodexDiscoveredSkill[];
}

export type CodexSkillScope = 'user' | 'repo' | 'system' | 'admin';

/** Exact metadata returned by Codex skills/list for a particular requested cwd. */
export interface CodexDiscoveredSkill {
  cwd: string;
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
  pluginId: string | null;
}

export interface CodexSkillDiscoveryError {
  cwd: string;
  path: string;
  message: string;
}

export interface CodexSkillsListEntry {
  cwd: string;
  skills: readonly CodexDiscoveredSkill[];
  errors: readonly CodexSkillDiscoveryError[];
}

export type CodexSkillsListValidation =
  | { ok: true; entries: readonly CodexSkillsListEntry[] }
  | { ok: false; reason: 'invalid_response' | 'request_mismatch' | 'cwd_mismatch'; field: string };

export interface CodexSkillsListRequestInput {
  requestId: string;
  cwds: readonly string[];
  forceReload?: boolean;
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

export interface CodexTurnSteerRequestInput {
  requestId: string;
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId: string;
  text: string;
  skills?: readonly CodexDiscoveredSkill[];
}

export interface CodexThreadQueueAddRequestInput {
  requestId: string;
  threadId: string;
  clientUserMessageId: string;
  text: string;
  skills?: readonly CodexDiscoveredSkill[];
}

export interface CodexThreadQueueStartRequestInput {
  requestId: string;
  threadId: string;
  queuedSubmissionId?: string;
}

export type CodexThreadQueueValidation =
  | {
      ok: true;
      submissionId?: string;
      submissions?: readonly { id: string; clientUserMessageId: string }[];
      nextCursor: string | null;
      turnId?: string;
      turnStatus?: 'completed' | 'interrupted' | 'failed' | 'inProgress';
    }
  | { ok: false; reason: 'invalid_response' | 'request_mismatch'; field: string };

export type CodexTurnSteerValidation =
  | { ok: true; turnId: string }
  | { ok: false; reason: 'invalid_response' | 'request_mismatch' | 'turn_mismatch'; field: string };

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
const MAX_QUEUE_ITEMS = 1_000;
const MAX_SKILL_CWDS = 16;
const MAX_SKILLS_PER_CWD = 512;
const MAX_SKILL_ERRORS_PER_CWD = 128;
const MAX_SELECTED_SKILLS = 32;
const MAX_SKILL_NAME = 256;
const MAX_SKILL_DESCRIPTION = 8_192;
const MAX_SKILL_ERROR_MESSAGE = 2_048;
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
  // Installed native app connectors have no VibeSpace approval or scope authority.
  // Authorized VibeSpace tools remain in the explicit dynamicTools manifest.
  const config: Record<string, unknown> = { features: { apps: false, remote_plugin: false } };
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
  return {
    id: requestId,
    method: 'turn/start' as const,
    params: {
      threadId,
      clientUserMessageId,
      input: buildCodexSkillUserInputs(input.text, input.skills),
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

function userTextInput(text: string) {
  if (!text || text.length > MAX_TEXT || UNSAFE_ANSWER_CONTROL.test(text)) {
    throw new Error('Codex user text is invalid.');
  }
  return [{ type: 'text' as const, text, text_elements: [] }];
}

export function buildCodexTurnSteerRequest(input: Readonly<CodexTurnSteerRequestInput>) {
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'turn/steer' as const,
    params: {
      threadId: requireIdentifier(input.threadId, 'thread'),
      expectedTurnId: requireIdentifier(input.expectedTurnId, 'turn'),
      clientUserMessageId: requireIdentifier(input.clientUserMessageId, 'message'),
      input: buildCodexSkillUserInputs(input.text, input.skills),
    },
  };
}

export function validateCodexTurnSteerResponse(
  value: unknown,
  expectedRequestId: string,
  expectedTurnId: string,
): CodexTurnSteerValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  const turnId = requireIdentifier(expectedTurnId, 'turn');
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) return { ok: false, reason: 'request_mismatch', field: 'id' };
  const result = recordOf(envelope.result);
  if (typeof result?.turnId !== 'string' || !SAFE_IDENTIFIER.test(result.turnId)) {
    return { ok: false, reason: 'invalid_response', field: 'turnId' };
  }
  if (result.turnId !== turnId) return { ok: false, reason: 'turn_mismatch', field: 'turnId' };
  return { ok: true, turnId };
}

export function buildCodexThreadQueueAddRequest(input: Readonly<CodexThreadQueueAddRequestInput>) {
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'thread/queue/add' as const,
    params: {
      threadId: requireIdentifier(input.threadId, 'thread'),
      clientUserMessageId: requireIdentifier(input.clientUserMessageId, 'message'),
      input: buildCodexSkillUserInputs(input.text, input.skills),
    },
  };
}

export function validateCodexThreadQueueAddResponse(
  value: unknown,
  expectedRequestId: string,
  expectedMessageId: string,
): CodexThreadQueueValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  const messageId = requireIdentifier(expectedMessageId, 'message');
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) return { ok: false, reason: 'request_mismatch', field: 'id' };
  const submission = recordOf(recordOf(envelope.result)?.queuedSubmission);
  const id = typeof submission?.id === 'string' ? submission.id : '';
  if (!id || !SAFE_IDENTIFIER.test(id) || submission?.clientUserMessageId !== messageId || !Array.isArray(submission?.input)) {
    return { ok: false, reason: 'invalid_response', field: 'queuedSubmission' };
  }
  return { ok: true, submissionId: id, nextCursor: null };
}

export function validateCodexThreadQueueListResponse(
  value: unknown,
  expectedRequestId: string,
): CodexThreadQueueValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) return { ok: false, reason: 'request_mismatch', field: 'id' };
  const result = recordOf(envelope.result);
  if (!result || !Array.isArray(result.data) || result.data.length > MAX_QUEUE_ITEMS) {
    return { ok: false, reason: 'invalid_response', field: 'data' };
  }
  const submissions: { id: string; clientUserMessageId: string }[] = [];
  for (const raw of result.data) {
    const submission = recordOf(raw);
    const id = typeof submission?.id === 'string' ? submission.id : '';
    const clientUserMessageId = typeof submission?.clientUserMessageId === 'string' ? submission.clientUserMessageId : '';
    if (!id || !SAFE_IDENTIFIER.test(id) || !clientUserMessageId || !SAFE_IDENTIFIER.test(clientUserMessageId) || !Array.isArray(submission?.input)) {
      return { ok: false, reason: 'invalid_response', field: 'data' };
    }
    submissions.push({ id, clientUserMessageId });
  }
  const nextCursor = result.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > MAX_CURSOR || UNSAFE_CONTROL.test(nextCursor))) {
    return { ok: false, reason: 'invalid_response', field: 'nextCursor' };
  }
  return { ok: true, submissions, nextCursor };
}

function requireSkillText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || UNSAFE_CONTROL.test(value)) {
    throw new Error(`Codex skill ${label} is invalid.`);
  }
  return value;
}

function skillPathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function buildCodexSkillsListRequest(input: Readonly<CodexSkillsListRequestInput>) {
  if (!Array.isArray(input.cwds) || input.cwds.length === 0 || input.cwds.length > MAX_SKILL_CWDS) {
    throw new Error('Codex skill working-directory count is invalid.');
  }
  const cwds = input.cwds.map((cwd) => requireAbsolutePath(cwd, 'skill working directory'));
  const keys = new Set(cwds.map((cwd) => {
    const path = comparablePath(cwd);
    return typeof path === 'string' && /^[A-Za-z]:\//u.test(path)
      ? path.toLocaleLowerCase('en-US')
      : path;
  }));
  if (keys.size !== cwds.length) throw new Error('Codex skill working directories must be unique.');
  if (input.forceReload !== undefined && typeof input.forceReload !== 'boolean') {
    throw new Error('Codex skill forceReload flag is invalid.');
  }
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'skills/list' as const,
    params: { cwds, ...(input.forceReload === undefined ? {} : { forceReload: input.forceReload }) },
  };
}

/** Force a native re-scan after `skills/changed` or an explicit refresh. */
export function buildCodexSkillsRefreshRequest(input: Readonly<Omit<CodexSkillsListRequestInput, 'forceReload'>>) {
  return buildCodexSkillsListRequest({ ...input, forceReload: true });
}

/** Validate the exact generated Codex 0.153.4 `skills/list` response shape. */
export function validateCodexSkillsListResponse(
  value: unknown,
  expectedRequestId: string,
  expectedCwds: readonly string[],
): CodexSkillsListValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  if (!Array.isArray(expectedCwds) || expectedCwds.length === 0 || expectedCwds.length > MAX_SKILL_CWDS) {
    return { ok: false, reason: 'invalid_response', field: 'expectedCwds' };
  }
  const expectedKeys = new Map<string, string>();
  for (const cwd of expectedCwds) {
    if (typeof cwd !== 'string' || !isAbsolutePath(cwd)) {
      return { ok: false, reason: 'invalid_response', field: 'expectedCwds' };
    }
    const key = skillPathKey(cwd);
    if (expectedKeys.has(key)) return { ok: false, reason: 'invalid_response', field: 'expectedCwds' };
    expectedKeys.set(key, cwd);
  }
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) return { ok: false, reason: 'request_mismatch', field: 'id' };
  const result = recordOf(envelope.result);
  if (!result || !Array.isArray(result.data) || result.data.length !== expectedKeys.size) {
    return { ok: false, reason: 'invalid_response', field: 'data' };
  }
  const seenCwds = new Set<string>();
  const entries: CodexSkillsListEntry[] = [];
  for (const rawEntry of result.data) {
    const entry = recordOf(rawEntry);
    if (!entry || typeof entry.cwd !== 'string' || !isAbsolutePath(entry.cwd)) {
      return { ok: false, reason: 'invalid_response', field: 'cwd' };
    }
    const cwdKey = skillPathKey(entry.cwd);
    const expectedCwd = expectedKeys.get(cwdKey);
    if (!expectedCwd || seenCwds.has(cwdKey)) {
      return { ok: false, reason: 'cwd_mismatch', field: 'cwd' };
    }
    if (!Array.isArray(entry.skills) || entry.skills.length > MAX_SKILLS_PER_CWD ||
        !Array.isArray(entry.errors) || entry.errors.length > MAX_SKILL_ERRORS_PER_CWD) {
      return { ok: false, reason: 'invalid_response', field: 'skills' };
    }
    const skills: CodexDiscoveredSkill[] = [];
    const identities = new Set<string>();
    for (const rawSkill of entry.skills) {
      const skill = recordOf(rawSkill);
      if (!skill || typeof skill.path !== 'string' || !isAbsolutePath(skill.path) ||
          typeof skill.enabled !== 'boolean' ||
          !['user', 'repo', 'system', 'admin'].includes(String(skill.scope)) ||
          (skill.pluginId !== null && typeof skill.pluginId !== 'string')) {
        return { ok: false, reason: 'invalid_response', field: 'skill.path' };
      }
      let name: string;
      let description: string;
      let shortDescription: string | undefined;
      try {
        name = requireSkillText(skill.name, 'name', MAX_SKILL_NAME);
        description = requireSkillText(skill.description, 'description', MAX_SKILL_DESCRIPTION);
        if (skill.shortDescription !== undefined) {
          shortDescription = requireSkillText(skill.shortDescription, 'shortDescription', MAX_SKILL_DESCRIPTION);
        }
        if (skill.pluginId !== null) requireIdentifier(skill.pluginId, 'skill plugin');
      } catch {
        return { ok: false, reason: 'invalid_response', field: 'skill.metadata' };
      }
      const identity = `${name}\u0000${skillPathKey(skill.path)}`;
      if (identities.has(identity)) return { ok: false, reason: 'invalid_response', field: 'skill.duplicate' };
      identities.add(identity);
      skills.push({
        cwd: expectedCwd,
        name,
        description,
        ...(shortDescription === undefined ? {} : { shortDescription }),
        path: skill.path,
        scope: skill.scope as CodexSkillScope,
        enabled: skill.enabled,
        pluginId: skill.pluginId as string | null,
      });
    }
    const errors: CodexSkillDiscoveryError[] = [];
    for (const rawError of entry.errors) {
      const error = recordOf(rawError);
      if (!error || typeof error.path !== 'string' || !isAbsolutePath(error.path)) {
        return { ok: false, reason: 'invalid_response', field: 'error.path' };
      }
      try {
        errors.push({
          cwd: expectedCwd,
          path: error.path,
          message: requireSkillText(error.message, 'error message', MAX_SKILL_ERROR_MESSAGE),
        });
      } catch {
        return { ok: false, reason: 'invalid_response', field: 'error.message' };
      }
    }
    seenCwds.add(cwdKey);
    entries.push({ cwd: expectedCwd, skills, errors });
  }
  if (seenCwds.size !== expectedKeys.size) return { ok: false, reason: 'cwd_mismatch', field: 'cwd' };
  return { ok: true, entries };
}

/** Exact app-server notification used only to invalidate and re-run skills/list. */
export function isCodexSkillsChangedNotification(value: unknown): boolean {
  const notification = recordOf(value);
  const params = recordOf(notification?.params);
  return notification?.method === 'skills/changed' && params !== undefined && Object.keys(params).length === 0;
}

export function buildCodexSkillUserInputs(
  text: string,
  skills: readonly CodexDiscoveredSkill[] = [],
) {
  if (!text || text.length > MAX_TEXT || UNSAFE_ANSWER_CONTROL.test(text)) {
    throw new Error('Codex user text is invalid.');
  }
  if (skills.length > MAX_SELECTED_SKILLS) throw new Error('Codex selected skill count is invalid.');
  const seen = new Set<string>();
  const inputs: (
    | { type: 'text'; text: string; text_elements: never[] }
    | { type: 'skill'; name: string; path: string }
  )[] = [{ type: 'text', text, text_elements: [] }];
  for (const skill of skills) {
    if (!skill || skill.enabled !== true) throw new Error('Codex selected skill is disabled.');
    const name = requireSkillText(skill.name, 'name', MAX_SKILL_NAME);
    const path = requireAbsolutePath(skill.path, 'skill path');
    const identity = `${name}\u0000${skillPathKey(path)}`;
    if (seen.has(identity)) throw new Error('Codex selected skills must be unique.');
    seen.add(identity);
    inputs.push({ type: 'skill' as const, name, path });
  }
  return inputs;
}

export function buildCodexThreadQueueListRequest(input: Readonly<{
  requestId: string;
  threadId: string;
  cursor?: string;
}>) {
  if (input.cursor !== undefined && (
    !input.cursor || input.cursor.length > MAX_CURSOR || UNSAFE_CONTROL.test(input.cursor)
  )) throw new Error('Codex queue cursor is invalid.');
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'thread/queue/list' as const,
    params: {
      threadId: requireIdentifier(input.threadId, 'thread'),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  };
}

export function buildCodexThreadReadRequest(input: Readonly<{
  requestId: string;
  threadId: string;
}>) {
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'thread/read' as const,
    params: { threadId: requireIdentifier(input.threadId, 'thread'), includeTurns: true },
  };
}

export function buildCodexThreadQueueStartRequest(
  input: Readonly<CodexThreadQueueStartRequestInput>,
) {
  return {
    id: requireIdentifier(input.requestId, 'request'),
    method: 'thread/queue/start' as const,
    params: {
      threadId: requireIdentifier(input.threadId, 'thread'),
      ...(input.queuedSubmissionId
        ? { queuedSubmissionId: requireIdentifier(input.queuedSubmissionId, 'queued submission') }
        : {}),
    },
  };
}

export function validateCodexThreadQueueStartResponse(
  value: unknown,
  expectedRequestId: string,
): CodexThreadQueueValidation {
  const requestId = requireIdentifier(expectedRequestId, 'request');
  const envelope = recordOf(value);
  if (!envelope) return { ok: false, reason: 'invalid_response', field: 'envelope' };
  if (envelope.id !== requestId) return { ok: false, reason: 'request_mismatch', field: 'id' };
  const turn = recordOf(recordOf(envelope.result)?.turn);
  const turnId = typeof turn?.id === 'string' ? turn.id : '';
  const turnStatus = turn?.status;
  if (
    !turnId ||
    !SAFE_IDENTIFIER.test(turnId) ||
    (turnStatus !== 'completed' && turnStatus !== 'interrupted' && turnStatus !== 'failed' && turnStatus !== 'inProgress')
  ) {
    return { ok: false, reason: 'invalid_response', field: 'turn' };
  }
  return { ok: true, nextCursor: null, turnId, turnStatus };
}
