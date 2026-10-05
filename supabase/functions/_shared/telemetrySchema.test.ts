import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TELEMETRY_BATCH_BYTES,
  parseTelemetryBatch,
  parseTelemetryJson,
  TelemetrySchemaError,
} from './telemetrySchema.ts';

const NOW = 1_758_500_000_000;
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

function validEvent(eventId = EVENT_ID): Record<string, unknown> {
  return {
    eventId,
    eventName: 'diagnostic',
    schemaVersion: 1,
    occurredAt: NOW,
    appVersion: '1.2.3',
    platform: 'windows',
    metrics: { durationMs: 12, retryCount: 0 },
    outcome: 'ok',
  };
}

function validBatch(event = validEvent()): Record<string, unknown> {
  return { batchId: BATCH_ID, events: [event] };
}

describe('telemetry wire schema', () => {
  it('returns a sanitized valid batch and preserves the approved metric set', () => {
    const parsed = parseTelemetryBatch(validBatch(), { nowMs: NOW });
    assert.equal(parsed.batchId, BATCH_ID);
    assert.deepEqual(parsed.events[0].metrics, { durationMs: 12, retryCount: 0 });
  });

  it('rejects unknown fields that could smuggle identity or provider data', () => {
    assert.throws(
      () =>
        parseTelemetryBatch(
          {
            ...validBatch(),
            userId: 'attacker-controlled',
          },
          { nowMs: NOW },
        ),
      (error: unknown) => error instanceof TelemetrySchemaError && error.code === 'invalid_batch',
    );
    assert.throws(
      () =>
        parseTelemetryBatch(
          { batchId: BATCH_ID, events: [{ ...validEvent(), providerId: 'secret-provider' }] },
          { nowMs: NOW },
        ),
      (error: unknown) => error instanceof TelemetrySchemaError && error.code === 'invalid_event',
    );
  });

  it('rejects non-finite, negative, and unknown metrics', () => {
    for (const metrics of [
      { durationMs: Number.NaN },
      { durationMs: Number.POSITIVE_INFINITY },
      { durationMs: -1 },
      { secretMetric: 1 },
    ]) {
      assert.throws(
        () => parseTelemetryBatch(validBatch({ ...validEvent(), metrics }), { nowMs: NOW }),
        (error: unknown) =>
          error instanceof TelemetrySchemaError && error.code === 'invalid_metric',
      );
    }
  });

  it('bounds semantic version text before it reaches storage', () => {
    assert.throws(
      () =>
        parseTelemetryBatch(
          validBatch({ ...validEvent(), appVersion: `1.2.3+${'x'.repeat(60)}` }),
          { nowMs: NOW },
        ),
      (error: unknown) => error instanceof TelemetrySchemaError && error.code === 'invalid_event',
    );
  });

  it('rejects duplicate event IDs and oversized batches', () => {
    assert.throws(
      () =>
        parseTelemetryBatch(
          { batchId: BATCH_ID, events: [validEvent(), validEvent()] },
          { nowMs: NOW },
        ),
      (error: unknown) => error instanceof TelemetrySchemaError && error.code === 'invalid_batch',
    );
    const events = Array.from({ length: 33 }, (_, index) =>
      validEvent(`33333333-3333-4${String(index).padStart(3, '0')}-8333-333333333333`),
    );
    assert.throws(
      () => parseTelemetryBatch({ batchId: BATCH_ID, events }, { nowMs: NOW }),
      (error: unknown) => error instanceof TelemetrySchemaError && error.code === 'invalid_batch',
    );
  });

  it('enforces the retention window and request body byte cap', () => {
    assert.throws(
      () =>
        parseTelemetryBatch(
          {
            batchId: BATCH_ID,
            events: [{ ...validEvent(), occurredAt: NOW - 30 * 24 * 60 * 60 * 1000 - 1 }],
          },
          { nowMs: NOW },
        ),
      (error: unknown) =>
        error instanceof TelemetrySchemaError && error.code === 'timestamp_out_of_retention',
    );
    assert.throws(
      () =>
        parseTelemetryBatch(validBatch({ ...validEvent(), occurredAt: NOW + 300_001 }), {
          nowMs: NOW,
        }),
      (error: unknown) =>
        error instanceof TelemetrySchemaError && error.code === 'timestamp_out_of_retention',
    );
    assert.throws(
      () => parseTelemetryJson('x'.repeat(MAX_TELEMETRY_BATCH_BYTES + 1), { nowMs: NOW }),
      (error: unknown) =>
        error instanceof TelemetrySchemaError && error.code === 'payload_too_large',
    );
  });
});

