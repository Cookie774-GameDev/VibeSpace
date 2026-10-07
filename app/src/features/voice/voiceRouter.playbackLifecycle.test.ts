import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
const h = vi.hoisted(() => ({ available: vi.fn(), ready: vi.fn(), invoke: vi.fn(), play: vi.fn(),
  fallback: vi.fn(), stop: vi.fn(), audioPlay: vi.fn(), audioPause: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('./speechSynthesis', () => ({ isSpeechSynthesisSupported: () => true, speakText: h.fallback,
  stopSpeech: h.stop, VOICE_PREVIEW_TEXT: 'Synthetic preview', preloadSpeechVoices: vi.fn(async () => {}) }));
vi.mock('./providers/jarvisHighLocal', () => ({ jarvisHighLocalProvider: {
  isAvailable: h.available, stop: vi.fn(), warmup: vi.fn(async () => {}) } }));
vi.mock('./modelManager', () => ({ ModelManager: { ensureJarvisReady: h.ready } }));
vi.mock('./audioPlayback', () => ({ playBase64Audio: h.play }));
vi.mock('./TtsService', () => ({ TtsService: { setProvider: vi.fn(), setVoicePreset: vi.fn(),
  stop: vi.fn(), speak: vi.fn(async () => {}), warmup: vi.fn(async () => {}) } }));
vi.mock('./providers/deepgramTts', () => ({ deepgramTtsProvider: { isAvailable: vi.fn(async () => false) } }));
vi.mock('./VoiceService', () => ({ VoiceService: { stopListening: vi.fn() } }));
vi.mock('./store', () => ({ useVoiceStore: { getState: () => ({ setState: vi.fn(),
  setPartialTranscript: vi.fn(), endSession: vi.fn(), session: null }) } }));
let voiceModalOpen = true;
vi.mock('@/stores/ui', () => ({ useUIStore: { getState: () => ({ voiceModalOpen, setVoiceListening: vi.fn() }) } }));
import { createJarvisStreamingPlayer, handleVoiceModuleClosed, speakWithSettings, stopAllVoiceOutput, syncVoiceModuleOpenState } from './voiceRouter';
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  stopAllVoiceOutput(); syncVoiceModuleOpenState(false);
  vi.clearAllMocks();
  h.available.mockReset().mockResolvedValue(true); h.ready.mockReset().mockResolvedValue(false);
  h.invoke.mockReset().mockResolvedValue({ audio: 'UklGRg==', mime: 'audio/wav' });
  h.play.mockReset().mockResolvedValue(undefined); h.fallback.mockReset().mockResolvedValue(undefined);
  h.audioPlay.mockReset().mockResolvedValue(undefined); h.audioPause.mockReset();
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: h.invoke });
  vi.stubGlobal('Audio', vi.fn(function SyntheticAudio(this: { play: typeof h.audioPlay; pause: typeof h.audioPause }) {
    this.play = h.audioPlay; this.pause = h.audioPause;
  }));
  useAuthStore.setState({ voiceEngine: 'system', voicePreset: 'jarvis-prime', speakReplies: false });
  voiceModalOpen = true; syncVoiceModuleOpenState(true);
  useAuthStore.setState({ voiceEngine: 'jarvis' });
});
afterEach(() => { stopAllVoiceOutput(); syncVoiceModuleOpenState(false); vi.unstubAllGlobals(); });

