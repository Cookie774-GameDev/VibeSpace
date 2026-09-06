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
