import { describe, expect, it, vi } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';
import type { ProviderConnection, ProviderRequest } from './types';

const model = 'opencode-go/deepseek-v4-flash-vision-exp';
const request: ProviderRequest = {
  requestId: 'recovery', connection: { id: 'openai-codex' } as ProviderConnection,
  modelId: model, prompt: 'Continue the task.',
  workingDirectory: 'C:\\workspace', interactionMode: 'ask',
  accountId: 'recovery-account', chatId: 'recovery-chat',
};
const key = 'vibespace.codex-thread.v1:' + JSON.stringify([
  request.accountId, request.workspaceId, request.projectId, request.chatId, request.workingDirectory,
]);

function fixture(error: { code: number; message: string }) {
  const write = vi.fn(async (_generation: string, _message: Record<string, unknown>) => {});
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted' }),
    start: async () => ({ generation: 'generation-1' }),
    stop: async () => true, write,
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      yield { id: 'recovery_model_1', result: { data: [{ model, supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null } };
      yield { id: 'recovery_resume', error };
      yield { id: 'recovery_thread', result: {
        thread: { id: 'new-thread' }, model, modelProvider: 'openai', serviceTier: null,
        cwd: 'C:\\workspace', approvalPolicy: 'never', approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null,
      } };
      yield { method: 'turn/started', params: { threadId: 'new-thread', turn: { id: 'turn-1' } } };
      yield { method: 'turn/completed', params: { threadId: 'new-thread', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' } } };
    })() }),
  });
  return { adapter, write };
}

describe('Codex saved thread recovery', () => {
  it('recreates an unavailable implicit thread with supplied conversation context', async () => {
    localStorage.setItem(key, 'old-thread');
    const { adapter, write } = fixture({ code: -32600, message: 'no rollout found for thread id old-thread' });
    try {
      for await (const _ of adapter.send!({ ...request, historyPrompt: 'user: Preserve marker BLUE.\nassistant: Understood.\nuser: Continue the task.' })) { /* consume */ }
      expect(write.mock.calls.map((call: unknown[]) => (call[1] as { method: string }).method)).toEqual(['model/list', 'thread/resume', 'thread/start', 'turn/start']);
      const turn = write.mock.calls.find((call: unknown[]) => (call[1] as { method: string }).method === 'turn/start');
      expect(JSON.stringify(turn)).toContain('Preserve marker BLUE.');
      expect(localStorage.getItem(key)).toBe('new-thread');
    } finally { localStorage.removeItem(key); }
  });

  it.each([
    { code: -32600, message: 'permission denied' },
    { code: -32603, message: 'no rollout found for thread id old-thread' },
  ])('never replaces a thread for unrelated protocol errors: $message', async (error) => {
    localStorage.setItem(key, 'old-thread');
    const { adapter, write } = fixture(error);
    try {
      await expect((async () => { for await (const _ of adapter.send!(request)) {} })()).rejects.toThrow();
      expect(write.mock.calls.some((call: unknown[]) => (call[1] as { method: string }).method === 'thread/start')).toBe(false);
    } finally { localStorage.removeItem(key); }
  });

  it('does not replace an explicitly required thread', async () => {
    const { adapter, write } = fixture({ code: -32600, message: 'no rollout found for thread id old-thread' });
    await expect((async () => { for await (const _ of adapter.send!({ ...request, sessionId: 'old-thread', expectedSessionId: 'old-thread' })) {} })()).rejects.toThrow();
    expect(write.mock.calls.some((call: unknown[]) => (call[1] as { method: string }).method === 'thread/start')).toBe(false);
  });
});
