/**
 * VibeSpace global dictation session — shared STT pipeline.
 *
 * The Ctrl+Space overlay uses the saved speech-to-text provider and the same
 * Deepgram option as composer settings. It opens exactly one of local
 * faster-whisper, built-in system speech, or Deepgram streaming; it never
 * substitutes another available provider or invokes Windows Win+H.
 *
 * Privacy: audio goes only to the engine listed above that the user's own
 * settings selected (local engines keep it on device). Nothing is stored.
 */

import { isTauri } from '@/lib/utils';
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

async function fasterWhisperReady(): Promise<boolean> {
  if (!isTauri || !getAudioContextCtor()) return false;
  try {
    return await FasterWhisperManager.checkInstalled(getFasterWhisperModel());
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
): Promise<GlobalDictationSession> {
  let finalText = '';
  let done = false;
  let opened = false;
  let meter: FasterWhisperRecorder | null = null;
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
      events.onError?.(formatGlobalDictationSessionFailure(message));
      if (kind !== 'no_speech' && kind !== 'aborted') teardown();
    }),
    VoiceService.on('voice:end', () => {
      if (!VoiceService.isListening() && !VoiceService.wantsListening()) teardown();
    }),
  ];

  const teardown = () => {
    if (done) return;
    done = true;
    offs.forEach((off) => off());
    meter?.stop();
    meter = null;
    VoiceService.stopListening();
    events.onClose?.();
  };

  try {
    // SpeechRecognition exposes no samples. Meter the same system-default
    // microphone without retaining PCM, and own that stream until teardown.
    meter = await startBatchAudioRecorder(
      (level) => {
        if (!done) events.onLevel?.(level);
      },
      () => undefined,
      { retainAudio: false },
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

  return {
    engine: 'web-speech',
    engineLabel: 'Built-in speech recognition',
    streaming: true,
    stop: async () => teardown(),
    cancel: () => {
      finalText = '';
      teardown();
    },
    getFinalText: () => finalText,
  };
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
  const scopedEvents: DictationEvents = {
    onOpen: () => {
      if (isCurrent()) events.onOpen?.();
    },
    onPartial: (text) => {
      if (isCurrent()) events.onPartial?.(text);
    },
    onFinal: (text) => {
      if (isCurrent()) events.onFinal?.(text);
    },
    onTurnEnd: () => {
      if (isCurrent()) events.onTurnEnd?.();
    },
    onLevel: (level) => {
      if (isCurrent()) events.onLevel?.(level);
    },
    onError: (message) => {
      if (isCurrent()) events.onError?.(message);
    },
    onClose: () => {
      if (closed) return;
      closed = true;
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
        try {
          await session.stop();
        } finally {
          release();
        }
      },
      cancel: () => {
        if (cancelled) return;
        // Invalidate publication before an engine's synchronous stop callbacks.
        cancelled = true;
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
    return adoptSession(await createWebSpeechSession(scopedEvents, assertCurrent));
  } catch (error) {
    release();
    throw error;
  }
}

/** Backwards-compatible name for the Ctrl+Space mini-module. */
export const createGlobalDictationSession = createSelectedSttSession;
