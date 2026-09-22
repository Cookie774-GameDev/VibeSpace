import { redactHarnessText } from '@/lib/harness/errors';

const MAX_MESSAGE_LENGTH = 2_048;
const MAX_CODE_LENGTH = 128;
const MAX_ID_LENGTH = 512;
const INTERNAL_ATTEMPT_FAILURE_CODE = 'jarvis_provider_attempt_failure';
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

const GENERIC_PROVIDER_FAILURE_MESSAGES = new Set([
  'The provider request failed.',
  'Provider request failed.',
  'OpenCode session failed.',
  'OpenCode session entered an error state.',
  'OpenCode reported a provider session error.',
]);

function providerErrorSpecificity(details: Readonly<ProviderErrorDetails>): number {
  let score = GENERIC_PROVIDER_FAILURE_MESSAGES.has(details.message) ? 0 : 16;
  if (details.code) score += 8;
  if (details.retryable !== undefined) score += 3;
  if (details.retryAfterMs !== undefined) score += 3;
  if (details.resetAt !== undefined) score += 3;
  if (details.providerId) score += 1;
  if (details.modelId) score += 1;
  return score;
}

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

const RATE_LIMIT_ERROR_PATTERN = /\b429\b|too[\s_-]+many[\s_-]+requests?|rate[\s_-]*limit(?:ed|ing)?|quota[\s_-]*(?:exhausted|exceeded|limit)|usage[\s_-]*limit|resource[\s_-]*exhausted/iu;
const USAGE_LIMIT_ERROR_PATTERN =
  /\b(?:quota|usage)(?:[\s_-]+(?:is|was|has|have|been))?(?:[\s_-]+(?:exhaust(?:ed|ion)?|exceed(?:ed|s|ing)?|limit(?:ed|ing)?|reach(?:ed|es)?))+\b|\bresource[\s_-]*exhaust(?:ed|ion)?\b/iu;

export interface ProviderErrorPresentation {
  title: string;
  message: string;
  usageLimit: boolean;
}

/** True when the bounded provider evidence identifies a request-rate or quota limit. */
export function isProviderRateLimitError(
  details: Pick<ProviderErrorDetails, 'message' | 'code'>,
): boolean {
  return RATE_LIMIT_ERROR_PATTERN.test(`${details.code ?? ''} ${details.message}`);
}

/** True when bounded provider evidence indicates exhausted quota or usage. */
export function isProviderUsageLimitError(
  details: Pick<ProviderErrorDetails, 'message' | 'code'>,
): boolean {
  return USAGE_LIMIT_ERROR_PATTERN.test(`${details.code ?? ''} ${details.message}`);
}

/**
 * Convert provider jargon into user-facing copy without discarding the
 * structured diagnostics rendered alongside it. Provider-specific wording is
 * retained for errors that are not recognizably a rate or quota limit.
 */
export function presentProviderError(
  details: Readonly<ProviderErrorDetails>,
): ProviderErrorPresentation {
  if (isProviderUsageLimitError(details)) {
    return Object.freeze({
      title: 'Usage limit reached',
      message:
        "The provider's current usage limit was reached for this request. Review the route and connection below, then retry after the limit resets or switch to another available model or credential.",
      usageLimit: true,
    });
  }

  if (isProviderRateLimitError(details)) {
    return Object.freeze({
      title: 'Too many requests',
      message:
        'The provider is temporarily rate limited. Wait a moment and try again, or switch to another available model or credential.',
      usageLimit: false,
    });
  }

  return Object.freeze({
    title: 'Provider error',
    message: details.message,
    usageLimit: false,
  });
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
        // This is an internal attempt wrapper marker, not a provider error
        // code. Keep it on the raw Error for execution classification, while
        // allowing an upstream code from the cause to survive in the public
        // provider-error envelope. If no upstream code exists, omission is
        // the truthful representation of an unknown provider code.
        ...(sourceCode && sourceCode !== INTERNAL_ATTEMPT_FAILURE_CODE ? { code: sourceCode } : {}),
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

/**
 * Merge independent failure evidence without letting a later generic session
 * status erase a richer upstream provider failure. Verified fallback route
 * identity remains authoritative.
 */
export function richestProviderErrorDetails(
  errors: readonly unknown[],
  fallback: ProviderErrorContext = {},
): Readonly<ProviderErrorDetails> {
  const candidates = errors
    .filter((error) => error !== undefined && error !== null)
    .map((error) => providerErrorDetails(error, fallback))
    .sort((left, right) => providerErrorSpecificity(right) - providerErrorSpecificity(left));

  if (candidates.length === 0) return sanitizeDetails(fallback);

  const richest = candidates[0]!;
  const merged: ProviderErrorContext = {
    ...fallback,
    message: richest.message,
  };
  for (const candidate of candidates) {
    if (merged.code === undefined && candidate.code !== undefined) merged.code = candidate.code;
    if (merged.retryable === undefined && candidate.retryable !== undefined) {
      merged.retryable = candidate.retryable;
    }
    if (merged.retryAfterMs === undefined && candidate.retryAfterMs !== undefined) {
      merged.retryAfterMs = candidate.retryAfterMs;
    }
    if (merged.resetAt === undefined && candidate.resetAt !== undefined) {
      merged.resetAt = candidate.resetAt;
    }
    if (merged.providerId === undefined && candidate.providerId !== undefined) {
      merged.providerId = candidate.providerId;
    }
    if (merged.modelId === undefined && candidate.modelId !== undefined) {
      merged.modelId = candidate.modelId;
    }
    if (merged.connectionId === undefined && candidate.connectionId !== undefined) {
      merged.connectionId = candidate.connectionId;
    }
    if (merged.requestId === undefined && candidate.requestId !== undefined) {
      merged.requestId = candidate.requestId;
    }
    if (merged.runId === undefined && candidate.runId !== undefined) {
      merged.runId = candidate.runId;
    }
  }
  return sanitizeDetails(merged);
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
