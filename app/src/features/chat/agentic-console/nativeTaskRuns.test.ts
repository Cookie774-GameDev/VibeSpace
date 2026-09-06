import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { collectNativeTaskRuns } from './nativeTaskRuns';

describe('native task run receipts', () => {
  it('deduplicates live and persisted child identity and preserves independent failure', () => {
    const message = { id: 'answer', chat_id: 'chat', role: 'assistant', created_at: 20, updated_at: 20, parts: [
      { kind: 'tool_call', tool: 'task', call_id: 'a', args: { nativeTask: { name: 'Read alpha', sessionId: 'session-a' } } },
      { kind: 'tool_result', call_id: 'a', result: { status: 'completed' } },
      { kind: 'tool_call', tool: 'task', call_id: 'b', args: { nativeTask: { name: 'Read beta', sessionId: 'session-b' } } },
      { kind: 'tool_result', call_id: 'b', error: 'Tool failed' },
    ] } as Message;
    const runs = collectNativeTaskRuns([message], [{ id: 'live-a', chatId: 'chat', kind: 'tool', status: 'running', title: 'task', ts: 15, nativeTask: { name: 'Read alpha', sessionId: 'session-a' } }], 10, true);
    expect(runs.map(run => [run.name, run.status])).toEqual([['Read alpha', 'done'], ['Read beta', 'error']]);
    expect(collectNativeTaskRuns([message], [], 30)).toEqual([]);
  });

  it('does not leave unconfirmed child work running after the parent ended', () => {
    expect(collectNativeTaskRuns([], [{ id: 'live', chatId: 'chat', kind: 'tool', status: 'running', title: 'task', ts: 15, nativeTask: { name: 'Read alpha' } }], 10, true))
      .toEqual([expect.objectContaining({ status: 'unknown', currentStep: 'Final status unavailable' })]);
  });
});
