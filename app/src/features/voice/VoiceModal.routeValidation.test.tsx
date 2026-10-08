import { normalizeChatModelSelection, validateSendModelAccess } from '@/lib/ai/modelSelection';
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { writeChatReasoningEffort } from '@/features/chat/reasoningSlashStore';
import { dispatchVoiceMainRequest } from '@/features/voice/voiceNativeDelegation';
import { resolveVoiceProviderSelection } from '@/features/voice/voiceProviderSelection';
import type { ChatId } from '@/types';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';

type VoiceHandler = (payload?: unknown) => void;
type MockVoiceChatTarget = {
  chatId: string;
  messageText: string;
  agentId?: string;
  mentionedAgentIds: string[];
};

let fetchSpy: MockInstance<typeof fetch>;

const voiceListeners = vi.hoisted(() => ({
  handlers: new Map<string, Set<VoiceHandler>>(),
}));

const routerMocks = vi.hoisted(() => ({
  handleVoiceModuleClosed: vi.fn(),
  syncVoiceModuleOpenState: vi.fn(),
  stopCurrentVoiceResponse: vi.fn(),
  speakWithSettings: vi.fn(async () => undefined),
}));

const chatHookMocks = vi.hoisted(() => ({
  useChatMessages: vi.fn(() => []),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

const chatRoutingMocks = vi.hoisted(() => ({
  ensureJarvisChatForVoice: vi.fn(async (): Promise<string | null> => 'chat_voice'),
  ensureJarvisChatForProvider: vi.fn(
    async (
      _provider: string,
      _title?: string,
      _options?: { freshVoiceConversation?: boolean; openingId?: string; cachedChatId?: ChatId },
    ): Promise<string | null> => 'chat_voice',
  ),
  focusVoiceChat: vi.fn(),
  resolveVoiceChatTarget: vi.fn(
    async (text: string): Promise<MockVoiceChatTarget | null> => ({
      chatId: 'chat_voice',
      messageText: text,
      agentId: undefined,
      mentionedAgentIds: [],
    }),
  ),
}));

vi.mock('@/features/voice/JarvisVoiceInputService', () => ({
  JarvisVoiceInputService: {
    isSupported: () => true,
    isListening: () => false,
    wantsListening: () => false,
    setInactivityTimeoutMs: vi.fn(),
    startListening: vi.fn(() => true),
    stopListening: vi.fn(),
    cancelListening: vi.fn(),
    on: (event: string, fn: VoiceHandler) => {
      let set = voiceListeners.handlers.get(event);
      if (!set) {
        set = new Set();
        voiceListeners.handlers.set(event, set);
      }
      set.add(fn);
      return () => set!.delete(fn);
    },
  },
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    aside: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
      <aside {...props}>{children}</aside>
    ),
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  useMotionValue: () => ({ get: () => 0, set: vi.fn() }),
}));

vi.mock('@/features/chat/hooks', () => ({
  useChatMessages: chatHookMocks.useChatMessages,
}));

// Turn/lifecycle fixtures do not exercise authenticated provider discovery.
const accessibleModelFixture = vi.hoisted(() => ({ options: [] as ModelPickerOption[] }));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({
    groups: [],
    flatOptions: accessibleModelFixture.options,
    hasAny: accessibleModelFixture.options.length > 0,
  }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: toastMocks.error,
  },
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  let nextMessage = 0;
  return {
    ...actual,
    messageRepo: {
      ...actual.messageRepo,
      create: vi.fn(async () => ({ id: `voice-message-${++nextMessage}` })),
    },
  };
});

vi.mock('@/features/voice/voiceChatRouting', () => chatRoutingMocks);

vi.mock('@/features/voice/voiceConversationFolder', () => ({
  syncVoiceConversationFolder: vi.fn(async () => ({ ok: true, folder: 'test', messageCount: 1 })),
}));

vi.mock('@/features/voice/voiceRouter', () => routerMocks);

vi.mock('@/features/voice/voiceProviderSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/voice/voiceProviderSelection')>();
  return {
    ...actual,
    resolveVoiceProviderSelection: vi.fn(({ provider }: { provider: string }) => ({
      provider,
      selection: { mode: 'single', providerId: 'groq', modelId: 'openai/gpt-oss-20b' },
      modelLabel: 'Groq fixture',
    })),
  };
});

