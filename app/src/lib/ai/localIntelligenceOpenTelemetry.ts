import { context, SpanStatusCode, TraceFlags, trace, type Context } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type {
  IntelligenceTelemetryAttribute,
  IntelligenceTelemetryEvent,
  IntelligenceTelemetryKind,
  IntelligenceTelemetryMetric,
} from './intelligenceTelemetry';

const EVENT_KEYS = new Set([
  'schemaVersion',
  'eventId',
  'requestId',
  'attemptNumber',
  'accountScopeHash',
  'projectScopeHash',
  'kind',
  'observedAt',
  'providerId',
  'modelId',
  'metrics',
  'attributes',
]);
const METRIC_KEYS = new Set<IntelligenceTelemetryMetric>([
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
]);
const ATTRIBUTE_KEYS = new Set<IntelligenceTelemetryAttribute>([
  'mode',
  'tokenizerSource',
  'cacheOutcome',
  'operation',
  'resultState',
  'errorCode',
]);
const KINDS = new Set<IntelligenceTelemetryKind>([
  'token_optimization',
  'context_retrieval',
  'repository_ranking',
  'provider_request',
  'native_capability',
  'browser_goal',
  'evaluation',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const SAFE_HASH = /^[A-Za-z0-9_-]{1,120}$/u;
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/u;
const SAFE_ENUM = /^[a-z][a-z0-9_:-]{0,63}$/u;
const DEFAULT_ATTRIBUTE_VALUES: Readonly<
  Record<IntelligenceTelemetryAttribute, readonly string[]>
> = Object.freeze({
  mode: ['off', 'saver', 'normal', 'final_boss'],
  tokenizerSource: ['exact_local', 'provider_native', 'conservative_estimate', 'mixed', 'none'],
  cacheOutcome: ['hit', 'miss', 'bypass', 'evicted', 'expired', 'disabled'],
  operation: [
    'token_usage_reconciliation',
    'token_optimization_preflight',
    'context_retrieval',
    'repository_ranking',
    'provider_request',
    'native_capability',
    'browser_goal',
    'evaluation',
  ],
  resultState: [
    'fits_context',
    'protected_overflow',
    'provider_reported',
    'success',
    'error',
    'cancelled',
    'unavailable',
  ],
  errorCode: [
    'provider_timeout',
    'provider_error',
    'cancelled',
    'overflow',
    'model_mismatch',
    'invalid_response',
    'unavailable',
  ],
});

export type LocalIntelligenceOpenTelemetryErrorCode =
  | 'invalid_event'
  | 'invalid_metric'
  | 'invalid_attribute'
  | 'shut_down';

export class LocalIntelligenceOpenTelemetryError extends Error {
  readonly code: LocalIntelligenceOpenTelemetryErrorCode;

  constructor(code: LocalIntelligenceOpenTelemetryErrorCode) {
    super(`Local intelligence telemetry error: ${code}.`);
    this.name = 'LocalIntelligenceOpenTelemetryError';
    this.code = code;
  }
}

export interface LocalIntelligenceSpanReceipt {
  readonly spanId: string;
  readonly traceId: string;
  readonly correlationKey: string;
  readonly eventId: string;
  readonly requestId: string;
  readonly attemptNumber: number;
  readonly kind: IntelligenceTelemetryKind;
  readonly observedAt: number;
  readonly durationMs: number;
  readonly state: 'ok' | 'error';
  readonly errorCode?: string;
}

export interface LocalIntelligenceOpenTelemetry {
  readonly enabled: boolean;
  record(event: IntelligenceTelemetryEvent): Readonly<LocalIntelligenceSpanReceipt> | null;
  snapshot(): readonly Readonly<LocalIntelligenceSpanReceipt>[];
  clear(): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
  exporterState(): Readonly<{ enabled: false; exporter: null }>;
}

export interface LocalIntelligenceOpenTelemetryOptions {
  readonly enabled?: boolean;
  readonly maxSpans?: number;
  readonly additionalAttributeValues?: Partial<
    Readonly<Record<IntelligenceTelemetryAttribute, readonly string[]>>
  >;
}

class BoundedLocalSpanProcessor implements SpanProcessor {
  readonly #maxSpans: number;
  readonly #receipts: Readonly<LocalIntelligenceSpanReceipt>[] = [];
  #shutDown = false;

  constructor(maxSpans: number) {
    this.#maxSpans = maxSpans;
  }

  onStart(_span: unknown, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (this.#shutDown) return;
    const receipt = receiptFromSpan(span);
    this.#receipts.push(receipt);
    if (this.#receipts.length > this.#maxSpans) {
      this.#receipts.splice(0, this.#receipts.length - this.#maxSpans);
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.#shutDown = true;
    return Promise.resolve();
  }

  snapshot(): readonly Readonly<LocalIntelligenceSpanReceipt>[] {
    return Object.freeze([...this.#receipts]);
  }

  clear(): void {
    this.#receipts.splice(0, this.#receipts.length);
  }
}

export function createLocalIntelligenceOpenTelemetry(
  options: Readonly<LocalIntelligenceOpenTelemetryOptions> = {},
): LocalIntelligenceOpenTelemetry {
  const enabled = options.enabled === true;
  const maxSpans = options.maxSpans ?? 500;
  if (!Number.isSafeInteger(maxSpans) || maxSpans < 1 || maxSpans > 10_000) {
    throw new LocalIntelligenceOpenTelemetryError('invalid_event');
  }
  const attributeValues = buildAttributeValueAllowlist(options.additionalAttributeValues);
  if (!enabled) return disabledBridge();

  const processor = new BoundedLocalSpanProcessor(maxSpans);
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
    spanLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit: 120,
      eventCountLimit: 0,
      linkCountLimit: 0,
    },
  });
  const tracer = provider.getTracer('vibespace.local-intelligence', '1.0.0');
  let shutDown = false;

  return {
    enabled: true,
    record(event) {
      if (shutDown) throw new LocalIntelligenceOpenTelemetryError('shut_down');
      const projected = validateAndProject(event, attributeValues);
      const parentContext = correlationContext(event);
      const durationMs = projected.metrics.durationMs ?? 0;
      const span = tracer.startSpan(
        `intelligence.${event.kind}`,
        {
          root: false,
          startTime: event.observedAt,
          attributes: projected.spanAttributes,
        },
        parentContext,
      );
      if (projected.errorCode) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(event.observedAt + durationMs);
      return processor.snapshot().at(-1) ?? null;
    },
    snapshot: () => processor.snapshot(),
    clear: () => processor.clear(),
    forceFlush: () => provider.forceFlush(),
    async shutdown() {
      if (shutDown) return;
      shutDown = true;
      await provider.forceFlush();
      await provider.shutdown();
    },
    exporterState: noExporterState,
  };
}

function disabledBridge(): LocalIntelligenceOpenTelemetry {
  let shutDown = false;
  return {
    enabled: false,
    record() {
      if (shutDown) throw new LocalIntelligenceOpenTelemetryError('shut_down');
      return null;
    },
    snapshot: () => Object.freeze([]),
    clear() {},
    forceFlush: () => Promise.resolve(),
    async shutdown() {
      shutDown = true;
    },
    exporterState: noExporterState,
  };
}

function noExporterState(): Readonly<{ enabled: false; exporter: null }> {
  return Object.freeze({ enabled: false as const, exporter: null });
}

function validateAndProject(
  event: IntelligenceTelemetryEvent,
  attributeValues: ReadonlyMap<IntelligenceTelemetryAttribute, ReadonlySet<string>>,
): Readonly<{
  metrics: Partial<Record<IntelligenceTelemetryMetric, number>>;
  errorCode?: string;
  spanAttributes: Record<string, string | number>;
}> {
  if (
    !event ||
    Reflect.ownKeys(event).some((key) => typeof key !== 'string' || !EVENT_KEYS.has(key)) ||
    event.schemaVersion !== 1 ||
    !SAFE_ID.test(event.eventId) ||
    !SAFE_ID.test(event.requestId) ||
    !Number.isSafeInteger(event.attemptNumber) ||
    event.attemptNumber < 1 ||
    !SAFE_HASH.test(event.accountScopeHash) ||
    !SAFE_HASH.test(event.projectScopeHash) ||
    !KINDS.has(event.kind) ||
    !Number.isSafeInteger(event.observedAt) ||
    event.observedAt < 0 ||
    !event.metrics ||
    typeof event.metrics !== 'object' ||
    Array.isArray(event.metrics) ||
    !event.attributes ||
    typeof event.attributes !== 'object' ||
    Array.isArray(event.attributes)
  ) {
    throw new LocalIntelligenceOpenTelemetryError('invalid_event');
  }
  if (event.providerId !== undefined) assertDimension(event.providerId);
  if (event.modelId !== undefined) assertDimension(event.modelId);

  const metrics: Partial<Record<IntelligenceTelemetryMetric, number>> = {};
  for (const [key, value] of Object.entries(event.metrics)) {
    if (
      !METRIC_KEYS.has(key as IntelligenceTelemetryMetric) ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      throw new LocalIntelligenceOpenTelemetryError('invalid_metric');
    }
    metrics[key as IntelligenceTelemetryMetric] = value;
  }
  const attributes: Partial<Record<IntelligenceTelemetryAttribute, string>> = {};
  for (const [key, value] of Object.entries(event.attributes)) {
    if (
      !ATTRIBUTE_KEYS.has(key as IntelligenceTelemetryAttribute) ||
      typeof value !== 'string' ||
      !SAFE_ENUM.test(value) ||
      !attributeValues.get(key as IntelligenceTelemetryAttribute)?.has(value)
    ) {
      throw new LocalIntelligenceOpenTelemetryError('invalid_attribute');
    }
    attributes[key as IntelligenceTelemetryAttribute] = value;
  }

  const spanAttributes: Record<string, string | number> = {
    'intelligence.schema_version': 1,
    'intelligence.event_id': event.eventId,
    'intelligence.request_id': event.requestId,
    'intelligence.attempt_number': event.attemptNumber,
    'intelligence.account_scope_hash': event.accountScopeHash,
    'intelligence.project_scope_hash': event.projectScopeHash,
    'intelligence.kind': event.kind,
    'intelligence.observed_at': event.observedAt,
    ...(event.providerId ? { 'intelligence.provider_id': event.providerId } : {}),
    ...(event.modelId ? { 'intelligence.model_id': event.modelId } : {}),
  };
  for (const [key, value] of Object.entries(metrics)) {
    spanAttributes[`intelligence.metric.${key}`] = value;
  }
  for (const [key, value] of Object.entries(attributes)) {
    spanAttributes[`intelligence.attribute.${key}`] = value;
  }
  return Object.freeze({
    metrics: Object.freeze(metrics),
    ...(attributes.errorCode ? { errorCode: attributes.errorCode } : {}),
    spanAttributes: Object.freeze(spanAttributes),
  });
}

function buildAttributeValueAllowlist(
  additional:
    | Partial<Readonly<Record<IntelligenceTelemetryAttribute, readonly string[]>>>
    | undefined,
): ReadonlyMap<IntelligenceTelemetryAttribute, ReadonlySet<string>> {
  const result = new Map<IntelligenceTelemetryAttribute, ReadonlySet<string>>();
  for (const key of ATTRIBUTE_KEYS) {
    const values = [...DEFAULT_ATTRIBUTE_VALUES[key], ...(additional?.[key] ?? [])];
    if (values.length > 128 || values.some((value) => !SAFE_ENUM.test(value))) {
      throw new LocalIntelligenceOpenTelemetryError('invalid_attribute');
    }
    result.set(key, new Set(values));
  }
  if (
    additional &&
    Reflect.ownKeys(additional).some(
      (key) =>
        typeof key !== 'string' || !ATTRIBUTE_KEYS.has(key as IntelligenceTelemetryAttribute),
    )
  ) {
    throw new LocalIntelligenceOpenTelemetryError('invalid_attribute');
  }
  return result;
}

function assertDimension(value: string): void {
  if (
    !SAFE_DIMENSION.test(value) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new LocalIntelligenceOpenTelemetryError('invalid_event');
  }
}

function correlationContext(event: IntelligenceTelemetryEvent): Context {
  const correlationSeed = JSON.stringify([
    event.accountScopeHash,
    event.projectScopeHash,
    event.requestId,
    event.attemptNumber,
  ]);
  const traceId = deterministicHex(correlationSeed, 32);
  const parentSpanId = deterministicHex(`${correlationSeed}:parent`, 16);
  return trace.setSpanContext(context.active(), {
    traceId,
    spanId: parentSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
}

function deterministicHex(value: string, length: 16 | 32): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  let result = '';
  for (const initial of seeds) {
    let hash = initial;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
      hash ^= hash >>> 13;
    }
    result += (hash >>> 0).toString(16).padStart(8, '0');
    if (result.length >= length) break;
  }
  const bounded = result.slice(0, length);
  return /^0+$/u.test(bounded) ? `${'0'.repeat(length - 1)}1` : bounded;
}

function receiptFromSpan(span: ReadableSpan): Readonly<LocalIntelligenceSpanReceipt> {
  const attemptNumber = numericAttribute(span, 'intelligence.attempt_number');
  const observedAt = numericAttribute(span, 'intelligence.observed_at');
  const requestId = stringAttribute(span, 'intelligence.request_id');
  const kind = stringAttribute(span, 'intelligence.kind') as IntelligenceTelemetryKind;
  const errorCode = optionalStringAttribute(span, 'intelligence.attribute.errorCode');
  const receipt: LocalIntelligenceSpanReceipt = {
    spanId: span.spanContext().spanId,
    traceId: span.spanContext().traceId,
    correlationKey: `${requestId}:attempt:${attemptNumber}`,
    eventId: stringAttribute(span, 'intelligence.event_id'),
    requestId,
    attemptNumber,
    kind,
    observedAt,
    durationMs: numericAttribute(span, 'intelligence.metric.durationMs', 0),
    state: errorCode ? 'error' : 'ok',
    ...(errorCode ? { errorCode } : {}),
  };
  return Object.freeze(receipt);
}

function stringAttribute(span: ReadableSpan, key: string): string {
  const value = span.attributes[key];
  if (typeof value !== 'string') throw new LocalIntelligenceOpenTelemetryError('invalid_event');
  return value;
}

function optionalStringAttribute(span: ReadableSpan, key: string): string | undefined {
  const value = span.attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new LocalIntelligenceOpenTelemetryError('invalid_event');
  return value;
}

function numericAttribute(span: ReadableSpan, key: string, fallback?: number): number {
  const value = span.attributes[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number') throw new LocalIntelligenceOpenTelemetryError('invalid_event');
  return value;
}
