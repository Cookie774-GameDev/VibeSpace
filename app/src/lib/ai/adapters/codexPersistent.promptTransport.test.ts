import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderEvent } from './types';
import { createCodexPersistentAdapter, resolveCodexExecutable } from './codexPersistent';

const connection: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-app-server',
  providerId: 'opencode-go',
  displayName: 'Codex via OpenCodex',
  mode: 'external-cli',
  authSource: 'opencode-provider-session',
  promptTransport: 'native-system',
  enabled: true,
  capabilities: {
    text: true,
    images: false,
    files: true,
    tools: true,
    modelSelection: true,
    structuredOutput: true,
    streaming: true,
    cancellation: true,
    resumeSession: true,
    systemPrompt: true,
    workingDirectory: true,
    usage: true,
    subscriptionQuota: false,
    localOnly: false,
  },
};

async function* frames(usageUpdates: Array<Record<string, unknown>> = []) {
  yield {
    id: 'request_1_model_1',
    result: {
      data: [
        {
          model: 'opencode-go/deepseek-v4-flash-vision-exp',
          supportedReasoningEfforts: [],
          serviceTiers: [],
        },
      ],
      nextCursor: null,
    },
  };
  yield {
    id: 'request_1_thread',
    result: {
      thread: { id: 'thread_native_1' },
      model: 'opencode-go/deepseek-v4-flash-vision-exp',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: 'C:\\workspace',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: null,
    },
  };
  yield {
    method: 'turn/started',
    params: {
      threadId: 'thread_native_1',
      turn: { id: 'turn_native_1' },
    },
  };
  yield {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      itemId: 'message_native_1',
      delta: 'Working on it.',
    },
  };
  yield {
    method: 'item/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      item: {
        id: 'command_native_1',
        type: 'commandExecution',
        status: 'completed',
        commandActions: [{ type: 'read', path: 'C:\\workspace\\game.js' }],
        exitCode: 0,
      },
    },
  };
  for (const tokenUsage of usageUpdates) {
    yield {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread_native_1',
        turnId: 'turn_native_1',
        tokenUsage,
      },
    };
  }
  yield {
    method: 'turn/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    },
  };
}

it.each([false, true])(
  'keeps application instructions out of user text (resume=%s)',
  async (resume) => {
    const writes: Array<Record<string, any>> = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => ({ generation: 'generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          for await (const frame of frames()) {
            yield resume && 'id' in frame && frame.id === 'request_1_thread'
              ? { ...frame, id: 'request_1_resume' }
              : frame;
            if (resume && 'id' in frame && frame.id === 'request_1_thread') {
              yield { id: 'request_1_policy', result: {} };
            }
          }
        })(),
      }),
      write: async (_generation, message) => {
        writes.push(message);
      },
      stop: async () => true,
    });
    for await (const _ of adapter.send!({
      requestId: 'request_1',
      connection,
      chatId: 'chat',
      prompt: 'Read the files and make an HTML.',
      historyPrompt: 'Earlier conversation. Read the files and make an HTML.',
      systemPrompt: 'Application policy and selected Ponytail skill.',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      ...(resume ? { sessionId: 'thread_native_1' } : {}),
    })) {
      /* Consume the real adapter event path. */
    }
    expect(writes[1].params.developerInstructions).toContain(
      'Application policy and selected Ponytail skill.',
    );
    expect(writes[1].params.developerInstructions).toContain(
      'Do not replace those tools with textual files.create',
    );
    expect(writes[1].params.developerInstructions).toContain('Ask and Plan remain read-only');
    expect(writes[1].params.developerInstructions).toContain(
      'Finish the response after such a proposal',
    );
    if (resume) {
      expect(writes[2].id).toBe('request_1_policy');
      expect(writes[2].params).toMatchObject({ threadId: 'thread_native_1' });
    }
    const turn = writes.find((message) => message.method === 'turn/start')!;
    expect(turn.params.input[0].text).toBe(
      resume
        ? 'Read the files and make an HTML.'
        : 'Earlier conversation. Read the files and make an HTML.',
    );
    expect(turn.params.input[0].text).not.toContain('Application policy');
  },
);

it('reports the entire Codex turn without prior-turn counts or duplicate snapshots', async () => {
  const updates = [
    {
      last: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
      total: { inputTokens: 990, outputTokens: 110, totalTokens: 1100 },
    },
    {
      last: { inputTokens: 180, outputTokens: 20, totalTokens: 200 },
      total: { inputTokens: 1170, outputTokens: 130, totalTokens: 1300 },
    },
  ];
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation' }),
    frames: () => ({ ready: Promise.resolve(), stream: frames([...updates, updates[1]!]) }),
    write: async () => {},
    stop: async () => true,
  });
  const usage: unknown[] = [];
  for await (const event of adapter.send!({
    requestId: 'request_1',
    connection,
    chatId: 'chat',
    prompt: 'Read the reference.',
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    workingDirectory: 'C:\\workspace',
    interactionMode: 'ask',
  })) {
    if (event.type === 'usage') usage.push(event.usage);
  }
  expect(usage).toHaveLength(3);
  expect(usage[0]).toMatchObject({ totalTokens: { value: 100 } });
  expect(usage[1]).toMatchObject({
    inputTokens: { value: 270 },
    outputTokens: { value: 30 },
    totalTokens: { value: 300, provenance: 'provider-reported' },
    cacheReadTokens: { provenance: 'unavailable' },
  });
  expect(usage[2]).toMatchObject({ totalTokens: { value: 300 } });
});
