import type { ActionRunContext } from '@/lib/actions/types';
import type { JarvisAuthorityBoundResult, JarvisRun } from '@/lib/jarvis/contracts/execution';
import type { JarvisApprovalV1 } from '@/lib/jarvis/contracts';
import type {
  JarvisCanonicalActionExecutionResult,
  JarvisKernelActionPort,
} from '@/lib/jarvis/approvalEngine';
import {
  validateJarvisRequestAttempt,
  type JarvisRequestAttempt,
} from '@/lib/jarvis/requestEnvelope';
import { canonicalizeBrowserJson, classifyRisk } from './browserActions';
import type {
  BrowserActionRisk,
  BrowserControlMode,
  BrowserJsonValue,
  BrowserReviewedAction,
} from './browserTypes';

export const BROWSER_OPERATOR_CAPABILITY_ID = 'browser.operator' as const;

export type BrowserApprovalAdapterErrorCode =
  | 'invalid_dependencies'
  | 'mutable_input'
  | 'invalid_record'
  | 'not_pending'
  | 'user_only'
  | 'account_mismatch'
  | 'run_mismatch'
  | 'context_mismatch'
  | 'secret_shaped_input';

export class BrowserApprovalAdapterError extends Error {
  constructor(readonly code: BrowserApprovalAdapterErrorCode) {
    super(`Browser approval adapter rejected: ${code}.`);
    this.name = 'BrowserApprovalAdapterError';
  }
}

export type BrowserApprovalParentReference = Readonly<{
  parentRun: JarvisRun;
  attempt: JarvisRequestAttempt;
  context: ActionRunContext;
  controlMode: BrowserControlMode;
}>;

export type BrowserCanonicalApprovalParametersV1 = Readonly<{
  schemaVersion: 1;
  reviewId: string;
  origin: string;
  tabId: string;
  frameId: string | null;
  target: Readonly<Record<string, BrowserJsonValue>>;
  parameters: Readonly<Record<string, BrowserJsonValue>>;
  parametersHash: string;
  reviewedHash: string;
  expectedEffect: string;
  reviewedRisk: BrowserActionRisk;
  capability: Readonly<{
    id: typeof BROWSER_OPERATOR_CAPABILITY_ID;
    operation: string;
  }>;
}>;

type BrowserActionPort = Pick<JarvisKernelActionPort, 'create' | 'executeAutoApprovedSafe'>;

export type BrowserApprovalAdapterResult =
  | Readonly<{
      kind: 'safe_execution';
      result: JarvisAuthorityBoundResult<JarvisCanonicalActionExecutionResult>;
    }>
  | Readonly<{
      kind: 'approval_created';
      result: JarvisAuthorityBoundResult<JarvisApprovalV1>;
    }>;

const REVIEWED_ACTION_KEYS = [
  'id',
  'accountId',
  'requester',
  'kind',
  'actionVersion',
  'origin',
  'tabId',
  'frameId',
  'target',
  'parameters',
  'parametersHash',
  'reviewedHash',
  'expectedEffect',
  'risk',
  'safeSummary',
  'status',
  'requestedAt',
  'expiresAt',
  'result',
] as const;

const ALLOWED_BROWSER_OPERATIONS = new Set([
  'browser.open',
  'browser.newTab',
  'browser.closeTab',
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.wait',
  'browser.inspect',
  'browser.readPage',
  'browser.findText',
  'browser.click',
  'browser.type',
  'browser.press',
  'browser.select',
  'browser.check',
  'browser.uncheck',
  'browser.upload',
  'browser.download',
  'browser.scroll',
  'browser.screenshot',
  'browser.getConsoleErrors',
  'browser.getCurrentUrl',
  'browser.listTabs',
  'browser.switchTab',
  'browser.submit',
  'browser.delete',
  'browser.purchase',
  'browser.pay',
  'browser.login',
  'browser.signIn',
  'browser.checkout',
  'browser.stop',
]);

const REQUEST_ATTEMPT_KEYS = ['kind', 'requestId', 'runId', 'attemptNumber'] as const;
const RETRY_ATTEMPT_KEYS = [
  ...REQUEST_ATTEMPT_KEYS,
  'previousRequestId',
  'previousRunId',
  'previousAttemptNumber',
] as const;

