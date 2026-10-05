import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { writeChatReasoningEffort } from '@/features/chat/reasoningSlashStore';
import {
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';
import { VOICE_REPLY_COOLDOWN_MS } from './voiceTurnCommit';
import { VOICE_BRIEF_SYSTEM_INSTRUCTION } from './voiceAgentFlow';
import { dispatchVoiceMainRequest } from './voiceNativeDelegation';
import { resolveVoiceProviderSelection } from './voiceProviderSelection';
import { createVoiceSessionBinding } from './voiceSessionBinding';
import type { ChatId } from '@/types';

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
      _options?: { freshVoiceConversation?: boolean; openingId?: string },
    ): Promise<string | null> => 'chat_voice',
  ),
  focusVoiceChat: vi.fn(),
  resolveVoiceChatTarget: vi.fn(async (text: string): Promise<MockVoiceChatTarget | null> => ({
    chatId: 'chat_voice',
    messageText: text,
    agentId: undefined,
    mentionedAgentIds: [],
  })),
}));

vi.mock('./JarvisVoiceInputService', () => ({
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
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ groups: [], flatOptions: [], hasAny: false }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: toastMocks.error,
  },
}));

vi.mock('@/lib/db', () => {
  let nextMessage = 0;
  return {
    messageRepo: {
      create: vi.fn(async () => ({ id: `voice-message-${++nextMessage}` })),
    },
  };
});

vi.mock('./voiceChatRouting', () => chatRoutingMocks);

vi.mock('./voiceConversationFolder', () => ({
  syncVoiceConversationFolder: vi.fn(async () => ({ ok: true, folder: 'test', messageCount: 1 })),
}));

vi.mock('./voiceRouter', () => routerMocks);

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

vi.mock('./voiceNativeDelegation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voiceNativeDelegation')>();
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

import { VoiceModal } from './VoiceModal';
import { messageRepo } from '@/lib/db';
import { useVoiceStore } from './store';
import { JarvisVoiceInputService as VoiceService } from './JarvisVoiceInputService';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { GROQ_DEFAULT_MODEL } from '@/lib/ai/providers/groq';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';
import { JarvisCommandCenterProvider } from '@/features/jarvis-command-center/JarvisCommandCenter';
import {
  acknowledgeJarvisApprovalNavigation,
  requestJarvisApprovalNavigation,
  resetJarvisApprovalNavigationForTests,
} from '@/features/jarvis-command-center/approvalNavigation';
import type {
  JarvisArtifactV1,
  JarvisCommandCenterDataPort,
  JarvisCommandCenterHostPort,
  JarvisEvent,
  JarvisRun,
} from '@/features/jarvis-command-center/types';
import type { ProjectId } from '@/types';
import {
  clearContextGalaxySnapshotsForTests,
  publishContextGalaxySnapshot,
} from '@/features/context/contextGalaxyRegistry';

function emitVoice(event: string, payload?: unknown) {
  voiceListeners.handlers.get(event)?.forEach((fn) => fn(payload));
}

