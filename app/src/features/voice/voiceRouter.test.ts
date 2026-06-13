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
  VOICE_PREVIEW_TEXT: 'preview phrase',
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

vi.mock('./providers/kokoroLocal', () => ({
  kokoroLocalProvider: {
    isAvailable: vi.fn(async () => false),
    stop: vi.fn(),
    warmup: vi.fn(async () => {}),
  },
}));

vi.mock('./modelManager', () => ({
  ModelManager: {
    ensureKokoroReady: vi.fn(async () => false),
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
    }),
  },
}));

import {
  cancelVoicePreview,
  previewVoiceWithSettings,
  registerActiveStreamingVoiceSession,
  speakWithSettings,
  stopAllVoiceOutput,
} from './voiceRouter';

describe('voiceRouter preview cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceModalOpen = true;
    useAuthStore.setState({ voiceEngine: 'system', voicePreset: 'jarvis-prime' });
    registerActiveStreamingVoiceSession(null);
  });

  afterEach(() => {
    registerActiveStreamingVoiceSession(null);
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
});

describe('voice module gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceModalOpen = true;
    useAuthStore.setState({ voiceEngine: 'system', voicePreset: 'jarvis-prime' });
  });

  it('speakWithSettings does nothing when the voice module is closed', async () => {
    voiceModalOpen = false;
    await speakWithSettings('Hello from Jarvis.');
    expect(h.speakText).not.toHaveBeenCalled();
  });

  it('speakWithSettings runs when the voice module is open', async () => {
    voiceModalOpen = true;
    h.speakText.mockResolvedValue(undefined);
    await speakWithSettings('Hello from Jarvis.');
    expect(h.speakText).toHaveBeenCalledTimes(1);
  });
});
