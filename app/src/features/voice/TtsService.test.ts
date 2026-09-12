import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above top-level consts, so build the mock
// providers inside vi.hoisted() and reference them from both the factories
// and the test body.
const h = vi.hoisted(() => {
  const calls: string[] = [];
  const make = (id: string, opts: { fail?: boolean } = {}) => ({
    id,
    isAvailable: vi.fn(async () => true),
    warmup: vi.fn(async () => {}),
    speakChunk: vi.fn(async () => {
      if (opts.fail) throw new Error('quota_exceeded');
      calls.push(id);
    }),
    stop: vi.fn(),
  });
  return {
    calls,
    jarvis: make('jarvis_local'),
    openai: make('openai_tts', { fail: true }),
    deepgram: make('deepgram_tts'),
    elevenlabs: make('elevenlabs_tts'),
    system: make('system_tts_fallback'),
  };
});

vi.mock('./providers/jarvisHighLocal', () => ({ jarvisHighLocalProvider: h.jarvis }));
vi.mock('./providers/systemFallback', () => ({ systemFallbackProvider: h.system }));
vi.mock('./providers/cloudTts', () => ({
  openaiTtsProvider: h.openai,
  elevenlabsTtsProvider: h.elevenlabs,
}));
vi.mock('./providers/deepgramTts', () => ({
  deepgramTtsProvider: h.deepgram,
}));

import { TtsService } from './TtsService';

describe('TtsService', () => {
  beforeEach(() => {
    h.calls.length = 0;
    vi.clearAllMocks();
    h.jarvis.isAvailable.mockResolvedValue(true);
    h.system.isAvailable.mockResolvedValue(true);
    h.openai.isAvailable.mockResolvedValue(true);
    h.jarvis.speakChunk.mockResolvedValue(undefined);
    h.system.speakChunk.mockResolvedValue(undefined);
    h.openai.speakChunk.mockImplementation(async () => {
      throw new Error('quota_exceeded');
    });
  });

  afterEach(() => {
    TtsService.stop();
  });

  it('speaks with the selected provider when available', async () => {
    TtsService.setProvider('jarvis_local');
    await TtsService.speak('Hello there.', { raw: true });
    expect(h.jarvis.speakChunk).toHaveBeenCalledTimes(1);
  });

  it('falls back to Jarvis High when cloud provider fails (quota_exceeded)', async () => {
    const notices: string[] = [];
    const off = TtsService.onNotice((m) => notices.push(m));
    TtsService.setProvider('openai_tts');
    await TtsService.speak('Read this aloud.', { raw: true });
    expect(h.openai.speakChunk).toHaveBeenCalled();
    expect(h.jarvis.speakChunk).toHaveBeenCalled();
    expect(notices.some((n) => /local Jarvis High voice/i.test(n))).toBe(true);
    off();
  });

  it('falls all the way to system fallback when Jarvis High is unavailable too', async () => {
    h.jarvis.isAvailable.mockResolvedValue(false);
    TtsService.setProvider('openai_tts');
    await TtsService.speak('Final fallback test.', { raw: true });
    expect(h.system.speakChunk).toHaveBeenCalled();
  });

  it('setProvider / setVoicePreset are reflected by getters', () => {
    TtsService.setProvider('deepgram_tts');
    TtsService.setVoicePreset('friday');
    expect(TtsService.getProvider()).toBe('deepgram_tts');
    expect(TtsService.getVoicePreset()).toBe('friday');
  });

  it('stop() resets status to idle', async () => {
    TtsService.setProvider('jarvis_local');
    await TtsService.speak('Something.', { raw: true });
    TtsService.stop();
    expect(TtsService.getStatus()).toBe('idle');
  });

  it('does not speak empty text', async () => {
    TtsService.setProvider('jarvis_local');
    await TtsService.speak('   ');
    expect(h.jarvis.speakChunk).not.toHaveBeenCalled();
  });
});
