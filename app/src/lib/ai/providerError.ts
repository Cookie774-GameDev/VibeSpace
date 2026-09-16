import { redactHarnessText } from '@/lib/harness/errors';

const MAX_MESSAGE_LENGTH = 2_048;
const MAX_CODE_LENGTH = 128;
const MAX_ID_LENGTH = 512;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export interface ProviderErrorDetails {
  message: string;
  code?: string;
  providerId?: string;
  modelId?: string;
  connectionId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  resetAt?: number;
  requestId?: string;
  runId?: string;
}

export type ProviderErrorContext = Partial<Omit<ProviderErrorDetails, 'message'>> & {
  message?: string;
};

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redactHarnessText(value).replace(UNSAFE_CONTROL_CHARACTERS, ' ').trim();
  return text.length > 0 && text.length <= maximum ? text : text.slice(0, maximum) || undefined;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sourceOf(error: unknown): Record<string, unknown> | undefined {
  const value = record(error);
  return record(value?.details) ?? value;
}

function readString(source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = boundedText(source?.[key], MAX_ID_LENGTH);
    if (value) return value;
  }
  return undefined;
}

function readMessage(error: unknown, source: Record<string, unknown> | undefined): string | undefined {
  return boundedText(source?.message, MAX_MESSAGE_LENGTH) ??
    boundedText(error instanceof Error ? error.message : undefined, MAX_MESSAGE_LENGTH);
}

function readCause(error: unknown): unknown {
  const source = record(error);
  return source?.cause;
}

function sanitizeDetails(input: ProviderErrorContext): Readonly<ProviderErrorDetails> {
  const message = boundedText(input.message, MAX_MESSAGE_LENGTH) ?? 'The provider request failed.';
  const code = boundedText(input.code, MAX_CODE_LENGTH);
  const providerId = boundedText(input.providerId, MAX_ID_LENGTH);
  const modelId = boundedText(input.modelId, MAX_ID_LENGTH);
  const connectionId = boundedText(input.connectionId, MAX_ID_LENGTH);
  const retryAfterMs = boundedNumber(input.retryAfterMs);
  const resetAt = boundedNumber(input.resetAt);
  const requestId = boundedText(input.requestId, MAX_ID_LENGTH);
  const runId = boundedText(input.runId, MAX_ID_LENGTH);
  const retryable = boundedBoolean(input.retryable);
  return Object.freeze({
    message,
    ...(code ? { code } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(requestId ? { requestId } : {}),
    ...(runId ? { runId } : {}),
  });
}

/**
 * Error used at the provider/router boundary. The details are bounded and
 * redacted before they can reach the chat renderer or durable transcript.
 */
export class ProviderRuntimeError extends Error {
  readonly details: Readonly<ProviderErrorDetails>;

  constructor(input: ProviderErrorContext) {
    const details = sanitizeDetails(input);
    super(details.message);
    this.name = 'ProviderRuntimeError';
    this.details = details;
  }
}

/**
 * Recover provider metadata through an attempt wrapper without exposing the
 * wrapper's generic transport message. Unknown errors keep a safe message and
 * the caller's verified identity context.
 */
export function providerErrorDetails(
  error: unknown,
  fallback: ProviderErrorContext = {},
): Readonly<ProviderErrorDetails> {
  let current: unknown = error;
  let details: ProviderErrorContext = { ...fallback };
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const source = sourceOf(current);
    if (source) {
      const sourceCode = readString(source, 'code', 'errorCode', 'error_code');
      const sourceProviderId = readString(source, 'providerId', 'provider', 'provider_id');
      const sourceModelId = readString(source, 'modelId', 'model', 'model_id');
      const sourceConnectionId = readString(source, 'connectionId', 'connection', 'connection_id');
      const sourceRequestId = readString(source, 'requestId', 'request_id');
      const sourceRunId = readString(source, 'runId', 'run_id');
      const sourceRetryable = boundedBoolean(source.retryable);
      const sourceRecoverable = boundedBoolean(source.recoverable);
      const sourceRetryAfterMs = boundedNumber(
        source.retryAfterMs ?? source.retry_after_ms ?? source.retryAfter ?? source.retry_after,
      );
      const sourceResetAt = boundedNumber(source.resetAt ?? source.reset_at ?? source.resetsAt);
      details = {
        ...details,
        ...(readMessage(current, source) ? { message: readMessage(current, source) } : {}),
        ...(sourceCode ? { code: sourceCode } : {}),
        // A caller's route binding is authoritative. Provider payloads may
        // contain display labels or stale aliases that must not relabel it.
        ...(details.providerId === undefined && sourceProviderId ? { providerId: sourceProviderId } : {}),
        ...(details.modelId === undefined && sourceModelId ? { modelId: sourceModelId } : {}),
        ...(details.connectionId === undefined && sourceConnectionId ? { connectionId: sourceConnectionId } : {}),
        ...(sourceRetryable !== undefined ? { retryable: sourceRetryable } : {}),
        ...(sourceRecoverable !== undefined && details.retryable === undefined
          ? { retryable: sourceRecoverable }
          : {}),
        ...(sourceRetryAfterMs !== undefined ? { retryAfterMs: sourceRetryAfterMs } : {}),
        ...(sourceResetAt !== undefined ? { resetAt: sourceResetAt } : {}),
        ...(details.requestId === undefined && sourceRequestId ? { requestId: sourceRequestId } : {}),
        ...(details.runId === undefined && sourceRunId ? { runId: sourceRunId } : {}),
      };
    }
    current = readCause(current);
  }
  return sanitizeDetails(details);
}

export function providerErrorFromEvent(
  event: Readonly<ProviderErrorContext>,
  fallback: ProviderErrorContext = {},
): ProviderRuntimeError {
  const routeIdentity = {
    ...(fallback.providerId !== undefined
      ? { providerId: fallback.providerId }
      : event.providerId !== undefined
        ? { providerId: event.providerId }
        : {}),
    ...(fallback.modelId !== undefined
      ? { modelId: fallback.modelId }
      : event.modelId !== undefined
        ? { modelId: event.modelId }
        : {}),
    ...(fallback.connectionId !== undefined
      ? { connectionId: fallback.connectionId }
      : event.connectionId !== undefined
        ? { connectionId: event.connectionId }
        : {}),
    ...(fallback.requestId !== undefined
      ? { requestId: fallback.requestId }
      : event.requestId !== undefined
        ? { requestId: event.requestId }
        : {}),
    ...(fallback.runId !== undefined
      ? { runId: fallback.runId }
      : event.runId !== undefined
        ? { runId: event.runId }
        : {}),
  };
  return new ProviderRuntimeError({ ...fallback, ...event, ...routeIdentity });
}

export function isProviderRuntimeError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof ProviderRuntimeError) return true;
    current = readCause(current);
  }
  return false;
}
