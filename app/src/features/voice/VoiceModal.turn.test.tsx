import * as React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { STREAMING_VOICE_END_EVENT } from './speechSynthesis';

type VoiceHandler = (payload?: unknown) => void;

const voiceListeners = vi.hoisted(() => ({
  handlers: new Map<string, Set<VoiceHandler>>(),
}));

vi.mock('./VoiceService', () => ({
  VoiceService: {
    isSupported: () => true,
    isListening: () => false,
    wantsListening: () => false,
    setInactivityTimeoutMs: vi.fn(),
    startListening: vi.fn(() => true),
    stopListening: vi.fn(),
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
  useMotionValue: () => ({ get: () => 0, set: vi.fn() }),
}));

vi.mock('@/features/chat/hooks', () => ({
  useChatMessages: () => [],
}));

vi.mock('@/lib/db', () => ({
  messageRepo: {
    create: vi.fn(async () => ({})),
  },
}));

vi.mock('./voiceChatRouting', () => ({
  ensureJarvisChatForVoice: vi.fn(async () => 'chat_voice'),
  focusVoiceChat: vi.fn(),
  resolveVoiceChatTarget: vi.fn(async (text: string) => ({
    chatId: 'chat_voice',
    messageText: text,
    agentId: 'agent_jarvis',
    mentionedAgentIds: [],
  })),
}));

vi.mock('./voiceRouter', () => ({
  handleVoiceModuleClosed: vi.fn(),
}));

import { VoiceModal } from './VoiceModal';
import { messageRepo } from '@/lib/db';
import { useVoiceStore } from './store';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';

function emitVoice(event: string, payload?: unknown) {
  voiceListeners.handlers.get(event)?.forEach((fn) => fn(payload));
}

describe('VoiceModal hands-free turn-taking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceListeners.handlers.clear();
    useUIStore.setState({
      voiceModalOpen: true,
      voiceListening: false,
      activeChatId: 'chat_voice',
    });
    useAuthStore.setState({
      voiceAutoListenOnOpen: true,
      voiceEndTrigger: 'phrase',
      voiceCommitPhrase: 'send it',
      voiceCancelPhrase: 'cancel',
      voiceSilenceDelayMs: 2000,
      voiceAutoApproveActions: true,
      apiKeys: { mock: 'mock-skip-sentinel' },
      stackCustomSteps: DEFAULT_CUSTOM_STEPS,
      chatModelSelection: selectionFromOption('mock', 'mock-default'),
    });
    useVoiceStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const event = send.mock.calls[0]?.[0] as CustomEvent<{ text: string; speakReply: boolean }>;
    expect(event.detail.text).toBe('help me plan');
    expect(event.detail.speakReply).toBe(true);

    window.removeEventListener('jarvis:send', send as EventListener);
  });

  it('blocks a second send until Jarvis finishes the current turn', async () => {
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
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    await act(async () => {
      emitVoice('voice:final', { text: 'second message send it' });
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(2);

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
});
