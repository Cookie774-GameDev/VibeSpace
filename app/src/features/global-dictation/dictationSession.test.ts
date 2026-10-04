import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Engine resolution for the Ctrl+Space overlay must mirror VibeSpace chat
 * STT settings and must NEVER fall back to OS dictation (Windows Win+H).
 */

const mocks = vi.hoisted(() => ({
  isTauri: { value: true },
  voiceHandlers: new Map<string, (payload: never) => void>(),
  voiceService: {
    isSupported: vi.fn(() => false),
    isListening: vi.fn(() => false),
    wantsListening: vi.fn(() => false),
    startListening: vi.fn(() => true),
    stopListening: vi.fn(),
    setInactivityTimeoutMs: vi.fn(),
    on: vi.fn<(event: string, handler: (payload: never) => void) => () => void>(
      () => () => undefined,
    ),
  },
  composer: {
    provider: 'system' as 'system' | 'faster-whisper' | 'deepgram',
    model: 'small',
    startBatchAudioRecorder: vi.fn(
      async (
        _onVolume: (level: number) => void,
        _onInactivity: () => void,
        _options?: { retainAudio?: boolean; maxBufferedSeconds?: number },
      ): Promise<{
        captureWav: () => Blob | null;
        captureWavAndReset?: () => Blob | null;
        stop: () => void;
      }> => ({
        captureWav: (): Blob | null => new Blob(['x'], { type: 'audio/wav' }),
        stop: vi.fn(),
      }),
    ),
    transcribeFasterWhisper: vi.fn(async () => 'local text'),
    transcribeGroq: vi.fn(async () => 'groq text'),
  },
  fasterWhisper: {
    checkInstalled: vi.fn(async () => false),
  },
  deepgramKey: { value: '' as string },
  deepgramSession: vi.fn(async () => ({
    stop: vi.fn(),
    cancel: vi.fn(),
    getFinalText: () => 'deepgram text',
  })),
}));

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get isTauri() {
    return mocks.isTauri.value;
  },
}));

vi.mock('@/features/voice/VoiceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/voice/VoiceService')>()),
  VoiceService: mocks.voiceService,
}));

vi.mock('@/features/composer-stt/composerSttService', () => ({
  getComposerSttProvider: () => mocks.composer.provider,
  getFasterWhisperModel: () => mocks.composer.model,
  startBatchAudioRecorder: mocks.composer.startBatchAudioRecorder,
  transcribeFasterWhisper: mocks.composer.transcribeFasterWhisper,
  transcribeGroq: mocks.composer.transcribeGroq,
}));

vi.mock('@/features/composer-stt/fasterWhisperManager', () => ({
  FasterWhisperManager: mocks.fasterWhisper,
}));

vi.mock('@/features/composer-stt/audio', () => ({
  getAudioContextCtor: () => function FakeAudioContext() {},
}));

vi.mock('@/lib/security/voiceKeys', () => ({
  getDeepgramVoiceKey: async () => mocks.deepgramKey.value,
}));

vi.mock('./deepgramDictation', () => ({
  createDeepgramDictationSession: mocks.deepgramSession,
}));

import {
  createGlobalDictationSession,
  createSelectedSttSession,
  NO_ENGINE_MESSAGE,
} from './dictationSession';
import { formatVoiceFailure } from '@/features/voice/VoiceService';
import { useAuthStore } from '@/stores/auth';
import { readSpeechHistory } from '@/features/composer-stt/speechHistory';

function stubMic(available: boolean) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: available ? { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } : {},
  });
}

