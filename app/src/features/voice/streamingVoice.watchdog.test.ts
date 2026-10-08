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
      voiceEngine: 'system',
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

let active: SyntheticUtterance | null;
let utterances: SyntheticUtterance[];
let cancelCount: number;
let naturalEnds: number;
let deliverCancelEvent: boolean;
let liveController: { dispose(): void } | null;
class SyntheticUtterance {
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fixture.speakReplies = true;
  fixture.invocationCount = 0;
  fixture.forbiddenCalls = [];
  active = null;
  utterances = [];
  cancelCount = 0;
  naturalEnds = 0;
  deliverCancelEvent = true;
  liveController = null;
  vi.stubGlobal('SpeechSynthesisUtterance', SyntheticUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: () => {
        cancelCount += 1;
        const prior = active;
        active = null;
        if (deliverCancelEvent) prior?.onerror?.({ error: 'canceled' });
      },
      resume: vi.fn(),
      get speaking() {
        return active !== null;
      },
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
        active = utterance;
        utterances.push(utterance);
      },
    },
  });
  vi.stubGlobal(
    'Audio',
    class {
      constructor() {
        forbidden('unexpected_media');
      }
    },
  );
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
});
afterEach(() => {
  liveController?.dispose();
  expect(fixture.forbiddenCalls).toEqual([]);
  expect(fixture.invocationCount).toBe(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function end(utterance: SyntheticUtterance) {
  if (active === utterance) active = null;
  naturalEnds += 1;
  utterance.onend?.();
}
async function start(text = 'The fixture is ready.') {
  const { createCanonicalVoicePlaybackAdapter } = await import('@/features/voice/streamingVoice');
  const controller = createCanonicalVoicePlaybackAdapter().prepare({
    accountId: 'synthetic-account',
    runId: 'synthetic-run',
    requestId: 'synthetic-request',
    attemptNumber: 1,
    spokenText: text,
  });
  if (!controller) throw new Error('Expected canonical controller');
  liveController = controller;
  const promise = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  return { controller, promise };
}
describe('actual Web Speech watchdog to canonical receipt', () => {
  it('does not report completed while healthy long speech continues beyond the old20-second cap', async () => {
    const text = 'This is a longer synthetic passage that the engine is still speaking. '.repeat(
      30,
    );
    expect(text.length * 55).toBeGreaterThan(20000);
    const { promise } = await start(text);
    expect(utterances).toHaveLength(1);
    let settledAt: number | null = null;
    void promise.then(() => {
      settledAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(21000);
    const beforeEnd = settledAt;
    const stillSpeaking = active === utterances[0];
    const cancelsBeforeEnd = cancelCount;
    const actualEndAt = Date.now();
    end(utterances[0]);
    const result = await promise;
    expect(stillSpeaking).toBe(true);
    expect(cancelsBeforeEnd).toBe(1);
    expect(beforeEnd).toBeNull();
    expect(result.terminalStatus).toBe('completed');
  });
  it('degrades an inactive engine with missing end rather than inventing successful completion', async () => {
    const { promise } = await start();
    expect(utterances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    active = null;
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;
    expect(naturalEnds).toBe(0);
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'failed' },
    });
  });
  it('retains completed for an actual natural engine end before the watchdog', async () => {
    const { promise } = await start();
    expect(utterances).toHaveLength(1);
    end(utterances[0]);
    const result = await promise;
    expect(result).toMatchObject({ terminalStatus: 'completed', playback: { state: 'completed' } });
    const cancels = cancelCount;
    await vi.advanceTimersByTimeAsync(2000);
    expect(cancelCount).toBe(cancels);
  });
  it('retains stopped after a genuine canonical abort', async () => {
    const { controller, promise } = await start();
    expect(utterances).toHaveLength(1);
    expect(controller.abort()).toBe('signal_delivered');
    const result = await promise;
    expect(result).toMatchObject({ terminalStatus: 'partial', playback: { reason: 'stopped' } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(active).toBeNull();
  });
  it('degrades with an unavailable engine without starting synthesis or waiting for a watchdog', async () => {
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const { promise } = await start();
    const result = await promise;
    expect(utterances).toHaveLength(0);
    expect(result).toMatchObject({
      terminalStatus: 'partial',
      playback: { state: 'degraded', reason: 'failed' },
    });
  });
  it('an older silent-cancel watchdog cannot stop a newer canonical owner', async () => {
    const { speakText } = await import('@/features/voice/speechSynthesis');
    deliverCancelEvent = false;
    const retiredPreview = speakText('An older preview.', { engine: 'system' });
    await vi.advanceTimersByTimeAsync(0);
    expect(utterances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    const { promise } = await start();
    expect(utterances).toHaveLength(2);
    const fresh = utterances[1];
    const cancels = cancelCount;
    await vi.advanceTimersByTimeAsync(800);
    await expect(retiredPreview).resolves.toBeUndefined();
    expect(active).toBe(fresh);
    expect(cancelCount).toBe(cancels);
    end(fresh);
    const result = await promise;
    expect(result.terminalStatus).toBe('completed');
  });
  it('a reentrant END replacement survives the actual Jarvis/Aurora local-to-system fallback caller', async () => {
    const { speakWithSettings } = await import('./voiceRouter');
    const { speakText, SPEECH_SYNTHESIS_END_EVENT } = await import('./speechSynthesis');
    const oldText = 'Old fallback phrase.';
    const freshText = 'Fresh owner phrase.';
    const old = speakWithSettings(oldText, { voiceEngine: 'jarvis', voicePreset: 'aurora' });
    const oldOutcome = old.then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(utterances.map((utterance) => utterance.text)).toEqual([oldText]);
    active = null;
    let replacement: Promise<void> | undefined;
    window.addEventListener(
      SPEECH_SYNTHESIS_END_EVENT,
      () => {
        replacement = speakText(freshText, { engine: 'system' });
      },
      { once: true },
    );
    await vi.advanceTimersByTimeAsync(1801);
    const observedTexts = utterances.map((utterance) => utterance.text);
    const cancelsBeforeFreshEnd = cancelCount;
    if (active) end(active);
    await expect(oldOutcome).resolves.toBe('resolved');
    await replacement;
    expect(observedTexts).toEqual([oldText, freshText]);
    expect(cancelsBeforeFreshEnd).toBe(2);
  });
});