vi.mock('@/features/voice/voiceNativeDelegation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/voice/voiceNativeDelegation')>();
  return {
    ...actual,
    dispatchVoiceMainRequest: vi.fn(async (detail: import('@/lib/ai/runtime').SendDetail) => {
      window.dispatchEvent(new CustomEvent('jarvis:send', { detail }));
      return {
        status: 'accepted' as const,
        chatId: detail.chatId,
        cancellationKey: String(detail.cancellationKey),
      };
    }),
  };
});

import { VoiceModal } from '@/features/voice/VoiceModal';
import { messageRepo } from '@/lib/db';
import { useVoiceStore } from '@/features/voice/store';
import { JarvisVoiceInputService as VoiceService } from '@/features/voice/JarvisVoiceInputService';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { GROQ_DEFAULT_MODEL } from '@/lib/ai/providers/groq';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';
import { resetJarvisApprovalNavigationForTests } from '@/features/jarvis-command-center/approvalNavigation';
import type { ProjectId } from '@/types';
import { clearContextGalaxySnapshotsForTests } from '@/features/context/contextGalaxyRegistry';

function setReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('VoiceModal joined route validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessibleModelFixture.options = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    setReducedMotion(false);
    chatHookMocks.useChatMessages.mockReset().mockReturnValue([]);
    chatRoutingMocks.ensureJarvisChatForVoice.mockReset().mockResolvedValue('chat_voice');
    chatRoutingMocks.ensureJarvisChatForProvider.mockReset().mockResolvedValue('chat_voice');
    chatRoutingMocks.focusVoiceChat.mockReset();
    chatRoutingMocks.resolveVoiceChatTarget.mockReset().mockImplementation(
      async (text: string): Promise<MockVoiceChatTarget | null> => ({
        chatId: 'chat_voice',
        messageText: text,
        agentId: undefined,
        mentionedAgentIds: [],
      }),
    );
    voiceListeners.handlers.clear();
    useUIStore.setState({
      voiceModalOpen: true,
      voiceInputMode: 'speech',
      voiceListening: false,
      activeChatId: 'chat_voice',
      route: 'chat',
    });
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      projectId: 'project-a' as ProjectId,
      voiceAutoListenOnOpen: true,
      voiceMiniBarEnabled: false,
      voiceStartFreshChat: false,
      voiceEndTrigger: 'phrase',
      voiceCommitPhrase: 'send it',
      voiceCancelPhrase: 'cancel',
      voiceSilenceDelayMs: 2000,
      voiceAutoApproveActions: true,
      apiKeys: { groq: 'gsk_test' },
      stackCustomSteps: DEFAULT_CUSTOM_STEPS,
      chatModelSelection: selectionFromOption('groq', GROQ_DEFAULT_MODEL),
    });
    useAgentStore.setState({ agents: {} });
    useVoiceStore.getState().reset();
    resetJarvisApprovalNavigationForTests();
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    clearContextGalaxySnapshotsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['declared', 'legacy'] as const)(
    'admits one Ready %s OpenCode route through real Voice and shared validation',
    async (form) => {
      const actual = await vi.importActual<
        typeof import('@/features/voice/voiceProviderSelection')
      >('@/features/voice/voiceProviderSelection');
      vi.mocked(resolveVoiceProviderSelection).mockImplementation(
        actual.resolveVoiceProviderSelection,
      );
      const complete = selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
      const selected =
        form === 'legacy'
          ? normalizeChatModelSelection({ ...complete, providerId: 'opencode' })
          : complete;
      accessibleModelFixture.options = [
        {
          id: 'opencode-cli:openai/gpt-6-luna',
          provider: 'openai',
          modelId: 'openai/gpt-6-luna',
          label: 'Luna',
          connectionId: OPENCODE_CLI_CONNECTION.id,
          connection: OPENCODE_CLI_CONNECTION,
          available: true,
          authLabel: 'Ready',
          catalogSource: 'opencode-live',
        },
      ];
      useAuthStore.setState({
        apiKeys: {},
        chatModelSelection: selected,
        voiceMainAgentProvider: 'opencode',
      });
      useUIStore.setState({ activeChatId: 'visible-source-chat' });
      writeChatReasoningEffort('visible-source-chat', 'low');
      useUIStore.getState().setVoiceModalOpen(true, 'text');
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
      const input = screen.getByRole('textbox', { name: 'Type to Jarvis voice' });
      fireEvent.change(input, { target: { value: `Synthetic joined route check ${form}` } });
      fireEvent.submit(screen.getByRole('form', { name: 'Jarvis voice mini bar' }));
      await waitFor(() =>
        expect(
          toastMocks.error.mock.calls.length + vi.mocked(messageRepo.create).mock.calls.length,
        ).toBeGreaterThan(0),
      );
      expect.soft(toastMocks.error).not.toHaveBeenCalled();
      expect(messageRepo.create).toHaveBeenCalledOnce();
      await waitFor(() => expect(dispatchVoiceMainRequest).toHaveBeenCalledOnce());
      expect(vi.mocked(dispatchVoiceMainRequest).mock.calls[0]?.[0]).toMatchObject({
        chatId: 'chat_voice',
        text: `Synthetic joined route check ${form}`,
        modelSelectionOverride: complete,
        reasoningPreference: { mode: 'normal', effortOverride: 'low' },
      });
      expect(useAuthStore.getState().chatModelSelection).toEqual(selected);
      expect(useAuthStore.getState().apiKeys).toEqual({});
      expect(VoiceService.startListening).not.toHaveBeenCalled();
    },
  );

  it.each([
    'unavailable',
    'wrong provider',
    'wrong model',
    'wrong connection',
    'wrong descriptor',
  ] as const)(
    'refuses %s without persistence or fallback even with a Ready label',
    async (reason) => {
      const actual = await vi.importActual<
        typeof import('@/features/voice/voiceProviderSelection')
      >('@/features/voice/voiceProviderSelection');
      vi.mocked(resolveVoiceProviderSelection).mockImplementation(
        actual.resolveVoiceProviderSelection,
      );
      let selected = selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
      if (reason === 'wrong provider')
        selected = selectionFromOption('anthropic', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
      if (reason === 'wrong model')
        selected = selectionFromOption('openai', 'openai/not-discovered', OPENCODE_CLI_CONNECTION);
      if (reason === 'wrong connection')
        selected = selectionFromOption('openai', 'gpt-6-luna', CODEX_CLI_CONNECTION);
      accessibleModelFixture.options = [
        {
          id: 'opencode-cli:openai/gpt-6-luna',
          provider: 'openai',
          modelId: 'openai/gpt-6-luna',
          label: 'Luna',
          connectionId: OPENCODE_CLI_CONNECTION.id,
          connection:
            reason === 'wrong descriptor' ? CODEX_CLI_CONNECTION : OPENCODE_CLI_CONNECTION,
          available: reason !== 'unavailable',
          authLabel: 'Ready',
          catalogSource: 'opencode-live',
        },
      ];
      useAuthStore.setState({
        apiKeys: {},
        chatModelSelection: selected,
        voiceMainAgentProvider: 'opencode',
      });
      useUIStore.getState().setVoiceModalOpen(true, 'text');
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
      const input = screen.getByRole('textbox', { name: 'Type to Jarvis voice' });
      const draft = 'Preserve refused ' + reason;
      fireEvent.change(input, { target: { value: draft } });
      fireEvent.submit(screen.getByRole('form', { name: 'Jarvis voice mini bar' }));
      await waitFor(() =>
        expect(toastMocks.error).toHaveBeenCalledWith(
          'Voice message failed',
          expect.stringMatching(/unavailable/),
        ),
      );
      expect(messageRepo.create).not.toHaveBeenCalled();
      expect(dispatchVoiceMainRequest).not.toHaveBeenCalled();
      expect(input).toHaveProperty('value', draft);
      expect(useAuthStore.getState().chatModelSelection).toEqual(selected);
      expect(VoiceService.startListening).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['openrouter', 'openrouter/openai/gpt-6-luna'],
    ['qwen', 'qwen-coding-plan/qwen3-coder'],
  ] as const)(
    'preserves registered %s qualified model ownership with the exact subscription transport',
    (provider, model) => {
      const selection = selectionFromOption(provider, model, OPENCODE_CLI_CONNECTION);
      expect(
        validateSendModelAccess(
          'Synthetic validation',
          selection,
          { apiKeys: {}, offlineMode: false, plan: 'free', defaultLocalModel: '' },
          [],
          { voice: true },
        ),
      ).toEqual({ ok: true, selection });
    },
  );

  it.each([
    ['openai', 'anthropic/claude'],
    ['openai', 'unknown/model'],
    ['openai', 'gpt-6-luna'],
    ['anthropic', 'openai/gpt-6-luna'],
  ] as const)('refuses unproven declared owner %s for %s at the shared gate', (provider, model) => {
    const selection = selectionFromOption(provider, model, OPENCODE_CLI_CONNECTION);
    expect(
      validateSendModelAccess(
        'Synthetic validation',
        selection,
        { apiKeys: {}, offlineMode: false, plan: 'free', defaultLocalModel: '' },
        [],
        { voice: true },
      ),
    ).toEqual({
      ok: false,
      message: 'The selected connection does not match this model provider.',
    });
  });

  it('keeps the exact native Codex descriptor/provider check intact', () => {
    const context = {
      apiKeys: {},
      offlineMode: false,
      plan: 'free' as const,
      defaultLocalModel: '',
    };
    const valid = selectionFromOption('openai', 'gpt-6-luna', CODEX_CLI_CONNECTION);
    expect(validateSendModelAccess('Synthetic', valid, context, [], { voice: true })).toEqual({
      ok: true,
      selection: valid,
    });
    expect(
      validateSendModelAccess(
        'Synthetic',
        selectionFromOption('anthropic', 'openai/gpt-6-luna', CODEX_CLI_CONNECTION),
        context,
        [],
        { voice: true },
      ),
    ).toMatchObject({
      ok: false,
      message: 'The selected connection does not match this model provider.',
    });
  });

  it('still enforces the exact transport file capability after model-owner admission', () => {
    const selected = selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
    if (
      selected.mode !== 'single' ||
      selected.connectionId !== OPENCODE_CLI_CONNECTION.id ||
      selected.connectionMode !== OPENCODE_CLI_CONNECTION.mode ||
      selected.authSource !== OPENCODE_CLI_CONNECTION.authSource ||
      !selected.capabilities
    )
      throw new Error('Fixture requires the complete OpenCode connection selection');
    const advertised: ReturnType<typeof selectionFromOption> = {
      ...selected,
      connectionId: selected.connectionId,
      connectionMode: selected.connectionMode,
      authSource: selected.authSource,
      capabilities: { ...selected.capabilities, files: true },
    };
    expect(
      validateSendModelAccess(
        'Synthetic attachment',
        advertised,
        { apiKeys: {}, offlineMode: false, plan: 'free', defaultLocalModel: '' },
        [],
        { voice: true, attachments: { hasFiles: true } },
      ),
    ).toEqual({ ok: false, message: 'The selected connection does not support file attachments.' });
  });

  it.each([
    ['embedded NUL', 'openai/gpt\u0000bad'],
    ['embedded newline', 'openai/gpt\nbad'],
    ['overlong identifier', 'openai/' + 'a'.repeat(513)],
  ])('returns structured refusal for a saved model with %s', (_label, model) => {
    const selected = normalizeChatModelSelection(
      selectionFromOption('openai', model, OPENCODE_CLI_CONNECTION),
    );
    expect(selected.mode).toBe('single');
    let result: ReturnType<typeof validateSendModelAccess> | undefined;
    expect(() => {
      result = validateSendModelAccess(
        'Synthetic',
        selected,
        { apiKeys: {}, offlineMode: false, plan: 'free', defaultLocalModel: '' },
        [],
        { voice: true },
      );
    }).not.toThrow();
    expect(result).toEqual({
      ok: false,
      message: 'The selected connection does not match this model provider.',
    });
  });
});