describe('selected Jarvis playback lifetime with synthetic readiness and audio IO', () => {
  it('does not begin synthesis when Stop happens during provider readiness', async () => {
    const available = deferred<boolean>(); h.available.mockReturnValueOnce(available.promise);
    const speech = speakWithSettings('Stopped during availability');
    expect(h.available).toHaveBeenCalledOnce(); stopAllVoiceOutput(); available.resolve(true);
    await speech;
    expect(h.invoke).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled(); expect(h.fallback).not.toHaveBeenCalled();
  });

  it('does not resurrect old speech after a close/reopen round trip, while fresh speech works', async () => {
    const available = deferred<boolean>(); h.available.mockReturnValueOnce(available.promise);
    const speech = speakWithSettings('Old opening speech');
    handleVoiceModuleClosed(); syncVoiceModuleOpenState(true); available.resolve(true);
    await speech;
    expect(h.invoke).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
    await speakWithSettings('Fresh opening speech');
    expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.play).toHaveBeenCalledTimes(1);
  });

  it('ignores an already aborted request before readiness or audio work', async () => {
    const controller = new AbortController(); controller.abort();
    await speakWithSettings('Already aborted speech', { signal: controller.signal });
    expect(h.available).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
  });

  it('respects caller abort while availability is pending', async () => {
    const available = deferred<boolean>(); h.available.mockReturnValueOnce(available.promise);
    const controller = new AbortController();
    const speech = speakWithSettings('Caller aborted pending speech', { signal: controller.signal });
    controller.abort(); available.resolve(true); await speech;
    expect(h.invoke).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
  });

  it('does not start the installed-voice fallback after Stop during setup readiness', async () => {
    const ready = deferred<boolean>(); h.available.mockResolvedValue(false); h.ready.mockReturnValueOnce(ready.promise);
    const speech = speakWithSettings('Stopped during setup');
    await vi.waitFor(() => expect(h.ready).toHaveBeenCalledOnce());
    stopAllVoiceOutput(); ready.resolve(false); await speech;
    expect(h.invoke).not.toHaveBeenCalled(); expect(h.fallback).not.toHaveBeenCalled();
  });

  it('does not start system fallback if the stopped local fallback rejects later', async () => {
    const local = deferred<void>(); h.available.mockResolvedValue(false); h.fallback.mockReturnValueOnce(local.promise);
    const speech = speakWithSettings('Stopped during local fallback');
    await vi.waitFor(() => expect(h.fallback).toHaveBeenCalledOnce());
    stopAllVoiceOutput(); local.reject(new Error('Synthetic stopped local voice')); await speech;
    expect(h.fallback).toHaveBeenCalledTimes(1);
    expect(h.fallback.mock.calls[0][1].engine).toBe('local');
  });

  it('does not resume generated speech when a stopped bundled acknowledgement rejects', async () => {
    const acknowledgement = deferred<void>(); h.audioPlay.mockReturnValueOnce(acknowledgement.promise);
    const speech = speakWithSettings('On it.');
    expect(h.audioPlay).toHaveBeenCalledOnce(); stopAllVoiceOutput();
    acknowledgement.reject(new Error('Synthetic audio interruption')); await speech;
    expect(h.available).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled(); expect(h.fallback).not.toHaveBeenCalled();
  });

  it('preserves a legitimate selected-engine synthesis and its existing local fallback', async () => {
    await speakWithSettings('Current selected Jarvis synthesis');
    expect(h.invoke.mock.calls[0].slice(0, 2)).toEqual(['jarvis_voice_speak', { text: 'Current selected Jarvis synthesis', speed: 1 }]);
    expect(h.play).toHaveBeenCalledOnce();
    h.available.mockResolvedValue(false);
    await speakWithSettings('Current fallback request');
    expect(h.fallback).toHaveBeenCalledWith('Current fallback request', { voicePreset: 'jarvis-prime', engine: 'local' });
  });

  it('does not begin setup after Stop while the second availability check is pending', async () => {
    const available = deferred<boolean>();
    h.available.mockResolvedValueOnce(false).mockReturnValueOnce(available.promise);
    const speech = speakWithSettings('Stopped before setup dispatch');
    await vi.waitFor(() => expect(h.available).toHaveBeenCalledTimes(2));
    stopAllVoiceOutput(); available.resolve(false); await speech;
    expect(h.ready).not.toHaveBeenCalled(); expect(h.fallback).not.toHaveBeenCalled();
  });

  it('keeps newer playback owned when older readiness finally settles', async () => {
    const available = deferred<boolean>(); h.available.mockReturnValueOnce(available.promise);
    const oldSpeech = speakWithSettings('Superseded readiness speech');
    const playing = deferred<void>(); h.play.mockReturnValueOnce(playing.promise);
    const newSpeech = speakWithSettings('Newer current playback');
    await vi.waitFor(() => expect(h.play).toHaveBeenCalledOnce());
    const newSignal = h.play.mock.calls[0][2].signal as AbortSignal;
    available.resolve(true); await oldSpeech;
    expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.play).toHaveBeenCalledTimes(1);
    expect(newSignal.aborted).toBe(false);
    stopAllVoiceOutput(); expect(newSignal.aborted).toBe(true);
    playing.resolve(undefined); await newSpeech;
  });

  it('removes the original caller abort listener when speech settles', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await speakWithSettings('Caller listener cleanup', { signal: controller.signal });
    const listener = add.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(listener).toBeTypeOf('function'); expect(remove).toHaveBeenCalledWith('abort', listener);
    add.mockRestore(); remove.mockRestore();
  });

});

