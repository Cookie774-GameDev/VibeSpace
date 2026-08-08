import type { IntelligenceTelemetryEvent } from '@/lib/ai/intelligenceTelemetry';
import type { ReconciledTokenUsage, TokenOptimizationReceipt } from './optimizationReport';

export interface IntelligenceTelemetryEnvelope {
  readonly eventId: string;
  readonly requestId: string;
  readonly attemptNumber: number;
  readonly accountScopeHash: string;
  readonly projectScopeHash: string;
  readonly observedAt: number;
}

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const SAFE_HASH = /^[A-Za-z0-9_-]{1,120}$/u;
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/u;

function assertEnvelope(envelope: IntelligenceTelemetryEnvelope): void {
  for (const [label, value] of [
    ['event id', envelope.eventId],
    ['request id', envelope.requestId],
  ] as const) {
    if (!SAFE_TOKEN.test(value)) throw new Error(`Invalid telemetry ${label}.`);
  }
  for (const [label, value] of [
    ['account scope hash', envelope.accountScopeHash],
    ['project scope hash', envelope.projectScopeHash],
  ] as const) {
    if (!SAFE_HASH.test(value)) throw new Error(`Invalid telemetry ${label}.`);
  }
  if (!Number.isSafeInteger(envelope.attemptNumber) || envelope.attemptNumber < 1) {
    throw new Error('Invalid telemetry attempt number.');
  }
  if (!Number.isSafeInteger(envelope.observedAt) || envelope.observedAt < 0) {
    throw new Error('Invalid telemetry observed time.');
  }
}

function safeDimension(label: string, value: string): string {
  if (!SAFE_DIMENSION.test(value)) throw new Error(`Invalid telemetry ${label}.`);
  return value;
}

function baseEvent(envelope: IntelligenceTelemetryEnvelope, providerId: string, modelId: string) {
  assertEnvelope(envelope);
  return {
    schemaVersion: 1 as const,
    eventId: envelope.eventId,
    requestId: envelope.requestId,
    attemptNumber: envelope.attemptNumber,
    accountScopeHash: envelope.accountScopeHash,
    projectScopeHash: envelope.projectScopeHash,
    observedAt: envelope.observedAt,
    providerId: safeDimension('provider id', providerId),
    modelId: safeDimension('model id', modelId),
  };
}

export function tokenOptimizationReceiptToTelemetry(
  receipt: TokenOptimizationReceipt,
  envelope: IntelligenceTelemetryEnvelope,
): IntelligenceTelemetryEvent {
  return Object.freeze({
    ...baseEvent(envelope, receipt.providerId, receipt.modelId),
    kind: 'token_optimization' as const,
    metrics: Object.freeze({
      estimatedInputTokensBefore: receipt.estimatedInputTokensBefore,
      estimatedInputTokensAfter: receipt.estimatedInputTokensAfter,
      estimatedTokensSaved: receipt.estimatedTokensSaved,
      selectedSourceCount: receipt.selectedCount,
      excludedSourceCount: receipt.excludedCount,
    }),
    attributes: Object.freeze({
      mode: receipt.mode,
      tokenizerSource: receipt.tokenizerSource,
      resultState: receipt.fitsContext ? 'fits_context' : 'protected_overflow',
    }),
  });
}

export function tokenUsageReceiptToTelemetry(
  usage: ReconciledTokenUsage,
  envelope: IntelligenceTelemetryEnvelope,
): IntelligenceTelemetryEvent {
  if (envelope.requestId !== usage.requestId || envelope.attemptNumber !== usage.attemptNumber) {
    throw new Error('Telemetry usage binding mismatch.');
  }
  return Object.freeze({
    ...baseEvent(envelope, usage.providerId, usage.modelId),
    kind: 'provider_request' as const,
    metrics: Object.freeze({
      estimatedInputTokensBefore: usage.estimatedInputTokens,
      estimatedInputTokensAfter: usage.estimatedInputTokens,
      actualInputTokens: usage.actualInputTokens,
      actualOutputTokens: usage.actualOutputTokens,
      ...(usage.actualReasoningTokens === undefined
        ? {}
        : { actualReasoningTokens: usage.actualReasoningTokens }),
      ...(usage.actualCachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: usage.actualCachedInputTokens }),
    }),
    attributes: Object.freeze({
      tokenizerSource: usage.tokenizerSource,
      operation: 'token_usage_reconciliation',
      resultState: 'provider_reported',
    }),
  });
}
