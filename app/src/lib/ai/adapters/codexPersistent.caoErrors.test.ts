import { expect, it, vi } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';
import type { ProviderConnection } from './types';
it('settles a rejected turn/start and releases its exact native child', async () => {
  const stop = vi.fn().mockResolvedValue(true);
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'codex' }),
    start: async () => ({ generation: 'rejected-turn-generation' }),
    stop,
    write: async () => {},
    frames: () => ({
      ready: Promise.resolve(),
      stream: (async function* () {
        yield {
          id: 'request_model_1',
          result: {
            data: [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [], serviceTiers: [] }],
            nextCursor: null,
          },
        };
        yield {
          id: 'request_thread',
          result: {
            thread: { id: 'thread' },
            model: 'gpt-5.6-terra',
            modelProvider: 'openai',
            serviceTier: null,
            cwd: 'C:\\game',
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandbox: { type: 'readOnly', networkAccess: false },
            reasoningEffort: null,
          },
        };
        yield {
          id: 'request_turn',
          error: { code: -32600, message: 'Experimental API is unavailable' },
        };
      })(),
    }),
  });
  const consume = async () => {
    for await (const _event of adapter.send!({
      requestId: 'request',
      connection: { id: 'openai-codex' } as ProviderConnection,
      codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-terra' },
      modelId: 'gpt-5.6-terra',
      workingDirectory: 'C:\\game',
      interactionMode: 'ask',
      prompt: 'Review only',
    })) {
      /* consume observed events */
    }
  };
  let failure: unknown;
  try {
    await consume();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: 'ProviderRuntimeError',
    details: { code: '-32600' },
  });
  expect(failure).toMatchObject({
    message: expect.stringContaining('Codex rejected turn/start (-32600)'),
  });
  expect((failure as Error).message).toContain('Experimental API is unavailable');
  expect(stop).toHaveBeenCalledWith('rejected-turn-generation');
});
