/**
 * VibeSpace global dictation session — shared STT pipeline.
 *
 * The Ctrl+Space overlay uses the saved speech-to-text provider and the same
 * Deepgram option as composer settings. It opens exactly one of local
 * faster-whisper, built-in system speech, or Deepgram streaming. Built-in
 * system speech can fall back to an already-installed local Whisper model only
 * when its speech service reports a network failure; Deepgram never falls back.
 *
 * Privacy: built-in speech uses the browser engine first. Only after its
 * network service fails may the current in-memory take be transcribed by an
 * already-installed local Whisper model. Deepgram is used only when selected.
 * Recognized text is checkpointed in local recovery history; microphone audio
 * is discarded at stop/cancel and is never stored there.
 */

import { isTauri } from '@/lib/utils';
import { createSpeechHistorySession } from '@/features/composer-stt/speechHistory';
import { getDeepgramVoiceKey } from '@/lib/security/voiceKeys';
import { getDeepgramSttOption, readDeepgramSttOption } from '@/lib/deepgram';
import { VoiceService } from '@/features/voice/VoiceService';
import {
  getComposerSttProvider,
  getFasterWhisperModel,
  startBatchAudioRecorder,
  transcribeFasterWhisper,
  type FasterWhisperRecorder,
} from '@/features/composer-stt/composerSttService';
import { FasterWhisperManager } from '@/features/composer-stt/fasterWhisperManager';
import { FASTER_WHISPER_MODELS } from '@/features/composer-stt/catalog';
import { getAudioContextCtor } from '@/features/composer-stt/audio';
import { createDeepgramDictationSession, type DictationEvents } from './deepgramDictation';
import {
  formatGlobalDictationSessionFailure,
  formatGlobalDictationTranscriptionFailure,
  NO_DICTATION_ENGINE_REASON,
} from './dictationFailures';

export type DictationEngineId = 'faster-whisper' | 'web-speech' | 'deepgram';

export interface GlobalDictationSession {
  engine: DictationEngineId;
  engineLabel: string;
  /** Streaming engines emit partials live; batch engines transcribe on stop. */
  streaming: boolean;
  /** Finalize: batch engines transcribe here. Resolves when the final text is ready. */
  stop: () => Promise<void>;
  /** Discard everything without transcribing. */
  cancel: () => void;
  getFinalText: () => string;
}

export const NO_ENGINE_MESSAGE = NO_DICTATION_ENGINE_REASON;

export const SELECTED_STT_SESSION_SUPERSEDED_MESSAGE =
  'The previous VibeSpace dictation request was superseded by a newer microphone destination.';

export interface SelectedSttSessionClaimOptions {
  readonly supersedeActive?: boolean;
  readonly requester?: 'jarvis-voice';
}

interface ActiveSelectedSttClaim {
  readonly token: symbol;
  superseded: boolean;
  cancel: (() => void) | null;
}

let activeSelectedSttClaim: ActiveSelectedSttClaim | null = null;

function micAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

async function fasterWhisperReady(model = getFasterWhisperModel()): Promise<boolean> {
  if (!isTauri || !getAudioContextCtor()) return false;
  try {
    return await FasterWhisperManager.checkInstalled(model);
  } catch {
    return false;
  }
}

function createBatchSession(
  engine: DictationEngineId,
  engineLabel: string,
  transcribe: (blob: Blob) => Promise<string>,
  events: DictationEvents,
): Promise<GlobalDictationSession> {
  let finalText = '';
  let recorder: FasterWhisperRecorder | null = null;
  let done = false;
  let cancelled = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    events.onLevel?.(0);
    events.onClose?.();
  };

  return startBatchAudioRecorder(
    (level) => events.onLevel?.(level),
    () => events.onError?.('No speech detected for a while — press Retry to keep listening.'),
  ).then((started) => {
    recorder = started;
    events.onOpen?.();
    return {
      engine,
      engineLabel,
      streaming: false,
      stop: async () => {
        if (done) return;
        done = true;
        const wav = recorder?.captureWav() ?? null;
        recorder?.stop();
        recorder = null;
        if (!wav || wav.size === 0) {
          close();
          return;
        }
        try {
          const text = (await transcribe(wav)).trim();
          if (!cancelled) {
            finalText = text;
            if (finalText) events.onFinal?.(finalText);
          }
        } catch {
          if (!cancelled) events.onError?.(formatGlobalDictationTranscriptionFailure(engine));
        } finally {
          close();
        }
      },
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        done = true;
        finalText = '';
        recorder?.stop();
        recorder = null;
        close();
      },
      getFinalText: () => finalText,
    };
  });
}