const PROTECTED_PARAMETER_KEYS = new Set([
  'password',
  'passphrase',
  'cookie',
  'setcookie',
  'authorization',
  'authorizationheader',
  'authheader',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'token',
  'clientsecret',
  'privatekey',
  'recoverycode',
  'recoveryphrase',
  'seedphrase',
  'mnemonic',
  'credentialhandle',
  'credentialhandleid',
  'secrethandle',
  'secrethandleid',
]);

function reject(code: BrowserApprovalAdapterErrorCode): never {
  throw new BrowserApprovalAdapterError(code);
}

function assertExactDataKeys(
  value: object,
  allowed: readonly string[],
  code: BrowserApprovalAdapterErrorCode,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) reject(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) reject(code);
  }
}

function isPlainDataObject(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredOwnDataValue(
  value: object,
  key: string,
  code: BrowserApprovalAdapterErrorCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) reject(code);
  return descriptor.value;
}

function optionalOwnDataValue(
  value: object,
  key: string,
  code: BrowserApprovalAdapterErrorCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) reject(code);
  return descriptor.value;
}

function stableText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\u0000')
  );
}

function isDeeplyFrozenData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return false;
    if (!isDeeplyFrozenData(descriptor.value, seen)) return false;
  }
  return true;
}

function protectedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (PROTECTED_PARAMETER_KEYS.has(normalized)) return true;
  return [
    'password',
    'passphrase',
    'cookie',
    'authorization',
    'apikey',
    'token',
    'clientsecret',
    'privatekey',
    'recoverycode',
    'recoveryphrase',
    'seedphrase',
    'mnemonic',
    'credentialhandle',
    'secrethandle',
  ].some((stem) => normalized.includes(stem));
}

function protectedText(value: string): boolean {
  return (
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value) ||
    /\b(?:bearer|basic)\s+[a-z0-9+/._=-]{8,}\b/i.test(value) ||
    /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/.test(value) ||
    /\b(?:sk|pk|api)[-_][a-z0-9_-]{16,}\b/i.test(value) ||
    /(?:password|cookie|authorization|api[_ -]?key|access[_ -]?token|client[_ -]?secret|recovery[_ -]?code)\s*[:=]/i.test(
      value,
    )
  );
}

function containsProtectedShape(value: BrowserJsonValue): boolean {
  if (typeof value === 'string') return protectedText(value);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsProtectedShape);
  return Object.entries(value).some(
    ([key, nested]) =>
      protectedKey(key) ||
      (key.toLowerCase() === 'secret' && nested === true) ||
      containsProtectedShape(nested),
  );
}

