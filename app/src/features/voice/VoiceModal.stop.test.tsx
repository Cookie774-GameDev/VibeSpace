import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';

type VoiceHandler = (payload?: unknown) => void;

const voiceMockState = vi.hoisted(() => ({
  handlers: new Map<string, Set<VoiceHandler>>(),
  listening: false,
}));

const routerMocks = vi.hoisted(() => ({
  handleVoiceModuleClosed: vi.fn(),
  syncVoiceModuleOpenState: vi.fn(),
  stopCurrentVoiceResponse: vi.fn(),
}));

vi.mock('./JarvisVoiceInputService', () => ({
  JarvisVoiceInputService: {
    isSupported: () => true,
    isListening: () => voiceMockState.listening,
    wantsListening: () => false,
    setInactivityTimeoutMs: vi.fn(),
    startListening: vi.fn(() => {
      voiceMockState.listening = true;
      return true;
    }),
    stopListening: vi.fn(() => {
      voiceMockState.listening = false;
    }),
    cancelListening: vi.fn(() => {
      voiceMockState.listening = false;
    }),
    on: (event: string, fn: VoiceHandler) => {
      let set = voiceMockState.handlers.get(event);
      if (!set) {
        set = new Set();
        voiceMockState.handlers.set(event, set);
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

vi.mock('./voiceRouter', () => routerMocks);

import { VoiceModal } from './VoiceModal';
import { JarvisVoiceInputService as VoiceService } from './JarvisVoiceInputService';
import { useVoiceStore } from './store';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { GROQ_DEFAULT_MODEL } from '@/lib/ai/providers/groq';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';
import { createVoiceSessionBinding } from './voiceSessionBinding';
import type { ChatId } from '@/types/common';
import { messageRepo } from '@/lib/db';

function emitVoice(event: string, payload?: unknown) {
  voiceMockState.handlers.get(event)?.forEach((fn) => fn(payload));
}

function voicePanelRole(...[role, options]: Parameters<typeof screen.getByRole>) {
  const panel = document.getElementById('jarvis-panel');
  if (!panel) throw new Error('voice panel lifecycle mount missing');
  return within(panel).getByRole(role, { ...options, hidden: true });
}

function setupAuth(handsFree: boolean) {
  useAuthStore.setState({
    voiceAutoListenOnOpen: handsFree,
    voiceEndTrigger: 'phrase',
    voiceCommitPhrase: 'send it',
    voiceCancelPhrase: 'cancel',
    voiceSilenceDelayMs: 2000,
    voiceAutoApproveActions: true,
    apiKeys: { groq: 'gsk_test' },
    stackCustomSteps: DEFAULT_CUSTOM_STEPS,
    chatModelSelection: selectionFromOption('groq', GROQ_DEFAULT_MODEL),
  });
}

describe('VoiceModal stop control and mic recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceMockState.handlers.clear();
    voiceMockState.listening = false;
    useUIStore.setState({
      voiceModalOpen: true,
      voiceListening: false,
      activeChatId: 'chat_voice',
    });
    useVoiceStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows pending capture without claiming listening until the real capture opens', () => {
    setupAuth(true);
    vi.mocked(VoiceService.startListening).mockImplementationOnce(() => true);
    render(<VoiceModal />);
    expect(useUIStore.getState().voiceListening).toBe(false);
    expect(useVoiceStore.getState().state).toBe('idle');
    expect(screen.getByText('Waiting for microphone')).toBeTruthy();
    expect(voicePanelRole('button', { name: 'Cancel microphone request' })).toBeTruthy();
    act(() => {
      voiceMockState.listening = true;
      emitVoice('voice:start');
    });
    expect(useUIStore.getState().voiceListening).toBe(true);
    expect(useVoiceStore.getState().state).toBe('listening');
  });

  it('cancels a pending microphone request without accepting a late capture start', () => {
    setupAuth(true);
    vi.mocked(VoiceService.startListening).mockImplementationOnce(() => true);
    render(<VoiceModal />);
    fireEvent.click(voicePanelRole('button', { name: 'Cancel microphone request' }));
    expect(VoiceService.cancelListening).toHaveBeenCalledOnce();
    act(() => emitVoice('voice:start'));
    expect(useUIStore.getState().voiceListening).toBe(false);
    expect(useVoiceStore.getState().state).toBe('paused');
  });

  it('rejects delayed audio-start events after a response was explicitly stopped', () => {
    setupAuth(false);
    render(<VoiceModal />);
    act(() => window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT)));
    fireEvent.click(voicePanelRole('button', { name: /Stop response/i }));
    expect(useVoiceStore.getState().state).toBe('idle');
    act(() => {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_START_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
    });
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('clicking the orb while Jarvis speaks stops the response and resumes listening (hands-free)', async () => {
    setupAuth(true);
    render(<VoiceModal />);

    act(() => {
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
    });
    expect(useVoiceStore.getState().state).toBe('speaking');

    const stop = voicePanelRole('button', { name: /Stop response/i });
    expect(stop.getAttribute('data-sik-evidence')).toBeNull();
    fireEvent.click(stop);

    expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().state).toBe('listening');
  });

  it('clicking the orb while Jarvis is thinking cancels before the first response token', () => {
    setupAuth(false);
    render(<VoiceModal />);

    act(() => useVoiceStore.getState().setState('thinking'));

    const stop = voicePanelRole('button', { name: /Stop response/i });
    expect(VoiceService.startListening).not.toHaveBeenCalled();
    fireEvent.click(stop);

    expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledTimes(1);
    expect(VoiceService.startListening).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('delegates bound-run cancellation before closing the voice UI', () => {
    setupAuth(false);
    useVoiceStore.getState().beginSession(
      createVoiceSessionBinding({
        sessionId: 'vsession-test',
        accountId: 'account-test',
        chatId: 'chat_voice' as ChatId,
        startedAt: 1,
      }),
    );
    useVoiceStore.getState().setSessionRun('run-voice');
    routerMocks.handleVoiceModuleClosed.mockImplementationOnce(() => {
      expect(useUIStore.getState().voiceModalOpen).toBe(true);
      expect(useVoiceStore.getState().session?.activeRunId).toBe('run-voice');
    });
    render(<VoiceModal />);

    fireEvent.click(voicePanelRole('button', { name: /Close Jarvis voice session/i }));

    expect(routerMocks.handleVoiceModuleClosed).toHaveBeenCalled();
    expect(useUIStore.getState().voiceModalOpen).toBe(false);
  });

  it('clicking the orb while Jarvis speaks stops the response and goes idle (push-to-talk)', async () => {
    setupAuth(false);
    render(<VoiceModal />);

    act(() => {
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
    });
    expect(useVoiceStore.getState().state).toBe('speaking');

    fireEvent.click(voicePanelRole('button', { name: /Stop response/i }));

    expect(routerMocks.stopCurrentVoiceResponse).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().state).toBe('idle');
  });

  it('hands-free listen timeout shows a visible paused state instead of a silent shutoff', async () => {
    setupAuth(true);
    render(<VoiceModal />);
    expect(useVoiceStore.getState().state).toBe('listening');

    act(() => {
      emitVoice('voice:timeout');
    });

    expect(useVoiceStore.getState().state).toBe('paused');
    expect(screen.getByText(/Paused — click the orb to resume/i)).toBeTruthy();
    expect(voicePanelRole('button', { name: /Resume listening/i })).toBeTruthy();
  });

  it('lets the user mute hands-free listening and rejects late transcript or restart events', () => {
    vi.useFakeTimers();
    setupAuth(true);
    useAuthStore.setState({ voiceEndTrigger: 'silence' });
    render(<VoiceModal />);
    expect(VoiceService.startListening).toHaveBeenCalledTimes(1);

    act(() => {
      emitVoice('voice:partial', { text: 'queued private transcript' });
      emitVoice('voice:final', { text: 'do not send this' });
    });

    fireEvent.click(voicePanelRole('button', { name: /Stop listening/i }));

    expect(VoiceService.cancelListening).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().voiceListening).toBe(false);
    expect(useVoiceStore.getState().state).toBe('paused');
    expect(voicePanelRole('button', { name: /Resume listening/i })).toBeTruthy();

    act(() => {
      emitVoice('voice:start');
      emitVoice('voice:partial', { text: 'late private transcript' });
      emitVoice('voice:final', { text: 'late private transcript' });
      emitVoice('voice:error', { kind: 'aborted', message: 'late abort' });
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
      vi.advanceTimersByTime(2000);
    });

    expect(useVoiceStore.getState().partialTranscript).toBe('');
    expect(useVoiceStore.getState().finalTranscript.map(({ text }) => text)).toEqual([
      'do not send this',
    ]);
    expect(useVoiceStore.getState().state).toBe('paused');
    expect(VoiceService.startListening).toHaveBeenCalledTimes(1);
    expect(messageRepo.create).not.toHaveBeenCalled();

    fireEvent.click(voicePanelRole('button', { name: /Resume listening/i }));
    expect(VoiceService.startListening).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().state).toBe('listening');
  });

  it('clicking the paused orb resumes listening', async () => {
    setupAuth(true);
    render(<VoiceModal />);
    act(() => {
      emitVoice('voice:timeout');
    });
    expect(useVoiceStore.getState().state).toBe('paused');

    fireEvent.click(voicePanelRole('button', { name: /Resume listening/i }));

    expect(useVoiceStore.getState().state).toBe('listening');
  });

  it('re-arms the push-to-talk mic after an external voice preview interrupts it', async () => {
    vi.useFakeTimers();
    setupAuth(false);
    render(<VoiceModal />);

    // User clicks to talk (push-to-talk).
    fireEvent.click(voicePanelRole('button', { name: /Click to talk/i }));
    expect(useVoiceStore.getState().state).toBe('listening');
    expect(VoiceService.startListening).toHaveBeenCalledTimes(1);

    // A Settings voice preview starts speaking - the modal parks the mic.
    act(() => {
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
    });
    expect(useVoiceStore.getState().state).toBe('speaking');

    // Preview ends - after the cooldown, the mic must come back on its own.
    act(() => {
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
      vi.advanceTimersByTime(2000);
    });

    expect(VoiceService.startListening).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().state).toBe('listening');
  });

  it('ignores late completion events after an explicit hands-free stop', async () => {
    vi.useFakeTimers();
    setupAuth(true);
    render(<VoiceModal />);
    act(() => window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT)));
    fireEvent.click(voicePanelRole('button', { name: /Stop response/i }));
    expect(VoiceService.startListening).toHaveBeenCalledTimes(2);

    voiceMockState.listening = false;
    act(() => {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
      vi.advanceTimersByTime(2000);
    });

    expect(VoiceService.startListening).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().state).toBe('listening');
  });
});
