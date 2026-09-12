import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';

const h = vi.hoisted(() => {
  let speakResolve: (() => void) | null = null;
  return {
    haltPlayback: vi.fn(),
    speakText: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          speakResolve = resolve;
        }),
    ),
    stopSpeech: vi.fn(),
    testVoice: vi.fn(async () => {}),
    ttsStop: vi.fn(),
    endSession: vi.fn(),
    requestCancellation: vi.fn(async () => ({ kind: 'authority_revoked_before_intent' as const })),
    ensureJarvisReady: vi.fn(async () => false),
    resolveSpeak() {
      const resolve = speakResolve;
      speakResolve = null;
      resolve?.();
    },
  };
});

vi.mock('./speechSynthesis', () => ({
  isSpeechSynthesisSupported: () => true,
  speakText: h.speakText,
  stopSpeech: h.stopSpeech,
  VOICE_PREVIEW_TEXT: 'Hi, what should we get to work on?',
  preloadSpeechVoices: vi.fn(async () => {}),
}));

vi.mock('./TtsService', () => ({
  TtsService: {
    setProvider: vi.fn(),
    setVoicePreset: vi.fn(),
    testVoice: h.testVoice,
    stop: h.ttsStop,
    warmup: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
  },
}));

vi.mock('./providers/deepgramTts', () => ({
  deepgramTtsProvider: { isAvailable: vi.fn(async () => false) },
}));

vi.mock('./providers/jarvisHighLocal', () => ({
  jarvisHighLocalProvider: {
    isAvailable: vi.fn(async () => false),
    stop: vi.fn(),
    warmup: vi.fn(async () => {}),
  },
}));

vi.mock('./modelManager', () => ({
  ModelManager: {
    ensureJarvisReady: h.ensureJarvisReady,
    status: vi.fn(async () => ({ ready: false })),
  },
}));

vi.mock('./audioPlayback', () => ({
  playBase64Audio: vi.fn(async () => () => {}),
}));

let voiceModalOpen = true;

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({
      voiceModalOpen,
      setVoiceListening: vi.fn(),
    }),
  },
}));

vi.mock('./VoiceService', () => ({
  VoiceService: { stopListening: vi.fn() },
}));

vi.mock('./store', () => ({
  useVoiceStore: {
    getState: () => ({
      setState: vi.fn(),
      setPartialTranscript: vi.fn(),
      endSession: h.endSession,
    }),
  },
}));

import {
  cancelVoicePreview,
  handleVoiceModuleClosed,
  previewVoiceWithSettings,
  registerActiveStreamingVoiceSession,
  registerActiveVoiceTurnCancellation,
  speakWithSettings,
  stopAllVoiceOutput,
  stopCurrentVoiceResponse,
  syncVoiceModuleOpenState,
} from './voiceRouter';

describe('voiceRouter preview cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceModalOpen = true;
    useAuthStore.setState({ voiceEngine: 'system', voicePreset: 'jarvis-prime' });
    registerActiveStreamingVoiceSession(null);
    registerActiveVoiceTurnCancellation(null);
    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      value: vi.fn(function MockAudio(
        this: {
          src: string;
          play: () => Promise<void>;
          pause: () => void;
          addEventListener: (name: string, callback: () => void) => void;
        },
        src: string,
      ) {
        this.src = src;
        this.play = vi.fn(async () => {});
        this.pause = vi.fn();
        this.addEventListener = vi.fn();
      }),
    });
  });

  afterEach(() => {
    registerActiveStreamingVoiceSession(null);
    registerActiveVoiceTurnCancellation(null);
    stopAllVoiceOutput();
  });

  it('cancelVoicePreview stops playback without halting an active streaming session', () => {
    registerActiveStreamingVoiceSession({ haltPlayback: h.haltPlayback } as never);
    cancelVoicePreview();
    expect(h.haltPlayback).not.toHaveBeenCalled();
    expect(h.stopSpeech).toHaveBeenCalled();
  });

  it('cancelVoicePreview invalidates an in-flight system preview', async () => {
    const pending = previewVoiceWithSettings('jarvis-prime', 'system');
    await Promise.resolve();
    expect(h.speakText).toHaveBeenCalledTimes(1);

    cancelVoicePreview();
    h.resolveSpeak();
    await pending;

    expect(h.stopSpeech).toHaveBeenCalled();
  });

  it('starting a new preview stops prior preview playback', async () => {
    h.speakText.mockResolvedValue(undefined);

    await previewVoiceWithSettings('jarvis-prime', 'system');
    const stopCallsAfterFirst = h.stopSpeech.mock.calls.length;

    await previewVoiceWithSettings('aurora', 'system');

    expect(h.speakText).toHaveBeenCalledTimes(2);
    expect(h.stopSpeech.mock.calls.length).toBeGreaterThan(stopCallsAfterFirst);
  });

  it('plays the bundled exact-script Jarvis preview without model or cloud access', async () => {
    await previewVoiceWithSettings('jarvis-prime', 'jarvis');

    expect(Audio).toHaveBeenCalledWith('/voice/jarvis-high-preview.mp3');
    expect(h.ensureJarvisReady).not.toHaveBeenCalled();
    expect(h.testVoice).not.toHaveBeenCalled();
    expect(h.speakText).not.toHaveBeenCalled();
  });

  it('previews Friday through the operating-system fallback with the exact script', async () => {
    h.speakText.mockResolvedValue(undefined);

    await previewVoiceWithSettings('aurora', 'jarvis');

    expect(h.speakText).toHaveBeenCalledWith('Hi, what should we get to work on?', {
      voicePreset: 'aurora',
      engine: 'local',
    });
    expect(h.ensureJarvisReady).not.toHaveBeenCalled();
  });
});

