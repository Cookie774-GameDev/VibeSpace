import { beforeEach, expect, it, vi } from 'vitest';
import type { RunAgentRequest } from '@/lib/ai/router';
import { caoChatControl } from './caoChatControlProduction';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance } from './caoGuidance';
import { useJarvisLearningStore } from './learningStore';
const mocks = vi.hoisted(() => ({
  permission: { enabled: true, mode: 'full-access' },
  dispatch: vi.fn(),
}));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ accountId: 'account' }),
}));
vi.mock('@/lib/ai/router', () => ({ runAgent: (input: RunAgentRequest) => mocks.dispatch(input) }));
vi.mock('@/lib/db', () => ({
  db: {
    chats: {
      get: async () => ({
        id: 'chat',
        workspace_id: 'workspace',
        project_id: 'project',
        active_agent_ids: ['agent'],
        connection: {
          id: 'openai-codex',
          providerId: 'openai',
          modelId: 'target-model',
          mode: 'local',
          authSource: 'native',
          capabilities: {},
        },
      }),
    },
    workspaces: { get: async () => ({ owner_id: 'account' }) },
    settings: { get: async () => ({ value: mocks.permission }) },
    messages: {
      where: () => ({
        between: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      }),
    },
  },
}));
beforeEach(() => {
  const store = useJarvisLearningStore.getState();
  store.clearForTests();
  store.setAccount('account');
  store.updateCaoGuidance(
    parseCaoGuidance(
      JSON.stringify({
        sections: Object.fromEntries(
          CAO_GUIDANCE_AREAS.map((area) => [
            area,
            {
              guidance: 'Use focused changes and report observed results before claiming success.',
              sourceIds: ['message'],
            },
          ]),
        ),
      }),
      ['message'],
    ),
  );
  mocks.permission = { enabled: true, mode: 'full-access' };
  mocks.dispatch.mockImplementation(async (request: RunAgentRequest) => {
    request.onProviderCompletionEvidence?.({
      requestId: request.requestId!,
      sessionId: 'session',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      observedAt: 1,
      usage: { capturedAt: 1 },
    });
    return { text: 'Please run focused checks and report observed results.' };
  });
});
it('dispatches the exact selected chat route and correlates its runtime acknowledgement', async () => {
  const onSend = vi.fn((event: Event) => {
    const detail = (event as CustomEvent).detail;
    expect(detail).toMatchObject({
      chatId: 'chat',
      origin: 'cao',
      agentId: 'agent',
      modelSelectionOverride: { modelId: 'target-model', connectionId: 'openai-codex' },
      approveAllForRun: false,
    });
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', {
        detail: { chatId: 'chat', cancellationKey: 'other', status: 'error' },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', {
        detail: { chatId: 'chat', cancellationKey: detail.cancellationKey, status: 'running' },
      }),
    );
  });
  window.addEventListener('jarvis:send', onSend);
  try {
    expect(
      (
        await caoChatControl.prepare(
          'account',
          'chat',
          'Verify the task',
          new AbortController().signal,
        )
      ).status,
    ).toBe('sent');
  } finally {
    window.removeEventListener('jarvis:send', onSend);
  }
  expect(onSend).toHaveBeenCalledOnce();
});
it('cancels only the submitted turn while awaiting runtime acknowledgement', async () => {
  const controller = new AbortController();
  let key = '';
  const onSend = (event: Event) => {
    key = (event as CustomEvent).detail.cancellationKey;
    controller.abort();
  };
  const onCancel = vi.fn((event: Event) => {
    expect((event as CustomEvent).detail).toEqual({ chatId: 'chat', messageId: key });
  });
  window.addEventListener('jarvis:send', onSend);
  window.addEventListener('jarvis:cancel', onCancel);
  try {
    await expect(
      caoChatControl.prepare('account', 'chat', 'Verify the task', controller.signal),
    ).rejects.toThrow('cao_send_cancelled');
  } finally {
    window.removeEventListener('jarvis:send', onSend);
    window.removeEventListener('jarvis:cancel', onCancel);
  }
  expect(onCancel).toHaveBeenCalledOnce();
});
