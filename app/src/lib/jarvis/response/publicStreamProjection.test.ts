import { describe, expect, it } from 'vitest';
import { createPublicStreamProjection } from './publicStreamProjection';

const tool = { id: 'read-1', name: 'read', status: 'started' as const };

describe('request-local public stream projection', () => {
  it('publishes short public text, interleaves tools, and replaces exact text identities', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'START_P4F8', streamPartId: 'text-1' });
    expect(stream.snapshot()).toMatchObject({ text: 'START_P4F8',
      segments: [{ kind: 'text', id: 'text-1', text: 'START_P4F8' }] });
    stream.updateTool(tool);
    stream.pushText({ delta: '\nChecking the repository', streamPartId: 'text-2' });
    expect(stream.snapshot().segments.map(row => row.id)).toEqual(['text-1', 'read-1', 'text-2']);
    stream.pushText({ delta: 'REVISED_P4F8', mode: 'replace', streamPartId: 'text-1' });
    expect(stream.snapshot().text).toBe('REVISED_P4F8\nChecking the repository');
    expect(stream.snapshot().segments.map(row => row.id)).toEqual(['text-1', 'read-1', 'text-2']);
    expect(stream.snapshot().segments.filter(row => row.kind === 'text')).toHaveLength(2);
  });

  it('preserves unchanged snapshot and completed tool identities during prose updates', () => {
    const stream = createPublicStreamProjection();
    const details = Object.freeze({ command: 'git rev-parse --short HEAD' });
    stream.updateTool({ ...tool, status: 'completed', details });
    const initial = stream.snapshot();
    expect(stream.updateTool({ ...tool, status: 'completed', details })).toBe(false);
    expect(stream.snapshot()).toBe(initial);
    for (let i = 0; i < 100; i += 1) {
      stream.pushText({ delta: 'x', streamPartId: 'public' });
      expect(stream.snapshot().segments[0]).toBe(initial.segments[0]);
    }
    expect(stream.updateTool(tool)).toBe(false);
    expect(stream.getTool('read-1')?.status).toBe('completed');
    expect(Object.isFrozen(stream.snapshot())).toBe(true);
    expect(Object.isFrozen(stream.snapshot().segments)).toBe(true);
  });

  it('does not expose a sensitive marker split across different text part identities', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'Checking api_', streamPartId: 'first' });
    stream.updateTool(tool);
    stream.pushText({ delta: 'key=SENTINEL_SECRET', streamPartId: 'second' });
    expect(stream.snapshot().text).toBe('Checking');
    expect(JSON.stringify(stream.snapshot())).not.toMatch(/SENTINEL_SECRET|api_|key=/);
  });

  it('preserves fence classification across separate public items and tool events', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'Checking\n```action\n', streamPartId: 'first' });
    stream.updateTool(tool);
    stream.pushText({ delta: '{"secret":"SENTINEL_SECRET"}\n```\nReady', streamPartId: 'second' });
    expect(stream.snapshot().text).toBe('Checking\nReady');
    expect(JSON.stringify(stream.snapshot())).not.toMatch(/SENTINEL_SECRET|```|action/);
  });

  it('removes replaced unsafe text instead of keeping stale public content', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'Ready', streamPartId: 'first' });
    stream.pushText({ delta: 'password=SENTINEL_SECRET', streamPartId: 'first', mode: 'replace' });
    expect(stream.snapshot().text).toBe('');
    expect(stream.snapshot().segments).toEqual([]);
  });

  it('flushes a safe pending suffix only on the explicit completion event', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'Checking a', streamPartId: 'first' });
    expect(stream.snapshot().text).toBe('Checking');
    stream.pushText({ delta: '', done: true });
    expect(stream.snapshot().text).toBe('Checking a');
    expect(stream.pushText({ delta: 'LATE_CALLBACK', streamPartId: 'first' })).toBe(false);
    expect(stream.snapshot().text).toBe('Checking a');
  });

  it('seals callbacks while retaining safe interrupted text and disposes all request state', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'The answer began', streamPartId: 'first' });
    stream.seal();
    const previous = stream.snapshot();
    expect(stream.pushText({ delta: 'LATE_CALLBACK' })).toBe(false);
    expect(stream.updateTool(tool)).toBe(false);
    expect(stream.snapshot()).toBe(previous);
    expect(stream.getPartialText()).toBe('The answer began');
    stream.dispose();
    expect(stream.snapshot()).toEqual({ text: '', segments: [] });
    expect(stream.getPartialText()).toBeUndefined();
    expect(stream.updateTool(tool)).toBe(false);
  });
});