describe('voice module gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceModalOpen = true;
    syncVoiceModuleOpenState(false);
    syncVoiceModuleOpenState(true);
    useAuthStore.setState({
      voiceEngine: 'system',
      voicePreset: 'jarvis-prime',
      speakReplies: false,
    });
  });

  it('speakWithSettings does nothing when the voice module is closed', async () => {
    voiceModalOpen = false;
    syncVoiceModuleOpenState(false);
    await speakWithSettings('Hello from Jarvis.');
    expect(h.speakText).not.toHaveBeenCalled();
  });

  it('speakWithSettings runs in the background when allowBackground is set', async () => {
    voiceModalOpen = false;
    syncVoiceModuleOpenState(false);
    h.speakText.mockResolvedValue(undefined);
    await speakWithSettings('Hello from Jarvis.', { allowBackground: true });
    expect(h.speakText).toHaveBeenCalledTimes(1);
  });

  it('speakWithSettings runs when the voice module is open', async () => {
    voiceModalOpen = true;
    syncVoiceModuleOpenState(true);
    h.speakText.mockResolvedValue(undefined);
    await speakWithSettings('Hello from Jarvis.');
    expect(h.speakText).toHaveBeenCalledTimes(1);
  });

  it('speakWithSettings runs for chat replies when speakReplies is on and the panel is closed', async () => {
    voiceModalOpen = false;
    syncVoiceModuleOpenState(false);
    useAuthStore.setState({ speakReplies: true });
    h.speakText.mockResolvedValue(undefined);
    await speakWithSettings('Hello from Jarvis.');
    expect(h.speakText).toHaveBeenCalledTimes(1);
  });

  it('routes Jarvis output through Jarvis High even when Settings still lists another engine', async () => {
    voiceModalOpen = true;
    syncVoiceModuleOpenState(true);
    useAuthStore.setState({
      voiceEngine: 'system',
      voicePreset: 'jarvis-prime',
      speakReplies: false,
    });
    h.speakText.mockResolvedValue(undefined);
    await speakWithSettings('Hello from Jarvis.');
    expect(h.ensureJarvisReady).toHaveBeenCalled();
    expect(h.speakText).toHaveBeenCalledTimes(1);
  });
});

describe('voice module lifecycle', () => {
  beforeEach(() => {
    registerActiveVoiceTurnCancellation(null);
    vi.clearAllMocks();
    voiceModalOpen = true;
    syncVoiceModuleOpenState(true);
    registerActiveStreamingVoiceSession(null);
    useAuthStore.setState({ speakReplies: false });
  });

  afterEach(async () => {
    registerActiveStreamingVoiceSession(null);
    registerActiveVoiceTurnCancellation(null);
    syncVoiceModuleOpenState(false);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('handleVoiceModuleClosed requests canonical cancellation before ending the session', async () => {
    const cancel = vi.fn();
    window.addEventListener('jarvis:cancel', cancel);
    registerActiveStreamingVoiceSession({ haltPlayback: h.haltPlayback } as never);
    registerActiveVoiceTurnCancellation({ requestCancellation: h.requestCancellation });

    handleVoiceModuleClosed();
    await vi.waitFor(() => {
      expect(h.requestCancellation).toHaveBeenCalledOnce();
      expect(h.endSession).toHaveBeenCalledOnce();
    });

    expect(h.haltPlayback).toHaveBeenCalled();
    expect(h.stopSpeech).toHaveBeenCalled();
    expect(h.requestCancellation.mock.invocationCallOrder[0]).toBeLessThan(
      h.endSession.mock.invocationCallOrder[0]!,
    );
    expect(cancel).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:cancel', cancel);
  });

  it('stopCurrentVoiceResponse uses only the registered process-local handle', async () => {
    const cancel = vi.fn();
    window.addEventListener('jarvis:cancel', cancel);
    const release = registerActiveVoiceTurnCancellation({
      requestCancellation: h.requestCancellation,
    });

    await expect(stopCurrentVoiceResponse()).resolves.toEqual({
      kind: 'authority_revoked_before_intent',
    });
    expect(h.requestCancellation).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();

    release();
    await expect(stopCurrentVoiceResponse()).resolves.toBeUndefined();
    expect(h.requestCancellation).toHaveBeenCalledOnce();
    window.removeEventListener('jarvis:cancel', cancel);
  });

  it('blocks speakWithSettings after the module closes even if UI flag lags', async () => {
    voiceModalOpen = true;
    h.speakText.mockResolvedValue(undefined);
    await speakWithSettings('First line.');
    expect(h.speakText).toHaveBeenCalledTimes(1);

    handleVoiceModuleClosed();
    h.speakText.mockClear();
    voiceModalOpen = true;
    await speakWithSettings('Should not play.');
    expect(h.speakText).not.toHaveBeenCalled();
  });
});
