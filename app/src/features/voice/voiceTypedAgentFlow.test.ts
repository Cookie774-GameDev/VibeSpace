import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(async () => ({ id: 'typed-message' })),
  listByChat: vi.fn(async () => [
    { role: 'user', parts: [{ kind: 'text', text: 'Earlier context' }] },
  ]),
  dispatch: vi.fn(async (detail: import('@/lib/ai/runtime').SendDetail) => {
    window.dispatchEvent(new CustomEvent('jarvis:send', { detail }));
    return {
      status: 'accepted' as const,
      chatId: detail.chatId,
      cancellationKey: String(detail.cancellationKey),
    };
  }),
  mainSetter: vi.fn(),
  workerSetter: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  capture: vi.fn(async () => ({
    ok: false as const,
    code: 'capture-unavailable' as const,
    message: 'Text sent.',
  })),
  supportsVision: vi.fn(() => true),
}));

vi.mock('@/lib/db', () => ({
  messageRepo: { create: mocks.createMessage, listByChat: mocks.listByChat },
}));
vi.mock('./voiceNativeDelegation', () => ({
  buildVoiceNativeDelegationGuidance: ({
    requestedWorkerProvider,
  }: {
    requestedWorkerProvider: string;
  }) => 'Answer directly or use one native ' + requestedWorkerProvider + ' worker.',
  dispatchVoiceMainRequest: mocks.dispatch,
}));
vi.mock('./voiceChatRouting', () => ({
  ensureJarvisChatForProvider: vi.fn(async () => 'typed-main'),
  focusVoiceChat: vi.fn(),
}));
vi.mock('./voiceScreenCapture', () => ({
  captureVoiceScreenAttachment: mocks.capture,
}));
vi.mock('@/lib/ai/vision', () => ({ modelSupportsVision: mocks.supportsVision }));
vi.mock('./voiceProviderSelection', () => ({
  resolveVoiceProviderSelection: vi.fn(({ provider }) => ({
    provider,
    modelLabel: provider,
    selection: {
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-5',
      connectionId: provider === 'codex' ? 'openai-codex' : 'opencode-cli',
    },
  })),
}));
vi.mock('@/lib/ai/modelSelection', () => ({
  modelSelectionContextFromAuth: vi.fn(() => ({})),
  validateSendModelAccess: vi.fn(() => ({ ok: true })),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    subscribe: () => () => {},
    getState: () => ({
      localUserId: 'typed-test-account', cloudSession: null, workspaceId: 'typed-test-workspace', projectId: null,
      voiceMainAgentProvider: 'codex',
      voiceWorkerProvider: 'codex',
      chatModelSelection: { mode: 'none' },
      setVoiceMainAgentProvider: mocks.mainSetter,
      setVoiceWorkerProvider: mocks.workerSetter,
    }),
  },
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { info: mocks.info, warning: mocks.warning, error: mocks.error },
}));

import { startTypedAgentOverride } from './voiceTypedAgentFlow';
import { VOICE_BRIEF_SYSTEM_INSTRUCTION } from './voiceAgentFlow';
import { resolveVoiceProviderSelection } from './voiceProviderSelection';
import { writeChatReasoningEffort } from '@/features/chat/reasoningSlashStore';

afterEach(() => {
  vi.clearAllMocks();
  mocks.supportsVision.mockReturnValue(true);
});

