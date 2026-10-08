import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  canSpeak: true,
  providers: [] as string[],
  forbidden: [] as string[],
}));
const denied = (name: string) => {
  h.forbidden.push(name);
  throw new Error(`forbidden_fixture_port:${name}`);
};
vi.mock('@/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      voiceEngine: 'deepgram',
      voicePreset: 'jarvis-prime',
      speakReplies: h.canSpeak,
    }),
  },
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ voiceModalOpen: false, setVoiceListening: vi.fn() }) },
}));
vi.mock('@/components/ui/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@/features/voice/providers/deepgramTts', () => ({
  deepgramTtsProvider: {
    id: 'deepgram_tts',
    isAvailable: async () => true,
    stop: vi.fn(),
    speakChunk: async () => {
      h.providers.push('deepgram');
      throw new Error('synthetic_provider_failure');
    },
  },
}));
vi.mock('@/features/voice/providers/jarvisHighLocal', () => ({
  jarvisHighLocalProvider: {
    id: 'jarvis_local',
    isAvailable: async () => true,
    stop: vi.fn(),
    warmup: vi.fn(async () => undefined),
    speakChunk: async () => {
      h.providers.push('jarvis');
      throw new Error('synthetic_provider_failure');
    },
  },
}));
vi.mock('@/features/voice/providers/cloudTts', () => ({
  openaiTtsProvider: {
    isAvailable: async () => false,
    stop: vi.fn(),
    speakChunk: () => denied('openai_tts'),
  },
  elevenlabsTtsProvider: {
    isAvailable: async () => false,
    stop: vi.fn(),
    speakChunk: () => denied('elevenlabs_tts'),
  },
}));
vi.mock('@/features/voice/modelManager', () => ({
  ModelManager: { ensureJarvisReady: () => denied('model_setup') },
}));
vi.mock('@/features/voice/VoiceService', () => ({
  VoiceService: { stopListening: vi.fn(), startListening: () => denied('microphone') },
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
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => denied('native') }));
let speechOutcome: 'ended' | 'error' | 'pending';
let pendingUtterance: SyntheticUtterance | null;
let speechCalls: number;
let speechEnds: number;
let controller: { dispose(): void; abort(): string } | null;
class SyntheticUtterance {
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}
beforeEach(() => {
  vi.resetModules();
  h.canSpeak = true;
  h.providers = [];
  h.forbidden = [];
  speechOutcome = 'error';
  pendingUtterance = null;
  speechCalls = 0;
  speechEnds = 0;
  controller = null;
  vi.stubGlobal('fetch', () => denied('fetch'));
  vi.stubGlobal(
    'Audio',
    class {
      constructor() {
        denied('unexpected_media');
      }
    },
  );
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        denied('websocket');
      }
    },
  );
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      constructor() {
        denied('xhr');
      }
    },
  );
  vi.stubGlobal('SpeechSynthesisUtterance', SyntheticUtterance);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => denied('microphone') },
  });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(() => {
        const pending = pendingUtterance;
        pendingUtterance = null;
        pending?.onerror?.({ error: 'canceled' });
      }),
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
        speechCalls += 1;
        if (speechOutcome === 'pending') {
          pendingUtterance = utterance;
          return;
        }
        queueMicrotask(() => {
          if (speechOutcome === 'ended') {
            speechEnds += 1;
            utterance.onend?.();
          } else utterance.onerror?.({ error: 'synthetic_speech_failure' });
        });
      },
    },
  });
});
afterEach(() => {
  controller?.dispose();
  expect(h.forbidden).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function run(_name: string) {
  const { TtsService } = await import('@/features/voice/TtsService');
  const { FALLBACK_MESSAGES } = await import('@/features/voice/voicePlans');
  const { createCanonicalVoicePlaybackAdapter } = await import('@/features/voice/streamingVoice');
  const notices: string[] = [];
  const dispose = TtsService.onNotice((text) => notices.push(text));
  const prepared = createCanonicalVoicePlaybackAdapter().prepare({
    accountId: 'synthetic-account',
    runId: 'synthetic-run',
    requestId: 'synthetic-request',
    attemptNumber: 1,
    spokenText: 'The fixture is ready.',
  });
  if (!prepared) throw new Error('Expected canonical controller');
  controller = prepared;
  const result = await prepared.start();
  dispose();
  return { result, notices, allFailed: FALLBACK_MESSAGES.allFailed };
}
describe('actual TtsService fallback exhaustion to canonical receipt', () => {
  it('does not report canonical completed after every actual fallback path has failed', async () => {
    const { result, notices, allFailed } = await run('exhausted');
    expect(h.providers).toEqual(['deepgram', 'jarvis']);
    expect(speechCalls).toBe(1);
    expect(speechEnds).toBe(0);
    expect(notices).toContain(allFailed);
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'failed' },
    });
  });
  it('retains completed when the real system fallback reaches synthetic natural end', async () => {
    speechOutcome = 'ended';
    const { result, notices, allFailed } = await run('fallback-ended');
    expect(h.providers).toEqual(['deepgram', 'jarvis']);
    expect(speechCalls).toBe(1);
    expect(speechEnds).toBe(1);
    expect(notices).not.toContain(allFailed);
    expect(result.terminalStatus).toBe('completed');
  });
  it('retains unavailable without attempting providers when owner is absent', async () => {
    h.canSpeak = false;
    const { result } = await run('owner-unavailable');
    expect(h.providers).toEqual([]);
    expect(speechCalls).toBe(0);
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { reason: 'unavailable' },
    });
  });
  it('retains legacy preview exhaustion as an existing notice without an unhandled rejection', async () => {
    const { TtsService } = await import('./TtsService');
    const { FALLBACK_MESSAGES } = await import('./voicePlans');
    TtsService.setProvider('deepgram_tts');
    const notices: string[] = [];
    const off = TtsService.onNotice((notice) => notices.push(notice));
    try {
      await expect(TtsService.testVoice()).resolves.toBeUndefined();
    } finally {
      off();
    }
    expect(h.providers).toEqual(['deepgram', 'jarvis']);
    expect(speechCalls).toBe(1);
    expect(speechEnds).toBe(0);
    expect(notices).toEqual([FALLBACK_MESSAGES.allFailed]);
  });
  it('keeps active cancellation stopped while the real system fallback is pending', async () => {
    speechOutcome = 'pending';
    const pending = run('cancel');
    await vi.waitFor(() => expect(speechCalls).toBe(1));
    if (!controller) throw new Error('Expected active canonical controller');
    expect(controller.abort()).toBe('signal_delivered');
    const { result } = await pending;
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'stopped' },
    });
    expect(h.providers).toEqual(['deepgram', 'jarvis']);
    expect(speechEnds).toBe(0);
  });
});
