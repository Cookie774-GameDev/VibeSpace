export type ProviderGoalStopReason = 'completed' | 'length' | 'tool_call' | 'cancelled' | 'error';

export type ProviderGoalPayload =
  | Readonly<{ kind: 'text_delta'; text: string }>
  | Readonly<{ kind: 'reasoning_summary'; summary: string }>
  | Readonly<{
      kind: 'tool_call';
      callId: string;
      toolName: string;
      argumentsHash: string;
    }>
  | Readonly<{
      kind: 'structured_output';
      schemaId: string;
      resultRef: `jresult_${string}`;
    }>
  | Readonly<{
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
    }>
  | Readonly<{ kind: 'error'; category: string; retryable: boolean; safeMessage: string }>
  | Readonly<{ kind: 'continuation'; continuationId: string }>
  | Readonly<{ kind: 'stop'; reason: ProviderGoalStopReason }>;

export type NormalizedProviderGoalEvent = Readonly<{
  schemaVersion: 1;
  providerId: string;
  modelId: string;
  connectionId?: string;
  requestId: string;
  sequence: number;
  observedAt: number;
  payload: ProviderGoalPayload;
}>;

export interface ProviderGoalAdapter {
  readonly identity: Readonly<{
    providerId: string;
    modelId: string;
    connectionId?: string;
    requestId: string;
  }>;
  push(payload: ProviderGoalPayload, observedAt: number): NormalizedProviderGoalEvent;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/iu;
const RESULT_REF = /^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const SECRET =
  /\b(?:bearer\s+\S+|password|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|secret)\b/iu;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e]/u;
const STOP_REASONS = new Set<ProviderGoalStopReason>([
  'completed',
  'length',
  'tool_call',
  'cancelled',
  'error',
]);

function stableText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum && !CONTROL.test(value)
  );
}

function tokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validatePayload(payload: ProviderGoalPayload): ProviderGoalPayload {
  switch (payload.kind) {
    case 'text_delta':
      if (!stableText(payload.text, 32_768)) break;
      return Object.freeze({ kind: payload.kind, text: payload.text });
    case 'reasoning_summary':
      if (!stableText(payload.summary, 1_000)) break;
      return Object.freeze({ kind: payload.kind, summary: payload.summary });
    case 'tool_call':
      if (
        !SAFE_ID.test(payload.callId) ||
        !SAFE_ID.test(payload.toolName) ||
        !SHA256.test(payload.argumentsHash)
      ) {
        break;
      }
      return Object.freeze({
        kind: payload.kind,
        callId: payload.callId,
        toolName: payload.toolName,
        argumentsHash: payload.argumentsHash.toLowerCase(),
      });
    case 'structured_output':
      if (!SAFE_ID.test(payload.schemaId) || !RESULT_REF.test(payload.resultRef)) break;
      return Object.freeze({
        kind: payload.kind,
        schemaId: payload.schemaId,
        resultRef: payload.resultRef,
      });
    case 'usage':
      if (
        !tokenCount(payload.inputTokens) ||
        !tokenCount(payload.outputTokens) ||
        (payload.cachedInputTokens !== undefined && !tokenCount(payload.cachedInputTokens))
      ) {
        break;
      }
      return Object.freeze({
        kind: payload.kind,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        ...(payload.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: payload.cachedInputTokens }),
      });
    case 'error':
      if (
        !SAFE_ID.test(payload.category) ||
        typeof payload.retryable !== 'boolean' ||
        !stableText(payload.safeMessage, 500) ||
        SECRET.test(payload.safeMessage)
      ) {
        break;
      }
      return Object.freeze({
        kind: payload.kind,
        category: payload.category,
        retryable: payload.retryable,
        safeMessage: payload.safeMessage,
      });
    case 'continuation':
      if (!SAFE_ID.test(payload.continuationId)) break;
      return Object.freeze({ kind: payload.kind, continuationId: payload.continuationId });
    case 'stop':
      if (!STOP_REASONS.has(payload.reason)) break;
      return Object.freeze({ kind: payload.kind, reason: payload.reason });
  }
  throw new Error('Invalid provider goal event payload.');
}

export function createProviderGoalAdapter(input: {
  providerId: string;
  modelId: string;
  connectionId?: string;
  requestId: string;
  startedAt: number;
}): ProviderGoalAdapter {
  if (
    !SAFE_ID.test(input.providerId) ||
    !SAFE_ID.test(input.modelId) ||
    (input.connectionId !== undefined && !SAFE_ID.test(input.connectionId)) ||
    !SAFE_ID.test(input.requestId) ||
    !Number.isFinite(input.startedAt) ||
    input.startedAt < 0
  ) {
    throw new Error('Invalid provider goal adapter identity.');
  }
  const identity = Object.freeze({
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    requestId: input.requestId,
  });
  let sequence = 0;
  let lastObservedAt = input.startedAt;
  let stopped = false;
  return Object.freeze<ProviderGoalAdapter>({
    identity,
    push(payload, observedAt) {
      if (stopped || !Number.isFinite(observedAt) || observedAt < lastObservedAt) {
        throw new Error('Invalid provider goal event sequence.');
      }
      const normalized = validatePayload(payload);
      sequence += 1;
      lastObservedAt = observedAt;
      if (normalized.kind === 'stop') stopped = true;
      return Object.freeze({
        schemaVersion: 1,
        ...identity,
        sequence,
        observedAt,
        payload: normalized,
      });
    },
  });
}
