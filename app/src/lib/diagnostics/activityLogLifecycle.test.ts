import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createActivityRecorder } from './appActivityLog';
import {
  startActivityLogPersistence,
  getActivityLogPersistenceStatus,
  awaitActivityDiagnosticClockCalibration,
  refreshActivityDiagnosticClockCalibration,
} from './activityLogLifecycle';
import type { DiagnosticBatch } from './activityLogPersistence';
import {
  ACTIVITY_DIAGNOSTIC_FIELDS,
  ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
} from './activityDiagnosticContract';

let stop: (() => Promise<void>) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
});
const sink = () =>
  vi.fn(async (batch: DiagnosticBatch) => ({
    accepted: batch.events.length,
    path: 'context-runtime.jsonl',
  }));
const capabilities = vi.fn(async () => ({
  schemaVersions: [ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION],
  fields: [...ACTIVITY_DIAGNOSTIC_FIELDS],
  maxBatchEvents: 64,
}));
const stableClockSample = async () => ({
  processId: 42,
  wallUs: 1_789_300_000_000_000,
  monotonicUs: 12_500_000,
});

it('does not write from a browser or auxiliary native window', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  recorder.record('model', 'started', { chatId: 'chat' });
  await startActivityLogPersistence({ recorder, write, capabilities, clockSample: stableClockSample, isDesktop: false, windowLabel: 'main' })();
  await startActivityLogPersistence({
    recorder,
    write,
    capabilities,
    clockSample: stableClockSample,
    isDesktop: true,
    windowLabel: 'dictation',
  })();
  await vi.runAllTimersAsync();
  expect(write).not.toHaveBeenCalled();
});

it('persists retained and future events without duplicate subscribers', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  recorder.record('model', 'started', { chatId: 'chat-a' });
  const options = { recorder, write, capabilities, clockSample: stableClockSample, isDesktop: true, windowLabel: 'main' };
  stop = startActivityLogPersistence(options);
  expect(startActivityLogPersistence(options)).toBe(stop);
  recorder.record('model', 'completed', { chatId: 'chat-a' });
  await vi.advanceTimersByTimeAsync(250);
  expect(
    write.mock.calls
      .flatMap(([batch]) => batch.events)
      .filter((row) => row.kind === 'model')
      .map((row) => [row.phase, row.chatId]),
  ).toEqual([
    ['started', 'chat-a'],
    ['completed', 'chat-a'],
  ]);
  expect(getActivityLogPersistenceStatus()).toMatchObject({ persisted: 3, dropped: 0 });
  await stop();
  recorder.record('model', 'started', { chatId: 'chat-b' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledTimes(1);
  stop = startActivityLogPersistence(options);
  await vi.advanceTimersByTimeAsync(250);
  expect(
    write.mock.calls
      .flatMap(([batch]) => batch.events)
      .filter((row) => row.kind === 'model')
      .map((row) => row.chatId),
  ).toEqual(['chat-a', 'chat-a', 'chat-b']);
});

it('reports source-ring eviction separately from successful native persistence', async () => {
  const recorder = createActivityRecorder(2);
  const write = sink();
  for (let i = 0; i < 5; i++) recorder.record('model', 'started', { chatId: 'chat' });
  stop = startActivityLogPersistence({ recorder, write, capabilities, clockSample: stableClockSample, isDesktop: true, windowLabel: 'main' });
  await vi.advanceTimersByTimeAsync(250);
  expect(write.mock.calls[0][0].droppedTotal).toBe(3);
  expect(
    write.mock.calls[0][0].events.filter((row) => row.kind === 'model').map((row) => row.sequence),
  ).toEqual([4, 5]);
  expect(write.mock.calls[0][0].events.some((row) => row.kind === 'diagnostics.clock')).toBe(true);
  expect(getActivityLogPersistenceStatus()).toMatchObject({ persisted: 3, dropped: 3 });
});

it('contains native failures and exposes them without leaking error messages', async () => {
  const recorder = createActivityRecorder();
  const write = vi.fn().mockRejectedValue(new Error('PRIVATE disk details'));
  stop = startActivityLogPersistence({
    recorder,
    write,
    capabilities,
    clockSample: async () => { throw new Error('clock unavailable'); },
    isDesktop: true,
    windowLabel: 'main',
  });
  expect(() =>
    recorder.record('semantic-tool', 'completed', { result: { ok: true } }),
  ).not.toThrow();
  await vi.advanceTimersByTimeAsync(250);
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    persisted: 0,
    dropped: 1,
    failedBatches: 1,
    lastError: 'persistence_uncertain',
    lastFailure: { kind: 'persistence_uncertain', firstSequence: 1, lastSequence: 1 },
  });
  expect(JSON.stringify(getActivityLogPersistenceStatus())).not.toContain('PRIVATE');
});

