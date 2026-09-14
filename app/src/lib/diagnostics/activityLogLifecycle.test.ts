import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createActivityRecorder } from './appActivityLog';
import {
  startActivityLogPersistence,
  getActivityLogPersistenceStatus,
} from './activityLogLifecycle';
import type { DiagnosticBatch } from './activityLogPersistence';

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

it('does not write from a browser or auxiliary native window', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  recorder.record('model', 'started', { chatId: 'chat' });
  await startActivityLogPersistence({ recorder, write, isDesktop: false, windowLabel: 'main' })();
  await startActivityLogPersistence({
    recorder,
    write,
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
  const options = { recorder, write, isDesktop: true, windowLabel: 'main' };
  stop = startActivityLogPersistence(options);
  expect(startActivityLogPersistence(options)).toBe(stop);
  recorder.record('model', 'completed', { chatId: 'chat-a' });
  await vi.advanceTimersByTimeAsync(250);
  expect(write.mock.calls.flatMap(([batch]) => batch.events.map((row) => row.sequence))).toEqual([
    1, 2,
  ]);
  expect(getActivityLogPersistenceStatus()).toMatchObject({ persisted: 2, dropped: 0 });
  await stop();
  recorder.record('model', 'started', { chatId: 'chat-b' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledTimes(1);
  stop = startActivityLogPersistence(options);
  await vi.advanceTimersByTimeAsync(250);
  expect(write.mock.calls.flatMap(([batch]) => batch.events.map((row) => row.sequence))).toEqual([
    1, 2, 3,
  ]);
});

it('reports source-ring eviction separately from successful native persistence', async () => {
  const recorder = createActivityRecorder(2);
  const write = sink();
  for (let i = 0; i < 5; i++) recorder.record('model', 'started', { chatId: 'chat' });
  stop = startActivityLogPersistence({ recorder, write, isDesktop: true, windowLabel: 'main' });
  await vi.advanceTimersByTimeAsync(250);
  expect(write.mock.calls[0][0].droppedTotal).toBe(3);
  expect(write.mock.calls[0][0].events.map((row) => row.sequence)).toEqual([4, 5]);
  expect(getActivityLogPersistenceStatus()).toMatchObject({ persisted: 2, dropped: 3 });
});

it('contains native failures and exposes them without leaking error messages', async () => {
  const recorder = createActivityRecorder();
  const write = vi.fn().mockRejectedValue(new Error('PRIVATE disk details'));
  stop = startActivityLogPersistence({ recorder, write, isDesktop: true, windowLabel: 'main' });
  expect(() =>
    recorder.record('semantic-tool', 'completed', { result: { ok: true } }),
  ).not.toThrow();
  await vi.advanceTimersByTimeAsync(250);
  expect(getActivityLogPersistenceStatus()).toMatchObject({
    persisted: 0,
    dropped: 1,
    failedBatches: 1,
    lastError: 'native_write_failed',
  });
  expect(JSON.stringify(getActivityLogPersistenceStatus())).not.toContain('PRIVATE');
});

it('flushes more than one native batch when the lifecycle stops', async () => {
  const recorder = createActivityRecorder();
  const write = sink();
  stop = startActivityLogPersistence({ recorder, write, isDesktop: true, windowLabel: 'main' });
  for (let i = 0; i < 130; i++) recorder.record('model', 'started', { chatId: 'chat' });
  await stop();
  expect(write).toHaveBeenCalledTimes(3);
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
  const options = { recorder, write, isDesktop: true, windowLabel: 'main' };
  const oldStop = startActivityLogPersistence(options);
  recorder.record('model', 'started', { chatId: 'old' });
  await vi.advanceTimersByTimeAsync(250);
  const closing = oldStop();
  stop = startActivityLogPersistence(options);
  recorder.record('model', 'completed', { chatId: 'new' });
  await vi.advanceTimersByTimeAsync(250);
  expect(write).toHaveBeenCalledTimes(1);
  release({ accepted: 1, path: 'context-runtime.jsonl' });
  await closing;
  await stop();
  expect(
    write.mock.calls.flatMap(([batch]) =>
      (batch as DiagnosticBatch).events.map((row) => row.sequence),
    ),
  ).toEqual([1, 2]);
  await oldStop();
  expect(write).toHaveBeenCalledTimes(2);
});
