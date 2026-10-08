import { expect, it, vi } from 'vitest';
import { codexTurnLease, createCodexTurnLease } from './codexTurnLease';
import { optionalActivityEvent } from '@/features/telemetry/telemetryExporter';
import { createAppDiagnosticsCollector } from '@/features/telemetry/appDiagnostics';
import type { AppActivityEvent } from '@/lib/diagnostics/appActivityLog';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { toPersistedActivity } from '@/lib/diagnostics/activityLogPersistence';

const requestId = 'jreq_12345678-1234-4234-8234-123456789abc';

it('keeps admission FIFO when a requested diagnostic synchronously requests another lease', async () => {
  const order: string[] = [];
  let late: Promise<void> | undefined;
  const lease = createCodexTurnLease(undefined, { record: (event) => {
    if (event.leaseId === 'codex-lease-1' && event.phase === 'requested') {
      late = lease.acquire(undefined, { kind: 'mcp-status' }).then((release) => {
        order.push('late'); release();
      });
    }
  } });
  await lease.acquire(undefined, { kind: 'turn', requestId }).then((release) => {
    order.push('first'); release();
  });
  await late;
  expect(order).toEqual(['first', 'late']);
});

it('keeps queued waiters ahead of reentrant diagnostics during release', async () => {
  const order: string[] = [];
  let late: Promise<void> | undefined;
  const lease = createCodexTurnLease(undefined, { record: (event) => {
    if (event.leaseId === 'codex-lease-1' && event.phase === 'released') {
      late = lease.acquire(undefined, { kind: 'mcp-status' }).then((release) => {
        order.push('late'); release();
      });
    }
  } });
  const first = await lease.acquire(undefined, { kind: 'model-catalog' });
  const queued = lease.acquire(undefined, { kind: 'turn', requestId }).then((release) => {
    order.push('queued'); release();
  });
  first();
  await queued;
  await late;
  expect(order).toEqual(['queued', 'late']);
});

it('attributes waiters to the actual held lease without changing FIFO or release timing', async () => {
  let now = 0;
  const events: Array<Record<string, unknown>> = [];
  const lease = createCodexTurnLease(undefined, {
    monotonic: () => now,
    record: (event) => events.push(event),
  });
  const first = await lease.acquire(undefined, { kind: 'model-catalog' });
  now = 5;
  let acquired = false;
  const second = lease.acquire(undefined, { kind: 'turn', requestId }).then((release) => {
    acquired = true;
    return release;
  });
  await Promise.resolve();
  expect(acquired).toBe(false);
  const queued = events.find((event) => event.kind === 'turn' && event.phase === 'requested');
  expect(queued).toMatchObject({
    requestId, blockedBy: { kind: 'model-catalog', leaseId: 'codex-lease-1' },
  });
  now = 25;
  first();
  const releaseSecond = await second;
  expect(events).toContainEqual(expect.objectContaining({
    phase: 'acquired', kind: 'turn', requestId, leaseId: 'codex-lease-2', durationMs: 20,
  }));
  releaseSecond();
  releaseSecond();
  expect(events.filter((event) => event.leaseId === 'codex-lease-2' && event.phase === 'released')).toHaveLength(1);
});

it('records a cancelled waiter once and never attributes it as an admitted owner', async () => {
  const events: Array<Record<string, unknown>> = [];
  const lease = createCodexTurnLease(undefined, { record: (event) => events.push(event) });
  const release = await lease.acquire(undefined, { kind: 'turn', requestId });
  const abort = new AbortController();
  const pending = lease.acquire(abort.signal, { kind: 'model-catalog' });
  const rejection = expect(pending).rejects.toThrow();
  abort.abort();
  await rejection;
  release();
  expect(events.filter((event) => event.leaseId === 'codex-lease-2' && event.phase === 'cancelled')).toHaveLength(1);
  expect(events.some((event) => event.leaseId === 'codex-lease-2' && event.phase === 'acquired')).toBe(false);
});

it('does not log arbitrary owner data or let a diagnostic failure alter lease behavior', async () => {
  const events: Array<Record<string, unknown>> = [];
  const lease = createCodexTurnLease(undefined, { record: (event) => {
    events.push(event);
    throw new Error('diagnostic sink failed');
  } });
  const release = await lease.acquire(undefined, {
    kind: 'turn', requestId: 'C:/PRIVATE_OWNER/sk-proj-secret',
  });
  release();
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_OWNER');
  expect(JSON.stringify(events)).not.toContain('sk-proj');
  expect(events.every((event) => event.requestId === undefined)).toBe(true);
});

