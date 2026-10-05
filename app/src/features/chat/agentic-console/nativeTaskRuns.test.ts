import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { collectNativeTaskRuns } from './nativeTaskRuns';

describe('native task run receipts', () => {
  it('keeps a real native child available after another parent turn and reload', () => {
    const message: Message = {
      id: 'answer' as Message['id'],
      chat_id: 'chat' as Message['chat_id'],
      role: 'assistant',
      created_at: 20,
      updated_at: 20,
      parts: [
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'wait',
          args: {
            nativeTask: {
              name: 'Review',
              sessionId: 'child',
              harness: 'codex',
              status: 'done',
              modelLabel: 'gpt-child',
              result: 'Review complete.',
            },
          },
        },
      ],
    };
    expect(collectNativeTaskRuns([message], [], 40, true)).toEqual([
      expect.objectContaining({
        sessionId: 'child',
        harness: 'codex',
        modelLabel: 'gpt-child',
        status: 'done',
        result: 'Review complete.',
      }),
    ]);
  });
  it('does not overwrite fresh follow-up progress with an earlier saved completion', () => {
    const message: Message = {
      id: 'answer' as Message['id'],
      chat_id: 'chat' as Message['chat_id'],
      role: 'assistant',
      created_at: 20,
      updated_at: 25,
      parts: [
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'wait',
          args: {
            nativeTask: {
              name: 'Review',
              sessionId: 'child',
              harness: 'codex',
              modelLabel: 'gpt-child',
              status: 'done',
              result: 'Earlier result',
            },
          },
        },
      ],
    };
    const [run] = collectNativeTaskRuns(
      [message],
      [
        {
          id: 'live',
          chatId: 'chat',
          kind: 'tool',
          status: 'running',
          title: 'task',
          ts: 50,
          nativeTask: { name: 'Review', sessionId: 'child', harness: 'codex', status: 'running' },
        },
      ],
      40,
    );
    expect(run).toMatchObject({ status: 'running', modelLabel: 'gpt-child' });
    expect(run?.result).toBeUndefined();
  });
  it('clears the earlier result when that same native child starts follow-up work', () => {
    const message: Message = {
      id: 'answer' as Message['id'],
      chat_id: 'chat' as Message['chat_id'],
      role: 'assistant',
      created_at: 20,
      updated_at: 20,
      parts: [
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'wait',
          args: {
            nativeTask: {
              name: 'Review',
              sessionId: 'child',
              status: 'done',
              result: 'Earlier result',
            },
          },
        },
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'reply',
          args: { nativeTask: { name: 'Review', sessionId: 'child', status: 'running' } },
        },
      ],
    };
    const [run] = collectNativeTaskRuns([message], [], 10);
    expect(run?.status).toBe('running');
    expect(run?.result).toBeUndefined();
  });
  it('preserves previously reported model and native route when a later wait omits them', () => {
    const message: Message = {
      id: 'answer' as Message['id'],
      chat_id: 'chat' as Message['chat_id'],
      role: 'assistant',
      created_at: 20,
      updated_at: 20,
      parts: [
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'spawn',
          args: {
            nativeTask: {
              name: 'Codex agent',
              sessionId: 'child',
              harness: 'codex',
              modelLabel: 'gpt-child',
              status: 'running',
            },
          },
        },
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'wait',
          args: {
            nativeTask: {
              name: 'Codex agent',
              sessionId: 'child',
              status: 'done',
              result: 'Checked files.',
            },
          },
        },
      ],
    };
    expect(collectNativeTaskRuns([message], [], 10, true)).toEqual([
      expect.objectContaining({
        sessionId: 'child',
        harness: 'codex',
        modelLabel: 'gpt-child',
        status: 'done',
        result: 'Checked files.',
      }),
    ]);
  });
  it('deduplicates live and persisted child identity and preserves independent failure', () => {
    const message = {
      id: 'answer',
      chat_id: 'chat',
      role: 'assistant',
      created_at: 20,
      updated_at: 20,
      parts: [
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'a',
          args: { nativeTask: { name: 'Read alpha', sessionId: 'session-a' } },
        },
        { kind: 'tool_result', call_id: 'a', result: { status: 'completed' } },
        {
          kind: 'tool_call',
          tool: 'task',
          call_id: 'b',
          args: { nativeTask: { name: 'Read beta', sessionId: 'session-b' } },
        },
        { kind: 'tool_result', call_id: 'b', error: 'Tool failed' },
      ],
    } as Message;
    const runs = collectNativeTaskRuns(
      [message],
      [
        {
          id: 'live-a',
          chatId: 'chat',
          kind: 'tool',
          status: 'running',
          title: 'task',
          ts: 15,
          nativeTask: { name: 'Read alpha', sessionId: 'session-a' },
        },
      ],
      10,
      true,
    );
    expect(runs.map((run) => [run.name, run.status])).toEqual([
      ['Read alpha', 'done'],
      ['Read beta', 'error'],
    ]);
    expect(collectNativeTaskRuns([message], [], 30)).toEqual([]);
  });

  it('does not leave unconfirmed child work running after the parent ended', () => {
    expect(
      collectNativeTaskRuns(
        [],
        [
          {
            id: 'live',
            chatId: 'chat',
            kind: 'tool',
            status: 'running',
            title: 'task',
            ts: 15,
            nativeTask: { name: 'Read alpha' },
          },
        ],
        10,
        true,
      ),
    ).toEqual([
      expect.objectContaining({ status: 'unknown', currentStep: 'Final status unavailable' }),
    ]);
  });
});
