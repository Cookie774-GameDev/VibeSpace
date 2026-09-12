import { describe, expect, it } from 'vitest';
import {
  createLocalIntelligenceOpenTelemetry,
  LocalIntelligenceOpenTelemetryError,
} from './localIntelligenceOpenTelemetry';
import type { IntelligenceTelemetryEvent } from './intelligenceTelemetry';

function event(overrides: Partial<IntelligenceTelemetryEvent> = {}): IntelligenceTelemetryEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    requestId: 'req-1',
    attemptNumber: 1,
    accountScopeHash: 'account_hash',
    projectScopeHash: 'project_hash',
    kind: 'provider_request',
    observedAt: 1000,
    providerId: 'openai',
    modelId: 'gpt-5',
    metrics: {
      actualInputTokens: 12,
      actualOutputTokens: 5,
      durationMs: 30,
    },
    attributes: {
      operation: 'token_usage_reconciliation',
      resultState: 'provider_reported',
    },
    ...overrides,
  };
}

describe('local intelligence OpenTelemetry bridge', () => {
  it('is inert and exporter-free until explicitly enabled', async () => {
    const bridge = createLocalIntelligenceOpenTelemetry();
    expect(bridge.enabled).toBe(false);
    expect(bridge.record(event())).toBeNull();
    expect(bridge.snapshot()).toEqual([]);
    expect(bridge.exporterState()).toEqual({ enabled: false, exporter: null });
    await bridge.forceFlush();
    await bridge.shutdown();
  });

  it('records bounded privacy-safe receipts with deterministic request/attempt correlation', () => {
    const bridge = createLocalIntelligenceOpenTelemetry({ enabled: true, maxSpans: 2 });
    const first = bridge.record(event());
    const correlated = bridge.record(
      event({
        eventId: 'evt-2',
        metrics: { selectedSourceCount: 2 },
        attributes: { mode: 'normal', tokenizerSource: 'exact_local' },
      }),
    );
    const nextAttempt = bridge.record(
      event({
        eventId: 'evt-3',
        attemptNumber: 2,
        attributes: { errorCode: 'provider_timeout' },
      }),
    );

    expect(first).toMatchObject({
      correlationKey: 'req-1:attempt:1',
      durationMs: 30,
      state: 'ok',
    });
    expect(correlated?.traceId).toBe(first?.traceId);
    expect(nextAttempt?.traceId).not.toBe(first?.traceId);
    expect(nextAttempt).toMatchObject({
      correlationKey: 'req-1:attempt:2',
      state: 'error',
      errorCode: 'provider_timeout',
    });
    expect(bridge.snapshot().map(({ eventId }) => eventId)).toEqual(['evt-2', 'evt-3']);
    expect(JSON.stringify(bridge.snapshot())).not.toContain('actualInputTokens');
    expect(JSON.stringify(bridge.snapshot())).not.toContain('token_usage_reconciliation');
    expect(bridge.exporterState()).toEqual({ enabled: false, exporter: null });
  });

  it('rejects raw-content/path-like attributes, unknown metrics, and error messages', () => {
    const bridge = createLocalIntelligenceOpenTelemetry({ enabled: true });
    expect(() =>
      bridge.record(
        event({
          attributes: { operation: 'raw prompt with spaces' },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<LocalIntelligenceOpenTelemetryError>>({
        code: 'invalid_attribute',
      }),
    );
    expect(() =>
      bridge.record(
        event({
          metrics: { rawPromptLength: 100 } as IntelligenceTelemetryEvent['metrics'],
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<LocalIntelligenceOpenTelemetryError>>({
        code: 'invalid_metric',
      }),
    );
    expect(() =>
      bridge.record(
        event({
          providerId: 'C:\\private\\provider',
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<LocalIntelligenceOpenTelemetryError>>({
        code: 'invalid_event',
      }),
    );
    expect(() =>
      bridge.record(
        event({
          attributes: { errorCode: 'Timeout while sending private prompt' },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<LocalIntelligenceOpenTelemetryError>>({
        code: 'invalid_attribute',
      }),
    );
    expect(bridge.snapshot()).toEqual([]);
  });

  it('flushes, clears, and shuts down cleanly without accepting later spans', async () => {
    const bridge = createLocalIntelligenceOpenTelemetry({ enabled: true });
    bridge.record(event());
    await bridge.forceFlush();
    expect(bridge.snapshot()).toHaveLength(1);
    bridge.clear();
    expect(bridge.snapshot()).toEqual([]);
    await bridge.shutdown();
    await bridge.shutdown();
    expect(() => bridge.record(event())).toThrowError(
      expect.objectContaining<Partial<LocalIntelligenceOpenTelemetryError>>({
        code: 'shut_down',
      }),
    );
  });
});
