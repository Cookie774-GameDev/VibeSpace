import { afterEach, expect, it, vi } from 'vitest';
import {
  createTelemetryExporter,
  optionalTelemetryEvent,
  optionalActivityEvent,
  type TelemetryBatch,
} from './telemetryExporter';
import type { IntelligenceTelemetryEvent } from '@/lib/ai/intelligenceTelemetry';
import { parseTelemetryBatch } from '../../../../supabase/functions/_shared/telemetrySchema';

const now = 1_800_000_000_000;
const source = (): IntelligenceTelemetryEvent => ({
  schemaVersion: 1,
  eventId: 'private-event',
  requestId: 'private-request',
  accountScopeHash: 'private-account',
  projectScopeHash: 'private-project',
  attemptNumber: 1,
  observedAt: now,
  kind: 'context_retrieval',
  providerId: 'private-provider',
  modelId: 'private-model',
  metrics: { durationMs: 12, actualInputTokens: 40 },
  attributes: { resultState: 'completed', errorCode: 'private-error-text' },
});
const event = () => optionalTelemetryEvent(source(), { appVersion: '1.5.0', platform: 'windows' })!;
const validate = (value: unknown): value is TelemetryBatch => {
  try {
    parseTelemetryBatch(value, { nowMs: now });
    return true;
  } catch {
    return false;
  }
};
function setup() {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  const transport = vi.fn(
    async (_account: string, batch: TelemetryBatch, _signal: AbortSignal) => ({
      acceptedEventIds: batch.events.map((row) => row.eventId),
    }),
  );
  const options = { storage, transport, validate, now: () => now, random: () => 0 };
  return { memory, storage, transport, options, exporter: createTelemetryExporter(options) };
}
afterEach(() => vi.useRealTimers());

it('bounds an unresponsive transport even when it ignores AbortSignal', async () => {
  vi.useFakeTimers();
  const { exporter, transport } = setup();
  exporter.configure('a', true);
  exporter.enqueue(event());
  transport.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = exporter.flush();
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(exporter.getSnapshot()).toMatchObject({ queued: 1, sending: false, retryAt: now + 2_000 });
});

it('never exports local identifiers, strings, raw payloads or nonfinite metrics', () => {
  const input = source();
  input.metrics.actualOutputTokens = Infinity;
  const safe = optionalTelemetryEvent(input, { appVersion: '1.5.0', platform: 'windows' });
  expect(JSON.stringify(safe)).not.toContain('private-');
  expect(safe?.metrics).toEqual({ durationMs: 12, actualInputTokens: 40 });
  expect(safe?.outcome).toBe('ok');
  expect(safe?.eventId).not.toBe(input.eventId);
});

it('exports tool outcome categories without copying diagnostic data or operation IDs', () => {
  const input = {
    sequence: 1,
    operationId: 'private-operation',
    kind: 'model.tool',
    phase: 'success',
    observedAt: now,
    monotonicMs: 7,
    durationMs: 12,
    data: { prompt: 'private-prompt', path: 'private-path', token: 'private-secret' },
  };
  const environment = { appVersion: '1.5.0', platform: 'windows' as const };
  const safe = optionalActivityEvent(input, environment);
  expect(safe).toMatchObject({
    eventName: 'tool_outcome',
    outcome: 'ok',
    metrics: { durationMs: 12 },
  });
  expect(JSON.stringify(safe)).not.toContain('private');
  expect(
    optionalActivityEvent({ ...input, kind: 'arbitrary-private-kind' }, environment),
  ).toBeNull();
  expect(optionalActivityEvent({ ...input, phase: 'observed' }, environment)).toBeNull();
});
it('does no enqueue, persistence, or networking before explicit account consent', async () => {
  const { exporter, memory, transport } = setup();
  expect(exporter.enqueue(event())).toBe(false);
  await exporter.flush();
  expect(memory.size).toBe(0);
  expect(transport).not.toHaveBeenCalled();
});
it('batches at 32, defers disk work, bounds its queue and keeps stable IDs on restart', async () => {
  const { exporter, memory, transport, options } = setup();
  exporter.configure('a', true);
  for (let i = 0; i < 300; i++) exporter.enqueue(event());
  expect(memory.size).toBe(0);
  transport.mockRejectedValueOnce(new Error('offline'));
  await exporter.flush();
  expect(exporter.getSnapshot()).toMatchObject({ queued: 256, dropped: 44, retryAt: now + 2_000 });
  const original = transport.mock.calls[0][1].events.map((row) => row.eventId);
  expect(original).toHaveLength(32);
  const restarted = createTelemetryExporter(options);
  restarted.configure('a', true);
  await restarted.flush();
  expect(transport.mock.calls[1][1].events.map((row) => row.eventId)).toEqual(original);
  expect(restarted.getSnapshot()).toMatchObject({ queued: 224, acknowledged: 32 });
});
it('aborts an active request and purges durable events when consent is withdrawn', async () => {
  const { exporter, memory, transport } = setup();
  let finish!: (value: { acceptedEventIds: string[] }) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  exporter.configure('a', true);
  const row = event();
  exporter.enqueue(row);
  const flight = exporter.flush();
  const signal = transport.mock.calls[0][2];
  expect(memory.size).toBe(1);
  exporter.configure('a', false);
  expect(signal.aborted).toBe(true);
  expect(memory.size).toBe(0);
  finish({ acceptedEventIds: [row.eventId] });
  await flight;
  expect(exporter.getSnapshot()).toMatchObject({ enabled: false, queued: 0, acknowledged: 0 });
});
it('does not replay another account events or accept acknowledgments for unsent IDs', async () => {
  const { exporter, options, transport } = setup();
  exporter.configure('a', true);
  exporter.enqueue(event());
  transport.mockRejectedValueOnce(Error('offline'));
  await exporter.flush();
  const restarted = createTelemetryExporter(options);
  restarted.configure('b', true);
  expect(restarted.getSnapshot().queued).toBe(0);
  restarted.enqueue(event());
  transport.mockResolvedValueOnce({ acceptedEventIds: ['foreign'] });
  await restarted.flush();
  expect(restarted.getSnapshot()).toMatchObject({
    queued: 1,
    acknowledged: 0,
    retryAt: now + 2_000,
  });
});
it('a permanent policy rejection turns uploading off and clears events', async () => {
  const { exporter, transport } = setup();
  exporter.configure('a', true);
  exporter.enqueue(event());
  transport.mockResolvedValueOnce({ acceptedEventIds: [], retryable: false } as never);
  await exporter.flush();
  expect(exporter.getSnapshot()).toMatchObject({ enabled: false, queued: 0 });
});
it('persistence failure cannot stop the product or prevent withdrawal', async () => {
  const { options, exporter } = setup();
  options.storage.setItem = () => {
    throw Error('quota');
  };
  exporter.configure('a', true);
  exporter.enqueue(event());
  await exporter.flush();
  expect(exporter.getSnapshot()).toMatchObject({ queued: 0, acknowledged: 1 });
  expect(() => exporter.configure(null, false)).not.toThrow();
});
