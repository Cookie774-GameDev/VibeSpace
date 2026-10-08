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
import { FALLBACK_MESSAGES } from './voicePlans';
import { prepareForSpeech } from './textCleanup';

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
  it('rejects strict full-chain exhaustion after exactly one existing notice', async () => {
    h.jarvis.speakChunk.mockRejectedValue(new Error('synthetic local failure'));
    h.system.speakChunk.mockRejectedValue(new Error('synthetic system failure'));
    const notices: string[] = [];
    const off = TtsService.onNotice((notice) => notices.push(notice));
    try {
      await expect(
        TtsService.speak('Strict reply.', {
          provider: 'openai_tts',
          raw: true,
          failureMode: 'reject',
        }),
      ).rejects.toMatchObject({ name: 'TtsPlaybackError', code: 'providers_exhausted' });
      expect(notices).toEqual([FALLBACK_MESSAGES.allFailed]);
      expect(TtsService.getStatus()).toBe('idle');
      expect(h.openai.speakChunk).toHaveBeenCalledTimes(1);
      expect(h.jarvis.speakChunk).toHaveBeenCalledTimes(1);
      expect(h.system.speakChunk).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('keeps legacy testVoice exhaustion notify-only', async () => {
    h.jarvis.speakChunk.mockRejectedValue(new Error('synthetic local failure'));
    h.system.speakChunk.mockRejectedValue(new Error('synthetic system failure'));
    TtsService.setProvider('openai_tts');
    const notices: string[] = [];
    const off = TtsService.onNotice((notice) => notices.push(notice));
    try {
      await expect(TtsService.testVoice()).resolves.toBeUndefined();
      expect(notices).toEqual([FALLBACK_MESSAGES.allFailed]);
    } finally {
      off();
    }
  });

  it('rejects strict exhaustion when all providers are unavailable without speaking', async () => {
    h.openai.isAvailable.mockResolvedValue(false);
    h.jarvis.isAvailable.mockResolvedValue(false);
    h.system.isAvailable.mockResolvedValue(false);
    await expect(
      TtsService.speak('Unavailable reply.', {
        provider: 'openai_tts',
        raw: true,
        failureMode: 'reject',
      }),
    ).rejects.toMatchObject({ code: 'providers_exhausted' });
    expect(h.openai.speakChunk).not.toHaveBeenCalled();
    expect(h.jarvis.speakChunk).not.toHaveBeenCalled();
    expect(h.system.speakChunk).not.toHaveBeenCalled();
  });

  it('strict replies retain successful first and later fallback completion', async () => {
    await expect(
      TtsService.speak('Local reply.', {
        provider: 'jarvis_local',
        raw: true,
        failureMode: 'reject',
      }),
    ).resolves.toBeUndefined();
    expect(h.jarvis.speakChunk).toHaveBeenCalledTimes(1);
    expect(h.system.speakChunk).not.toHaveBeenCalled();
    h.jarvis.speakChunk.mockRejectedValueOnce(new Error('synthetic local failure'));
    await expect(
      TtsService.speak('Fallback reply.', {
        provider: 'openai_tts',
        raw: true,
        failureMode: 'reject',
      }),
    ).resolves.toBeUndefined();
    expect(h.openai.speakChunk).toHaveBeenCalledTimes(1);
    expect(h.jarvis.speakChunk).toHaveBeenCalledTimes(2);
    expect(h.system.speakChunk).toHaveBeenCalledTimes(1);
  });

  it('captures strict failure mode per call and stops before later queued chunks', async () => {
    let release!: (ready: boolean) => void;
    h.openai.isAvailable.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    h.jarvis.speakChunk.mockRejectedValue(new Error('synthetic local failure'));
    h.system.speakChunk.mockRejectedValue(new Error('synthetic system failure'));
    const options: Parameters<typeof TtsService.speak>[1] = {
      provider: 'openai_tts',
      failureMode: 'reject',
    };
    const text = 'This synthetic sentence makes a long reply for the queue. '.repeat(80);
    expect(prepareForSpeech(text).length).toBeGreaterThan(1);
    const pending = TtsService.speak(text, options);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'providers_exhausted' });
    options.failureMode = 'notify';
    release(true);
    await assertion;
    expect(h.openai.speakChunk).toHaveBeenCalledTimes(1);
    expect(h.jarvis.speakChunk).toHaveBeenCalledTimes(1);
    expect(h.system.speakChunk).toHaveBeenCalledTimes(1);
  });

  it('stop during a failing strict attempt resolves without trying later providers', async () => {
    let reject!: (error: Error) => void;
    h.openai.speakChunk.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    );
    const pending = TtsService.speak('Stopped reply.', {
      provider: 'openai_tts',
      raw: true,
      failureMode: 'reject',
    });
    await vi.waitFor(() => expect(h.openai.speakChunk).toHaveBeenCalledTimes(1));
    TtsService.stop();
    reject(new Error('synthetic failure after cancellation'));
    await expect(pending).resolves.toBeUndefined();
    expect(h.jarvis.speakChunk).not.toHaveBeenCalled();
    expect(h.system.speakChunk).not.toHaveBeenCalled();
  });

  it('a newer speak call retires the old strict attempt without inheriting its failure', async () => {
    let rejectOld!: (error: Error) => void;
    h.openai.speakChunk.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = TtsService.speak('Old reply.', {
      provider: 'openai_tts',
      raw: true,
      failureMode: 'reject',
    });
    await vi.waitFor(() => expect(h.openai.speakChunk).toHaveBeenCalledTimes(1));
    const fresh = TtsService.speak('Fresh reply.', { provider: 'jarvis_local', raw: true });
    rejectOld(new Error('late old failure'));
    await expect(old).resolves.toBeUndefined();
    await expect(fresh).resolves.toBeUndefined();
    expect(h.jarvis.speakChunk).toHaveBeenCalledTimes(1);
    expect(h.system.speakChunk).not.toHaveBeenCalled();
  });

  it('strict failure does not retry old text when a fresh healthy call arrives', async () => {
    h.jarvis.speakChunk.mockRejectedValueOnce(new Error('synthetic local failure'));
    h.system.speakChunk.mockRejectedValueOnce(new Error('synthetic system failure'));
    await expect(
      TtsService.speak('Failed old reply.', {
        provider: 'openai_tts',
        raw: true,
        failureMode: 'reject',
      }),
    ).rejects.toMatchObject({ code: 'providers_exhausted' });
    await expect(
      TtsService.speak('Fresh reply.', {
        provider: 'jarvis_local',
        raw: true,
        failureMode: 'reject',
      }),
    ).resolves.toBeUndefined();
    expect(h.jarvis.speakChunk).toHaveBeenLastCalledWith('Fresh reply.', expect.any(Object));
    expect(h.openai.speakChunk).toHaveBeenCalledTimes(1);
  });
  it('keeps cancellation from an exhaustion notice stopped rather than rethrowing strict failure', async () => {
    h.jarvis.speakChunk.mockRejectedValue(new Error('synthetic local failure'));
    h.system.speakChunk.mockRejectedValue(new Error('synthetic system failure'));
    const off = TtsService.onNotice((notice) => {
      if (notice === FALLBACK_MESSAGES.allFailed) TtsService.stop();
    });
    try {
      await expect(
        TtsService.speak('Cancelled on notice.', {
          provider: 'openai_tts',
          raw: true,
          failureMode: 'reject',
        }),
      ).resolves.toBeUndefined();
      expect(TtsService.getStatus()).toBe('idle');
    } finally {
      off();
    }
  });
});