function diagnosticEvent(overrides: Record<string, unknown> = {}) {
  return {
    ...validEvent(),
    schemaVersion: 2,
    eventName: 'diagnostic',
    feature: 'app',
    diagnostic: 'resource_sample',
    metrics: { sampleCount: 1, heapUsedMiB: 128, heapLimitMiB: 2048 },
    ...overrides,
  };
}
describe('expanded app diagnostics wire scope', () => {
  it('preserves only the closed v2 feature, category and aggregate contract', () => {
    for (const event of [
      diagnosticEvent(),
      diagnosticEvent({
        diagnostic: 'event_loop_delay',
        metrics: { sampleCount: 4, eventLoopDelayMs: 80 },
      }),
      diagnosticEvent({ diagnostic: 'renderer_error', metrics: { count: 2 }, outcome: 'error' }),
      {
        ...validEvent(),
        schemaVersion: 2,
        eventName: 'feature_open',
        feature: 'canvas',
        metrics: { count: 3 },
      },
      {
        ...validEvent(),
        schemaVersion: 2,
        eventName: 'tool_outcome',
        feature: 'terminal',
        metrics: { count: 1, durationMs: 400 },
      },
    ])
      assert.deepEqual(
        parseTelemetryBatch(validBatch(event), { nowMs: NOW, allowAppDiagnostics: true }).events[0],
        event,
      );
  });
  it('does not expand the v1 allowlist when v2 categories are introduced', () => {
    for (const event of [
      { ...validEvent(), feature: 'settings' },
      { ...validEvent(), diagnostic: 'resource_sample' },
      { ...validEvent(), metrics: { heapUsedMiB: 128 } },
      { ...validEvent(), metrics: { count: 1 } },
    ])
      assert.throws(
        () => parseTelemetryBatch(validBatch(event), { nowMs: NOW, allowAppDiagnostics: true }),
        TelemetrySchemaError,
      );
    assert.deepEqual(
      parseTelemetryBatch(validBatch(), { nowMs: NOW, allowAppDiagnostics: true }).events[0],
      validEvent(),
    );
  });
  it('rejects private sentinels, unknown enums and cross-category fields', () => {
    for (const field of [
      'message',
      'stack',
      'url',
      'path',
      'args',
      'token',
      'accountBalance',
      'content',
      'providerId',
    ]) {
      assert.throws(
        () =>
          parseTelemetryBatch(validBatch(diagnosticEvent({ [field]: 'PRIVATE_SENTINEL' })), {
            nowMs: NOW,
            allowAppDiagnostics: true,
          }),
        TelemetrySchemaError,
      );
    }
    for (const event of [
      diagnosticEvent({ feature: 'PRIVATE_SENTINEL' }),
      diagnosticEvent({ diagnostic: 'PRIVATE_SENTINEL' }),
      diagnosticEvent({ eventName: 'token_optimization' }),
      diagnosticEvent({ metrics: { sampleCount: 1, actualInputTokens: 40 } }),
      diagnosticEvent({ eventName: 'feature_open', metrics: { count: 1 } }),
      diagnosticEvent({ [Symbol('PRIVATE_SENTINEL')]: true }),
    ])
      assert.throws(
        () => parseTelemetryBatch(validBatch(event), { nowMs: NOW, allowAppDiagnostics: true }),
        TelemetrySchemaError,
      );
  });
  it('bounds v2 aggregates and requires meaningful category-specific measurements', () => {
    for (const metrics of [
      {},
      { sampleCount: 0, heapUsedMiB: 1, heapLimitMiB: 2 },
      { sampleCount: 61, heapUsedMiB: 1, heapLimitMiB: 2 },
      { sampleCount: 1, heapUsedMiB: -1, heapLimitMiB: 2 },
      { sampleCount: 1, heapUsedMiB: 0.5, heapLimitMiB: 2 },
      { sampleCount: 1, heapUsedMiB: Infinity, heapLimitMiB: 2 },
      { sampleCount: 1, heapUsedMiB: 3, heapLimitMiB: 2 },
      { sampleCount: 1, heapUsedMiB: 1, heapLimitMiB: 1_048_577 },
    ])
      assert.throws(
        () =>
          parseTelemetryBatch(validBatch(diagnosticEvent({ metrics })), {
            nowMs: NOW,
            allowAppDiagnostics: true,
          }),
        TelemetrySchemaError,
      );
    assert.throws(
      () =>
        parseTelemetryBatch(
          validBatch(
            diagnosticEvent({
              diagnostic: 'event_loop_delay',
              metrics: { sampleCount: 1, eventLoopDelayMs: 60_001 },
            }),
          ),
          { nowMs: NOW, allowAppDiagnostics: true },
        ),
      TelemetrySchemaError,
    );
  });
});

it('keeps existing client validators v1-only unless their caller explicitly opts into v2', () => {
  assert.throws(
    () => parseTelemetryBatch(validBatch(diagnosticEvent()), { nowMs: NOW }),
    TelemetrySchemaError,
  );
});
