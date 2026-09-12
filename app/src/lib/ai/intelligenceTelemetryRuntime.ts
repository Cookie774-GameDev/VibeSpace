import {
  createLocalIntelligenceTelemetry,
  type LocalIntelligenceTelemetry,
  type IntelligenceTelemetryEvent,
} from './intelligenceTelemetry';
import {
  createLocalIntelligenceOpenTelemetry,
  type LocalIntelligenceOpenTelemetry,
  type LocalIntelligenceSpanReceipt,
} from './localIntelligenceOpenTelemetry';

export interface IntelligenceTelemetryRuntimeSnapshot {
  readonly events: readonly Readonly<IntelligenceTelemetryEvent>[];
  readonly spans: readonly Readonly<LocalIntelligenceSpanReceipt>[];
  readonly exporter: Readonly<{ enabled: false; exporter: null }>;
}

export interface IntelligenceTelemetryRuntime {
  emit(event: IntelligenceTelemetryEvent): Readonly<LocalIntelligenceSpanReceipt> | null;
  snapshot(): Readonly<IntelligenceTelemetryRuntimeSnapshot>;
  clear(): void;
}

export function createIntelligenceTelemetryRuntime(input: {
  readonly events?: LocalIntelligenceTelemetry;
  readonly traces?: LocalIntelligenceOpenTelemetry;
} = {}): IntelligenceTelemetryRuntime {
  const events = input.events ?? createLocalIntelligenceTelemetry({ maxEvents: 500 });
  const traces =
    input.traces ?? createLocalIntelligenceOpenTelemetry({ enabled: true, maxSpans: 500 });

  if (events.exporterState().enabled || traces.exporterState().enabled) {
    throw new Error('Local intelligence telemetry cannot enable an exporter.');
  }

  return Object.freeze({
    emit(event: IntelligenceTelemetryEvent) {
      events.record(event);
      return traces.record(event);
    },
    snapshot() {
      return Object.freeze({
        events: events.snapshot(),
        spans: traces.snapshot(),
        exporter: Object.freeze({ enabled: false as const, exporter: null }),
      });
    },
    clear() {
      events.clear();
      traces.clear();
    },
  });
}

/**
 * Process-local diagnostics for AI usage and retrieval. This intentionally has
 * no persistence or network exporter; callers must provide only redacted,
 * allowlisted dimensions and hashed account/project scopes.
 */
export const localIntelligenceTelemetryRuntime = createIntelligenceTelemetryRuntime();
