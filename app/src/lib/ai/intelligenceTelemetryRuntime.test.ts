import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceTelemetryEvent } from './intelligenceTelemetry';
import { createIntelligenceTelemetryRuntime } from './intelligenceTelemetryRuntime';

const event = Object.freeze({
  schemaVersion: 1 as const,
  eventId: 'event-token-1',
  requestId: 'request-1',
  attemptNumber: 1,
  accountScopeHash: 'account_hash',
  projectScopeHash: 'project_hash',
  kind: 'token_optimization' as const,
  observedAt: 1_000,
  providerId: 'openai',
  modelId: 'gpt-5',
  metrics: Object.freeze({ estimatedTokensSaved: 200 }),
  attributes: Object.freeze({
    mode: 'saver',
    tokenizerSource: 'exact_local',
    resultState: 'fits_context',
  }),
}) satisfies IntelligenceTelemetryEvent;

describe('createIntelligenceTelemetryRuntime', () => {
  it('records the same privacy-safe event to the bounded event and trace stores', () => {
    const recordEvent = vi.fn();
    const recordTrace = vi.fn(() => Object.freeze({ spanId: 'span-1' }));
    const runtime = createIntelligenceTelemetryRuntime({
      events: {
        record: recordEvent,
        snapshot: () => Object.freeze([event]),
        clear: vi.fn(),
        exporterState: () => Object.freeze({ enabled: false as const, exporter: null }),
      },
      traces: {
        enabled: true,
        record: recordTrace as never,
        snapshot: () => Object.freeze([]),
        clear: vi.fn(),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
        exporterState: () => Object.freeze({ enabled: false as const, exporter: null }),
      },
    });

    expect(runtime.emit(event)).toEqual({ spanId: 'span-1' });
    expect(recordEvent).toHaveBeenCalledWith(event);
    expect(recordTrace).toHaveBeenCalledWith(event);
    expect(runtime.snapshot().exporter).toEqual({ enabled: false, exporter: null });
  });

  it('rejects any telemetry sink that exposes a network exporter', () => {
    expect(() =>
      createIntelligenceTelemetryRuntime({
        events: {
          record: vi.fn(),
          snapshot: () => Object.freeze([]),
          clear: vi.fn(),
          exporterState: () =>
            ({ enabled: true, exporter: {} } as unknown as {
              enabled: false;
              exporter: null;
            }),
        },
      }),
    ).toThrow(/cannot enable an exporter/i);
  });
});