it('independent: stops before the deferred native synthesis import dispatches', async () => {
  const speech = speakWithSettings('Independent stopped before synthesis IPC');
  await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalled();
  stopAllVoiceOutput();
  await speech;
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.play).not.toHaveBeenCalled();
  expect(h.fallback).not.toHaveBeenCalled();
});

it('independent: disposes caller ownership when readiness rejects', async () => {
  const caller = new AbortController();
  const add = vi.spyOn(caller.signal, 'addEventListener');
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  h.available.mockRejectedValueOnce(new Error('Synthetic readiness rejection'));
  await expect(speakWithSettings('Independent rejected readiness', { signal: caller.signal })).rejects.toThrow('Synthetic readiness rejection');
  const listener = add.mock.calls.find(([type]) => type === 'abort')?.[1];
  expect(listener).toBeTypeOf('function');
  expect(remove).toHaveBeenCalledWith('abort', listener);
  await speakWithSettings('Independent fresh after readiness rejection');
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.play).toHaveBeenCalledTimes(1);
  add.mockRestore(); remove.mockRestore();
});


it('lets a fresh identical phrase start after its predecessor is stopped before IPC', async () => {
  const text = 'Same phrase after pre-dispatch stop';
  const oldSpeech = speakWithSettings(text);
  await Promise.resolve(); expect(h.invoke).not.toHaveBeenCalled();
  stopAllVoiceOutput();
  const newSpeech = speakWithSettings(text);
  await Promise.all([oldSpeech, newSpeech]);
  expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.play).toHaveBeenCalledTimes(1);
  expect(h.fallback).not.toHaveBeenCalled();
});

it('reuses already admitted audio for a fresh identical phrase without reviving old playback', async () => {
  const audio = deferred<{ audio: string; mime: string }>(); h.invoke.mockReturnValueOnce(audio.promise);
  const text = 'Same phrase after admitted synthesis';
  const oldSpeech = speakWithSettings(text);
  await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledOnce());
  stopAllVoiceOutput(); const newSpeech = speakWithSettings(text);
  audio.resolve({ audio: 'UklGRg==', mime: 'audio/wav' });
  await Promise.all([oldSpeech, newSpeech]);
  expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.play).toHaveBeenCalledTimes(1);
  expect(h.fallback).not.toHaveBeenCalled();
});

it('stops a streaming phrase before its deferred native dispatch', async () => {
  const player = createJarvisStreamingPlayer('jarvis-prime');
  player.enqueue('Streaming phrase stopped before dispatch');
  await Promise.resolve(); expect(h.invoke).not.toHaveBeenCalled();
  player.stop(); await player.complete();
  expect(h.invoke).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
});

it('keeps current streaming synthesis and playback working', async () => {
  const player = createJarvisStreamingPlayer('jarvis-prime');
  player.enqueue('Current synthetic streaming phrase'); await player.complete();
  expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.play).toHaveBeenCalledTimes(1);
});

it('review-r2: stopping two synth-ahead phrases owns every rejection', async () => {
  const readiness = deferred<boolean>();
  h.available.mockReturnValueOnce(readiness.promise);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const player = createJarvisStreamingPlayer('jarvis-prime');
    player.enqueue('Independent synth-ahead first');
    player.enqueue('Independent synth-ahead second');
    expect(h.invoke).not.toHaveBeenCalled();
    player.stop();
    readiness.resolve(true);
    await player.complete();
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    console.info('SYNTH_AHEAD_OBSERVATION', JSON.stringify({ nativeDispatches: h.invoke.mock.calls.length, playbacks: h.play.mock.calls.length, unhandled: unhandled.map((error) => String(error)) }));
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

it('review-r2: an evicted old failure cannot delete newer admitted same-phrase audio', async () => {
  const oldAudio = deferred<{ audio: string; mime: string }>();
  const newAudio = deferred<{ audio: string; mime: string }>();
  const text = 'Independent eviction ownership target';
  let targetCalls = 0;
  h.invoke.mockImplementation((_command: string, args: { text: string }) => {
    if (args.text === text) { targetCalls += 1; return targetCalls === 1 ? oldAudio.promise : newAudio.promise; }
    return Promise.resolve({ audio: 'UklGRg==', mime: 'audio/wav' });
  });
  const oldSpeech = speakWithSettings(text);
  await vi.waitFor(() => expect(targetCalls).toBe(1));
  for (let i = 0; i < 64; i += 1) await speakWithSettings(`Independent eviction filler ${i}`);
  h.play.mockClear();
  const newer = speakWithSettings(text);
  await vi.waitFor(() => expect(targetCalls).toBe(2));
  oldAudio.reject(new Error('Synthetic evicted synthesis failure'));
  await oldSpeech;
  const latest = speakWithSettings(text);
  await vi.dynamicImportSettled();
  expect(targetCalls).toBe(2);
  newAudio.resolve({ audio: 'UklGRg==', mime: 'audio/wav' });
  await Promise.all([newer, latest]);
  expect(targetCalls).toBe(2);
  expect(h.play).toHaveBeenCalledOnce();
});

it('owns an early queued failure and still applies its fallback when playback reaches it', async () => {
  const firstAudio = deferred<{ audio: string; mime: string }>();
  const secondAudio = deferred<{ audio: string; mime: string }>();
  h.invoke.mockReturnValueOnce(firstAudio.promise).mockReturnValueOnce(secondAudio.promise);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const player = createJarvisStreamingPlayer('jarvis-prime');
    player.enqueue('Current first queued audio');
    player.enqueue('Current second queued fallback');
    const completion = player.complete();
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2));
    secondAudio.reject(new Error('Synthetic early second synthesis failure'));
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(h.play).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    firstAudio.resolve({ audio: 'UklGRg==', mime: 'audio/wav' });
    await completion;
    expect(h.play).toHaveBeenCalledOnce();
    expect(h.fallback).toHaveBeenCalledWith('Current second queued fallback', {
      voicePreset: 'jarvis-prime', engine: 'local',
    });
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', onUnhandled); }
});


