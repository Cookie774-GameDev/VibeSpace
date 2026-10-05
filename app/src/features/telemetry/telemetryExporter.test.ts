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

const expandedEvent = () => ({
  eventId: crypto.randomUUID(),
  eventName: 'feature_open' as const,
  schemaVersion: 2 as const,
  occurredAt: now,
  appVersion: '1.5.0',
  platform: 'windows' as const,
  feature: 'canvas' as const,
  outcome: 'ok' as const,
  metrics: { count: 1 },
});
function setupExpanded() {
  const f = setup();
  let time = now;
  const options = {
    ...f.options,
    now: () => time,
    validate: (value: unknown): value is TelemetryBatch => {
      try {
        parseTelemetryBatch(value, { nowMs: time, allowAppDiagnostics: true });
        return true;
      } catch {
        return false;
      }
    },
  };
  return {
    ...f,
    options,
    exporter: createTelemetryExporter(options),
    advance: () => {
      time += 3_000;
    },
  };
}
it('requires explicit current v2 authorization even with a schema-capable validator', async () => {
  const f = setupExpanded();
  f.exporter.configure('a', true);
  expect(f.exporter.enqueue(expandedEvent())).toBe(false);
  f.exporter.configure('a', true, true);
  expect(f.exporter.enqueue(expandedEvent())).toBe(true);
  await f.exporter.flush();
  expect(f.transport.mock.calls[0][1].events[0].schemaVersion).toBe(2);
});
it('drops persisted v2 rows on restart while retaining legacy mixed-queue recovery', async () => {
  const f = setupExpanded();
  f.exporter.configure('a', true, true);
  const legacy = event();
  const expanded = expandedEvent();
  f.exporter.enqueue(legacy);
  f.exporter.enqueue(expanded);
  f.transport.mockRejectedValueOnce(new Error('synthetic offline'));
  await f.exporter.flush();
  const reopened = createTelemetryExporter(f.options);
  reopened.configure('a', true, true);
  expect(reopened.getSnapshot().queued).toBe(1);
  await reopened.flush();
  expect(f.transport.mock.calls[1][1].events.map((row) => row.eventId)).toEqual([legacy.eventId]);
});
it('retains stable v2 IDs for same-session offline retry under current authorization', async () => {
  const f = setupExpanded();
  f.exporter.configure('a', true, true);
  const row = expandedEvent();
  f.exporter.enqueue(row);
  f.transport.mockRejectedValueOnce(new Error('synthetic offline'));
  await f.exporter.flush();
  f.advance();
  await f.exporter.flush();
  expect(f.transport.mock.calls.map((call) => call[1].events[0].eventId)).toEqual([
    row.eventId,
    row.eventId,
  ]);
});
it('aborts old mixed flights and discards v2 when expanded scope is withdrawn without dropping v1', async () => {
  const f = setupExpanded();
  let finish!: (value: { acceptedEventIds: string[] }) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.exporter.configure('a', true, true);
  const legacy = event();
  const expanded = expandedEvent();
  f.exporter.enqueue(legacy);
  f.exporter.enqueue(expanded);
  const flight = f.exporter.flush();
  const signal = f.transport.mock.calls[0][2];
  f.exporter.configure('a', true, false);
  expect(signal.aborted).toBe(true);
  expect(f.exporter.getSnapshot().queued).toBe(1);
  expect(f.exporter.enqueue(expandedEvent())).toBe(false);
  finish({ acceptedEventIds: [legacy.eventId, expanded.eventId] });
  await flight;
  f.exporter.configure('a', true, true);
  await f.exporter.flush();
  expect(f.transport.mock.calls[1][1].events.map((row) => row.eventId)).toEqual([legacy.eventId]);
});
it('does not revive v2 after account ABA or scope off/on', async () => {
  const f = setupExpanded();
  f.exporter.configure('a', true, true);
  f.exporter.enqueue(expandedEvent());
  f.exporter.configure('b', true, true);
  f.exporter.configure('a', true, true);
  await f.exporter.flush();
  expect(f.transport).not.toHaveBeenCalled();
  f.exporter.enqueue(expandedEvent());
  f.exporter.configure('a', true, false);
  f.exporter.configure('a', true, true);
  await f.exporter.flush();
  expect(f.transport).not.toHaveBeenCalled();
});

it('notifies only the current account when authoritative upload authorization is rejected', async () => {
  const f = setupExpanded();
  const rejected = vi.fn();
  const unsubscribe = f.exporter.subscribeAuthorizationRejections(rejected);
  f.exporter.configure('a', true, true);
  f.exporter.enqueue(expandedEvent());
  f.transport.mockResolvedValueOnce({ acceptedEventIds: [], retryable: false } as never);
  await f.exporter.flush();
  expect(rejected).toHaveBeenCalledExactlyOnceWith('a');
  unsubscribe();
  f.exporter.configure('b', true, true);
  f.exporter.enqueue(expandedEvent());
  f.transport.mockResolvedValueOnce({ acceptedEventIds: [], retryable: false } as never);
  await f.exporter.flush();
  expect(rejected).toHaveBeenCalledTimes(1);
});
it('does not notify denial from an obsolete account flight or a transient outage', async () => {
  const f = setupExpanded();
  const rejected = vi.fn();
  f.exporter.subscribeAuthorizationRejections(rejected);
  let finish!: (value: { acceptedEventIds: string[]; retryable: false }) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.exporter.configure('a', true, true);
  f.exporter.enqueue(expandedEvent());
  const flight = f.exporter.flush();
  f.exporter.configure('b', true, true);
  finish({ acceptedEventIds: [], retryable: false });
  await flight;
  expect(rejected).not.toHaveBeenCalled();
  f.exporter.enqueue(expandedEvent());
  f.transport.mockRejectedValueOnce(new Error('synthetic temporary outage'));
  await f.exporter.flush();
  expect(rejected).not.toHaveBeenCalled();
  expect(f.exporter.getSnapshot().enabled).toBe(true);
});
