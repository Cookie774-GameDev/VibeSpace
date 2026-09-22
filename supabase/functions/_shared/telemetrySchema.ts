/**
 * The server-side wire contract for account-scoped product telemetry.
 *
 * Keep this module dependency-free: the web exporter and Edge Functions both
 * use it, and validation must not depend on a provider, database, or runtime
 * global. The authenticated account is deliberately absent from the client
 * payload; the ingest function supplies it from the verified bearer token.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const MAX_TELEMETRY_EVENTS_PER_BATCH = 32;
export const MAX_TELEMETRY_BATCH_BYTES = 64 * 1024;
export const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TELEMETRY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const TELEMETRY_MAX_METRIC_VALUE = Number.MAX_SAFE_INTEGER;
export const TELEMETRY_MAX_APP_VERSION_LENGTH = 64;

export const TELEMETRY_EVENT_NAMES = [
  'token_optimization',
  'context_retrieval',
  'repository_ranking',
  'provider_request',
  'native_capability',
  'browser_goal',
  'evaluation',
  'feature_open',
  'tool_outcome',
  'diagnostic',
] as const;

export const TELEMETRY_METRIC_NAMES = [
  'estimatedInputTokensBefore',
  'estimatedInputTokensAfter',
  'estimatedTokensSaved',
  'actualInputTokens',
  'actualOutputTokens',
  'actualReasoningTokens',
  'cachedInputTokens',
  'selectedSourceCount',
  'excludedSourceCount',
  'retryCount',
  'durationMs',
] as const;

export const TELEMETRY_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const;
export const TELEMETRY_OUTCOMES = ['ok', 'error', 'cancelled', 'unknown'] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryMetricName = (typeof TELEMETRY_METRIC_NAMES)[number];
export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number];
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];
export type TelemetryMetrics = Partial<Record<TelemetryMetricName, number>>;

export interface TelemetryEvent {
  eventId: string;
  eventName: TelemetryEventName;
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  occurredAt: number;
  appVersion: string;
  platform: TelemetryPlatform;
  metrics: TelemetryMetrics;
  outcome: TelemetryOutcome;
}

export interface TelemetryBatch {
  batchId: string;
  events: readonly TelemetryEvent[];
}

export type TelemetrySchemaErrorCode =
  | 'invalid_json'
  | 'payload_too_large'
  | 'invalid_batch'
  | 'invalid_event'
  | 'invalid_metric'
  | 'timestamp_out_of_retention';

export class TelemetrySchemaError extends Error {
  readonly code: TelemetrySchemaErrorCode;

  constructor(code: TelemetrySchemaErrorCode, message: string) {
    super(message);
    this.name = 'TelemetrySchemaError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EVENT_KEYS = new Set([
  'eventId',
  'eventName',
  'schemaVersion',
  'occurredAt',
  'appVersion',
  'platform',
  'metrics',
  'outcome',
]);
const BATCH_KEYS = new Set(['batchId', 'events']);
const METRIC_KEYS = new Set<string>(TELEMETRY_METRIC_NAMES);
const EVENT_NAME_SET = new Set<string>(TELEMETRY_EVENT_NAMES);
const PLATFORM_SET = new Set<string>(TELEMETRY_PLATFORMS);
const OUTCOME_SET = new Set<string>(TELEMETRY_OUTCOMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key));
}

function invalid(code: TelemetrySchemaErrorCode, message: string): never {
  throw new TelemetrySchemaError(code, message);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return invalid('invalid_event', `${label} must be a UUID.`);
  }
  return value;
}

function requireTimestamp(value: unknown, nowMs: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('invalid_event', 'occurredAt must be a non-negative epoch millisecond integer.');
  }
  const occurredAt = value as number;
  if (
    occurredAt < nowMs - TELEMETRY_RETENTION_MS ||
    occurredAt > nowMs + TELEMETRY_MAX_FUTURE_SKEW_MS
  ) {
    return invalid('timestamp_out_of_retention', 'occurredAt is outside the retention window.');
  }
  return occurredAt;
}

function parseMetrics(value: unknown): TelemetryMetrics {
  if (!isRecord(value) || !hasOnlyKeys(value, METRIC_KEYS)) {
    return invalid('invalid_metric', 'metrics must contain only approved metric names.');
  }

  const metrics: TelemetryMetrics = {};
  for (const [name, metric] of Object.entries(value)) {
    if (
      typeof metric !== 'number' ||
      !Number.isFinite(metric) ||
      metric < 0 ||
      metric > TELEMETRY_MAX_METRIC_VALUE
    ) {
      return invalid('invalid_metric', `Metric ${name} must be finite and non-negative.`);
    }
    metrics[name as TelemetryMetricName] = metric;
  }
  return metrics;
}

function parseEvent(value: unknown, nowMs: number): TelemetryEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, EVENT_KEYS)) {
    return invalid('invalid_event', 'Event contains an unknown field.');
  }
  if (value.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    return invalid('invalid_event', 'Unsupported telemetry schema version.');
  }
  if (typeof value.eventName !== 'string' || !EVENT_NAME_SET.has(value.eventName)) {
    return invalid('invalid_event', 'Unsupported telemetry event name.');
  }
  if (
    typeof value.appVersion !== 'string' ||
    value.appVersion.length > TELEMETRY_MAX_APP_VERSION_LENGTH ||
    !SEMVER_RE.test(value.appVersion)
  ) {
    return invalid('invalid_event', 'appVersion must be a semantic version.');
  }
  if (typeof value.platform !== 'string' || !PLATFORM_SET.has(value.platform)) {
    return invalid('invalid_event', 'Unsupported telemetry platform.');
  }
  if (typeof value.outcome !== 'string' || !OUTCOME_SET.has(value.outcome)) {
    return invalid('invalid_event', 'Unsupported telemetry outcome.');
  }

  return {
    eventId: requireUuid(value.eventId, 'eventId'),
    eventName: value.eventName as TelemetryEventName,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    occurredAt: requireTimestamp(value.occurredAt, nowMs),
    appVersion: value.appVersion,
    platform: value.platform as TelemetryPlatform,
    metrics: parseMetrics(value.metrics),
    outcome: value.outcome as TelemetryOutcome,
  };
}

export interface ParseTelemetryBatchOptions {
  /** Tests may inject a fixed clock; production defaults to Date.now(). */
  nowMs?: number;
}