async function createWebSpeechSession(
  events: DictationEvents,
  assertCurrent: () => void,
  autoFinishLocalFallback = false,
): Promise<GlobalDictationSession> {
  let finalText = '';
  let done = false;
  let opened = false;
  let stopping: Promise<void> | null = null;
  let finishStop: (() => void) | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let meter: FasterWhisperRecorder | null = null;
  let checkingLocalFallback = false;
  let usingLocalFallback = false;
  let fallbackCheck: Promise<void> | null = null;
  let fallbackTranscription: Promise<void> | null = null;
  let fallbackModel: ReturnType<typeof getFasterWhisperModel> | null = null;
  let fallbackSilenceTimer: ReturnType<typeof setInterval> | null = null;
  let lastVoiceAt = 0;
  let autoStopFallback: (() => void) | null = null;

  const transcribeLocalFallback = (): Promise<void> => {
    if (fallbackTranscription) return fallbackTranscription;
    const wav = meter?.captureWav() ?? null;
    meter?.stop();
    meter = null;
    fallbackTranscription = (async () => {
      if (!wav || wav.size === 0) {
        if (!done) events.onError?.(formatGlobalDictationSessionFailure('No speech detected'));
        teardown();
        return;
      }
      try {
        const text = (
          await transcribeFasterWhisper(wav, fallbackModel ?? getFasterWhisperModel())
        ).trim();
        if (done) return;
        if (text) {
          finalText = text;
          events.onFinal?.(text);
          if (autoFinishLocalFallback) events.onTurnEnd?.({ forceCommit: true });
        } else {
          events.onError?.(formatGlobalDictationSessionFailure('No speech detected'));
        }
      } catch {
        if (!done) events.onError?.(formatGlobalDictationTranscriptionFailure('faster-whisper'));
      } finally {
        teardown();
      }
    })();
    return fallbackTranscription;
  };

  const beginLocalFallback = (message: string): Promise<void> => {
    if (done || usingLocalFallback || checkingLocalFallback) {
      return fallbackCheck ?? Promise.resolve();
    }
    checkingLocalFallback = true;
    fallbackCheck = (async () => {
      const selectedModel = getFasterWhisperModel();
      let model: ReturnType<typeof getFasterWhisperModel> | null = null;
      for (const candidate of [
        selectedModel,
        ...FASTER_WHISPER_MODELS.map(({ id }) => id).filter((id) => id !== selectedModel),
      ]) {
        if (await fasterWhisperReady(candidate)) {
          model = candidate;
          break;
        }
        if (done) return;
      }
      if (done) return;
      checkingLocalFallback = false;
      if (!model) {
        events.onError?.(formatGlobalDictationSessionFailure(message));
        teardown();
        return;
      }

      fallbackModel = model;
      usingLocalFallback = true;
      if (!opened) {
        opened = true;
        events.onOpen?.();
      }
      events.onStatus?.(
        `Web Speech could not reach its service. Recording locally with Whisper (${model}); ${autoFinishLocalFallback ? 'finishing after you pause.' : 'press Space to finish.'}`,
      );
      if (stopTimer !== null) clearTimeout(stopTimer);
      stopTimer = null;
      VoiceService.stopListening();
      if (autoFinishLocalFallback) {
        fallbackSilenceTimer = setInterval(() => {
          if (lastVoiceAt && Date.now() - lastVoiceAt >= 1_200) autoStopFallback?.();
        }, 150);
      }
      if (stopping) void transcribeLocalFallback();
    })().catch(() => {
      checkingLocalFallback = false;
      if (done) return;
      events.onError?.(formatGlobalDictationSessionFailure(message));
      teardown();
    });
    return fallbackCheck;
  };

  const offs = [
    VoiceService.on('voice:start', () => {
      if (done || opened) return;
      opened = true;
      events.onOpen?.();
    }),
    VoiceService.on('voice:partial', (payload) => {
      const text = (payload as { text?: string })?.text ?? '';
      if (text) events.onPartial?.(text);
    }),
    VoiceService.on('voice:final', (payload) => {
      const text = ((payload as { text?: string })?.text ?? '').trim();
      if (!text) return;
      finalText = `${finalText} ${text}`.trim();
      events.onFinal?.(finalText);
    }),
    VoiceService.on('voice:error', ({ kind, message }) => {
      // Chromium emits these when idle or restarting its continuous session.
      // VoiceService already resumes listening; a normal pause is not a failure.
      if (kind === 'no_speech' || kind === 'aborted') return;
      if (kind === 'network') {
        void beginLocalFallback(message);
        return;
      }
      events.onError?.(formatGlobalDictationSessionFailure(message));
      teardown();
    }),
    VoiceService.on('voice:end', () => {
      if (checkingLocalFallback || usingLocalFallback) return;
      if (stopping || (!VoiceService.isListening() && !VoiceService.wantsListening())) teardown();
    }),
  ];

  const teardown = () => {
    if (done) return;
    done = true;
    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = null;
    if (fallbackSilenceTimer !== null) clearInterval(fallbackSilenceTimer);
    fallbackSilenceTimer = null;
    offs.forEach((off) => off());
    meter?.stop();
    meter = null;
    VoiceService.stopListening();
    events.onClose?.();
    finishStop?.();
  };

  try {
    // SpeechRecognition exposes no samples. Keep the same microphone's PCM
    // in memory for this take so an unreachable browser service can hand the
    // captured audio to an already-installed local Whisper model. Audio is
    // discarded at stop/cancel and never written to dictation history.
    meter = await startBatchAudioRecorder(
      (level) => {
        if (!done) {
          if (level >= 0.12) lastVoiceAt = Date.now();
          events.onLevel?.(level);
        }
      },
      () => {
        if (!done && usingLocalFallback) {
          events.onError?.(formatGlobalDictationSessionFailure('No speech detected'));
          teardown();
        }
      },
      { retainAudio: true },
    );
    assertCurrent();
    VoiceService.setInactivityTimeoutMs(null);
    if (!VoiceService.startListening()) {
      throw new Error('Built-in speech recognition could not start in this window.');
    }
  } catch (error) {
    teardown();
    throw error;
  }

  const session: GlobalDictationSession = {
    engine: 'web-speech',
    engineLabel: 'Built-in speech recognition',
    streaming: true,
    stop: () => {
      if (done) return Promise.resolve();
      if (stopping) return stopping;
      stopping = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      if (usingLocalFallback) {
        void transcribeLocalFallback();
        return stopping;
      }
      if (checkingLocalFallback) return stopping;
      // Keep result listeners alive until recognition's final result/end event.
      // A bounded wait also handles engines that never send an end notification.
      stopTimer = setTimeout(teardown, 1_200);
      VoiceService.stopListening();
      return stopping;
    },
    cancel: () => {
      finalText = '';
      teardown();
    },
    getFinalText: () => finalText,
  };
  autoStopFallback = () => {
    if (fallbackSilenceTimer !== null) clearInterval(fallbackSilenceTimer);
    fallbackSilenceTimer = null;
    void session.stop();
  };
  return session;
}

