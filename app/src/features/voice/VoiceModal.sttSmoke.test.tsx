import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { GROQ_DEFAULT_MODEL } from '@/lib/ai/providers/groq';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';

const invoke = vi.hoisted(() => vi.fn());
const messageCreate = vi.hoisted(() => vi.fn(async () => ({})));
const voiceHandlers = vi.hoisted(() => new Map<string, Set<(payload?: unknown) => void>>());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/lib/db', () => ({ messageRepo: { create: messageCreate } }));
vi.mock('@/features/chat/hooks', () => ({ useChatMessages: () => [] }));
vi.mock('./JarvisVoiceInputService', () => ({
  JarvisVoiceInputService: {
    isSupported: () => true,
    isListening: () => false,
    wantsListening: () => false,
    setInactivityTimeoutMs: vi.fn(),
    startListening: vi.fn(() => true),
    stopListening: vi.fn(),
    cancelListening: vi.fn(),
    on: (event: string, handler: (payload?: unknown) => void) => {
      const handlers = voiceHandlers.get(event) ?? new Set();
      handlers.add(handler);
      voiceHandlers.set(event, handlers);
      return () => handlers.delete(handler);
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
vi.mock('./voiceChatRouting', () => ({
  ensureJarvisChatForVoice: vi.fn(async () => 'chat_voice'),
  ensureJarvisChatForProvider: vi.fn(async () => 'chat_voice'),
  focusVoiceChat: vi.fn(),
  resolveVoiceChatTarget: vi.fn(async (text: string) => ({
    chatId: 'chat_voice',
    messageText: text,
    mentionedAgentIds: [],
  })),
}));
vi.mock('./voiceRouter', () => ({
  handleVoiceModuleClosed: vi.fn(),
  stopCurrentVoiceResponse: vi.fn(),
  speakWithSettings: vi.fn(async () => undefined),
}));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ flatOptions: [] }),
}));
vi.mock('./voiceProviderSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voiceProviderSelection')>();
  return {
    ...actual,
    resolveVoiceProviderSelection: vi.fn(({ provider }: { provider: string }) => ({
      provider,
      selection: { mode: 'single', providerId: 'groq', modelId: 'openai/gpt-oss-20b' },
      modelLabel: 'Groq fixture',
    })),
  };
});
vi.mock('./voiceAgentFlow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voiceAgentFlow')>();
  return {
    ...actual,
    createVoiceAgentFlow: (deps: import('./voiceAgentFlow').VoiceAgentFlowDependencies) => ({
      run: async (input: import('./voiceAgentFlow').VoiceAgentRequest) => {
        await deps.persistUser(input);
        await deps.deliverMainResult({
          chatId: input.chatId,
          userText: input.text,
          mainProvider: input.mainProvider,
          workerProvider: input.workerProvider,
          childChatId: 'child-smoke',
          workerStatus: 'done',
          workerText: 'Smoke worker result',
          instruction: actual.VOICE_BRIEF_SYSTEM_INSTRUCTION,
        });
        return { status: 'main_dispatched' as const, duplicate: false, elapsedMs: 0 };
      },
    }),
  };
});

async function renderVoice(flag: string) {
  vi.resetModules();
  vi.stubEnv('VITE_SIK_SMOKE', flag);
  const [{ VoiceModal }, { useVoiceStore }, { useUIStore }, { useAuthStore }] = await Promise.all([
    import('./VoiceModal'),
    import('./store'),
    import('@/stores/ui'),
    import('@/stores/auth'),
  ]);
  useUIStore.setState({ voiceModalOpen: true, voiceListening: false, activeChatId: 'chat_voice' });
  useAuthStore.setState({
    localUserId: 'account-smoke',
    cloudSession: null,
    voiceAutoListenOnOpen: false,
    voiceEndTrigger: 'phrase',
    voiceCommitPhrase: 'send it',
    voiceCancelPhrase: 'cancel',
    voiceAutoApproveActions: false,
    fasterWhisperModel: 'small',
    apiKeys: { groq: 'gsk_test' },
    stackCustomSteps: DEFAULT_CUSTOM_STEPS,
    chatModelSelection: selectionFromOption('groq', GROQ_DEFAULT_MODEL),
  });
  useVoiceStore.getState().reset();
  render(<VoiceModal />);
  await waitFor(() => expect(useVoiceStore.getState().session).not.toBeNull());
}

