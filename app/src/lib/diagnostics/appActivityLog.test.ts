import { describe, it, expect, vi } from 'vitest';
import { createActivityRecorder } from './appActivityLog';

describe('app-wide activity recorder', () => {
  it('reports unsuccessful tool responses as failure and clears active work', async () => {
    const log = createActivityRecorder();
    await log.trace('semantic-tool', { tool: 'vibespace_context' }, async () => {
      expect(log.snapshot().active).toHaveLength(1);
      return { ok: false, message: 'source unavailable' };
    });
    expect(log.snapshot().events.at(-1)?.phase).toBe('failed');
    expect(log.snapshot().active).toHaveLength(0);
  });
  it('keeps correlated start/result records with measured duration and redacts secrets', async () => {
    const log = createActivityRecorder(10);
    const result = await log.trace(
      'tool',
      { requestId: 'r1', tool: 'vibespace_context' },
      async () => ({ ok: true, password: 'do-not-log', data: 'source answer' }),
    );
    expect(result.password).toBe('do-not-log');
    const rows = log.snapshot(0).events;
    expect(rows.map((row) => row.phase)).toEqual(['started', 'completed']);
    expect(rows[1].operationId).toBe(rows[0].operationId);
    expect(rows[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(rows)).not.toContain('do-not-log');
    expect(JSON.stringify(rows)).toContain('source answer');
  });
  it('preserves operation errors and exposes buffer gaps instead of pretending complete coverage', async () => {
    const log = createActivityRecorder(2);
    const error = new Error('operation failed');
    await expect(
      log.trace('model', {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    log.record('tool', 'received', { tool: 'context.read' });
    expect(log.snapshot(0).dropped).toBe(1);
    expect(log.snapshot(0).events[0].phase).toBe('failed');
    expect(log.snapshot(2).events).toHaveLength(1);
  });
});

it('keeps native viewer imports and reloaded instrumentation on one recorder', async () => {
  const first = await import('./appActivityLog');
  first.appActivityLog.record('fixture', 'received', { tool: 'vibespace_context' });
  const sequence = first.appActivityLog.snapshot().sequence;
  vi.resetModules();
  const reloaded = await import('./appActivityLog');
  expect(reloaded.appActivityLog).toBe(first.appActivityLog);
  expect(reloaded.appActivityLog.snapshot().sequence).toBe(sequence);
});

describe('bounded diagnostic work', () => {
  it('does not walk every entry of large tool results before truncating', () => {
    const log = createActivityRecorder();
    let reads = 0;
    const rows = Array.from({ length: 20_000 }, (_, id) => ({
      id,
      get text() {
        reads += 1;
        return 'source evidence';
      },
    }));
    log.record('semantic-tool', 'completed', { rows });
    expect(reads).toBeLessThan(1_000);
    expect(JSON.stringify(log.snapshot().events)).toContain('omitted');
    expect(log.snapshot().events).toHaveLength(1);
  });

  it('records deeply nested results without overflowing or losing the event', () => {
    const log = createActivityRecorder();
    let data: unknown = { answer: 'bottom' };
    for (let i = 0; i < 12_000; i += 1) data = { next: data };
    log.record('semantic-tool', 'completed', data);
    expect(log.snapshot().events).toHaveLength(1);
    expect(JSON.stringify(log.snapshot().events)).toContain('omitted');
  });
});

describe('diagnostic lifecycle and persistence subscribers', () => {
  it.each(['cancelled', 'canceled', 'aborted', 'timed_out', 'wall_time_exceeded'])(
    'settles active operations on %s',
    (phase) => {
      const log = createActivityRecorder();
      const id = log.record('semantic-tool', 'started', {});
      log.record('semantic-tool', phase, {}, id);
      expect(log.snapshot().active).toHaveLength(0);
    },
  );
  it('publishes sanitized events, isolates broken sinks, and unsubscribes', async () => {
    const log = createActivityRecorder();
    const rows: unknown[] = [];
    log.subscribe(() => {
      throw new Error('disk unavailable');
    });
    log.subscribe(async () => {
      throw new Error('async sink unavailable');
    });
    const stop = log.subscribe((event) => {
      rows.push(event);
    });
    const result = await log.trace('semantic-tool', { password: 'do-not-copy' }, async () => 42);
    expect(result).toBe(42);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('do-not-copy');
    stop();
    log.record('fixture', 'received', {});
    expect(rows).toHaveLength(2);
  });
});

describe('observational-only result classification', () => {
  it('does not read result accessors or replace a successful return with a logging error', async () => {
    const log = createActivityRecorder();
    const result = {
      get ok() {
        throw new Error('not diagnostic data');
      },
    };
    await expect(log.trace('semantic-tool', {}, async () => result)).resolves.toBe(result);
    expect(log.snapshot().events.at(-1)?.phase).toBe('completed');
  });
  it.each([
    ['cancelled', 'cancelled'],
    ['wall_time_exceeded', 'timed_out'],
  ])('keeps structured %s errors distinct from tool failures', async (code, phase) => {
    const log = createActivityRecorder();
    const error = Object.assign(new Error('bounded operation ended'), { code });
    await expect(
      log.trace('semantic-tool', {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const last = log.snapshot().events.at(-1)!;
    expect(last.phase).toBe(phase);
    expect(last.data).toMatchObject({ error: { code } });
    expect(log.snapshot().active).toHaveLength(0);
  });
});

describe('returned tool failure envelopes', () => {
  it('counts an MCP isError result as failure without changing the result', async () => {
    const log = createActivityRecorder();
    const result = { isError: true, content: [{ type: 'text', text: 'tool rejected input' }] };
    await expect(log.trace('semantic-tool', {}, async () => result)).resolves.toBe(result);
    expect(log.snapshot().events.at(-1)?.phase).toBe('failed');
    expect(log.snapshot().active).toHaveLength(0);
  });
  it.each([
    ['cancelled', 'cancelled'],
    ['wall_time_exceeded', 'timed_out'],
  ])('classifies returned %s separately from generic errors', async (code, phase) => {
    const log = createActivityRecorder();
    const result = { ok: false, code };
    await expect(log.trace('semantic-tool', {}, async () => result)).resolves.toBe(result);
    expect(log.snapshot().events.at(-1)?.phase).toBe(phase);
    expect(log.snapshot().active).toHaveLength(0);
  });
});

// Pending: diagnostic-copy truncation metadata. The implementation tool call
// was blocked externally; do not count the separate reproduction as a pass.

it('marks diagnostic-copy clipping independently of the source result status', () => {
  const recorder = createActivityRecorder();
  recorder.record('semantic-tool', 'completed', {
    result: {
      ok: true,
      data: {
        complete: true,
        text: 'small response',
      },
    },
  });
  recorder.record('semantic-tool', 'completed', {
    result: {
      ok: true,
      data: {
        complete: true,
        text: 'x'.repeat(20_000),
      },
    },
  });
  recorder.record('semantic-tool', 'completed', { rows: Array.from({ length: 100 }, (_, i) => i) });
  const events = recorder.snapshot().events;
  expect(events.map((row) => row.diagnosticTruncated)).toEqual([false, true, true]);
  expect(events[1].data).toMatchObject({ result: { ok: true, data: { complete: true } } });
});


describe('generated diagnostic correlation identifiers', () => {
  const requestId = 'jreq_01234567-89ab-4cde-8f01-23456789abcd';
  const runId = 'jrun_01234567-89ab-4cde-8f01-23456789abcd';

  it('preserves exact generated IDs in trusted envelope positions across entropy redaction', async () => {
    const log = createActivityRecorder();
    await log.trace('model', { requestId, runId, password: requestId }, async () => ({ ok: true }));
    const rows = log.snapshot().events;
    expect(rows[0].data).toMatchObject({ requestId, runId, password: '[redacted]' });
    expect(rows[1].data).toMatchObject({ request: { requestId, runId, password: '[redacted]' } });
  });

  it('does not exempt secrets, malformed IDs, or arbitrary result text', () => {
    const log = createActivityRecorder();
    log.record('model', 'started', {
      requestId: 'sk-proj-0123456789abcdefghijklmnopqrstuvwxyz',
      runId: runId + '-private',
      result: { requestId, text: requestId },
      password: runId,
    });
    const data = log.snapshot().events[0].data as Record<string, unknown>;
    expect(data.requestId).not.toContain('sk-proj-');
    expect(data.runId).not.toBe(runId + '-private');
    expect(data.result).not.toEqual({ requestId, text: requestId });
    expect(data.password).toBe('[redacted]');
  });
});
