import { describe, expect, it } from 'vitest';
import {
  createQueuedMessage,
  describeQueueToast,
  queueFlushModeLabel,
  shouldDispatchNextQueuedMessage,
  shouldScheduleQueuedRunFlush,
  shouldFlushOnRunStatus,
  shouldFlushOnToolTerminal,
  takeNextQueuedMessage,
} from './composerQueuePolicy';

describe('composerQueuePolicy', () => {
  it('creates after-tool and after-run queue items', () => {
    const tool = createQueuedMessage('  fix the bug  ', 'after-tool', 1000, 'q1');
    const run = createQueuedMessage('summarize', 'after-run', 1001, 'q2');
    expect(tool).toEqual({
      id: 'q1',
      text: 'fix the bug',
      createdAt: 1000,
      flushMode: 'after-tool',
    });
    expect(run?.flushMode).toBe('after-run');
    expect(createQueuedMessage('   ', 'after-tool')).toBeNull();
  });

  it('flushes after-tool only on tool terminal statuses', () => {
    const head = createQueuedMessage('next', 'after-tool', 1, 'q')!;
    expect(shouldFlushOnToolTerminal(head, 'running')).toBe(false);
    expect(shouldFlushOnToolTerminal(head, 'pending')).toBe(false);
    expect(shouldFlushOnToolTerminal(head, 'done')).toBe(true);
    expect(shouldFlushOnToolTerminal(head, 'error')).toBe(true);
    expect(shouldFlushOnToolTerminal(head, 'cancelled')).toBe(true);
    const afterRun = createQueuedMessage('later', 'after-run', 2, 'q2')!;
    expect(shouldFlushOnToolTerminal(afterRun, 'done')).toBe(false);
  });

  it('flushes any head when the full run ends', () => {
    const tool = createQueuedMessage('a', 'after-tool', 1, 'q1')!;
    const run = createQueuedMessage('b', 'after-run', 2, 'q2')!;
    expect(shouldFlushOnRunStatus(tool, 'done')).toBe(true);
    expect(shouldFlushOnRunStatus(run, 'cancelled')).toBe(true);
    expect(shouldFlushOnRunStatus(run, 'running')).toBe(false);
  });

  it('does not auto-flush a terminal run while an explicit steer is in flight', () => {
    expect(shouldScheduleQueuedRunFlush('done', false)).toBe(true);
    expect(shouldScheduleQueuedRunFlush('error', false)).toBe(true);
    expect(shouldScheduleQueuedRunFlush('cancelled', false)).toBe(true);
    expect(shouldScheduleQueuedRunFlush('cancelled', true)).toBe(false);
    expect(shouldScheduleQueuedRunFlush('done', true)).toBe(false);
    expect(shouldScheduleQueuedRunFlush('running', true)).toBe(false);
  });

  it('does not execute an already-scheduled queue flush during a steer handoff', () => {
    expect(shouldDispatchNextQueuedMessage(false, false)).toBe(true);
    expect(shouldDispatchNextQueuedMessage(true, false)).toBe(false);
    expect(shouldDispatchNextQueuedMessage(false, true)).toBe(false);
  });

  it.each(['opencode', 'codex'])('retains the %s FIFO while the full turn is still running', () => {
    const queue = [createQueuedMessage('later one', 'after-run', 1, 'one')!,
      createQueuedMessage('later two', 'after-run', 2, 'two')!];
    for (const phase of ['approval', 'question', 'streaming', 'post-tool']) {
      expect(shouldDispatchNextQueuedMessage(false, false, 'running'), phase).toBe(false);
      expect(queue.map(item => item.id)).toEqual(['one', 'two']);
    }
    for (const status of ['done', 'error', 'cancelled']) {
      expect(shouldDispatchNextQueuedMessage(false, false, status)).toBe(true);
    }
  });

  it('pops FIFO and labels modes for UI', () => {
    const a = createQueuedMessage('one', 'after-tool', 1, 'a')!;
    const b = createQueuedMessage('two', 'after-run', 2, 'b')!;
    const { next, remaining } = takeNextQueuedMessage([a, b]);
    expect(next?.id).toBe('a');
    expect(remaining.map((m) => m.id)).toEqual(['b']);
    expect(queueFlushModeLabel('after-tool')).toBe('After tool');
    expect(queueFlushModeLabel('after-run')).toBe('After run');
    expect(describeQueueToast('after-tool').title).toBe('Message queued');
    expect(describeQueueToast('after-run').body).toMatch(/Tab/i);
  });
});
