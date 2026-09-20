import { describe, expect, it, vi } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';
import { CODEX_CLI_CONNECTION } from './catalog';

describe('projectless Codex requests', () => {
  it.each(['gpt-5.4-mini', 'opencode-go/deepseek-v4-flash-vision-exp'])(
    'uses the resolved workspace throughout a %s turn',
    async (model) => {
      const translated = model.startsWith('opencode-go/');
      const connection = translated
        ? { ...CODEX_CLI_CONNECTION, id: 'opencode-go', providerId: 'opencode-go', authSource: 'opencode-auth' as const }
        : CODEX_CLI_CONNECTION;
      const cwd = 'C:\\app-data\\harness\\codex-server\\workspace';
      const writes: Record<string, any>[] = [];
      async function* frames() {
        yield {
          id: 'request_model_1',
          result: { data: [{ model, supportedReasoningEfforts: [] }], nextCursor: null },
        };
        yield {
          id: 'request_thread',
          result: {
            thread: { id: 'thread' },
            model,
            modelProvider: 'openai',
            cwd,
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: { type: 'readOnly', networkAccess: false },
            reasoningEffort: 'medium',
          },
        };
        yield { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } };
        yield {
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread', turnId: 'turn', itemId: 'text', delta: 'OK' },
        };
        yield {
          method: 'turn/completed',
          params: { threadId: 'thread', turnId: 'turn', turn: { id: 'turn', status: 'completed' } },
        };
      }
      const directory = vi.fn(async () => cwd);
      const stop = vi.fn(async () => true);
      const adapter = createCodexPersistentAdapter({
        workingDirectory: directory,
        findExecutable: async () => ({ executableId: 'codex' }),
        start: async () => ({ generation: 'generation' }),
        frames: () => ({ stream: frames(), ready: Promise.resolve() }),
        write: async (_generation, message) => {
          writes.push(message);
        },
        stop,
      });
      const events = [];
      for await (const event of adapter.send!({
        requestId: 'request',
        chatId: 'chat',
        connection,
        accountId: 'account-test',
        codexRoute: translated
          ? { kind: 'opencodex-translation', accountId: 'account-test', connectionId: connection.id,
              providerId: 'opencode-go', modelId: model, upstreamModelId: 'deepseek-v4-flash-vision-exp',
              routeHandle: 'test-route', configurationGeneration: 'test-generation', adapter: 'openai-chat' }
          : { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: model },
        modelId: model,
        prompt: 'Hello\nthere',
        systemPrompt: 'System instructions.',
        interactionMode: 'agent',
      }))
        events.push(event);
      expect(directory).toHaveBeenCalledWith(undefined);
      for (const method of ['thread/start', 'turn/start']) {
        expect(writes.find((message) => message.method === method)?.params.cwd).toBe(cwd);
      }
      expect(writes.find((message) => message.method === 'thread/start')?.params.developerInstructions).toContain(
        'System instructions.',
      );
      expect(writes.find((message) => message.method === 'turn/start')?.params.input[0].text).toBe('Hello\nthere');
      expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
      expect(stop).toHaveBeenCalledWith('generation');
    },
  );
});
