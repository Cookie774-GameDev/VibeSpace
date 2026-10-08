import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  speakReplies: true,
  synthesisFails: false,
  invocationCount: 0,
  forbiddenCalls: [] as string[],
}));
const forbidden = (name: string) => {
  fixture.forbiddenCalls.push(name);
  throw new Error(`forbidden_fixture_port:${name}`);
};
vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      voiceEngine: 'jarvis',
      voicePreset: 'jarvis-prime',
      speakReplies: fixture.speakReplies,
    }),
  },
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ voiceModalOpen: false, setVoiceListening: vi.fn() }) },
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@/features/voice/providers/jarvisHighLocal', () => ({
  jarvisHighLocalProvider: {
    isAvailable: vi.fn(async () => true),
    stop: vi.fn(),
    warmup: vi.fn(async () => undefined),
  },
}));
vi.mock('@/features/voice/providers/deepgramTts', () => ({
  deepgramTtsProvider: { isAvailable: vi.fn(async () => false) },
}));
vi.mock('@/features/voice/modelManager', () => ({
  ModelManager: { ensureJarvisReady: () => forbidden('model_setup') },
}));
vi.mock('@/features/voice/TtsService', () => ({
  TtsService: {
    stop: vi.fn(),
    setProvider: vi.fn(),
    setVoicePreset: vi.fn(),
    speak: () => forbidden('cloud_tts'),
    warmup: () => forbidden('tts_warmup'),
    testVoice: () => forbidden('tts_preview'),
  },
}));
vi.mock('@/features/voice/VoiceService', () => ({
  VoiceService: { stopListening: vi.fn(), startListening: () => forbidden('microphone') },
}));
vi.mock('@/features/voice/store', () => ({
  useVoiceStore: {
    getState: () => ({
      session: null,
      setState: vi.fn(),
      setPartialTranscript: vi.fn(),
      endSession: vi.fn(),
    }),
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command !== 'jarvis_voice_speak') return forbidden(`native:${command}`);
    fixture.invocationCount += 1;
    if (fixture.synthesisFails) throw new Error('synthetic_synthesis_failure');
    return { audio: 'AA==', mime: 'audio/wav' };
  },
}));

type AudioMode = 'ended' | 'error' | 'reject' | 'pending';
let mode: AudioMode;
let instances: SyntheticAudio[];
let activeController: { dispose(): void } | null;
class SyntheticAudio extends EventTarget {
  src: string;
  volume = 1;
  paused = false;
  ended = false;
  error: { code: number; message: string } | null = null;
  constructor(src: string) {
    super();
    this.src = src;
    instances.push(this);
  }
  pause() {
    this.paused = true;
  }
  play(): Promise<void> {
    if (mode === 'reject') return Promise.reject(new Error('synthetic_play_rejection'));
    if (mode !== 'pending')
      queueMicrotask(() => {
        if (mode === 'ended') this.ended = true;
        else this.error = { code: 3, message: 'synthetic_decode_failure' };
        this.dispatchEvent(new Event(mode));
      });
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  fixture.speakReplies = true;
  fixture.synthesisFails = false;
  fixture.invocationCount = 0;
  fixture.forbiddenCalls = [];
  mode = 'ended';
  instances = [];
  activeController = null;
  vi.stubGlobal('Audio', SyntheticAudio);
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('SpeechSynthesisUtterance', undefined);
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  vi.stubGlobal('fetch', () => forbidden('fetch'));
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        forbidden('websocket');
      }
    },
  );
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      constructor() {
        forbidden('xhr');
      }
    },
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => forbidden('microphone') },
  });
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-voice-fixture');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  activeController?.dispose();
  expect(fixture.forbiddenCalls).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function prepare() {
  const { createCanonicalVoicePlaybackAdapter } = await import('./streamingVoice');
  const controller = createCanonicalVoicePlaybackAdapter().prepare({
    accountId: 'synthetic-account',
    runId: 'synthetic-run',
    requestId: 'synthetic-request',
    attemptNumber: 1,
    spokenText: 'The fixture is ready.',
  });
  expect(controller).not.toBeNull();
  activeController = controller;
  return controller!;
}