it('keeps the new diagnostic event kinds outside optional telemetry export', () => {
  const emit = vi.fn(() => true);
  const collector = createAppDiagnosticsCollector({
    allowed: () => true,
    readUi: () => ({ route: 'chat', settingsOpen: false, paletteOpen: false, voiceModalOpen: false }),
    subscribeUi: () => () => undefined,
    events: new EventTarget(), isVisible: () => true, readHeap: () => null,
    now: () => 1_790_000_000_000, monotonic: () => 0,
    environment: { appVersion: 'test', platform: 'windows' }, emit,
  });
  for (const kind of ['harness.codex.lease', 'harness.codex.model-validation', 'harness.codex.model-observation']) {
    const source: AppActivityEvent = {
      sequence: 1, operationId: 'local-only', kind, phase: 'failed',
      observedAt: 1, monotonicMs: 1, data: { requestId }, durationMs: 5,
    };
    expect(optionalActivityEvent(source, { appVersion: 'test', platform: 'windows' })).toBeNull();
    collector.recordOperation(kind, source.phase, source.durationMs);
  }
  collector.dispose();
  expect(emit.mock.calls).toHaveLength(0);
});

it('persists the actual blocking lease join without expanding the diagnostic schema', async () => {
  const before = appActivityLog.snapshot().sequence;
  const first = await codexTurnLease.acquire(undefined, { kind: 'model-catalog' });
  const waiting = codexTurnLease.acquire(undefined, { kind: 'turn', requestId });
  const rows = appActivityLog.snapshot(before).events
    .filter((event) => event.kind === 'harness.codex.lease').map(toPersistedActivity);
  try {
    const holder = rows.find((event) => event.eventType === 'lease.model-catalog.acquired');
    expect(holder?.callId).toMatch(/^codex-lease-\d+$/u);
    const waiter = rows.find((event) => event.requestId === requestId && event.phase === 'requested');
    expect(waiter?.resultCode).toBe(`blocked-by.${holder!.callId}`);
  } finally {
    first();
    (await waiting)();
  }
});

it('joins a native-shaped generation to its actual owner and omits arbitrary remembered values', async () => {
  const events: Array<Record<string, unknown>> = [];
  const lease = createCodexTurnLease(undefined, { record: (event) => events.push(event) });
  const release = await lease.acquire(undefined, { kind: 'turn', requestId });
  lease.remember('C:/PRIVATE_NATIVE_PATH');
  lease.remember('codex-generation-abcdefghijklmnopqrst');
  release();
  lease.remember('codex-generation-uvwxyzabcdefghijklmn');
  const bindings = events.filter((event) => event.phase === 'native-bound');
  expect(bindings).toEqual([expect.objectContaining({
    leaseId: 'codex-lease-1', kind: 'turn', requestId,
    generation: 'codex-generation-abcdefghijklmnopqrst',
  })]);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_NATIVE_PATH');
});
it('serializes owners and removes aborted queued requests', async () => {
  const lease = createCodexTurnLease();
  const first = await lease.acquire();
  const aborter = new AbortController();
  const cancelled = lease.acquire(aborter.signal);
  const rejection = expect(cancelled).rejects.toThrow();
  aborter.abort();
  await rejection;
  const admitted = vi.fn();
  const next = lease.acquire().then((release) => {
    admitted();
    release();
  });
  await Promise.resolve();
  expect(admitted).not.toHaveBeenCalled();
  first();
  first();
  await next;
  expect(admitted).toHaveBeenCalledTimes(1);
});
it('recovers only the remembered native generation after renderer replacement', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const prior = createCodexTurnLease(storage);
  prior.remember('native-generation-one');
  const next = createCodexTurnLease(storage);
  const stop = vi.fn().mockResolvedValue(true);
  await next.recover(stop);
  expect(stop).toHaveBeenCalledWith('native-generation-one');
  await next.recover(stop);
  expect(stop).toHaveBeenCalledTimes(1);
});
it('retains cleanup ownership on failure and cannot clear a replacement generation', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const lease = createCodexTurnLease(storage);
  lease.remember('first');
  await expect(
    lease.recover(async () => {
      throw Error('stop failed');
    }),
  ).rejects.toThrow('stop failed');
  lease.remember('second');
  lease.forget('first');
  const stop = vi.fn().mockResolvedValue(false);
  await lease.recover(stop);
  expect(stop).toHaveBeenCalledWith('second');
});
