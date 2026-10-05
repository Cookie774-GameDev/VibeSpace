/**
 * The server-side wire contract for account-scoped product telemetry.
 *
 * Keep this module dependency-free: the web exporter and Edge Functions both
 * use it, and validation must not depend on a provider, database, or runtime
 * global. The authenticated account is deliberately absent from the client
 * payload; the ingest function supplies it from the verified bearer token.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
// Reserved for a newly disclosed scope. Never reuse a legacy policy version.
export const APP_DIAGNOSTICS_SCOPE = 'app-diagnostics-v1' as const;
export const APP_DIAGNOSTICS_POLICY_VERSION = 'telemetry-app-diagnostics-2026-10-05-v1' as const;
export const APP_DIAGNOSTICS_SCHEMA_VERSION = 2 as const;

export function supportsAppDiagnosticsScope(
  config:
    | {
        policyVersion?: unknown;
        appDiagnosticsScope?: unknown;
      }
    | undefined,
): boolean {
  return (
    config?.policyVersion === APP_DIAGNOSTICS_POLICY_VERSION &&
    config.appDiagnosticsScope === APP_DIAGNOSTICS_SCOPE
  );
}
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
  events: readonly (TelemetryEvent | AppDiagnosticsEvent)[];
}

// Explicit release allowlists: new routes are not automatically new telemetry.
export const APP_DIAGNOSTICS_FEATURES = [
  'chat',
  'canvas',
  'workbench',
  'preview',
  'browser',
  'terminal',
  'kanban',
  'schedule',
  'ade',
  'agents',
  'model-foundry',
  'agent-detail',
  'project-detail',
  'context',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
  'notes',
  'account',
  'settings',
  'command-palette',
  'voice',
  'app',
] as const;
export const APP_DIAGNOSTICS_CATEGORIES = [
  'renderer_error',
  'unhandled_rejection',
  'event_loop_delay',
  'resource_sample',
  'operation_outcome',
] as const;
type AppDiagnosticsMetric =
  | 'count'
  | 'sampleCount'
  | 'durationMs'
  | 'eventLoopDelayMs'
  | 'heapUsedMiB'
  | 'heapLimitMiB';
export interface AppDiagnosticsEvent extends Omit<
  TelemetryEvent,
  'schemaVersion' | 'eventName' | 'metrics'
> {
  schemaVersion: typeof APP_DIAGNOSTICS_SCHEMA_VERSION;
  eventName: 'feature_open' | 'diagnostic' | 'tool_outcome';
  feature: (typeof APP_DIAGNOSTICS_FEATURES)[number];
  diagnostic?: (typeof APP_DIAGNOSTICS_CATEGORIES)[number];
  metrics: Partial<Record<AppDiagnosticsMetric, number>>;
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
const DIAGNOSTICS_EVENT_KEYS = new Set([...EVENT_KEYS, 'feature', 'diagnostic']);
const FEATURE_SET = new Set<string>(APP_DIAGNOSTICS_FEATURES);
const DIAGNOSTIC_SET = new Set<string>(APP_DIAGNOSTICS_CATEGORIES);
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

function parseDiagnosticsMetrics(event: Record<string, unknown>): AppDiagnosticsEvent['metrics'] {
  const metrics = event.metrics;
  const category = event.diagnostic;
  const resource = category === 'resource_sample';
  const delay = category === 'event_loop_delay';
  const operation = category === 'operation_outcome' || event.eventName === 'tool_outcome';
  const required = resource
    ? ['sampleCount', 'heapUsedMiB', 'heapLimitMiB']
    : delay
      ? ['sampleCount', 'eventLoopDelayMs']
      : ['count'];
  const allowed = new Set(operation ? [...required, 'durationMs'] : required);
  if (
    !isRecord(metrics) ||
    !hasOnlyKeys(metrics, allowed) ||
    required.some((key) => !Object.hasOwn(metrics, key))
  ) {
    return invalid('invalid_metric', 'Metrics do not match the diagnostic category.');
  }
  const result: AppDiagnosticsEvent['metrics'] = {};
  for (const [key, value] of Object.entries(metrics)) {
    const max =
      key === 'count'
        ? 1_000
        : key === 'sampleCount'
          ? 60
          : key === 'eventLoopDelayMs'
            ? 60_000
            : key === 'durationMs'
              ? 86_400_000
              : 1_048_576;
    const min = ['count', 'sampleCount', 'heapLimitMiB'].includes(key) ? 1 : 0;
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      return invalid('invalid_metric', 'Diagnostic metric is outside its aggregate bound.');
    }
    result[key as AppDiagnosticsMetric] = value as number;
  }
  if (resource && result.heapUsedMiB! > result.heapLimitMiB!) {
    return invalid('invalid_metric', 'Heap usage exceeds its reported limit.');
  }
  return result;
}

function parseEvent(
  value: unknown,
  nowMs: number,
  allowAppDiagnostics: boolean,
): TelemetryEvent | AppDiagnosticsEvent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      value.schemaVersion === APP_DIAGNOSTICS_SCHEMA_VERSION ? DIAGNOSTICS_EVENT_KEYS : EVENT_KEYS,
    )
  ) {
    return invalid('invalid_event', 'Event contains an unknown field.');
  }
  if (
    value.schemaVersion !== TELEMETRY_SCHEMA_VERSION &&
    value.schemaVersion !== APP_DIAGNOSTICS_SCHEMA_VERSION
  ) {
    return invalid('invalid_event', 'Unsupported telemetry schema version.');
  }
  if (value.schemaVersion === APP_DIAGNOSTICS_SCHEMA_VERSION && !allowAppDiagnostics) {
    return invalid('invalid_event', 'Expanded diagnostics require an explicit schema opt-in.');
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

  const common = {
    eventId: requireUuid(value.eventId, 'eventId'),
    occurredAt: requireTimestamp(value.occurredAt, nowMs),
    appVersion: value.appVersion,
    platform: value.platform as TelemetryPlatform,
    outcome: value.outcome as TelemetryOutcome,
  };
  if (value.schemaVersion === APP_DIAGNOSTICS_SCHEMA_VERSION) {
    if (
      !['feature_open', 'diagnostic', 'tool_outcome'].includes(value.eventName) ||
      typeof value.feature !== 'string' ||
      !FEATURE_SET.has(value.feature) ||
      (value.eventName === 'diagnostic'
        ? typeof value.diagnostic !== 'string' || !DIAGNOSTIC_SET.has(value.diagnostic)
        : Object.hasOwn(value, 'diagnostic'))
    ) {
      return invalid('invalid_event', 'Unsupported diagnostic feature or category.');
    }
    return {
      ...common,
      schemaVersion: APP_DIAGNOSTICS_SCHEMA_VERSION,
      eventName: value.eventName as AppDiagnosticsEvent['eventName'],
      feature: value.feature as AppDiagnosticsEvent['feature'],
      ...(value.eventName === 'diagnostic'
        ? { diagnostic: value.diagnostic as AppDiagnosticsEvent['diagnostic'] }
        : {}),
      metrics: parseDiagnosticsMetrics(value),
    };
  }
  return {
    ...common,
    eventName: value.eventName as TelemetryEventName,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    metrics: parseMetrics(value.metrics),
  };
}

export interface ParseTelemetryBatchOptions {
  /** Tests may inject a fixed clock; production defaults to Date.now(). */
  nowMs?: number;
  /** Schema support only, not consent. Existing client validators remain v1-only. */
  allowAppDiagnostics?: boolean;
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
    const parsed = parseEvent(event, nowMs, options.allowAppDiagnostics === true);
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