function commandCenterBinding(accountId = 'account-a', runs: readonly JarvisRun[] = []) {
  const dataPort: JarvisCommandCenterDataPort = {
    getRunsForChat: vi.fn(async () => runs),
    getEventsForRun: vi.fn(async ({ runId }): Promise<readonly JarvisEvent[]> =>
      runs.some((run) => run.id === runId && run.status === 'awaiting_approval')
        ? [
            {
              runId,
              seq: 1,
              idempotencyKey: 'approval-1',
              type: 'approval',
              status: 'pending',
              title: 'Approval pending',
              sourceRefs: [],
              artifactIds: [],
              createdAt: 105,
            },
          ]
        : [],
    ),
    getArtifactsForRun: vi.fn(async () => []),
    getLiveEvidenceSnapshot: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
  const hostPort = {
    accountId,
    requestCancellation: vi.fn(),
    retryScheduledTransport: vi.fn(),
    retryLogicalRun: vi.fn(),
  } as unknown as JarvisCommandCenterHostPort;
  return { dataPort, hostPort };
}

function approvalRun(): JarvisRun {
  return {
    id: 'run-approval',
    accountId: 'account-a',
    chatId: 'chat_voice',
    source: 'voice',
    status: 'awaiting_approval',
    agentId: 'jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-1',
    model: {
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      connectionMode: 'native-api',
      capabilities: {},
      capturedAt: 90,
    },
    createdAt: 100,
    updatedAt: 110,
  };
}

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

function voicePanel() {
  const panel = document.getElementById('jarvis-panel');
  if (!panel) throw new Error('voice panel lifecycle mount missing');
  return panel;
}

function voicePanelRole(...[role, options]: Parameters<typeof screen.getByRole>) {
  return within(voicePanel()).getByRole(role, { ...options, hidden: true });
}

function queryVoicePanelRole(...[role, options]: Parameters<typeof screen.queryByRole>) {
  return within(voicePanel()).queryByRole(role, { ...options, hidden: true });
}

function findVoicePanelRole(...[role, options]: Parameters<typeof screen.findByRole>) {
  return within(voicePanel()).findByRole(role, { ...options, hidden: true });
}

function voiceMiniBar() {
  const form = document.querySelector<HTMLFormElement>('form[aria-label="Jarvis voice mini bar"]');
  if (!form) throw new Error('voice mini bar mount missing');
  return form;
}

describe('VoiceModal hands-free turn-taking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    setReducedMotion(false);
    chatHookMocks.useChatMessages.mockReset().mockReturnValue([]);
    chatRoutingMocks.ensureJarvisChatForVoice.mockReset().mockResolvedValue('chat_voice');
    chatRoutingMocks.ensureJarvisChatForProvider.mockReset().mockResolvedValue('chat_voice');
    chatRoutingMocks.focusVoiceChat.mockReset();
    chatRoutingMocks.resolveVoiceChatTarget
      .mockReset()
      .mockImplementation(async (text: string): Promise<MockVoiceChatTarget | null> => ({
        chatId: 'chat_voice',
        messageText: text,
        agentId: undefined,
        mentionedAgentIds: [],
      }));
    voiceListeners.handlers.clear();
    useUIStore.setState({
      voiceModalOpen: true,
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

  it('resumes the provider chat by default and requests a fresh chat only when selected', async () => {
    const first = render(<VoiceModal />);
    await waitFor(() => expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalled());
    expect(chatRoutingMocks.ensureJarvisChatForProvider.mock.calls[0]?.[2]).toMatchObject({
      freshVoiceConversation: false,
    });
    first.unmount();
    chatRoutingMocks.ensureJarvisChatForProvider.mockClear();
    useAuthStore.getState().setVoiceStartFreshChat(true);
    render(<VoiceModal />);
    await waitFor(() => expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalled());
    expect(chatRoutingMocks.ensureJarvisChatForProvider.mock.calls[0]?.[2]).toMatchObject({
      freshVoiceConversation: true,
    });
  });

  it('creates a different chat when New is selected and the mounted voice panel reopens', async () => {
    useAuthStore.getState().setVoiceStartFreshChat(true);
    chatRoutingMocks.ensureJarvisChatForProvider
      .mockResolvedValueOnce('voice-opening-one')
      .mockResolvedValueOnce('voice-opening-two');

    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('voice-opening-one'));
    act(() => useUIStore.getState().setVoiceModalOpen(false));
    act(() => useUIStore.getState().setVoiceModalOpen(true));
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('voice-opening-two'));
    expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalledTimes(2);
    expect(chatRoutingMocks.ensureJarvisChatForProvider.mock.calls[0]?.[2]).toMatchObject({
      freshVoiceConversation: true,
    });
    expect(chatRoutingMocks.ensureJarvisChatForProvider.mock.calls[0]?.[2]?.openingId).not.toBe(
      chatRoutingMocks.ensureJarvisChatForProvider.mock.calls[1]?.[2]?.openingId,
    );
  });

  it('clears an orphaned voice session when the panel mounts closed', async () => {
    useUIStore.setState({ voiceModalOpen: false, voiceListening: true });
    const binding = createVoiceSessionBinding({
      sessionId: 'orphaned-voice-session',
      accountId: 'account-a',
      chatId: 'chat_voice' as ChatId,
      startedAt: Date.now(),
    });
    useVoiceStore.getState().beginSession(binding);
    useVoiceStore.getState().setState('listening');

    render(<VoiceModal />);

    await waitFor(() => expect(useVoiceStore.getState().session).toBeNull());
    expect(useVoiceStore.getState().state).toBe('idle');
    expect(useUIStore.getState().voiceListening).toBe(false);
    expect(VoiceService.cancelListening).toHaveBeenCalled();
  });

  it('keeps voice lifecycle active while hiding the panel and enabled mini bar', async () => {
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));

    const panel = voicePanel();
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(getComputedStyle(panel).display).toBe('none');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'Jarvis voice session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand Command Center' })).toBeNull();
    expect(useUIStore.getState().voiceModalOpen).toBe(true);

    act(() => useAuthStore.getState().setVoiceMiniBarEnabled(true));
    await waitFor(() => expect(voiceMiniBar().hasAttribute('hidden')).toBe(true));
    expect(getComputedStyle(voiceMiniBar()).display).toBe('none');
    expect(voiceMiniBar().getAttribute('aria-hidden')).toBe('true');
    expect(voiceMiniBar().hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('form', { name: 'Jarvis voice mini bar' })).toBeNull();
    expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice');
  });

  it('keeps the optional mini bar hidden but preserves its voice-submit flow', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    const rendered = render(<VoiceModal />);
    expect(screen.queryByRole('form', { name: 'Jarvis voice mini bar' })).toBeNull();
    act(() => useAuthStore.getState().setVoiceMiniBarEnabled(true));
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    const form = await waitFor(() => voiceMiniBar());
    expect(form.hasAttribute('hidden')).toBe(true);
    const input = form.querySelector<HTMLInputElement>('input[aria-label="Type to Jarvis voice"]');
    if (!input) throw new Error('voice mini bar input missing');
    fireEvent.change(input, { target: { value: 'Check the status' } });
    fireEvent.submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(routerMocks.speakWithSettings).toHaveBeenCalledWith('On it.', {
      allowBackground: true,
    });
    expect((send.mock.calls[0]?.[0] as CustomEvent).detail.chatId).toBe('chat_voice');
    expect((input as HTMLInputElement).value).toBe('');
    rendered.unmount();
    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('captures the bound chat Low effort with its voice Main route', async () => {
    const key = 'vibespace.chat-reasoning.v1';
    const previous = localStorage.getItem(key);
    useAuthStore.getState().setVoiceMiniBarEnabled(true);
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
      writeChatReasoningEffort('chat_voice', 'low');
      const input = voiceMiniBar().querySelector<HTMLInputElement>(
        'input[aria-label="Type to Jarvis voice"]',
      );
      if (!input) throw new Error('voice mini bar input missing');
      fireEvent.change(input, { target: { value: 'What is seven times eight?' } });
      fireEvent.submit(voiceMiniBar());
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      const detail = (send.mock.calls[0]?.[0] as CustomEvent).detail;
      expect(detail.modelSelectionOverride).toMatchObject({ mode: 'single' });
      expect(detail.reasoningPreference).toEqual({ mode: 'normal', effortOverride: 'low' });
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it('restores hidden mini-bar submission after a streamed reply ends', async () => {
    useAuthStore.getState().setVoiceMiniBarEnabled(true);
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
      const form = await waitFor(() => voiceMiniBar());
      const input = form.querySelector<HTMLInputElement>(
        'input[aria-label="Type to Jarvis voice"]',
      );
      if (!input) throw new Error('voice mini bar input missing');
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (!submit) throw new Error('voice mini bar submit button missing');
      expect(form.hasAttribute('hidden')).toBe(true);
      act(() => window.dispatchEvent(new CustomEvent(STREAMING_VOICE_START_EVENT)));
      act(() => window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT)));
      await waitFor(() => expect(useVoiceStore.getState().state).not.toBe('speaking'), {
        timeout: VOICE_REPLY_COOLDOWN_MS + 1_000,
      });
      fireEvent.change(input, { target: { value: 'Next question' } });
      expect(submit.disabled).toBe(false);
      fireEvent.submit(form);
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('shows the actual one-request Main provider without saving that override', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
      act(() => emitVoice('voice:final', { text: 'Use OpenCode as main for this answer send it' }));
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(voicePanel().dataset.voiceProvider).toBe('opencode');
      expect(voicePanelRole('img', { name: 'Jarvis voice activity' }).dataset.voiceProvider).toBe(
        'opencode',
      );
      expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('sends a simple Main answer without resolving an unavailable Worker provider', async () => {
    useAuthStore.getState().setVoiceWorkerProvider('opencode');
    const resolveRoute = vi.mocked(resolveVoiceProviderSelection);
    const originalResolve = resolveRoute.getMockImplementation();
    if (!originalResolve) throw new Error('voice provider test resolver unavailable');
    resolveRoute.mockImplementation((input) => {
      if (input.provider === 'opencode') throw new Error('Worker provider unavailable');
      return originalResolve(input);
    });
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
      act(() => emitVoice('voice:final', { text: 'What day is it send it' }));
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(resolveRoute.mock.calls.map(([input]) => input.provider)).toEqual(['codex']);
      expect(useAuthStore.getState().voiceWorkerProvider).toBe('opencode');
      expect(toastMocks.error).not.toHaveBeenCalled();
    } finally {
      resolveRoute.mockImplementation(originalResolve);
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('does not submit a repeated transcript after a New-chat reopen', async () => {
    useAuthStore.getState().setVoiceStartFreshChat(true);
    chatRoutingMocks.ensureJarvisChatForProvider
      .mockResolvedValueOnce('voice-first')
      .mockResolvedValueOnce('voice-second');
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('voice-first'));
      act(() => emitVoice('voice:final', { text: 'Unique repeated task send it' }));
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      act(() => useUIStore.getState().setVoiceModalOpen(false));
      act(() => useUIStore.getState().setVoiceModalOpen(true));
      await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('voice-second'));
      act(() => emitVoice('voice:final', { text: 'Unique repeated task send it' }));
      await waitFor(() =>
        expect(screen.getByText('Already sent; continuing the existing request')).not.toBeNull(),
      );
      expect(send).toHaveBeenCalledOnce();
      expect(messageRepo.create).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('binds a New chat while the previous Main request awaits runtime acceptance', async () => {
    useAuthStore.getState().setVoiceStartFreshChat(true);
    chatRoutingMocks.ensureJarvisChatForProvider
      .mockResolvedValueOnce('voice-pending-first')
      .mockResolvedValueOnce('voice-pending-second');
    let accept!: (receipt: Awaited<ReturnType<typeof dispatchVoiceMainRequest>>) => void;
    vi.mocked(dispatchVoiceMainRequest).mockImplementationOnce(
      () => new Promise((resolve) => (accept = resolve)),
    );
    render(<VoiceModal />);
    await waitFor(() =>
      expect(useVoiceStore.getState().session?.chatId).toBe('voice-pending-first'),
    );
    act(() => emitVoice('voice:final', { text: 'Work while I reopen send it' }));
    await waitFor(() => expect(dispatchVoiceMainRequest).toHaveBeenCalledOnce());
    act(() => useUIStore.getState().setVoiceModalOpen(false));
    act(() => useUIStore.getState().setVoiceModalOpen(true));
    await waitFor(() =>
      expect(useVoiceStore.getState().session?.chatId).toBe('voice-pending-second'),
    );
    act(() => emitVoice('voice:final', { text: 'A separate request in the new chat send it' }));
    await waitFor(() => expect(dispatchVoiceMainRequest).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dispatchVoiceMainRequest).mock.calls[1]?.[0]?.chatId).toBe(
      'voice-pending-second',
    );
    act(() =>
      accept({
        status: 'failed',
        code: 'runtime_rejected',
        message: 'The old request was rejected.',
      }),
    );
    await act(async () => Promise.resolve());
    expect(useVoiceStore.getState().session?.chatId).toBe('voice-pending-second');
    expect(screen.getByText('Sent to Codex Main Agent')).toBeTruthy();
    expect(useVoiceStore.getState().state).not.toBe('error');
  });

  it('embeds the account-and-project-scoped Context galaxy directly below the transcript', async () => {
    publishContextGalaxySnapshot({
      accountId: 'account-a',
      projectId: 'project-a',
      mapId: 'map-a',
      nodes: [
        {
          id: 'source-a',
          label: 'Source A',
          description: 'A retrieved source.',
          parentId: null,
          groupId: 'sources',
          depth: 0,
          order: 0,
          radius: 12,
        },
      ],
      edges: [],
      selectedId: 'source-a',
      activityNodeIds: ['source-a'],
    });

    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));

    const transcript = screen.getByLabelText('Voice session transcript');
    const galaxy = voicePanelRole('region', { name: 'Compact Context galaxy' });
    expect(
      transcript.compareDocumentPosition(galaxy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(voicePanelRole('button', { name: /Use 2D fallback/i })).not.toBeNull();
    expect(voicePanelRole('button', { name: /Source A/i }).dataset.contextActivity).toBe('true');
  });

  it('captures one immutable account/chat binding and keeps transcript and default sends pinned to it', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    chatRoutingMocks.resolveVoiceChatTarget.mockResolvedValueOnce({
      chatId: 'chat_changed_after_open',
      messageText: 'bound message',
      agentId: undefined,
      mentionedAgentIds: [],
    });

    const bindingPort = commandCenterBinding();
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );

    await waitFor(() => expect(useVoiceStore.getState().session).not.toBeNull());
    expect(document.querySelector('[data-sik-evidence="voice.transcript"]')).toBeNull();
    expect(document.querySelector('[data-sik-evidence="voice.stt-fixture"]')).toBeNull();
    const binding = useVoiceStore.getState().session!;
    expect(binding).toMatchObject({ accountId: 'account-a', chatId: 'chat_voice' });
    expect(binding.sessionId).toMatch(/^vsession_/);
    expect(Object.isFrozen(binding)).toBe(true);

    act(() => useUIStore.setState({ activeChatId: 'chat_changed_after_open' }));
    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));
    await waitFor(() => expect(chatHookMocks.useChatMessages).toHaveBeenCalledWith('chat_voice'));
    expect(
      within(voicePanel())
        .getAllByRole('tab', { hidden: true })
        .map((tab) => tab.textContent),
    ).toEqual(['Outputs', 'Live Systems']);
    expect(screen.getByTitle(/GPT.OSS.20B/i)).not.toBeNull();
    await waitFor(() =>
      expect(bindingPort.dataPort.getRunsForChat).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-a', chatId: 'chat_voice' }),
      ),
    );
    expect(useVoiceStore.getState().session).toBe(binding);

    act(() => {
      emitVoice('voice:final', { text: 'bound message' });
      emitVoice('voice:final', { text: 'send it' });
    });

    await waitFor(() => expect(messageRepo.create).toHaveBeenCalledOnce());
    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 'chat_voice' }),
    );
    expect((send.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      accountId: 'account-a',
      chatId: 'chat_voice',
      voiceSessionId: binding.sessionId,
    });
    expect(chatRoutingMocks.focusVoiceChat).toHaveBeenLastCalledWith('chat_voice');
    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('never mounts Command Center data from a different account session', async () => {
    const bindingPort = commandCenterBinding('account-b');
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );

    await waitFor(() => expect(useVoiceStore.getState().session?.accountId).toBe('account-a'));
    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));

    expect(queryVoicePanelRole('tab')).toBeNull();
    expect(bindingPort.dataPort.getRunsForChat).not.toHaveBeenCalled();
    expect(
      screen.getByText('Command Center is unavailable for this voice session.'),
    ).not.toBeNull();
  });

  it('closes only the matching voice overlay when approval navigation returns to chat', async () => {
    const bindingPort = commandCenterBinding('account-a', [approvalRun()]);
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );

    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    requestJarvisApprovalNavigation({
      accountId: 'account-other',
      chatId: 'chat_voice',
      runId: 'run-approval',
      approvalId: 'approval-1',
    });
    expect(useUIStore.getState().voiceModalOpen).toBe(true);
    expect(
      acknowledgeJarvisApprovalNavigation({
        accountId: 'account-other',
        chatId: 'chat_voice',
        runId: 'run-approval',
        approvalId: 'approval-1',
      }),
    ).toBe(true);

    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));
    fireEvent.click(await findVoicePanelRole('button', { name: 'Open approval in chat' }));
    await waitFor(() => expect(useUIStore.getState().voiceModalOpen).toBe(false));
  });

  it('keeps the voice overlay open when the approval target names another run', async () => {
    const bindingPort = commandCenterBinding('account-a', [approvalRun()]);
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );

    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    const focusCount = chatRoutingMocks.focusVoiceChat.mock.calls.length;
    requestJarvisApprovalNavigation({
      accountId: 'account-a',
      chatId: 'chat_voice',
      runId: 'run-other',
      approvalId: 'approval-1',
    });

    await waitFor(() => expect(bindingPort.dataPort.getRunsForChat).toHaveBeenCalled());
    expect(useUIStore.getState().voiceModalOpen).toBe(true);
    expect(chatRoutingMocks.focusVoiceChat).toHaveBeenCalledTimes(focusCount);
  });

  it('keeps the voice overlay open when the current run has a newer pending approval', async () => {
    const bindingPort = commandCenterBinding('account-a', [approvalRun()]);
    vi.mocked(bindingPort.dataPort.getEventsForRun).mockResolvedValue([
      {
        runId: 'run-approval',
        seq: 2,
        idempotencyKey: 'approval-newer',
        type: 'approval',
        status: 'pending',
        title: 'Current approval',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 110,
      },
    ]);
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );

    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    const focusCount = chatRoutingMocks.focusVoiceChat.mock.calls.length;
    requestJarvisApprovalNavigation({
      accountId: 'account-a',
      chatId: 'chat_voice',
      runId: 'run-approval',
      approvalId: 'approval-1',
    });

    await waitFor(() => expect(bindingPort.dataPort.getEventsForRun).toHaveBeenCalled());
    expect(useUIStore.getState().voiceModalOpen).toBe(true);
    expect(chatRoutingMocks.focusVoiceChat).toHaveBeenCalledTimes(focusCount);
  });

  it('cancels an in-flight approval lookup when another valid target supersedes it', async () => {
    const bindingPort = commandCenterBinding('account-a', [approvalRun()]);
    let resolveRuns!: (runs: readonly JarvisRun[]) => void;
    const pendingRuns = new Promise<readonly JarvisRun[]>((resolve) => {
      resolveRuns = resolve;
    });
    vi.mocked(bindingPort.dataPort.getRunsForChat).mockReturnValueOnce(pendingRuns);
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );

    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    const focusCount = chatRoutingMocks.focusVoiceChat.mock.calls.length;
    requestJarvisApprovalNavigation({
      accountId: 'account-a',
      chatId: 'chat_voice',
      runId: 'run-approval',
      approvalId: 'approval-1',
    });
    await waitFor(() => expect(bindingPort.dataPort.getRunsForChat).toHaveBeenCalledTimes(1));

    expect(
      requestJarvisApprovalNavigation({
        accountId: 'account-other',
        chatId: 'chat-other',
        runId: 'run-other',
        approvalId: 'approval-other',
      }),
    ).toBe(true);
    await act(async () => {
      resolveRuns([approvalRun()]);
      await pendingRuns;
    });

    expect(useUIStore.getState().voiceModalOpen).toBe(true);
    expect(chatRoutingMocks.focusVoiceChat).toHaveBeenCalledTimes(focusCount);
  });

  it('keeps eight meaningful turns, expands long text, and does not yank a reader from history', async () => {
    const longTail = `latest ${'voice session detail '.repeat(8)}`.trim();
    const shortMultiline = 'first line\nsecond line\nthird line';
    chatHookMocks.useChatMessages.mockReturnValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `message-${index + 1}`,
        chat_id: 'chat_voice',
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [
          {
            kind: 'text',
            text: index === 9 ? longTail : index === 8 ? shortMultiline : `turn ${index + 1}`,
          },
        ],
        created_at: index + 1,
        updated_at: index + 1,
      })) as never[],
    );

    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));

    expect(screen.queryByText('turn 1')).toBeNull();
    expect(screen.queryByText('turn 2')).toBeNull();
    expect(screen.getByText('turn 3')).not.toBeNull();
    expect(screen.getByText(/first line\s+second line\s+third line/u)).not.toBeNull();
    expect(screen.getByText(longTail)).not.toBeNull();

    const showMore = within(voicePanel()).getAllByRole('button', {
      name: 'Show more',
      hidden: true,
    });
    expect(showMore).toHaveLength(2);
    expect(showMore[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(showMore[0]?.classList.contains('min-h-7')).toBe(true);
    expect(voicePanel().querySelector('[class*="text-[8px]"]')).toBe(null);
    fireEvent.click(showMore[0]!);
    expect(voicePanelRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    const transcript = screen.getByLabelText('Voice session transcript');
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    act(() => useVoiceStore.getState().setPartialTranscript('new partial'));
    expect(transcript.scrollTop).toBe(100);
  });

  it('provides practical pointer targets and tooltips for compact icon controls', async () => {
    render(<VoiceModal />);
    act(() => emitVoice('voice:start')); // The icon must reflect actual capture, not request acceptance.
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));

    const close = voicePanelRole('button', { name: 'Close Jarvis voice session' });
    expect(close.getAttribute('title')).toBe('Close');
    expect(close.classList.contains('h-7')).toBe(true);
    expect(close.classList.contains('w-7')).toBe(true);

    const voiceControl = voicePanelRole('button', {
      name: /Listening active|Stop listening/i,
    });
    expect(voiceControl.getAttribute('title')).toBeTruthy();
    expect(voiceControl.classList.contains('min-h-8')).toBe(true);
    expect(voiceControl.classList.contains('min-w-8')).toBe(true);

    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));
    const region = document.getElementById(
      voicePanelRole('button', { name: /Command Center/i }).getAttribute('aria-controls')!,
    );
    expect(region?.getAttribute('data-motion-kind')).toBe('spring');
  });

  it('keeps the voice shell transparent and preserves disclosure text at browser text zoom', async () => {
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));

    const panel = voicePanel();
    const disclosure = voicePanelRole('button', { name: /Command Center/i });
    expect(panel.className).toContain('text-foreground');
    expect(panel.className).not.toMatch(
      /\b(?:jarvis-glass-panel|border|bg-elevated|backdrop-blur)\b/,
    );
    expect(disclosure.classList.contains('text-xs')).toBe(true);

    fireEvent.click(disclosure);
    const modelLabel = disclosure.querySelector('span[title]');
    expect(modelLabel).not.toBeNull();
    expect(modelLabel?.classList.contains('truncate')).toBe(false);
    expect(modelLabel?.classList.contains('break-words')).toBe(true);
  });

  it('collapses the embedded Command Center on Escape and restores disclosure focus', async () => {
    const bindingPort = commandCenterBinding();
    render(
      <JarvisCommandCenterProvider value={bindingPort}>
        <VoiceModal />
      </JarvisCommandCenterProvider>,
    );
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));

    const disclosure = voicePanelRole('button', { name: /Command Center/i });
    fireEvent.click(disclosure);
    const outputTab = await findVoicePanelRole('tab', { name: 'Outputs' });
    outputTab.focus();
    fireEvent.keyDown(outputTab, { key: 'Escape' });

    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(disclosure);
    expect(document.getElementById(disclosure.getAttribute('aria-controls')!)).toBeNull();

    fireEvent.click(disclosure);
    disclosure.focus();
    fireEvent.keyDown(disclosure, { key: 'Escape' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  });

  it('profiles bounded commits while listening, speaking, running tools, showing artifacts, dragging, and switching routes', async () => {
    const profiledRun = { ...approvalRun(), status: 'running' as const };
    const bindingPort = commandCenterBinding('account-a', [profiledRun]);
    const taskEvents: readonly JarvisEvent[] = Array.from({ length: 6 }, (_, index) => ({
      runId: profiledRun.id,
      seq: index + 1,
      idempotencyKey: `profile-tool-${index + 1}`,
      type: 'tool',
      status: index === 5 ? 'running' : 'completed',
      title: `Tool step ${index + 1}`,
      sourceRefs: [],
      artifactIds: [],
      createdAt: 120 + index,
    }));
    const artifacts: readonly JarvisArtifactV1[] = Array.from({ length: 6 }, (_, index) => ({
      schemaVersion: 1,
      id: `jartifact_profile_${index + 1}`,
      runId: profiledRun.id,
      requestId: 'request-profile',
      attemptNumber: 1,
      state: 'ready',
      kind: 'text',
      title: `Profile artifact ${index + 1}`,
      safeSummary: `Verified artifact ${index + 1}.`,
      sourceRefs: [],
      createdAt: 140 + index,
    }));
    vi.mocked(bindingPort.dataPort.getEventsForRun).mockResolvedValue(taskEvents);
    vi.mocked(bindingPort.dataPort.getArtifactsForRun).mockResolvedValue(artifacts);
    vi.mocked(bindingPort.dataPort.getLiveEvidenceSnapshot).mockResolvedValue({
      schemaVersion: 1,
      accountId: 'account-a',
      runId: profiledRun.id,
      capturedAt: 160,
      nodes: [],
    });

    const commits: number[] = [];
    const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commits.push(actualDuration);
    };
    const settle = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    const measure = async (action: () => void | Promise<void>) => {
      await settle();
      const start = commits.length;
      await action();
      await settle();
      return commits.slice(start);
    };

    render(
      <React.Profiler id="voice-command-center-profile" onRender={onRender}>
        <JarvisCommandCenterProvider value={bindingPort}>
          <VoiceModal />
        </JarvisCommandCenterProvider>
      </React.Profiler>,
    );
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));

    const artifactsProfile = await measure(async () => {
      fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));
      await screen.findByText('Profile artifact 6');
    });

    const toolTaskProfile = await measure(async () => {
      const liveSystemsTab = voicePanelRole('tab', { name: 'Live Systems' });
      liveSystemsTab.focus();
      fireEvent.keyDown(liveSystemsTab, { key: 'Enter' });
      await screen.findByText('Tool step 6');
    });

    act(() => useVoiceStore.setState({ state: 'paused' }));
    const listeningProfile = await measure(() => {
      act(() => useVoiceStore.setState({ state: 'listening' }));
      expect(voicePanelRole('button', { name: 'Stop listening' })).not.toBeNull();
    });

    const speakingProfile = await measure(() => {
      act(() => useVoiceStore.setState({ state: 'speaking' }));
      expect(voicePanelRole('button', { name: 'Stop response' })).not.toBeNull();
    });

    const dragProfile = await measure(() => {
      const dragRow = document.querySelector<HTMLElement>('.jarvis-voice-drag-row');
      if (!dragRow) throw new Error('Expected voice panel drag row.');
      Object.defineProperty(dragRow, 'setPointerCapture', { configurable: true, value: vi.fn() });
      fireEvent.pointerDown(dragRow, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(dragRow, { clientX: 35, clientY: 40, pointerId: 1 });
      fireEvent.pointerUp(dragRow, { clientX: 35, clientY: 40, pointerId: 1 });
    });

    const routeProfile = await measure(() => {
      act(() => useUIStore.getState().setRoute('schedule'));
      expect(useUIStore.getState().route).toBe('schedule');
    });

    for (const entry of commits) {
      expect(Number.isFinite(entry)).toBe(true);
      expect(entry).toBeGreaterThanOrEqual(0);
    }
    expect(artifactsProfile.length).toBeGreaterThan(0);
    expect(artifactsProfile.length).toBeLessThanOrEqual(10);
    expect(toolTaskProfile.length).toBeLessThanOrEqual(10);
    expect(listeningProfile.length).toBeLessThanOrEqual(2);
    expect(speakingProfile.length).toBeLessThanOrEqual(2);
    expect(dragProfile.length).toBeLessThanOrEqual(1);
    expect(routeProfile.length).toBeLessThanOrEqual(1);
    expect(bindingPort.dataPort.getEventsForRun).toHaveBeenCalledTimes(1);
    expect(bindingPort.dataPort.getArtifactsForRun).toHaveBeenCalledTimes(1);
  });

  it('removes outer panel and disclosure motion when the user prefers reduced motion', async () => {
    setReducedMotion(true);
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));

    const panel = voicePanel();
    expect(panel.getAttribute('data-reduced-motion')).toBe('true');
    expect(panel.classList.contains('transition-[width]')).toBe(false);
    expect(panel.querySelector('[data-orb-motion="reduced"]')).not.toBeNull();
    expect(panel.getAttribute('initial')).toBeNull();
    expect(panel.getAttribute('animate')).toBeNull();
    expect(panel.getAttribute('exit')).toBeNull();

    fireEvent.click(voicePanelRole('button', { name: /Command Center/i }));
    const region = document.getElementById(
      voicePanelRole('button', { name: /Command Center/i }).getAttribute('aria-controls')!,
    );
    expect(region).not.toBeNull();
    expect(region?.getAttribute('initial')).toBeNull();
    expect(region?.getAttribute('animate')).toBeNull();
    expect(region?.getAttribute('exit')).toBeNull();
    expect(region?.getAttribute('data-motion-kind')).toBe('none');
  });

  it('retries voice-session binding when the agent roster hydrates after the modal opens', async () => {
    chatRoutingMocks.ensureJarvisChatForProvider
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('chat_voice');

    render(<VoiceModal />);
    await waitFor(() =>
      expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalledOnce(),
    );
    expect(useVoiceStore.getState().session).toBeNull();

    act(() => useAgentStore.setState({ agents: {} }));

    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalledTimes(2);
  });

  it('keeps a spoken specialist mention in the provider-bound Main Agent flow', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session).not.toBeNull());

    act(() => {
      emitVoice('voice:final', { text: 'ask the builder' });
      emitVoice('voice:final', { text: 'send it' });
    });

    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const detail = (send.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail).toMatchObject({ chatId: 'chat_voice', accountId: 'account-a' });
    expect(detail).not.toHaveProperty('agentId');
    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('ends the old binding before starting a replacement when account identity changes', async () => {
    let releaseStop!: () => void;
    routerMocks.stopCurrentVoiceResponse.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      }),
    );
    const observedAccounts: Array<string | null> = [];
    const unsubscribe = useVoiceStore.subscribe((voice) => {
      observedAccounts.push(voice.session?.accountId ?? null);
    });

    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.accountId).toBe('account-a'));
    const firstSessionId = useVoiceStore.getState().session!.sessionId;
    observedAccounts.length = 0;

    act(() => useAuthStore.setState({ localUserId: 'account-b' }));

    await waitFor(() => expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledOnce());
    act(() => {
      useVoiceStore.getState().setSessionRun('jrun-late-old-account');
      releaseStop();
    });

    await waitFor(() => expect(useVoiceStore.getState().session?.accountId).toBe('account-b'));
    expect(useVoiceStore.getState().session?.sessionId).not.toBe(firstSessionId);
    expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledOnce();
    expect(observedAccounts.indexOf(null)).toBeGreaterThanOrEqual(0);
    expect(observedAccounts.indexOf(null)).toBeLessThan(observedAccounts.indexOf('account-b'));
    unsubscribe();
  });

  it('cancels and clears the old binding when account identity becomes unavailable', async () => {
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.accountId).toBe('account-a'));

    act(() => useAuthStore.setState({ localUserId: null, cloudSession: null }));

    await waitFor(() => expect(useVoiceStore.getState().session).toBeNull());
    expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledOnce();
  });

  it('reports a safe templated failure when the old voice session cannot close', async () => {
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.accountId).toBe('account-a'));
    routerMocks.stopCurrentVoiceResponse.mockRejectedValueOnce(
      new Error('synthetic close implementation detail'),
    );

    act(() => useAuthStore.setState({ localUserId: null, cloudSession: null }));

    await waitFor(() =>
      expect(useVoiceStore.getState()).toMatchObject({
        state: 'error',
        errorMessage:
          'The action failed, sir. Action: Voice session closure. Cause: The previous voice session could not be closed cleanly.',
      }),
    );
    expect(useVoiceStore.getState().errorMessage).not.toContain(
      'synthetic close implementation detail',
    );
  });

  it('classifies an account-replacement shutdown failure as session closure', async () => {
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.accountId).toBe('account-a'));
    routerMocks.stopCurrentVoiceResponse.mockRejectedValueOnce(
      new Error('synthetic replacement shutdown detail'),
    );

    act(() => useAuthStore.setState({ localUserId: 'account-b' }));

    await waitFor(() =>
      expect(useVoiceStore.getState()).toMatchObject({
        state: 'error',
        errorMessage:
          'The action failed, sir. Action: Voice session closure. Cause: The previous voice session could not be closed cleanly.',
      }),
    );
    expect(useVoiceStore.getState().errorMessage).not.toContain(
      'synthetic replacement shutdown detail',
    );
    expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalledOnce();
  });

  it('reports a safe templated failure when voice session startup throws', async () => {
    chatRoutingMocks.ensureJarvisChatForProvider.mockRejectedValueOnce(
      new Error('synthetic startup implementation detail'),
    );

    render(<VoiceModal />);

    await waitFor(() =>
      expect(useVoiceStore.getState()).toMatchObject({
        state: 'error',
        errorMessage:
          'The action failed, sir. Action: Voice session startup. Cause: A Jarvis chat could not be prepared for the new voice session.',
      }),
    );
    expect(useVoiceStore.getState().errorMessage).not.toContain(
      'synthetic startup implementation detail',
    );
  });

  it('starts no bound session or chat resolution without canonical account identity', async () => {
    useAuthStore.setState({ localUserId: null, cloudSession: null });

    render(<VoiceModal />);
    await act(async () => Promise.resolve());

    expect(useVoiceStore.getState().session).toBeNull();
    expect(chatRoutingMocks.ensureJarvisChatForProvider).not.toHaveBeenCalled();
  });

  it('reports a precise routing failure without persisting or sending when no target exists', async () => {
    chatRoutingMocks.ensureJarvisChatForProvider.mockResolvedValue(null);
    render(<VoiceModal />);
    await waitFor(() =>
      expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalledOnce(),
    );
    vi.useFakeTimers();
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    try {
      act(() => emitVoice('voice:final', { text: 'unroutable request send it' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useVoiceStore.getState()).toMatchObject({
        state: 'error',
        errorMessage:
          'The action failed, sir. Action: Voice message routing. Cause: No Jarvis chat target was available.',
      });
      expect(messageRepo.create).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('binds a provider chat when the initial voice session had no chat', async () => {
    chatRoutingMocks.ensureJarvisChatForProvider.mockResolvedValueOnce(null);
    render(<VoiceModal />);
    await waitFor(() =>
      expect(chatRoutingMocks.ensureJarvisChatForProvider).toHaveBeenCalledOnce(),
    );
    vi.useFakeTimers();
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    try {
      act(() => emitVoice('voice:final', { text: 'unbound request send it' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice');
      expect(messageRepo.create).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('does not send on silence without the commit phrase', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    render(<VoiceModal />);

    act(() => {
      emitVoice('voice:final', { text: 'So the idea is' });
      vi.advanceTimersByTime(5000);
    });

    expect(send).not.toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();

    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('submits a confirmed provider turn immediately in click-to-talk mode', async () => {
    useAuthStore.setState({ voiceAutoListenOnOpen: false, voiceSilenceDelayMs: 60_000 });
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      fireEvent.click(voicePanelRole('button', { name: /click to talk/i }));
      act(() => {
        emitVoice('voice:final', { text: 'What is two plus two?' });
        emitVoice('voice:turn-end');
        emitVoice('voice:turn-end');
      });
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(messageRepo.create).toHaveBeenCalledOnce();
      const detail = (send.mock.calls[0][0] as CustomEvent).detail;
      expect(detail.text).toBe('What is two plus two?');
      expect(detail.interactionMode).toBe('agent');
      expect(detail.localCommandContext).toContain(VOICE_BRIEF_SYSTEM_INSTRUCTION);
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('does not bypass hands-free commit phrase on provider turn end', async () => {
    render(<VoiceModal />);
    act(() => {
      emitVoice('voice:final', { text: 'Keep this as a draft' });
      emitVoice('voice:turn-end');
    });
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('submits a completed local fallback transcript in hands-free phrase mode', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    try {
      render(<VoiceModal />);
      act(() => {
        emitVoice('voice:final', { text: 'Summarize my notes' });
        emitVoice('voice:turn-end', { forceCommit: true });
        emitVoice('voice:turn-end', { forceCommit: true });
      });
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(messageRepo.create).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('jarvis:send', send as EventListener);
    }
  });

  it('preserves the configured hands-free pause on provider turn end', async () => {
    vi.useFakeTimers();
    useAuthStore.setState({ voiceEndTrigger: 'silence', voiceSilenceDelayMs: 60_000 });
    render(<VoiceModal />);
    act(() => {
      emitVoice('voice:final', { text: 'Wait for my configured pause' });
      emitVoice('voice:turn-end');
      vi.advanceTimersByTime(1_000);
    });
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('waits for resumed speech to finalize before starting a new silence interval', async () => {
    useAuthStore.setState({ voiceEndTrigger: 'silence', voiceSilenceDelayMs: 2000 });
    render(<VoiceModal />);
    await waitFor(() => expect(useVoiceStore.getState().session?.chatId).toBe('chat_voice'));
    vi.useFakeTimers();
    act(() => {
      emitVoice('voice:final', { text: 'Please add' });
      vi.advanceTimersByTime(1500);
      emitVoice('voice:partial', { text: 'milk to my list' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(messageRepo.create).not.toHaveBeenCalled();
    act(() => emitVoice('voice:final', { text: 'milk to my list' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(messageRepo.create).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(messageRepo.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        parts: [{ kind: 'text', text: 'Please add milk to my list' }],
      }),
    );
  });

  it('disables the listening timeout while send-it mode is active', async () => {
    render(<VoiceModal />);

    await waitFor(() => expect(VoiceService.setInactivityTimeoutMs).toHaveBeenCalledWith(null));
  });

  it('uses the one configured duration for hands-free pause mode', async () => {
    useAuthStore.setState({
      voiceEndTrigger: 'silence',
      voiceSilenceDelayMs: 60_000,
    });
    render(<VoiceModal />);

    await waitFor(() => expect(VoiceService.setInactivityTimeoutMs).toHaveBeenCalledWith(60_000));
  });

  it('sends exactly once when the commit phrase is spoken', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    render(<VoiceModal />);

    act(() => {
      emitVoice('voice:final', { text: 'help me plan' });
      emitVoice('voice:final', { text: 'send it' });
    });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(messageRepo.create).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as CustomEvent<{
      text: string;
      speakReply: boolean;
      autoApproveActions: boolean;
    }>;
    expect(event.detail.text).toBe('help me plan');
    expect(event.detail.speakReply).toBe(true);
    expect(event.detail.autoApproveActions).toBe(false);

    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('reports a precise templated save failure without sending or exposing the thrown detail', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    vi.mocked(messageRepo.create).mockRejectedValueOnce(
      new Error('synthetic storage implementation detail'),
    );

    render(<VoiceModal />);

    act(() => {
      emitVoice('voice:final', { text: 'failed message send it' });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const expectedFailure =
      'The action failed, sir. Action: Voice message. Cause: The local message could not be saved, so nothing was sent.';
    expect(messageRepo.create).toHaveBeenCalledOnce();
    expect(toastMocks.error).toHaveBeenCalledWith('Voice message failed', expectedFailure);
    expect(useVoiceStore.getState()).toMatchObject({
      state: 'error',
      errorMessage: expectedFailure,
    });
    expect(useVoiceStore.getState().errorMessage).not.toContain(
      'synthetic storage implementation detail',
    );
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(toastMocks.error.mock.calls)).not.toContain(
      'synthetic storage implementation detail',
    );

    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('accepts another task once worker launch is confirmed', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    render(<VoiceModal />);

    await act(async () => {
      emitVoice('voice:final', { text: 'first message send it' });
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);

    act(() => {
      emitVoice('voice:final', { text: 'interrupt send it' });
    });
    await act(async () => Promise.resolve());
    expect(send).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    await act(async () => {
      emitVoice('voice:final', { text: 'second message send it' });
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(3);

    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('clears the draft on cancel phrase without sending', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);

    render(<VoiceModal />);

    act(() => {
      emitVoice('voice:final', { text: 'never mind' });
      emitVoice('voice:final', { text: 'cancel' });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(send).not.toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().partialTranscript).toBe('');

    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('releases the active turn immediately after the user stops speech', async () => {
    const send = vi.fn();
    window.addEventListener('jarvis:send', send as EventListener);
    render(<VoiceModal />);

    act(() => window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT)));
    fireEvent.click(voicePanelRole('button', { name: /Stop response/i }));
    act(() => emitVoice('voice:final', { text: 'new request send it' }));

    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledOnce();
    window.removeEventListener('jarvis:send', send as EventListener);
  });
});
