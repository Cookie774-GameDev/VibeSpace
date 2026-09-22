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
