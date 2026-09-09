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

async function* frames() {
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
  yield {
    method: 'turn/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    },
  };
}


it.each([false, true])('keeps application instructions out of user text (resume=%s)', async (resume) => {
  const writes: Array<Record<string, any>> = [];
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation' }),
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      for await (const frame of frames()) {
        yield resume && 'id' in frame && frame.id === 'request_1_thread'
          ? { ...frame, id: 'request_1_resume' } : frame;
      }
    })() }),
    write: async (_generation, message) => { writes.push(message); },
    stop: async () => true,
  });
  for await (const _ of adapter.send!({
    requestId: 'request_1', connection, chatId: 'chat', prompt: 'Read the files and make an HTML.',
    historyPrompt: 'Earlier conversation. Read the files and make an HTML.',
    systemPrompt: 'Application policy and selected Ponytail skill.',
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp', workingDirectory: 'C:\\workspace',
    interactionMode: 'ask', ...(resume ? { sessionId: 'thread_native_1' } : {}),
  })) { /* Consume the real adapter event path. */ }
  expect(writes[1].params.developerInstructions).toContain('Application policy and selected Ponytail skill.');
  expect(writes[1].params.developerInstructions).toContain('Do not replace those tools with textual files.create');
  expect(writes[1].params.developerInstructions).toContain('Ask and Plan remain read-only');
  expect(writes[1].params.developerInstructions).toContain('Finish the response after such a proposal');
  expect(writes[2].params.input[0].text).toBe(resume
    ? 'Read the files and make an HTML.'
    : 'Earlier conversation. Read the files and make an HTML.');
  expect(writes[2].params.input[0].text).not.toContain('Application policy');
});