it('exposes a stale native schema before attempting persistence', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  const incompatible = vi.fn(async () => ({
    schemaVersions: [0],
    fields: [...ACTIVITY_DIAGNOSTIC_FIELDS],
    maxBatchEvents: 64,
  }));
  stop = startActivityLogPersistence({
    recorder,
    write,
    capabilities: incompatible,
    clockSample: stableClockSample,
    isDesktop: true,
    windowLabel: 'main',
  });
  await incompatible.mock.results[0]!.value;
  await Promise.resolve();
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    schemaStatus: 'mismatch',
    schemaError: 'diagnostics_schema_mismatch',
  });
  recorder.record('model', 'started', { chatId: 'chat' });
  await vi.advanceTimersByTimeAsync(250);
  expect(write).not.toHaveBeenCalled();
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    failedBatches: 1,
    lastError: 'diagnostics_schema_rejected',
  });
});

it('calibrates native and renderer monotonic clocks and supports an explicit bracket refresh', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  const samples = [
    { processId: 42, wallUs: 1_789_300_000_000_000, monotonicUs: 12_500 },
    { processId: 42, wallUs: 1_789_300_000_010_000, monotonicUs: 22_000 },
  ];
  const clockSample = vi.fn(async () => samples.shift()!);
  const walls = [1_000, 1_004, 1_010, 1_012];
  const monotonic = [10, 14, 20, 22];
  stop = startActivityLogPersistence({
    recorder,
    write,
    capabilities,
    clockSample,
    wallNow: () => walls.shift()!,
    monotonicNow: () => monotonic.shift()!,
    isDesktop: true,
    windowLabel: 'main',
  });
  const first = await awaitActivityDiagnosticClockCalibration();
  expect(first).toMatchObject({
    processId: 42,
    roundTripMs: 4,
    uncertaintyMs: 2,
    offsetMinMs: -1.5,
    offsetMaxMs: 2.5,
  });
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    clockStatus: 'ready',
    clockSamples: 1,
  });

  const second = await refreshActivityDiagnosticClockCalibration();
  expect(second).toMatchObject({
    processId: 42,
    roundTripMs: 2,
    uncertaintyMs: 1,
    offsetMinMs: 0,
    offsetMaxMs: 2,
  });
  expect(clockSample).toHaveBeenCalledTimes(2);
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    clockStatus: 'ready',
    clockSamples: 2,
  });
  expect(
    recorder.snapshot().events
      .filter((event) => event.kind === 'diagnostics.clock')
      .map((event) => event.phase),
  ).toEqual(['attached', 'refreshed']);
});

it('preserves reversed clock ordering as an explicit measurement failure instead of clamping', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  stop = startActivityLogPersistence({
    recorder,
    write,
    capabilities,
    clockSample: async () => ({ processId: 42, wallUs: 10_000, monotonicUs: 5_000 }),
    wallNow: (() => {
      const values = [10, 11];
      return () => values.shift()!;
    })(),
    monotonicNow: (() => {
      const values = [20, 19];
      return () => values.shift()!;
    })(),
    isDesktop: true,
    windowLabel: 'main',
  });
  expect(await awaitActivityDiagnosticClockCalibration()).toBeNull();
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    clockStatus: 'unavailable',
    clockSamples: 0,
  });
  const failed = recorder.snapshot().events.find(
    (event) => event.kind === 'diagnostics.clock' && event.phase === 'failed',
  );
  expect(failed).toBeDefined();
  expect(failed?.data).toMatchObject({ resultCode: 'clock_order_invalid' });
});

it('flushes more than one native batch when the lifecycle stops', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  stop = startActivityLogPersistence({ recorder, write, capabilities, clockSample: stableClockSample, isDesktop: true, windowLabel: 'main' });
  for (let i = 0; i < 130; i++) recorder.record('model', 'started', { chatId: 'chat' });
  await stop();
  expect(write).toHaveBeenCalledTimes(3);
  expect(
    write.mock.calls.flatMap(([batch]) => batch.events).filter((row) => row.kind === 'model'),
  ).toHaveLength(130);
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    persisted: 130,
    pending: 0,
    stopped: true,
  });
});

it('serializes a hot replacement behind the previous native acknowledgement', async () => {
  const recorder = createActivityRecorder();
  let release!: (receipt: { accepted: number; path: string }) => void;
  const write = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async (batch: DiagnosticBatch) => ({
      accepted: batch.events.length,
      path: 'context-runtime.jsonl',
    }));
  const options = { recorder, write, capabilities, clockSample: stableClockSample, isDesktop: true, windowLabel: 'main' };
  const oldStop = startActivityLogPersistence(options);
  recorder.record('model', 'started', { chatId: 'old' });
  await vi.advanceTimersByTimeAsync(250);
  const closing = oldStop();
  stop = startActivityLogPersistence(options);
  recorder.record('model', 'completed', { chatId: 'new' });
  await vi.advanceTimersByTimeAsync(250);
  expect(write).toHaveBeenCalledTimes(1);
  release({ accepted: (write.mock.calls[0]![0] as DiagnosticBatch).events.length, path: 'context-runtime.jsonl' });
  await closing;
  await stop();
  expect(
    write.mock.calls
      .flatMap(([batch]) => (batch as DiagnosticBatch).events)
      .filter((row) => row.kind === 'model')
      .map((row) => row.sequence),
  ).toEqual([1, 3]);
  await oldStop();
  expect(write).toHaveBeenCalledTimes(2);
});