it('review-r3: a stopped streaming local fallback cannot start system speech later', async () => {
  const local = deferred<void>();
  h.invoke.mockRejectedValueOnce(new Error('Synthetic streaming synthesis failure'));
  h.fallback.mockReturnValueOnce(local.promise);
  const player = createJarvisStreamingPlayer('jarvis-prime');
  player.enqueue('Independent streaming fallback stop');
  const completion = player.complete();
  await vi.waitFor(() => expect(h.fallback).toHaveBeenCalledOnce());
  expect(h.fallback.mock.calls[0][1].engine).toBe('local');
  player.stop();
  local.reject(new Error('Synthetic stopped streaming local voice'));
  await completion;
  expect(h.fallback.mock.calls.map(([, options]) => options.engine)).toEqual(['local']);
  expect(h.fallback).toHaveBeenCalledTimes(1);
  expect(h.play).not.toHaveBeenCalled();
});

it('retains system fallback when current streaming local speech fails', async () => {
  h.invoke.mockRejectedValueOnce(new Error('Synthetic current streaming synthesis failure'));
  h.fallback.mockRejectedValueOnce(new Error('Synthetic current local voice failure'));
  const player = createJarvisStreamingPlayer('jarvis-prime');
  player.enqueue('Current streaming system fallback');
  await player.complete();
  expect(h.fallback.mock.calls.map(([, options]) => options.engine)).toEqual(['local', 'system']);
  expect(h.fallback.mock.calls.map(([text]) => text)).toEqual([
    'Current streaming system fallback', 'Current streaming system fallback',
  ]);
  expect(h.play).not.toHaveBeenCalled();
});

it('keeps fresh streaming playback owned after a stopped older fallback rejects', async () => {
  const local = deferred<void>();
  h.invoke.mockRejectedValueOnce(new Error('Synthetic older synthesis failure'));
  h.fallback.mockReturnValueOnce(local.promise);
  const oldPlayer = createJarvisStreamingPlayer('jarvis-prime');
  oldPlayer.enqueue('Retired streaming local fallback');
  const oldCompletion = oldPlayer.complete();
  await vi.waitFor(() => expect(h.fallback).toHaveBeenCalledOnce());
  oldPlayer.stop();
  const playback = deferred<void>();
  h.play.mockReturnValueOnce(playback.promise);
  const currentPlayer = createJarvisStreamingPlayer('jarvis-prime');
  currentPlayer.enqueue('Fresh streaming playback after Stop');
  const currentCompletion = currentPlayer.complete();
  await vi.waitFor(() => expect(h.play).toHaveBeenCalledOnce());
  const currentSignal = h.play.mock.calls[0][2].signal as AbortSignal;
  const stopCount = h.stop.mock.calls.length;
  local.reject(new Error('Synthetic retired local rejection'));
  await oldCompletion;
  expect(h.fallback).toHaveBeenCalledOnce();
  expect(h.stop).toHaveBeenCalledTimes(stopCount);
  expect(currentSignal.aborted).toBe(false);
  playback.resolve(undefined);
  await currentCompletion;
  expect(currentSignal.aborted).toBe(false);
});