describe('VoiceModal native smoke fixtures', () => {
  beforeEach(() => {
    invoke.mockReset();
    messageCreate.mockClear();
    voiceHandlers.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('exposes no smoke controls when the exact browser gate is off', async () => {
    await renderVoice('');
    expect(document.querySelector('[data-sik-evidence="voice.transcript"]')).toBeNull();
    expect(document.querySelector('[data-sik-evidence="voice.stt-fixture"]')).toBeNull();
  }, 20_000);

  it('submits the fixed transcript through the genuine protected utterance path', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    await renderVoice('1');

    fireEvent.click(screen.getByRole('button', { name: 'Submit fixed transcript' }));

    await waitFor(() => expect(messageCreate).toHaveBeenCalledOnce());
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 'chat_voice',
        parts: [{ kind: 'text', text: 'Stop this fixed voice smoke turn.' }],
      }),
    );
    expect((send.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      accountId: 'account-smoke',
      chatId: 'chat_voice',
      text: 'Stop this fixed voice smoke turn.',
    });
    window.removeEventListener('jarvis:send', send as EventListener);
  }, 20_000);

  it('passes only pinned native bytes to real Faster Whisper and submits its transcript', async () => {
    const audioBase64 = 'UklGRnNhZmU=';
    invoke
      .mockResolvedValueOnce({
        audioBase64,
        sha256: 'b3bab750a95495ae54c457b54cb9a066147e36acc6a711e1a09ea05265c272f7',
        mimeType: 'audio/wav',
      })
      .mockResolvedValueOnce('Transcribe the fixed native audio fixture.');
    await renderVoice('1');

    fireEvent.click(screen.getByRole('button', { name: 'Transcribe fixed audio' }));

    await waitFor(() => expect(messageCreate).toHaveBeenCalledOnce());
    expect(invoke.mock.calls[0]).toEqual(['sik_smoke_voice_fixture']);
    expect(invoke.mock.calls[1]).toEqual([
      'faster_whisper_transcribe',
      { model: 'small', audioBase64 },
    ]);
    expect(document.documentElement.outerHTML).not.toContain(audioBase64);
    expect(
      document
        .querySelector('[data-sik-evidence="voice.stt-state"]')
        ?.getAttribute('data-stt-state'),
    ).toBe('submitted');
    const evidence = document.querySelector('[data-sik-evidence="voice.stt-state"]');
    expect(evidence?.getAttribute('data-engine-id')).toBe('faster-whisper');
    expect(evidence?.getAttribute('data-model-id')).toBe('small');
    expect(evidence?.getAttribute('data-fixture-sha256')).toBe(
      'b3bab750a95495ae54c457b54cb9a066147e36acc6a711e1a09ea05265c272f7',
    );
    expect(evidence?.getAttribute('data-session-bound')).toBe('true');
  }, 20_000);

  it('reports engine failure without transcript fallback or kernel dispatch', async () => {
    invoke
      .mockResolvedValueOnce({
        audioBase64: 'UklGRnNhZmU=',
        sha256: 'b3bab750a95495ae54c457b54cb9a066147e36acc6a711e1a09ea05265c272f7',
        mimeType: 'audio/wav',
      })
      .mockRejectedValueOnce(new Error('missing faster-whisper model'));
    await renderVoice('1');

    fireEvent.click(screen.getByRole('button', { name: 'Transcribe fixed audio' }));

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-sik-evidence="voice.stt-state"]')
          ?.getAttribute('data-stt-state'),
      ).toBe('blocked_external'),
    );
    expect(
      document
        .querySelector('[data-sik-evidence="voice.stt-state"]')
        ?.getAttribute('data-blocker-code'),
    ).toBe('engine_failed');
    expect(messageCreate).not.toHaveBeenCalled();
  }, 20_000);
});