describe('createGlobalDictationSession engine resolution', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.isTauri.value = true;
    mocks.composer.provider = 'system';
    mocks.composer.model = 'small';
    mocks.voiceService.isSupported.mockReturnValue(false);
    mocks.voiceService.startListening.mockReturnValue(true);
    mocks.voiceHandlers.clear();
    mocks.voiceService.on.mockImplementation((event, handler) => {
      mocks.voiceHandlers.set(event, handler);
      return () => {
        mocks.voiceHandlers.delete(event);
      };
    });
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(false);
    mocks.deepgramKey.value = '';
    useAuthStore.setState({ apiKeys: {} });
    stubMic(true);
  });

  it('checkpoints shared system partials before cancellation and ignores late callbacks', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const session = await createSelectedSttSession();
    const partial = mocks.voiceHandlers.get('voice:partial')!;
    partial({ text: 'words before interruption' } as never);
    expect(readSpeechHistory()[0].text).toBe('words before interruption');
    session.cancel();
    partial({ text: 'late result' } as never);
    expect(readSpeechHistory()[0]).toMatchObject({
      text: 'words before interruption',
      status: 'interrupted',
    });
  });
  it('clears earlier recovery words when the active desktop take is cleared', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const session = await createGlobalDictationSession();
    try {
      mocks.voiceHandlers.get('voice:final')?.({ text: 'discard first phrase' } as never);
      expect(readSpeechHistory()[0].text).toBe('discard first phrase');
      session.clearRecoveryText?.();
      expect(readSpeechHistory()).toEqual([]);
      mocks.voiceHandlers.get('voice:final')?.({ text: 'keep second phrase' } as never);
      expect(readSpeechHistory()[0].text).toBe('keep second phrase');
    } finally {
      session.cancel();
    }
  });

  it('saves completed local transcription through the shared pipeline', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    const onTurnEnd = vi.fn();
    const session = await createSelectedSttSession({ onTurnEnd });
    await session.stop();
    expect(onTurnEnd).not.toHaveBeenCalled();
    expect(readSpeechHistory()[0]).toMatchObject({ text: 'local text', status: 'completed' });
  });

  it('finishes selected local Whisper in Jarvis voice after speech pauses and submits once', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    let sample!: (level: number) => void;
    mocks.composer.startBatchAudioRecorder.mockImplementationOnce(async (onLevel) => {
      sample = onLevel;
      return {
        captureWav: () => new Blob(['spoken voice'], { type: 'audio/wav' }),
        stop: vi.fn(),
      };
    });
    const onFinal = vi.fn();
    const onTurnEnd = vi.fn();
    const session = await createSelectedSttSession(
      { onFinal, onTurnEnd },
      { requester: 'jarvis-voice' },
    );
    try {
      sample(0.35);
      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith('local text'), {
        timeout: 2_500,
      });
      expect(onTurnEnd).toHaveBeenCalledOnce();
      expect(onTurnEnd).toHaveBeenCalledWith({ forceCommit: true });
      expect(readSpeechHistory()[0]).toMatchObject({ text: 'local text', status: 'completed' });
      await session.stop();
      expect(onTurnEnd).toHaveBeenCalledOnce();
    } finally {
      session.cancel();
    }
  });

  it('uses the configured local faster-whisper model first (same as composer STT)', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);

    const session = await createGlobalDictationSession();

    expect(session.engine).toBe('faster-whisper');
    expect(session.streaming).toBe(false);
    await session.stop();
    expect(mocks.composer.transcribeFasterWhisper).toHaveBeenCalled();
    expect(session.getFinalText()).toBe('local text');
  });

  it('keeps desktop dictation alive through silence and drains long takes in segments', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    let onInactivity!: () => void;
    const segments = [
      new Blob(['first'], { type: 'audio/wav' }),
      new Blob(['second'], { type: 'audio/wav' }),
    ];
    const recorder = {
      captureWav: vi.fn(() => null),
      captureWavAndReset: vi.fn(() => segments.shift() ?? null),
      stop: vi.fn(),
    };
    mocks.composer.startBatchAudioRecorder.mockImplementationOnce(async (_onLevel, idle) => {
      onInactivity = idle;
      return recorder;
    });
    mocks.composer.transcribeFasterWhisper
      .mockResolvedValueOnce('first words')
      .mockResolvedValueOnce('later words');
    const onError = vi.fn();
    const session = await createGlobalDictationSession({ onError });
    onInactivity();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    expect(recorder.stop).not.toHaveBeenCalled();
    await session.stop();
    expect(session.getFinalText()).toBe('first words later words');
    expect(readSpeechHistory()[0]).toMatchObject({
      text: 'first words later words',
      status: 'completed',
    });
  });

  it('reports a safe shared batch-transcription failure without provider details', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    mocks.composer.transcribeFasterWhisper.mockRejectedValueOnce(
      new Error('synthetic local model path and provider detail'),
    );
    const onError = vi.fn();

    const session = await createGlobalDictationSession({ onError });
    await session.stop();

    expect(onError).toHaveBeenCalledWith(
      'The action failed, sir. Action: Local faster-whisper transcription. ' +
        'Cause: Captured audio could not be transcribed. ' +
        'Check the selected engine and connection, then retry.',
    );
    expect(onError.mock.calls[0]?.[0]).not.toContain('synthetic local model path');
  });

  it('uses the built-in Web Speech engine when available (default chat STT engine)', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);

    const session = await createGlobalDictationSession();

    expect(session.engine).toBe('web-speech');
    expect(session.streaming).toBe(true);
    expect(mocks.voiceService.startListening).toHaveBeenCalled();
    session.cancel();
    expect(mocks.voiceService.stopListening).toHaveBeenCalled();
  });

  it('keeps listening through normal browser silence and restart events', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const onError = vi.fn();
    const session = await createSelectedSttSession({ onError });
    try {
      for (const kind of ['no_speech', 'aborted']) {
        mocks.voiceHandlers.get('voice:error')?.({ kind, message: 'normal restart' } as never);
      }
      expect(onError).not.toHaveBeenCalled();
      expect(mocks.voiceService.stopListening).not.toHaveBeenCalled();
    } finally {
      session.cancel();
    }
  });

  it('keeps the take and transcribes it locally when Web Speech cannot reach its service', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    const wav = new Blob(['captured local audio'], { type: 'audio/wav' });
    const stopMeter = vi.fn();
    mocks.composer.startBatchAudioRecorder.mockResolvedValueOnce({
      captureWav: () => wav,
      stop: stopMeter,
    });
    const onStatus = vi.fn();
    const onFinal = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();

    const session = await createSelectedSttSession({ onStatus, onFinal, onError, onClose });
    try {
      mocks.voiceHandlers.get('voice:error')?.({
        kind: 'network',
        message: formatVoiceFailure('network'),
      } as never);
      await vi.waitFor(() =>
        expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('Whisper')),
      );
      expect(mocks.composer.startBatchAudioRecorder).toHaveBeenLastCalledWith(
        expect.any(Function),
        expect.any(Function),
        { retainAudio: true, maxBufferedSeconds: 60 },
      );
      expect(onError).not.toHaveBeenCalled();

      await session.stop();

      expect(mocks.composer.transcribeFasterWhisper).toHaveBeenCalledWith(wav, 'small');
      expect(onFinal).toHaveBeenCalledWith('local text');
      expect(onError).not.toHaveBeenCalled();
      expect(stopMeter).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      expect(readSpeechHistory()[0]).toMatchObject({ text: 'local text', status: 'completed' });
    } finally {
      session.cancel();
    }
  });

  it('keeps earlier confirmed words and stays open through a quiet desktop fallback', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    let onInactivity!: () => void;
    mocks.composer.startBatchAudioRecorder.mockImplementationOnce(async (_level, idle) => {
      onInactivity = idle;
      return {
        captureWav: () => new Blob(['recent audio'], { type: 'audio/wav' }),
        stop: vi.fn(),
      };
    });
    const onError = vi.fn();
    const session = await createGlobalDictationSession({ onError });
    mocks.voiceHandlers.get('voice:final')?.({ text: 'earlier confirmed words' } as never);
    mocks.voiceHandlers.get('voice:error')?.({
      kind: 'network',
      message: formatVoiceFailure('network'),
    } as never);
    await vi.waitFor(() => expect(mocks.voiceService.stopListening).toHaveBeenCalled());
    onInactivity();
    expect(onError).not.toHaveBeenCalled();
    await session.stop();
    expect(session.getFinalText()).toBe('earlier confirmed words local text');
    expect(readSpeechHistory()[0].text).toBe('earlier confirmed words local text');
  });

  it('transcribes fallback audio periodically throughout a long desktop take', async () => {
    vi.useFakeTimers();
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    const chunks = [
      new Blob(['first'], { type: 'audio/wav' }),
      new Blob(['second'], { type: 'audio/wav' }),
    ];
    mocks.composer.startBatchAudioRecorder.mockResolvedValueOnce({
      captureWav: () => null,
      captureWavAndReset: () => chunks.shift() ?? null,
      stop: vi.fn(),
    });
    mocks.composer.transcribeFasterWhisper
      .mockResolvedValueOnce('first local minute')
      .mockResolvedValueOnce('second local minute');
    const onFinal = vi.fn();
    const session = await createGlobalDictationSession({ onFinal });
    try {
      mocks.voiceHandlers.get('voice:error')?.({
        kind: 'network',
        message: formatVoiceFailure('network'),
      } as never);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(55_000);
      expect(onFinal).toHaveBeenCalledWith('first local minute');
      await session.stop();
      expect(session.getFinalText()).toBe('first local minute second local minute');
      expect(readSpeechHistory()[0].text).toBe('first local minute second local minute');
    } finally {
      session.cancel();
      vi.useRealTimers();
    }
  });

  it('finishes a voice-only local fallback after speech becomes quiet', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    let sample!: (level: number) => void;
    mocks.composer.startBatchAudioRecorder.mockImplementationOnce(async (onLevel) => {
      sample = onLevel;
      return {
        captureWav: () => new Blob(['spoken voice'], { type: 'audio/wav' }),
        stop: vi.fn(),
      };
    });
    const onFinal = vi.fn();
    const onClose = vi.fn();
    const onTurnEnd = vi.fn();
    const session = await createSelectedSttSession(
      { onFinal, onClose, onTurnEnd },
      { requester: 'jarvis-voice' },
    );
    try {
      mocks.voiceHandlers.get('voice:error')?.({
        kind: 'network',
        message: formatVoiceFailure('network'),
      } as never);
      await vi.waitFor(() => expect(mocks.voiceService.stopListening).toHaveBeenCalled());
      sample(0.3);
      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith('local text'), {
        timeout: 2_500,
      });
      expect(onTurnEnd).toHaveBeenCalledOnce();
      expect(onTurnEnd).toHaveBeenCalledWith({ forceCommit: true });
      expect(onClose).toHaveBeenCalledOnce();
      expect(readSpeechHistory()[0]).toMatchObject({ text: 'local text', status: 'completed' });
    } finally {
      session.cancel();
    }
  });

  it('uses an installed Whisper model when the saved model is unavailable during a system network failure', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.composer.model = 'whisper-small-en-q8';
    mocks.fasterWhisper.checkInstalled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onStatus = vi.fn();
    const onFinal = vi.fn();
    const onError = vi.fn();
    const session = await createSelectedSttSession({ onStatus, onFinal, onError });
    try {
      mocks.voiceHandlers.get('voice:error')?.({
        kind: 'network',
        message: formatVoiceFailure('network'),
      } as never);
      await vi.waitFor(() =>
        expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('whisper-base-en-q5')),
      );
      await session.stop();
      expect(mocks.fasterWhisper.checkInstalled).toHaveBeenNthCalledWith(1, 'whisper-small-en-q8');
      expect(mocks.fasterWhisper.checkInstalled).toHaveBeenNthCalledWith(2, 'whisper-base-en-q5');
      expect(mocks.composer.transcribeFasterWhisper).toHaveBeenCalledWith(
        expect.any(Blob),
        'whisper-base-en-q5',
      );
      expect(onFinal).toHaveBeenCalledWith('local text');
      expect(onError).not.toHaveBeenCalled();
      expect(mocks.composer.model).toBe('whisper-small-en-q8');
    } finally {
      session.cancel();
    }
  });

  it('keeps the original Web Speech network error when no local model is installed', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(false);
    const onStatus = vi.fn();
    const onError = vi.fn();
    const stopMeter = vi.fn();
    mocks.composer.startBatchAudioRecorder.mockResolvedValueOnce({
      captureWav: () => new Blob(['captured local audio'], { type: 'audio/wav' }),
      stop: stopMeter,
    });
    const session = await createSelectedSttSession({ onStatus, onError });
    try {
      mocks.voiceHandlers.get('voice:error')?.({
        kind: 'network',
        message: formatVoiceFailure('network'),
      } as never);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(formatVoiceFailure('network')));

      expect(onStatus).not.toHaveBeenCalled();
      expect(mocks.composer.transcribeFasterWhisper).not.toHaveBeenCalled();
      expect(stopMeter).toHaveBeenCalledOnce();
    } finally {
      session.cancel();
    }
  });

  it('discards captured fallback audio when the user cancels instead of finishing', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    const stopMeter = vi.fn();
    mocks.composer.startBatchAudioRecorder.mockResolvedValueOnce({
      captureWav: () => new Blob(['captured local audio'], { type: 'audio/wav' }),
      stop: stopMeter,
    });
    const onStatus = vi.fn();
    const onClose = vi.fn();
    const session = await createSelectedSttSession({ onStatus, onClose });

    mocks.voiceHandlers.get('voice:error')?.({
      kind: 'network',
      message: formatVoiceFailure('network'),
    } as never);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledOnce());
    session.cancel();

    expect(stopMeter).toHaveBeenCalledOnce();
    expect(mocks.composer.transcribeFasterWhisper).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('waits for the browser final result after stop before returning the transcript', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const session = await createSelectedSttSession();
    const stopping = session.stop();
    mocks.voiceHandlers.get('voice:final')?.({ text: 'last spoken words' } as never);
    mocks.voiceHandlers.get('voice:end')?.(undefined as never);
    await stopping;
    expect(session.getFinalText()).toBe('last spoken words');
  });

  it('keeps the last live words when Web Speech ends without a final result', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const onFinal = vi.fn();
    const session = await createSelectedSttSession({ onFinal });
    mocks.voiceHandlers.get('voice:partial')?.({ text: 'last spoken words' } as never);

    const stopping = session.stop();
    mocks.voiceHandlers.get('voice:end')?.(undefined as never);
    await stopping;

    expect(session.getFinalText()).toBe('last spoken words');
    expect(onFinal).toHaveBeenLastCalledWith('last spoken words');
  });

  it('joins confirmed and pending Web Speech words once on stop', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const session = await createSelectedSttSession();
    mocks.voiceHandlers.get('voice:partial')?.({ text: 'hello' } as never);
    mocks.voiceHandlers.get('voice:final')?.({ text: 'hello' } as never);
    mocks.voiceHandlers.get('voice:partial')?.({ text: 'world' } as never);

    const stopping = session.stop();
    mocks.voiceHandlers.get('voice:end')?.(undefined as never);
    await stopping;

    expect(session.getFinalText()).toBe('hello world');
  });

  it('preserves the closed browser-recognition startup diagnostic', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const onError = vi.fn();
    const session = await createGlobalDictationSession({ onError });
    const startupMessage = formatVoiceFailure('unknown', 'startup');

    mocks.voiceHandlers.get('voice:error')?.({
      kind: 'unknown',
      message: startupMessage,
    } as never);

    expect(onError).toHaveBeenCalledWith(startupMessage);
    session.cancel();
  });

  it('uses the selected Deepgram streaming session before Web Speech', async () => {
    mocks.composer.provider = 'deepgram';
    mocks.deepgramKey.value = 'dg_key';
    mocks.voiceService.isSupported.mockReturnValue(true);

    const session = await createGlobalDictationSession();

    expect(session.engine).toBe('deepgram');
    expect(mocks.deepgramSession).toHaveBeenCalled();
    expect(mocks.voiceService.startListening).not.toHaveBeenCalled();
    expect(session.getFinalText()).toBe('deepgram text');
    await session.stop();
  });

  it('lets an explicit voice handoff supersede an active selected-STT session', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);

    const first = await createSelectedSttSession();
    const replacement = await createSelectedSttSession(
      {},
      { supersedeActive: true, requester: 'jarvis-voice' },
    );

    expect(mocks.voiceService.stopListening).toHaveBeenCalledOnce();
    expect(mocks.voiceService.startListening).toHaveBeenCalledTimes(2);
    replacement.cancel();
    first.cancel();
  });

  it('forwards confirmed turn completion only from the current selected session', async () => {
    mocks.composer.provider = 'deepgram';
    mocks.deepgramKey.value = 'disposable-test-key';
    const onTurnEnd = vi.fn();
    const first = await createSelectedSttSession({ onTurnEnd });
    const firstEvents = (
      mocks.deepgramSession.mock.calls.at(-1) as unknown as [{ onTurnEnd?: () => void }]
    )[0];
    firstEvents.onTurnEnd?.();
    expect(onTurnEnd).toHaveBeenCalledOnce();
    const replacement = await createSelectedSttSession(
      {},
      { supersedeActive: true, requester: 'jarvis-voice' },
    );
    try {
      firstEvents.onTurnEnd?.();
      expect(onTurnEnd).toHaveBeenCalledOnce();
    } finally {
      first.cancel();
      replacement.cancel();
    }
  });

  it('cancels a late pending capture after an explicit voice handoff supersedes it', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    const firstRecorder = {
      captureWav: () => new Blob(['late'], { type: 'audio/wav' }),
      stop: vi.fn(),
    };
    let resolveFirstRecorder!: (recorder: typeof firstRecorder) => void;
    mocks.composer.startBatchAudioRecorder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRecorder = resolve;
        }),
    );

    const first = createSelectedSttSession();
    await vi.waitFor(() => expect(mocks.composer.startBatchAudioRecorder).toHaveBeenCalledOnce());

    const replacement = await createSelectedSttSession(
      {},
      { supersedeActive: true, requester: 'jarvis-voice' },
    );
    resolveFirstRecorder(firstRecorder);

    await expect(first).rejects.toThrow(/superseded by a newer microphone destination/i);
    expect(firstRecorder.stop).toHaveBeenCalledOnce();
    replacement.cancel();
  });

  it('cancels an in-flight batch transcription immediately and discards its late result', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.fasterWhisper.checkInstalled.mockResolvedValue(true);
    let finish!: (text: string) => void;
    mocks.composer.transcribeFasterWhisper.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const onFinal = vi.fn();
    const onClose = vi.fn();
    const session = await createSelectedSttSession({ onFinal, onClose });
    const stopping = session.stop();
    session.cancel();
    expect.soft(onClose).toHaveBeenCalledOnce();
    finish('discard this cancelled turn');
    await stopping;
    expect(session.getFinalText()).toBe('');
    expect(onFinal).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('never presents transcript length as microphone energy', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const onLevel = vi.fn();
    const session = await createSelectedSttSession({ onLevel });
    try {
      mocks.voiceHandlers.get('voice:partial')?.({
        text: 'A harmless fixed dictation phrase.',
      } as never);
      expect(onLevel.mock.calls.every(([level]) => level === 0)).toBe(true);
    } finally {
      session.cancel();
    }
  });

  it('reports capture readiness and real samples, then releases the meter on cancel', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    let sample!: (level: number) => void;
    const stopMeter = vi.fn();
    mocks.composer.startBatchAudioRecorder.mockImplementationOnce(
      async (onLevel: (level: number) => void) => {
        sample = onLevel;
        return { captureWav: () => null, stop: stopMeter };
      },
    );
    const onOpen = vi.fn();
    const onLevel = vi.fn();
    const session = await createSelectedSttSession({ onOpen, onLevel });
    try {
      expect.soft(onOpen).not.toHaveBeenCalled();
      expect.soft(typeof sample).toBe('function');
      mocks.voiceHandlers.get('voice:start')?.(undefined as never);
      expect(onOpen).toHaveBeenCalledOnce();
      sample?.(0.625);
      expect.soft(onLevel).toHaveBeenLastCalledWith(0.625);
      mocks.voiceHandlers.get('voice:partial')?.({ text: 'A harmless fixed phrase' } as never);
      expect.soft(onLevel).toHaveBeenLastCalledWith(0.625);
    } finally {
      session.cancel();
    }
    expect(stopMeter).toHaveBeenCalledOnce();
    expect(onLevel).toHaveBeenLastCalledWith(0);
    const count = onLevel.mock.calls.length;
    sample?.(0.8);
    expect(onLevel).toHaveBeenCalledTimes(count);
  });

  it('releases its meter immediately when the speech engine reports a terminal microphone failure', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const stopMeter = vi.fn();
    mocks.composer.startBatchAudioRecorder.mockResolvedValueOnce({
      captureWav: () => null,
      stop: stopMeter,
    });
    const onClose = vi.fn();
    const onError = vi.fn();
    const session = await createSelectedSttSession({ onClose, onError });
    try {
      mocks.voiceHandlers.get('voice:error')?.({
        kind: 'audio_capture',
        message: 'The microphone became unavailable.',
      } as never);
      expect(onError).toHaveBeenCalledOnce();
      expect(stopMeter).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      session.cancel();
    }
  });

  it('releases the meter on a terminal engine end without waiting for the HUD to close', async () => {
    mocks.voiceService.isSupported.mockReturnValue(true);
    const stopMeter = vi.fn();
    mocks.composer.startBatchAudioRecorder.mockResolvedValueOnce({
      captureWav: () => null,
      stop: stopMeter,
    });
    const onClose = vi.fn();
    const session = await createSelectedSttSession({ onClose });
    try {
      mocks.voiceHandlers.get('voice:end')?.(undefined as never);
      expect(stopMeter).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      session.cancel();
    }
  });

  it('cancels Deepgram without requesting a final transcription', async () => {
    mocks.composer.provider = 'deepgram';
    mocks.deepgramKey.value = 'disposable-test-key';
    const session = await createSelectedSttSession();
    const engine = await mocks.deepgramSession.mock.results.at(-1)!.value;
    session.cancel();
    expect(engine.cancel).toHaveBeenCalledOnce();
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('does not silently downgrade a selected Deepgram model when its key is missing', async () => {
    mocks.composer.provider = 'deepgram';
    mocks.voiceService.isSupported.mockReturnValue(true);

    await expect(createGlobalDictationSession()).rejects.toThrow(/selected Deepgram/i);
    expect(mocks.voiceService.startListening).not.toHaveBeenCalled();
    expect(mocks.composer.transcribeGroq).not.toHaveBeenCalled();
  });

  it('does not silently downgrade a selected local faster-whisper model', async () => {
    mocks.composer.provider = 'faster-whisper';
    mocks.voiceService.isSupported.mockReturnValue(true);

    await expect(createGlobalDictationSession()).rejects.toThrow(/selected local faster-whisper/i);
    expect(mocks.voiceService.startListening).not.toHaveBeenCalled();
  });

  it('fails with a clear fix path (and an explicit no-Win+H statement) when no engine exists', async () => {
    await expect(createGlobalDictationSession()).rejects.toThrow(/Settings → Speech to Text/);
    await expect(createGlobalDictationSession()).rejects.toThrow(/never uses Windows Win\+H/);
    expect(NO_ENGINE_MESSAGE).toContain('never uses Windows Win+H');
  });

  it('reports a microphone problem distinctly when capture is unavailable', async () => {
    stubMic(false);
    await expect(createGlobalDictationSession()).rejects.toThrow(/microphone permission/i);
  });
});