/** Validate an already-decoded client payload and return a sanitized copy. */
export function parseTelemetryBatch(
  input: unknown,
  options: ParseTelemetryBatchOptions = {},
): TelemetryBatch {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs must be a non-negative epoch millisecond integer.');
  }
  if (!isRecord(input) || !hasOnlyKeys(input, BATCH_KEYS)) {
    return invalid('invalid_batch', 'Batch contains an unknown field.');
  }
  const batchId = requireUuid(input.batchId, 'batchId');
  if (
    !Array.isArray(input.events) ||
    input.events.length < 1 ||
    input.events.length > MAX_TELEMETRY_EVENTS_PER_BATCH
  ) {
    return invalid(
      'invalid_batch',
      `Batch must contain 1-${MAX_TELEMETRY_EVENTS_PER_BATCH} events.`,
    );
  }

  const eventIds = new Set<string>();
  const events = input.events.map((event) => {
    const parsed = parseEvent(event, nowMs);
    if (eventIds.has(parsed.eventId)) {
      return invalid('invalid_batch', 'Batch contains duplicate event IDs.');
    }
    eventIds.add(parsed.eventId);
    return parsed;
  });

  return { batchId, events };
}

/** Decode and validate a request body, enforcing the wire-size limit first. */
export function parseTelemetryJson(
  body: string | Uint8Array,
  options: ParseTelemetryBatchOptions = {},
): TelemetryBatch {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > MAX_TELEMETRY_BATCH_BYTES) {
    return invalid('payload_too_large', 'Telemetry batch exceeds the 64 KiB limit.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalid('invalid_json', 'Telemetry body must be valid JSON.');
  }
  return parseTelemetryBatch(decoded, options);
}

export function isTelemetryEventName(value: unknown): value is TelemetryEventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value);
}

export function isTelemetryMetricName(value: unknown): value is TelemetryMetricName {
  return typeof value === 'string' && METRIC_KEYS.has(value);
}
