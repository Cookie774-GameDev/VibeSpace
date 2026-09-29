import { describe, expect, it } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';
import { CODEX_CLI_CONNECTION } from './catalog';

describe('Codex token-saving effort', () => {
  it.each([
    ['gpt-5.6-luna', 'minimal', 'low'],
    ['gpt-5.6-luna', 'none', 'low'],
    ['gpt-5.6-luna', 'ultra', 'xhigh'],
    ['gpt-6-luna', 'low', 'low'],
  ] as const)(
    'transports %s %s as supported %s effort in thread and turn requests',
    async (modelId, selectedEffort, wireEffort) => {
      const writes: Record<string, any>[] = [];
      async function* frames() {
        yield {
          id: 'request_model_1',
          result: {
            data: [
              { model: modelId, supportedReasoningEfforts: [{ reasoningEffort: wireEffort }] },
            ],
            nextCursor: null,
          },
        };
        yield {
          id: 'request_thread',
          result: {
            thread: { id: 'thread' },
            model: modelId,
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
        codexRoute: {
          kind: 'official-codex',
          connectionId: 'openai-codex',
          providerId: 'openai',
          modelId,
        },
        modelId,
        reasoningEffort: selectedEffort,
        prompt: 'Brief answer.',
        interactionMode: 'agent',
      })) {
        /* drain */
      }
      const thread = writes.find((frame) => frame.method === 'thread/start');
      const turn = writes.find((frame) => frame.method === 'turn/start');
      expect(thread?.params.model).toBe(modelId);
      expect(thread?.params.config.model_reasoning_effort).toBe(wireEffort);
      expect(turn?.params.model).toBe(modelId);
      expect(turn?.params.effort).toBe(wireEffort);
      expect(turn?.params.collaborationMode.settings.reasoning_effort).toBe(wireEffort);
    },
  );
});
