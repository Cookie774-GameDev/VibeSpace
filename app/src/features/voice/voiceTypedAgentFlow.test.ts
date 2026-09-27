import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(async () => undefined),
  listByChat: vi.fn(async (chatId: string) =>
    chatId === 'child'
      ? [{ role: 'assistant', parts: [{ kind: 'text', text: 'Finished the task.' }] }]
      : [{ role: 'user', parts: [{ kind: 'text', text: 'Earlier context' }] }],
  ),
  launch: vi.fn(async () => ({ agentId: 'agent', childChatId: 'child', agents: [] })),
  mainSetter: vi.fn(),
  workerSetter: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  capture: vi.fn(async () => ({
    ok: false,
    code: 'capture-unavailable',
    message: 'Text sent.',
  })),
  supportsVision: vi.fn(() => true),
}));

vi.mock('@/lib/db', () => ({
  messageRepo: { create: mocks.createMessage, listByChat: mocks.listByChat },
}));
vi.mock('@/features/jarvis-interaction/agentRunner', () => ({
  launchJarvisChatAgent: mocks.launch,
}));
vi.mock('@/features/jarvis-interaction/sessionStore', () => ({
  useJarvisInteractionStore: {
    getState: () => ({
      agentsForChat: () => [
        {
          agentId: 'agent',
          status: 'done',
          harnessSessionId: 'native-worker-session',
          summary: 'Finished the task.',
        },
      ],
    }),
    subscribe: () => () => undefined,
  },
}));
vi.mock('@/features/voice/voiceChatRouting', () => ({
  ensureJarvisChatForProvider: vi.fn(async () => 'typed-main'),
  focusVoiceChat: vi.fn(),
}));
vi.mock('@/features/voice/voiceScreenCapture', () => ({
  captureVoiceScreenAttachment: mocks.capture,
}));
vi.mock('@/lib/ai/vision', () => ({ modelSupportsVision: mocks.supportsVision }));
vi.mock('@/features/voice/voiceProviderSelection', () => ({
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
    getState: () => ({
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

afterEach(() => {
  vi.clearAllMocks();
  mocks.supportsVision.mockReturnValue(true);
});

describe('typed one-request provider override', () => {
  it('routes one worker and a text-only Main result without changing either saved default', async () => {
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
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(routedChatId).toBe('typed-main');
      expect(mocks.launch).toHaveBeenCalledTimes(1);
      expect(mocks.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          workerProvider: 'opencode',
          recordParentCommand: false,
          task: expect.stringContaining('Earlier context'),
        }),
      );
      expect(events[0]?.detail).toMatchObject({
        chatId: 'typed-main',
        speakReply: false,
        modelSelectionOverride: { connectionId: 'openai-codex' },
      });
      expect(events[0]?.detail.localCommandContext).not.toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
      expect(mocks.mainSetter).not.toHaveBeenCalled();
      expect(mocks.workerSetter).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('jarvis:send', onSend);
    }
  });

  it('keeps the typed draft unaccepted when the worker fails to launch', async () => {
    mocks.launch.mockRejectedValueOnce(new Error('worker unavailable'));

    await expect(
      startTypedAgentOverride({
        parsed: {
          providers: { worker: 'opencode' },
          taskText: 'Check this task',
          saveAsDefault: false,
        },
        options: [],
        sourceChatId: 'source',
      }),
    ).rejects.toThrow('worker unavailable');
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.mainSetter).not.toHaveBeenCalled();
    expect(mocks.workerSetter).not.toHaveBeenCalled();
  });

  it('sends text and discloses the limitation when the worker model cannot receive screenshots', async () => {
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
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ imageAttachments: [] }));
    expect(mocks.warning).toHaveBeenCalledWith(
      'Agent task',
      'The selected worker model cannot receive a screenshot; continuing with text.',
    );
  });
});
