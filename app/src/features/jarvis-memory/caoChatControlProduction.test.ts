import { beforeEach, expect, it, vi } from 'vitest';
import type { RunAgentRequest } from '@/lib/ai/router';
import { caoChatControl } from './caoChatControlProduction';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance } from './caoGuidance';
import { useJarvisLearningStore } from './learningStore';
import { useAgentStore } from '@/stores/agents';
import type { Agent } from '@/types';
const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  chatUpdatedAt: 1,
  activeAgents: ['agent'],
  permission: {
    enabled: true,
    mode: 'full-access',
    learningEpoch: undefined as string | undefined,
  },
  dispatch: vi.fn(),
  pendingRows: new Map<string, { value: unknown }>(),
}));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ accountId: 'account' }),
}));
vi.mock('@/lib/ai/router', () => ({ runAgent: (input: RunAgentRequest) => mocks.dispatch(input) }));
vi.mock('@/lib/db', () => ({
  messageRepo: { create: (...args: unknown[]) => mocks.createMessage(...args) },
  db: {
    chats: {
      get: async () => ({
        id: 'chat',
        workspace_id: 'workspace',
        project_id: 'project',
        active_agent_ids: mocks.activeAgents,
        updated_at: mocks.chatUpdatedAt,
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
    projects: { get: async () => ({ workspace_id: 'workspace' }) },
    settings: {
      get: async (key: string) =>
        key.startsWith('cao.chat.approval.v1:')
          ? mocks.pendingRows.get(key)
          : { value: mocks.permission },
      put: async (row: { key: string; value: unknown }) => {
        if (row.key.startsWith('cao.chat.approval.v1:'))
          mocks.pendingRows.set(row.key, { value: row.value });
      },
      delete: async (key: string) => {
        mocks.pendingRows.delete(key);
      },
    },
    transaction: async (_mode: string, _table: unknown, operation: () => Promise<unknown>) =>
      operation(),
    messages: {
      where: () => ({
        between: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      }),
    },
  },
}));
beforeEach(() => {
  mocks.pendingRows.clear();
  mocks.chatUpdatedAt = 1;
  mocks.createMessage.mockReset();
  mocks.createMessage.mockImplementation(async (input) => {
    mocks.chatUpdatedAt = input.created_at;
    return { ...input, updated_at: input.created_at };
  });
  mocks.activeAgents = ['agent'];
  const agent: Agent = {
    id: 'agent' as Agent['id'],
    slug: 'coder',
    name: 'Coder',
    description: '',
    system_prompt: 'Follow the selected task.',
    model: { provider: 'openai', model: 'target-model' },
    tools_allowed: [],
    memory_scope: 'project',
    capabilities: [],
    created_at: 0,
    updated_at: 1,
  };
  useAgentStore.setState({
    agents: {
      [agent.id]: agent,
      ['jarvis' as Agent['id']]: {
        ...agent,
        id: 'jarvis' as Agent['id'],
        slug: 'jarvis',
        builtin: true,
      },
    },
  });
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
  mocks.permission = {
    enabled: true,
    mode: 'full-access',
    learningEpoch: store.currentProfile().caoLearningEpoch,
  };
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
it('prepares and sends to protected Jarvis when a normal chat has no explicit agent', async () => {
  mocks.activeAgents = [];
  const onSend = vi.fn((event: Event) => {
    const detail = (event as CustomEvent).detail;
    expect(detail.agentId).toBe('jarvis');
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
          'Continue the simulation',
          new AbortController().signal,
        )
      ).status,
    ).toBe('sent');
    expect(onSend).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('jarvis:send', onSend);
  }
});

it.each([{ ids: [] }, { ids: ['missing-agent'] }])(
  'rejects an unavailable target agent without substituting another: $ids',
  async ({ ids }) => {
    mocks.activeAgents = ids;
    if (ids.length === 0) {
      // A different available agent must not replace the protected default.
      const agent = useAgentStore.getState().agents['agent' as Agent['id']];
      useAgentStore.setState({ agents: { [agent.id]: agent } });
    }
    mocks.dispatch.mockClear();
    await expect(
      caoChatControl.prepare('account', 'chat', 'Continue', new AbortController().signal),
    ).rejects.toThrow('cao_target_agent_unavailable');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);

it('rejects approval after the resolved default agent revision changes', async () => {
  mocks.activeAgents = [];
  mocks.permission.mode = 'approve-before-send';
  const proposal = await caoChatControl.prepare(
    'account',
    'chat',
    'Continue',
    new AbortController().signal,
  );
  useAgentStore
    .getState()
    .updateAgent('jarvis' as Agent['id'], { system_prompt: 'Changed agent policy.' });
  await expect(caoChatControl.approve(proposal.id)).rejects.toThrow('cao_target_changed');
});
it('dispatches the exact selected chat route and correlates its runtime acknowledgement', async () => {
  const onSend = vi.fn((event: Event) => {
    const detail = (event as CustomEvent).detail;
    expect(mocks.createMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: detail.cancellationKey,
        chat_id: 'chat',
        role: 'user',
        parts: [{ kind: 'text', text: detail.text }],
      }),
    );
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
it('does not dispatch when saving the outgoing CAO message fails', async () => {
  mocks.createMessage.mockRejectedValueOnce(new Error('storage unavailable'));
  const onSend = vi.fn();
  window.addEventListener('jarvis:send', onSend);
  try {
    await expect(
      caoChatControl.prepare('account', 'chat', 'Continue', new AbortController().signal),
    ).rejects.toThrow('storage unavailable');
    expect(onSend).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('jarvis:send', onSend);
  }
});

it.each(['permission', 'agent', 'cancel'] as const)(
  'rechecks %s after persisting the outgoing message',
  async (change) => {
    const controller = new AbortController();
    mocks.createMessage.mockImplementationOnce(async (input) => {
      mocks.chatUpdatedAt = input.created_at;
      if (change === 'permission') mocks.permission.enabled = false;
      if (change === 'agent')
        useAgentStore.getState().updateAgent('agent' as Agent['id'], { name: 'Changed' });
      if (change === 'cancel') controller.abort();
      return { ...input, updated_at: input.created_at };
    });
    const onSend = vi.fn();
    window.addEventListener('jarvis:send', onSend);
    try {
      await expect(
        caoChatControl.prepare('account', 'chat', 'Continue', controller.signal),
      ).rejects.toThrow();
      expect(mocks.createMessage).toHaveBeenCalledOnce();
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('jarvis:send', onSend);
    }
  },
);
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

it.each(['agent', 'ask', 'plan'] as const)('preserves the target %s mode and selected access without borrowing one-shot approval', async mode => {
  const { useJarvisInteractionStore } = await import('@/features/jarvis-interaction/sessionStore');
  const { writeChatRuntimePolicyState, DEFAULT_CHAT_RUNTIME_POLICY_STATE } = await import('@/features/chat/runtime/chatRuntimeSettingsStore');
  useJarvisInteractionStore.getState().setChatMode('chat', mode);
  writeChatRuntimePolicyState('chat', { ...DEFAULT_CHAT_RUNTIME_POLICY_STATE, access: 'read-only', approveAllForRun: true });
  let sent: Record<string, unknown> | undefined;
  const listener = (event: Event) => { sent=(event as CustomEvent).detail; window.dispatchEvent(new CustomEvent('jarvis:run-state', {detail: {chatId:'chat', cancellationKey:sent!.cancellationKey,status:'running'}})); };
  window.addEventListener('jarvis:send',listener);
  try { await caoChatControl.prepare('account','chat','Build inside assigned directory',new AbortController().signal);
    expect(sent).toMatchObject({interactionMode:mode,accessLevel:'read-only',approveAllForRun:false});
  } finally { window.removeEventListener('jarvis:send',listener); }
});
it('rejects a pending CAO approval when the target switches interaction mode', async () => {
 const { useJarvisInteractionStore } = await import('@/features/jarvis-interaction/sessionStore');
 useJarvisInteractionStore.getState().setChatMode('chat','agent');mocks.permission.mode='approve-before-send';
 const proposal=await caoChatControl.prepare('account','chat','Build the game',new AbortController().signal);
 useJarvisInteractionStore.getState().setChatMode('chat','ask');
 await expect(caoChatControl.approve(proposal.id)).rejects.toThrow('cao_target_changed');
 expect(mocks.createMessage).not.toHaveBeenCalled();
});