describe('typed one-request provider override', () => {
  it('sends one Main Agent turn, preserves source context, and leaves saved defaults alone', async () => {
    const events: CustomEvent[] = [];
    const onSend = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('jarvis:send', onSend);
    try {
      const routedChatId = await startTypedAgentOverride({
        parsed: {
          providers: { worker: 'opencode' },
          taskText: 'Check this task',
          saveAsDefault: false,
        },
        options: [],
        sourceChatId: 'source',
      });
      expect(routedChatId).toBe('typed-main');
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.createMessage).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(events[0]?.detail).toMatchObject({
        chatId: 'typed-main',
        text: 'Check this task',
        speakReply: false,
        interactionMode: 'agent',
        cancellationKey: 'typed-message',
        modelSelectionOverride: { connectionId: 'openai-codex' },
      });
      expect(JSON.stringify(events[0]?.detail.structuredContext)).toContain('opencode');
      expect(JSON.stringify(events[0]?.detail.structuredContext)).toContain('Earlier context');
      expect(events[0]?.detail.localCommandContext).not.toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
      expect(mocks.mainSetter).not.toHaveBeenCalled();
      expect(mocks.workerSetter).not.toHaveBeenCalled();
      expect(mocks.info).toHaveBeenCalledWith('Main Agent routed', 'Sent to Codex.');
    } finally {
      window.removeEventListener('jarvis:send', onSend);
    }
  });

  it('keeps the resolved visible Main route and source effort for a worker-only directive', async () => {
    const key = 'vibespace.chat-reasoning.v1';
    const old = localStorage.getItem(key);
    try {
      writeChatReasoningEffort('source', 'low');
      const { selectionFromOption } = await vi.importActual<typeof import('@/lib/ai/modelSelection')>('@/lib/ai/modelSelection');
      const { OPENCODE_CLI_CONNECTION } = await import('@/lib/ai/adapters/catalog');
      vi.mocked(resolveVoiceProviderSelection).mockReturnValueOnce({
        provider: 'opencode', providerLabel: 'OpenCode', connectionId: 'opencode-cli',
        routeId: 'luna-current', modelLabel: 'Luna',
        selection: selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION),
      });
      await startTypedAgentOverride({
        parsed: { providers: { worker: 'codex' }, taskText: 'Keep the selected Main route', saveAsDefault: false },
        options: [], sourceChatId: 'source',
      });
      expect(resolveVoiceProviderSelection).toHaveBeenCalledWith(expect.objectContaining({ preservePreferredRoute: true }));
      expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
        modelSelectionOverride: expect.objectContaining({ modelId: 'openai/gpt-6-luna', connectionId: 'opencode-cli' }),
        reasoningPreference: { mode: 'normal', effortOverride: 'low' },
        structuredContext: expect.objectContaining({ payload: expect.objectContaining({ mainProvider: 'opencode', requestedWorkerProvider: 'codex' }) }),
      }));
      expect(mocks.mainSetter).not.toHaveBeenCalled();
    } finally {
      if (old === null) localStorage.removeItem(key); else localStorage.setItem(key, old);
    }
  });

  it('keeps the typed draft unaccepted when the Main runtime rejects dispatch', async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: 'failed', code: 'runtime_rejected' } as never);
    await expect(
      startTypedAgentOverride({
        parsed: {
          providers: { worker: 'opencode' },
          taskText: 'Check failing task',
          saveAsDefault: false,
        },
        options: [],
        sourceChatId: 'source',
      }),
    ).rejects.toThrow('Main Agent did not accept');
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.mainSetter).not.toHaveBeenCalled();
    expect(mocks.workerSetter).not.toHaveBeenCalled();
  });

  it('sends text and discloses the limit when the Main model cannot receive a screenshot', async () => {
    mocks.supportsVision.mockReturnValueOnce(false);
    await startTypedAgentOverride({
      parsed: {
        providers: { worker: 'opencode' },
        taskText: 'Check what is on my screen',
        saveAsDefault: false,
      },
      options: [],
      sourceChatId: 'source',
    });
    expect(mocks.capture).not.toHaveBeenCalled();
    const detail = mocks.dispatch.mock.lastCall?.[0];
    expect(detail?.imageAttachments ?? []).toEqual([]);
    expect(mocks.warning).toHaveBeenCalledWith(
      'Agent task',
      'The selected Main Agent model cannot receive a screenshot; sending text.',
    );
  });
});
