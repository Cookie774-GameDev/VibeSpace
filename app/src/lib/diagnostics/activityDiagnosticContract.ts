export const ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION = 2 as const;

export const ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS = Object.freeze([
  'sequence',
  'operationId',
  'kind',
  'phase',
  'observedAt',
  'monotonicMs',
  'outcome',
  'completeness',
] as const);

export const ACTIVITY_DIAGNOSTIC_IDENTIFIER_FIELDS = Object.freeze([
  'operationId',
  'kind',
  'phase',
  'requestId',
  'chatId',
  'sessionId',
  'callId',
  'runId',
  'provider',
  'model',
  'tool',
  'operation',
  'eventType',
  'resultCode',
  'runtimeGeneration',
] as const);

export const ACTIVITY_DIAGNOSTIC_INTEGER_FIELDS = Object.freeze([
  'sequence',
  'returnedItems',
  'returnedChars',
  'publicationRevision',
  'coalescedRevisions',
  'nativeSequence',
  'nativeHandoffWallUs',
  'nativeHandoffMonotonicUs',
  'nativeProcessId',
] as const);

export const ACTIVITY_DIAGNOSTIC_NUMBER_FIELDS = Object.freeze([
  'observedAt',
  'monotonicMs',
  'durationMs',
  'uiCommitMs',
  'rendererReceivedAt',
  'rendererReceivedMonotonicMs',
  'rendererSentAt',
  'rendererSentMonotonicMs',
  'clockRoundTripMs',
  'clockUncertaintyMs',
] as const);

export const ACTIVITY_DIAGNOSTIC_BOOLEAN_FIELDS = Object.freeze([
  'hasContinuation',
  'diagnosticTruncated',
] as const);

export const ACTIVITY_DIAGNOSTIC_OUTCOMES = Object.freeze([
  'running',
  'success',
  'failure',
  'cancelled',
  'timeout',
  'unknown',
] as const);

export const ACTIVITY_DIAGNOSTIC_COMPLETENESS = Object.freeze([
  'complete',
  'partial',
  'truncated',
  'unknown',
] as const);

export const ACTIVITY_DIAGNOSTIC_FIELDS = Object.freeze([
  ...ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS,
  ...ACTIVITY_DIAGNOSTIC_IDENTIFIER_FIELDS.filter(
    (field) => !ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS.includes(field as never),
  ),
  ...ACTIVITY_DIAGNOSTIC_INTEGER_FIELDS.filter(
    (field) => !ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS.includes(field as never),
  ),
  ...ACTIVITY_DIAGNOSTIC_NUMBER_FIELDS.filter(
    (field) => !ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS.includes(field as never),
  ),
  ...ACTIVITY_DIAGNOSTIC_BOOLEAN_FIELDS,
] as const);

export interface ActivityDiagnosticCapabilities {
  readonly schemaVersions: readonly number[];
  readonly fields: readonly string[];
  readonly maxBatchEvents: number;
}

export interface ActivityDiagnosticClockSample {
  readonly processId: number;
  readonly wallUs: number;
  readonly monotonicUs: number;
}

export interface ActivityDiagnosticClockCalibration {
  readonly processId: number;
  readonly nativeWallUs: number;
  readonly nativeMonotonicUs: number;
  readonly rendererSentAt: number;
  readonly rendererSentMonotonicMs: number;
  readonly rendererReceivedAt: number;
  readonly rendererReceivedMonotonicMs: number;
  readonly roundTripMs: number;
  readonly uncertaintyMs: number;
  /**
   * Native monotonic minus renderer monotonic. The actual offset is bounded
   * within this interval; the two monotonic clocks never share an assumed epoch.
   */
  readonly offsetMinMs: number;
  readonly offsetMaxMs: number;
}

function safeClockInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function deriveActivityDiagnosticClockCalibration(
  sample: ActivityDiagnosticClockSample,
  rendererSentAt: number,
  rendererSentMonotonicMs: number,
  rendererReceivedAt: number,
  rendererReceivedMonotonicMs: number,
): ActivityDiagnosticClockCalibration | undefined {
  if (
    !safeClockInteger(sample.processId) ||
    sample.processId === 0 ||
    !safeClockInteger(sample.wallUs) ||
    !safeClockInteger(sample.monotonicUs) ||
    !Number.isFinite(rendererSentAt) ||
    rendererSentAt < 0 ||
    !Number.isFinite(rendererReceivedAt) ||
    rendererReceivedAt < 0 ||
    !Number.isFinite(rendererSentMonotonicMs) ||
    rendererSentMonotonicMs < 0 ||
    !Number.isFinite(rendererReceivedMonotonicMs) ||
    rendererReceivedMonotonicMs < rendererSentMonotonicMs
  ) {
    return undefined;
  }
  const roundTripMs = rendererReceivedMonotonicMs - rendererSentMonotonicMs;
  const nativeMonotonicMs = sample.monotonicUs / 1_000;
  const offsetMinMs = nativeMonotonicMs - rendererReceivedMonotonicMs;
  const offsetMaxMs = nativeMonotonicMs - rendererSentMonotonicMs;
  return Object.freeze({
    processId: sample.processId,
    nativeWallUs: sample.wallUs,
    nativeMonotonicUs: sample.monotonicUs,
    rendererSentAt,
    rendererSentMonotonicMs,
    rendererReceivedAt,
    rendererReceivedMonotonicMs,
    roundTripMs,
    uncertaintyMs: roundTripMs / 2,
    offsetMinMs,
    offsetMaxMs,
  });
}

export function hasCompatibleActivityDiagnosticCapabilities(
  value: unknown,
): value is ActivityDiagnosticCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const capability = value as Partial<ActivityDiagnosticCapabilities>;
  if (
    !Array.isArray(capability.schemaVersions) ||
    !capability.schemaVersions.includes(ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION) ||
    !Array.isArray(capability.fields) ||
    capability.maxBatchEvents !== 64
  ) {
    return false;
  }
  const fields = new Set(capability.fields.filter((field): field is string => typeof field === 'string'));
  return ACTIVITY_DIAGNOSTIC_REQUIRED_FIELDS.every((field) => fields.has(field)) &&
    ACTIVITY_DIAGNOSTIC_FIELDS.every((field) => fields.has(field));
}
