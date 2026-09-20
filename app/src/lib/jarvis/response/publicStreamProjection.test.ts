import { describe, expect, it } from 'vitest';
import { createPublicStreamProjection } from './publicStreamProjection';

const tool = { id: 'read-1', name: 'read', status: 'started' as const };

describe('request-local public stream projection', () => {
  it('publishes short public text, interleaves tools, and replaces exact text identities', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'START_P4F8', streamPartId: 'text-1' });
    expect(stream.snapshot()).toMatchObject({
      text: 'START_P4F8',
      segments: [{ kind: 'text', id: 'text-1', text: 'START_P4F8' }],
    });
    stream.updateTool(tool);
    stream.pushText({ delta: '\nChecking the repository', streamPartId: 'text-2' });
    expect(stream.snapshot().segments.map((row) => row.id)).toEqual(['text-1', 'read-1', 'text-2']);
    stream.pushText({ delta: 'REVISED_P4F8', mode: 'replace', streamPartId: 'text-1' });
    expect(stream.snapshot().text).toBe('REVISED_P4F8\nChecking the repository');
    expect(stream.snapshot().segments.map((row) => row.id)).toEqual(['text-1', 'read-1', 'text-2']);
    expect(stream.snapshot().segments.filter((row) => row.kind === 'text')).toHaveLength(2);
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

  it('keeps reasoning, tools, and public text in arrival order while merging reasoning deltas', () => {
    const stream = createPublicStreamProjection();
    stream.pushReasoning({ delta: 'Inspecting the request. ', mode: 'replace' });
    stream.pushReasoning({ delta: 'Checking the workspace.' });
    stream.updateTool(tool);
    stream.pushReasoning({ delta: 'A second thought.', mode: 'replace' });
    stream.pushText({ delta: 'The answer is ready.', streamPartId: 'answer' });

    expect(stream.snapshot().segments).toEqual([
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        text: 'Inspecting the request. Checking the workspace.',
      },
      { kind: 'tool', id: 'read-1', name: 'read', status: 'started' },
      { kind: 'reasoning', id: 'reasoning-2', text: 'A second thought.' },
      { kind: 'text', id: 'answer', text: 'The answer is ready.' },
    ]);
    expect(stream.snapshot().text).toBe('The answer is ready.');
  });

  it('projects an ordered public failure suffix with safe tool results', () => {
    const stream = createPublicStreamProjection();
    const details = Object.freeze({ command: 'git status' });
    stream.pushText({ delta: 'The answer began.', streamPartId: 'answer' });
    stream.pushReasoning({ delta: 'Checking the workspace.' });
    stream.updateTool({ ...tool, status: 'completed', details });
    stream.updateTool({ id: 'write-1', name: 'write', status: 'failed', details });
    stream.updateTool({ id: 'grep-1', name: 'grep', status: 'started' });

    expect(stream.getPartialParts()).toEqual([
      { kind: 'text', text: 'The answer began.' },
      { kind: 'reasoning', text: 'Checking the workspace.' },
      { kind: 'tool_call', tool: 'read', args: {}, call_id: 'read-1', details },
      { kind: 'tool_result', call_id: 'read-1', result: { status: 'completed' } },
      { kind: 'tool_call', tool: 'write', args: {}, call_id: 'write-1', details },
      { kind: 'tool_result', call_id: 'write-1', error: 'Tool failed' },
      { kind: 'tool_call', tool: 'grep', args: {}, call_id: 'grep-1' },
      { kind: 'tool_result', call_id: 'grep-1', error: 'Tool interrupted' },
    ]);
  });

  it('omits unsafe text while retaining already-public reasoning and tools', () => {
    const stream = createPublicStreamProjection();
    stream.pushText({ delta: 'safe. password=SENTINEL_SECRET', streamPartId: 'answer' });
    stream.pushReasoning({ delta: 'Safe reasoning.' });
    stream.updateTool(tool);

    expect(stream.getPartialParts()).toEqual([
      { kind: 'reasoning', text: 'Safe reasoning.' },
      { kind: 'tool_call', tool: 'read', args: {}, call_id: 'read-1' },
      { kind: 'tool_result', call_id: 'read-1', error: 'Tool interrupted' },
    ]);
    expect(JSON.stringify(stream.getPartialParts())).not.toMatch(/SENTINEL_SECRET|password/);
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
    expect(stream.getPartialParts()).toEqual([]);
    expect(stream.updateTool(tool)).toBe(false);
  });
});