/**
 * Open exactly the engine selected in Settings. A process-wide token prevents
 * two destinations from opening competing microphone sessions.
 */
export async function createSelectedSttSession(
  events: DictationEvents = {},
  options: SelectedSttSessionClaimOptions = {},
): Promise<GlobalDictationSession> {
  if (!micAvailable()) {
    throw new Error(
      'Microphone capture is not available in this runtime. Check your microphone permission for VibeSpace.',
    );
  }
  const previousClaim = activeSelectedSttClaim;
  if (previousClaim) {
    if (!(options.supersedeActive && options.requester === 'jarvis-voice')) {
      throw new Error(
        'Another VibeSpace dictation session is already using the microphone. Stop it, then try again.',
      );
    }
    previousClaim.superseded = true;
    try {
      previousClaim.cancel?.();
    } finally {
      if (activeSelectedSttClaim === previousClaim) activeSelectedSttClaim = null;
    }
  }

  const token = Symbol('selected-stt-session');
  const claim: ActiveSelectedSttClaim = { token, superseded: false, cancel: null };
  activeSelectedSttClaim = claim;
  let released = false;
  let cancelled = false;
  let closed = false;
  const isCurrent = () =>
    !cancelled && !claim.superseded && activeSelectedSttClaim?.token === token;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error(SELECTED_STT_SESSION_SUPERSEDED_MESSAGE);
  };
  const release = () => {
    if (released) return;
    released = true;
    if (activeSelectedSttClaim?.token === token) activeSelectedSttClaim = null;
  };
  const history = createSpeechHistorySession(getComposerSttProvider());
  let finishing = false;
  let hasFinal = false;
  const scopedEvents: DictationEvents = {
    onOpen: () => {
      if (isCurrent()) events.onOpen?.();
    },
    onStatus: (message) => {
      if (isCurrent()) events.onStatus?.(message);
    },
    onPartial: (text) => {
      if (isCurrent()) {
        history.partial(text);
        events.onPartial?.(text);
      }
    },
    onFinal: (text) => {
      if (isCurrent()) {
        hasFinal = hasFinal || Boolean(text.trim());
        history.final(text);
        events.onFinal?.(text);
      }
    },
    onTurnEnd: (signal) => {
      if (isCurrent()) events.onTurnEnd?.(signal);
    },
    onLevel: (level) => {
      if (isCurrent()) events.onLevel?.(level);
    },
    onError: (message) => {
      if (isCurrent()) {
        history.finish('interrupted');
        events.onError?.(message);
      }
    },
    onClose: () => {
      if (closed) return;
      closed = true;
      if (!finishing) history.finish(hasFinal ? 'completed' : 'interrupted');
      release();
      if (!claim.superseded) {
        events.onLevel?.(0);
        events.onClose?.();
      }
    },
  };
  const adoptSession = (session: GlobalDictationSession): GlobalDictationSession => {
    const wrapped: GlobalDictationSession = {
      ...session,
      stop: async () => {
        finishing = true;
        try {
          await session.stop();
          history.finish('completed');
        } catch (error) {
          history.finish('interrupted');
          throw error;
        } finally {
          release();
        }
      },
      cancel: () => {
        if (cancelled) return;
        // Invalidate publication before an engine's synchronous stop callbacks.
        cancelled = true;
        history.finish('interrupted');
        try {
          session.cancel();
        } finally {
          scopedEvents.onClose?.();
        }
      },
      getFinalText: () => (cancelled || claim.superseded ? '' : session.getFinalText()),
    };
    if (!isCurrent()) {
      try {
        wrapped.cancel();
      } catch {
        release();
      }
      throw new Error(SELECTED_STT_SESSION_SUPERSEDED_MESSAGE);
    }
    claim.cancel = wrapped.cancel;
    return wrapped;
  };

  try {
    const provider = getComposerSttProvider();
    if (provider === 'faster-whisper') {
      const model = getFasterWhisperModel();
      const ready = await fasterWhisperReady();
      assertCurrent();
      if (!ready) {
        throw new Error(
          `The selected local faster-whisper model (${model}) is not ready. Install or repair it in Settings → Speech to Text, then retry.`,
        );
      }
      return adoptSession(
        await createBatchSession(
          'faster-whisper',
          `Local faster-whisper (${model})`,
          (blob) => transcribeFasterWhisper(blob, model),
          scopedEvents,
        ),
      );
    }

    if (provider === 'deepgram') {
      const optionId = readDeepgramSttOption();
      const option = getDeepgramSttOption(optionId);
      const deepgramKey = await getDeepgramVoiceKey();
      assertCurrent();
      if (!deepgramKey) {
        throw new Error(
          `The selected Deepgram model ${option.label} (${option.runtimeModel}, ${option.endpointVersion}/listen) needs a connected Deepgram key. Connect it in Settings → Speech to Text, then retry.`,
        );
      }
      const session = await createDeepgramDictationSession(scopedEvents, optionId);
      return adoptSession({
        engine: 'deepgram',
        engineLabel: `Deepgram · ${option.label} (${option.runtimeModel}, ${option.endpointVersion}/listen)`,
        streaming: true,
        stop: async () => session.stop(),
        cancel: () => session.cancel(),
        getFinalText: () => session.getFinalText(),
      });
    }

    if (!VoiceService.isSupported()) {
      throw new Error(
        `The selected built-in system speech engine is unavailable in this window. ${NO_ENGINE_MESSAGE}`,
      );
    }
    return adoptSession(
      await createWebSpeechSession(
        scopedEvents,
        assertCurrent,
        options.requester === 'jarvis-voice',
      ),
    );
  } catch (error) {
    history.finish('interrupted');
    release();
    throw error;
  }
}

/** Backwards-compatible name for the Ctrl+Space mini-module. */
export const createGlobalDictationSession = createSelectedSttSession;