function canonicalCopy<T>(value: BrowserJsonValue): T {
  return JSON.parse(canonicalizeBrowserJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function validateDependencies(
  dependencies: Readonly<{ actions: BrowserActionPort }>,
): BrowserActionPort {
  if (!isPlainDataObject(dependencies)) reject('invalid_dependencies');
  assertExactDataKeys(dependencies, ['actions'], 'invalid_dependencies');
  const actions = requiredOwnDataValue(dependencies, 'actions', 'invalid_dependencies');
  if (!isPlainDataObject(actions)) reject('invalid_dependencies');
  assertExactDataKeys(actions, ['create', 'executeAutoApprovedSafe'], 'invalid_dependencies');
  const create = requiredOwnDataValue(actions, 'create', 'invalid_dependencies');
  const executeAutoApprovedSafe = requiredOwnDataValue(
    actions,
    'executeAutoApprovedSafe',
    'invalid_dependencies',
  );
  if (typeof create !== 'function' || typeof executeAutoApprovedSafe !== 'function') {
    reject('invalid_dependencies');
  }
  return Object.freeze({ create, executeAutoApprovedSafe }) as BrowserActionPort;
}

function validateRequester(action: Readonly<BrowserReviewedAction>): Readonly<{
  agentId: string;
  runId: string | undefined;
}> {
  const requester = requiredOwnDataValue(action, 'requester', 'invalid_record');
  if (!requester || typeof requester !== 'object' || Array.isArray(requester)) {
    reject('invalid_record');
  }
  const kind = requiredOwnDataValue(requester, 'kind', 'invalid_record');
  const agent = requiredOwnDataValue(requester, 'agent', 'invalid_record');
  if (kind !== 'agent' || !agent || typeof agent !== 'object' || Array.isArray(agent)) {
    reject('invalid_record');
  }
  const agentId = requiredOwnDataValue(agent, 'id', 'invalid_record');
  const runId = optionalOwnDataValue(requester, 'runId', 'invalid_record');
  if (!stableText(agentId) || (runId !== undefined && !stableText(runId))) {
    reject('invalid_record');
  }
  return Object.freeze({ agentId, runId });
}

function validateRecord(action: Readonly<BrowserReviewedAction>): Readonly<{
  agentId: string;
  runId: string | undefined;
}> {
  if (!action || typeof action !== 'object') reject('invalid_record');
  assertExactDataKeys(action, REVIEWED_ACTION_KEYS, 'invalid_record');
  if (!isDeeplyFrozenData(action)) reject('mutable_input');
  if (action.status !== 'pending') reject('not_pending');
  if (
    action.actionVersion !== 1 ||
    !stableText(action.id) ||
    !stableText(action.accountId) ||
    !stableText(action.kind) ||
    !ALLOWED_BROWSER_OPERATIONS.has(action.kind) ||
    !stableText(action.origin) ||
    !stableText(action.tabId) ||
    !stableText(action.parametersHash) ||
    !stableText(action.reviewedHash) ||
    !stableText(action.expectedEffect) ||
    !['safe', 'confirm', 'dangerous'].includes(action.risk) ||
    !Number.isSafeInteger(action.requestedAt) ||
    !Number.isSafeInteger(action.expiresAt) ||
    action.expiresAt <= action.requestedAt
  ) {
    reject('invalid_record');
  }
  canonicalizeBrowserJson(action.parameters);
  canonicalizeBrowserJson(action.target as unknown as BrowserJsonValue);
  if (
    containsProtectedShape(action.parameters) ||
    containsProtectedShape(action.target as unknown as BrowserJsonValue) ||
    protectedText(action.expectedEffect)
  ) {
    reject('secret_shaped_input');
  }
  if (classifyRisk(action.kind, action.parameters) !== action.risk) reject('invalid_record');
  return validateRequester(action);
}

function validateAttempt(
  attempt: JarvisRequestAttempt,
): Readonly<{ requestId: string; runId: string; attemptNumber: number }> {
  if (!isPlainDataObject(attempt)) reject('context_mismatch');
  const kind = requiredOwnDataValue(attempt, 'kind', 'context_mismatch');
  const keys =
    kind === 'transport_retry' || kind === 'logical_retry'
      ? RETRY_ATTEMPT_KEYS
      : REQUEST_ATTEMPT_KEYS;
  assertExactDataKeys(attempt, keys, 'context_mismatch');
  for (const key of keys) requiredOwnDataValue(attempt, key, 'context_mismatch');
  try {
    const identity = validateJarvisRequestAttempt(attempt);
    if (!stableText(identity.runId) || !stableText(identity.requestId)) {
      reject('context_mismatch');
    }
    return identity;
  } catch (error) {
    if (error instanceof BrowserApprovalAdapterError) throw error;
    reject('context_mismatch');
  }
}

function validateParent(
  action: Readonly<BrowserReviewedAction>,
  parent: BrowserApprovalParentReference,
  requester: Readonly<{ agentId: string; runId: string | undefined }>,
): BrowserApprovalParentReference {
  if (!isPlainDataObject(parent)) reject('context_mismatch');
  assertExactDataKeys(
    parent,
    ['parentRun', 'attempt', 'context', 'controlMode'],
    'context_mismatch',
  );
  const parentRun = requiredOwnDataValue(parent, 'parentRun', 'context_mismatch');
  const attempt = requiredOwnDataValue(parent, 'attempt', 'context_mismatch');
  const context = requiredOwnDataValue(parent, 'context', 'context_mismatch');
  const controlMode = requiredOwnDataValue(parent, 'controlMode', 'context_mismatch');
  if (
    !parentRun ||
    typeof parentRun !== 'object' ||
    Array.isArray(parentRun) ||
    !attempt ||
    typeof attempt !== 'object' ||
    Array.isArray(attempt) ||
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context)
  ) {
    reject('context_mismatch');
  }
  if (
    !Object.isFrozen(parent) ||
    !Object.isFrozen(parentRun) ||
    !Object.isFrozen(attempt) ||
    !Object.isFrozen(context)
  ) {
    reject('mutable_input');
  }
  if (controlMode === 'user_only') reject('user_only');
  if (
    !['ask_every_action', 'allow_safe_session', 'agent_controlled'].includes(
      controlMode as BrowserControlMode,
    )
  ) {
    reject('context_mismatch');
  }
  const parentRunId = requiredOwnDataValue(parentRun, 'id', 'run_mismatch');
  const parentAccountId = requiredOwnDataValue(parentRun, 'accountId', 'account_mismatch');
  const parentAgentId = requiredOwnDataValue(parentRun, 'agentId', 'run_mismatch');
  if (!stableText(parentRunId) || !stableText(parentAgentId)) reject('run_mismatch');
  if (!stableText(parentAccountId) || action.accountId !== parentAccountId) {
    reject('account_mismatch');
  }
  const attemptIdentity = validateAttempt(attempt as JarvisRequestAttempt);
  if (
    attemptIdentity.runId !== parentRunId ||
    (requester.runId !== undefined && requester.runId !== parentRunId) ||
    requester.agentId !== parentAgentId
  ) {
    reject('run_mismatch');
  }
  const contextSource = requiredOwnDataValue(context, 'source', 'context_mismatch');
  const contextAccountId = requiredOwnDataValue(context, 'accountId', 'context_mismatch');
  const contextRunId = requiredOwnDataValue(context, 'runId', 'context_mismatch');
  const contextRequestId = requiredOwnDataValue(context, 'requestId', 'context_mismatch');
  const contextAttemptNumber = requiredOwnDataValue(context, 'attemptNumber', 'context_mismatch');
  const contextCallId = requiredOwnDataValue(context, 'callId', 'context_mismatch');
  if (
    contextSource !== 'ai' ||
    !stableText(contextAccountId) ||
    !stableText(contextRunId) ||
    !stableText(contextRequestId) ||
    !Number.isSafeInteger(contextAttemptNumber) ||
    (contextAttemptNumber as number) <= 0 ||
    contextAccountId !== parentAccountId ||
    contextRunId !== parentRunId ||
    contextRequestId !== attemptIdentity.requestId ||
    contextAttemptNumber !== attemptIdentity.attemptNumber ||
    contextCallId !== action.id
  ) {
    reject('context_mismatch');
  }
  return Object.freeze({
    parentRun: parentRun as JarvisRun,
    attempt: attempt as JarvisRequestAttempt,
    context: context as ActionRunContext,
    controlMode: controlMode as BrowserControlMode,
  });
}

function canonicalParameters(
  action: Readonly<BrowserReviewedAction>,
): BrowserCanonicalApprovalParametersV1 {
  const value: BrowserCanonicalApprovalParametersV1 = {
    schemaVersion: 1,
    reviewId: action.id,
    origin: action.origin,
    tabId: action.tabId,
    frameId: action.frameId ?? null,
    target: canonicalCopy(action.target as unknown as BrowserJsonValue),
    parameters: canonicalCopy(action.parameters),
    parametersHash: action.parametersHash,
    reviewedHash: action.reviewedHash,
    expectedEffect: action.expectedEffect,
    reviewedRisk: action.risk,
    capability: {
      id: BROWSER_OPERATOR_CAPABILITY_ID,
      operation: action.kind,
    },
  };
  return deepFreeze(canonicalCopy(value as unknown as BrowserJsonValue));
}

export function createBrowserApprovalAdapter(
  dependencies: Readonly<{ actions: BrowserActionPort }>,
): Readonly<{
  submit(
    action: Readonly<BrowserReviewedAction>,
    parent: BrowserApprovalParentReference,
  ): Promise<BrowserApprovalAdapterResult>;
}> {
  const actions = validateDependencies(dependencies);
  return Object.freeze({
    async submit(action, parent): Promise<BrowserApprovalAdapterResult> {
      const requester = validateRecord(action);
      const validatedParent = validateParent(action, parent, requester);
      const input = Object.freeze({
        parentRun: validatedParent.parentRun,
        attempt: validatedParent.attempt,
        actionId: action.kind,
        actionVersion: action.actionVersion,
        params: canonicalParameters(action),
        expiresAt: action.expiresAt,
      });
      if (action.risk === 'safe') {
        const result = await actions.executeAutoApprovedSafe(
          Object.freeze({ ...input, context: validatedParent.context }),
        );
        return Object.freeze({ kind: 'safe_execution', result });
      }
      const result = await actions.create(input);
      return Object.freeze({ kind: 'approval_created', result });
    },
  });
}
