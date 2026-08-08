export type IntelligenceTelemetryKind =
  | 'token_optimization'
  | 'context_retrieval'
  | 'repository_ranking'
  | 'provider_request'
  | 'native_capability'
  | 'browser_goal'
  | 'evaluation';

export type IntelligenceTelemetryMetric =
  | 'estimatedInputTokensBefore'
  | 'estimatedInputTokensAfter'
  | 'estimatedTokensSaved'
  | 'actualInputTokens'
  | 'actualOutputTokens'
  | 'actualReasoningTokens'
  | 'cachedInputTokens'
  | 'selectedSourceCount'
  | 'excludedSourceCount'
  | 'retryCount'
  | 'durationMs';

export type IntelligenceTelemetryAttribute =
  | 'mode'
  | 'tokenizerSource'
  | 'cacheOutcome'
  | 'operation'
  | 'resultState'
  | 'errorCode';

export interface IntelligenceTelemetryEvent {
  schemaVersion: 1;
  eventId: string;
  requestId: string;
  attemptNumber: number;
  accountScopeHash: string;
  projectScopeHash: string;
  kind: IntelligenceTelemetryKind;
  observedAt: number;
  providerId?: string;
  modelId?: string;
  metrics: Partial<Record<IntelligenceTelemetryMetric, number>>;
  attributes: Partial<Record<IntelligenceTelemetryAttribute, string>>;
}

export interface LocalIntelligenceTelemetry {
  record(event: IntelligenceTelemetryEvent): void;
  snapshot(): readonly Readonly<IntelligenceTelemetryEvent>[];
  clear(): void;
  exporterState(): Readonly<{ enabled: false; exporter: null }>;
}

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

function validateEvent(event: IntelligenceTelemetryEvent): void {
  if (
    Reflect.ownKeys(event).some((key) => typeof key !== 'string' || !EVENT_KEYS.has(key)) ||
    event.schemaVersion !== 1 ||
    !event.eventId ||
    !event.requestId ||
    !Number.isSafeInteger(event.attemptNumber) ||
    event.attemptNumber < 1 ||
    !event.accountScopeHash ||
    !event.projectScopeHash ||
    !KINDS.has(event.kind) ||
    !Number.isSafeInteger(event.observedAt) ||
    event.observedAt < 0
  ) {
    throw new Error('Invalid intelligence telemetry event.');
  }
  for (const [key, value] of Object.entries(event.metrics)) {
    if (
      !METRIC_KEYS.has(key as IntelligenceTelemetryMetric) ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw new Error('Invalid intelligence telemetry metric.');
    }
  }
  for (const [key, value] of Object.entries(event.attributes)) {
    if (
      !ATTRIBUTE_KEYS.has(key as IntelligenceTelemetryAttribute) ||
      typeof value !== 'string' ||
      value.length > 120
    ) {
      throw new Error('Invalid intelligence telemetry attribute.');
    }
  }
}

function detachEvent(event: IntelligenceTelemetryEvent): Readonly<IntelligenceTelemetryEvent> {
  return Object.freeze({
    ...event,
    metrics: Object.freeze({ ...event.metrics }),
    attributes: Object.freeze({ ...event.attributes }),
  });
}

export function createLocalIntelligenceTelemetry(
  options: Readonly<{ maxEvents?: number }> = {},
): LocalIntelligenceTelemetry {
  const maxEvents = options.maxEvents ?? 500;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) {
    throw new Error('Invalid intelligence telemetry retention limit.');
  }
  const events: Readonly<IntelligenceTelemetryEvent>[] = [];

  return {
    record(event) {
      validateEvent(event);
      events.push(detachEvent(event));
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    },
    snapshot() {
      return Object.freeze([...events]);
    },
    clear() {
      events.splice(0, events.length);
    },
    exporterState() {
      return Object.freeze({ enabled: false as const, exporter: null });
    },
  };
}
