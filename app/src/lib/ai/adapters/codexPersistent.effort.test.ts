import { describe, expect, it } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';
import { CODEX_CLI_CONNECTION } from './catalog';

describe('Codex token-saving effort', () => {
  it.each([['minimal', 'low'], ['none', 'low'], ['ultra', 'xhigh']] as const)('transports %s as the supported %s effort in thread and turn requests', async (selectedEffort, wireEffort) => {
    const writes: Record<string, any>[] = [];
    async function* frames() {
      yield {
        id: 'request_model_1',
        result: {
          data: [
            { model: 'gpt-5.6-luna', supportedReasoningEfforts: [{ reasoningEffort: wireEffort }] },
          ],
          nextCursor: null,
        },
      };
      yield {
        id: 'request_thread',
        result: {
          thread: { id: 'thread' },
          model: 'gpt-5.6-luna',
          modelProvider: 'openai',
          cwd: 'C:\\workspace',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
          reasoningEffort: wireEffort,
        },
      };
      yield { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } };
      yield {
        method: 'turn/completed',
        params: { threadId: 'thread', turnId: 'turn', turn: { id: 'turn', status: 'completed' } },
      };
    }
    const adapter = createCodexPersistentAdapter({
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'codex' }),
      start: async () => ({ generation: 'generation' }),
      frames: () => ({ stream: frames(), ready: Promise.resolve() }),
      write: async (_generation, message) => {
        writes.push(message);
      },
      stop: async () => true,
    });
    for await (const _event of adapter.send!({
      requestId: 'request',
      chatId: 'chat',
      connection: CODEX_CLI_CONNECTION,
      modelId: 'gpt-5.6-luna',
      reasoningEffort: selectedEffort,
      prompt: 'Brief answer.',
      interactionMode: 'agent',
    })) {
      /* drain */
    }
    expect(
      writes.find((frame) => frame.method === 'thread/start')?.params.config.model_reasoning_effort,
    ).toBe(wireEffort);
    expect(writes.find((frame) => frame.method === 'turn/start')?.params.effort).toBe(wireEffort);
  });
});
