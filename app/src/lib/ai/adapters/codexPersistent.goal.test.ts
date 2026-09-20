import { describe, expect, it, vi } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';
import { PROVIDER_CONNECTIONS } from './catalog';
import type { ProviderEvent, ProviderRequest } from './types';

const request = (): ProviderRequest => ({
  requestId: 'goal_test',
  connection: PROVIDER_CONNECTIONS.find((c) => c.id === 'openai-codex')!,
  codexRoute: {
    kind: 'official-codex',
    connectionId: 'openai-codex',
    providerId: 'openai',
    modelId: 'gpt-5.6-luna',
  },
  modelId: 'gpt-5.6-luna',
  prompt: '/goal Build and test a small game',
  interactionMode: 'ask',
  workingDirectory: 'C:\\workspace',
  reasoningEffort: 'low',
});

describe('Codex native goal dispatch', () => {
  it.each([false, true])('sets the goal before starting a turn; rejected=%s', async (rejected) => {
    const write = vi.fn(async () => undefined);
    async function* frames() {
      yield {
        id: 'goal_test_model_1',
        result: {
          data: [
            {
              model: 'gpt-5.6-luna',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              serviceTiers: [],
            },
          ],
          nextCursor: null,
        },
      };
      yield {
        id: 'goal_test_thread',
        result: {
          thread: { id: 'thread_goal' },
          model: 'gpt-5.6-luna',
          modelProvider: 'openai',
          serviceTier: null,
          cwd: 'C:\\workspace',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
          reasoningEffort: 'low',
        },
      };
      yield rejected
        ? { id: 'goal_test_goal', error: { code: -32601, message: 'Native goal API unavailable' } }
        : {
            id: 'goal_test_goal',
            result: {
              goal: {
                threadId: 'thread_goal',
                objective: 'Build and test a small game',
                status: 'active',
              },
            },
          };
      yield {
        method: 'turn/started',
        params: { threadId: 'thread_goal', turn: { id: 'turn_goal' } },
      };
      yield {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread_goal',
          turnId: 'turn_goal',
          itemId: 'msg_goal',
          delta: 'I will build the game.',
        },
      };
      yield {
        method: 'turn/completed',
        params: {
          threadId: 'thread_goal',
          turnId: 'turn_goal',
          turn: { id: 'turn_goal', status: 'completed' },
        },
      };
    }
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted' }),
      start: async () => ({ generation: 'goal-generation' }),
      frames: () => ({ ready: Promise.resolve(), stream: frames() }),
      write,
      stop: async () => true,
    });
    const events: ProviderEvent[] = [];
    const consume = async () => {
      for await (const event of adapter.send!(request())) events.push(event);
    };
    if (rejected) await expect(consume()).rejects.toThrow('Native goal API unavailable');
    else await consume();
    const sent = write.mock.calls.map(
      (call) =>
        (call as unknown[])[1] as { method: string; params: { input?: { text: string }[] } },
    );
    expect(sent.map((frame) => frame.method)).toContain('thread/goal/set');
    if (rejected) {
      expect(sent.some((frame) => frame.method === 'turn/start')).toBe(false);
    } else {
      expect(sent.map((frame) => frame.method)).toEqual([
        'model/list',
        'thread/start',
        'thread/goal/set',
        'turn/start',
      ]);
      expect(sent.at(-1)?.params.input?.[0]?.text).toBe('Build and test a small game');
      expect(events.some((event) => event.type === 'error')).toBe(false);
    }
  });
});