describe('actual Jarvis playback to canonical outcome, synthetic external ports only', () => {
  it('natural media ended yields verified canonical completed', async () => {
    const controller = await prepare();
    const result = await controller.start();
    expect(instances).toHaveLength(1);
    expect(instances[0].ended).toBe(true);
    expect(result.terminalStatus).toBe('completed');
    expect(result.playback.state).toBe('completed');
    expect(controller.verify(result)).toBe(true);
    expect(controller.verify({ ...result })).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it.each(['error', 'reject'] as const)(
    '%s must not become canonical completed when no fallback engine exists',
    async (failure) => {
      mode = failure;
      const controller = await prepare();
      const result = await controller.start();
      expect(instances).toHaveLength(1);
      expect(instances[0].ended).toBe(false);
      expect(fixture.invocationCount).toBe(1);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        terminalStatus: 'partial',
        playback: { state: 'degraded', reason: 'failed' },
      });
    },
  );
  it('synthesis rejection with unavailable real speech fallback already yields failed, not success', async () => {
    fixture.synthesisFails = true;
    const controller = await prepare();
    const result = await controller.start();
    expect(instances).toHaveLength(0);
    expect(fixture.invocationCount).toBe(1);
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'failed' },
    });
  });
  it('abort after actual playback admission yields stopped with one cleanup', async () => {
    mode = 'pending';
    const controller = await prepare();
    const resultPromise = controller.start();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(controller.abort()).toBe('signal_delivered');
    const result = await resultPromise;
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'stopped' },
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('unavailable owner does not admit synthesis or playback', async () => {
    fixture.speakReplies = false;
    const controller = await prepare();
    const result = await controller.start();
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'unavailable' },
    });
    expect(fixture.invocationCount).toBe(0);
    expect(instances).toHaveLength(0);
  });
  it('retains the stop callback and exactly-once cleanup after natural media completion', async () => {
    const { playBase64Audio } = await import('./audioPlayback');
    const cleanup = await playBase64Audio('AA==', 'audio/wav');
    expect(typeof cleanup).toBe('function');
    expect(instances[0].ended).toBe(true);
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('uses the existing installed-voice fallback after failed media and completes only after fallback end', async () => {
    mode = 'error';
    const fallback = installSyntheticSpeech('ended');
    const controller = await prepare();
    const result = await controller.start();
    expect(instances).toHaveLength(1);
    expect(instances[0].ended).toBe(false);
    expect(fallback.spoken).toHaveLength(1);
    expect(fallback.ended).toBe(1);
    expect(result).toMatchObject({ terminalStatus: 'completed', playback: { state: 'completed' } });
  });
  it('propagates failed existing local and system fallbacks to canonical failed', async () => {
    mode = 'reject';
    const fallback = installSyntheticSpeech('error');
    const controller = await prepare();
    const result = await controller.start();
    expect(fallback.spoken).toHaveLength(2);
    expect(fallback.ended).toBe(0);
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'failed' },
    });
  });
  it('does not start an installed-voice fallback when abort wins during media playback', async () => {
    mode = 'pending';
    const fallback = installSyntheticSpeech('ended');
    const controller = await prepare();
    const pending = controller.start();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(controller.abort()).toBe('signal_delivered');
    instances[0].dispatchEvent(new Event('error'));
    expect(await pending).toMatchObject({
      terminalStatus: 'partial',
      playback: { reason: 'stopped' },
    });
    expect(fallback.spoken).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});

function installSyntheticSpeech(outcome: 'ended' | 'error') {
  const state = { spoken: [] as SyntheticUtterance[], ended: 0 };
  class SyntheticUtterance {
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    constructor(readonly text: string) {}
  }
  vi.stubGlobal('SpeechSynthesisUtterance', SyntheticUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(),
      resume: vi.fn(),
      speaking: false,
      pending: false,
      getVoices: () => [
        {
          name: 'David',
          voiceURI: 'synthetic-local',
          lang: 'en-US',
          localService: true,
          default: true,
        },
      ],
      speak: (utterance: SyntheticUtterance) => {
        state.spoken.push(utterance);
        queueMicrotask(() => {
          if (outcome === 'ended') {
            state.ended += 1;
            utterance.onend?.();
          } else utterance.onerror?.({ error: 'synthetic_speech_failure' });
        });
      },
    },
  });
  return state;
}
