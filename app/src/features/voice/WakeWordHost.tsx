import * as React from 'react';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { containsWakePhrase, readWakeWordEnabled, WAKE_WORD_SETTING_EVENT } from './wakeWord';
import { VOICE_EXCLUSIVE_START_EVENT, VOICE_EXCLUSIVE_STOP_EVENT } from './VoiceService';
import { speakText, VOICE_ACKNOWLEDGEMENT_TEXT } from './speechSynthesis';

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface WakeSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
}

type WakeSpeechRecognitionCtor = new () => WakeSpeechRecognition;
type WakeStatus = 'listening' | 'heard' | 'unsupported' | 'blocked';

function getRecognitionCtor(): WakeSpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as unknown as {
    SpeechRecognition?: WakeSpeechRecognitionCtor;
    webkitSpeechRecognition?: WakeSpeechRecognitionCtor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function WakeWordHost() {
  const voiceModalOpen = useUIStore((state) => state.voiceModalOpen);
  const setVoiceModalOpen = useUIStore((state) => state.setVoiceModalOpen);
  const [enabled, setEnabled] = React.useState(() => readWakeWordEnabled());
  const [status, setStatus] = React.useState<WakeStatus>('listening');
  const recognitionRef = React.useRef<WakeSpeechRecognition | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const syncFromStorage = () => setEnabled(readWakeWordEnabled());
    const onSetting = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      setEnabled(Boolean(detail?.enabled));
    };

    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(WAKE_WORD_SETTING_EVENT, onSetting);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(WAKE_WORD_SETTING_EVENT, onSetting);
    };
  }, []);

  React.useEffect(() => {
    if (!enabled || voiceModalOpen) {
      stopRecognition(recognitionRef);
      clearRestart(restartTimerRef);
      return;
    }

    const RecognitionCtor = getRecognitionCtor();
    if (!RecognitionCtor) {
      setStatus('unsupported');
      return;
    }

    let disposed = false;

    const scheduleRestart = () => {
      clearRestart(restartTimerRef);
      if (disposed || !readWakeWordEnabled() || useUIStore.getState().voiceModalOpen) return;
      restartTimerRef.current = window.setTimeout(startRecognition, 800);
    };

    const onExclusiveStart = () => {
      clearRestart(restartTimerRef);
      stopRecognition(recognitionRef);
    };
    const onExclusiveStop = () => {
      scheduleRestart();
    };

    const startRecognition = () => {
      if (disposed || recognitionRef.current) return;
      const recognition = new RecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = 'en-US';
      recognition.onresult = (event) => {
        const transcripts: string[] = [];
        for (
          let resultIndex = event.resultIndex;
          resultIndex < event.results.length;
          resultIndex += 1
        ) {
          const result = event.results[resultIndex];
          const alternative = result[0];
          if (alternative?.transcript) transcripts.push(alternative.transcript);
        }
        if (!containsWakePhrase(transcripts.join(' '))) return;

        setStatus('heard');
        toast.success('Hey Jarvis heard', 'Opening voice.');
        stopRecognition(recognitionRef);
        setVoiceModalOpen(true);
        window.setTimeout(() => {
          void speakText(VOICE_ACKNOWLEDGEMENT_TEXT).catch((err) => {
            toast.warning(
              'Voice acknowledgement unavailable',
              err instanceof Error ? err.message : 'Jarvis could not play the acknowledgement.',
            );
          });
        }, 140);
      };
      recognition.onerror = (event) => {
        const blocked =
          event.error === 'not-allowed' ||
          event.error === 'service-not-allowed' ||
          event.error === 'audio-capture';
        if (blocked) {
          setStatus('blocked');
          stopRecognition(recognitionRef);
          return;
        }
        stopRecognition(recognitionRef);
        scheduleRestart();
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        scheduleRestart();
      };

      recognitionRef.current = recognition;
      setStatus('listening');
      try {
        recognition.start();
      } catch {
        recognitionRef.current = null;
        scheduleRestart();
      }
    };

    window.addEventListener(VOICE_EXCLUSIVE_START_EVENT, onExclusiveStart);
    window.addEventListener(VOICE_EXCLUSIVE_STOP_EVENT, onExclusiveStop);
    startRecognition();

    return () => {
      disposed = true;
      window.removeEventListener(VOICE_EXCLUSIVE_START_EVENT, onExclusiveStart);
      window.removeEventListener(VOICE_EXCLUSIVE_STOP_EVENT, onExclusiveStop);
      clearRestart(restartTimerRef);
      stopRecognition(recognitionRef);
    };
  }, [enabled, setVoiceModalOpen, voiceModalOpen]);

  if (!enabled || voiceModalOpen) return null;

  return (
    <button
      type="button"
      onClick={() => setVoiceModalOpen(true)}
      className="fixed bottom-4 right-4 z-[70] flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      aria-live="polite"
      aria-label={status === 'listening' ? 'Wake word active. Click to open Jarvis.' : status === 'heard' ? 'Jarvis awake.' : 'Wake word indicator'}
    >
      <span className="relative flex h-6 w-6 items-center justify-center">
        <span
          className={cn(
            'absolute inset-0 rounded-full',
            status === 'listening' && 'animate-ping',
          )}
          style={{
            background: 'radial-gradient(circle at 38% 34%, #fff7cb 0%, #ffd45a 18%, #ff980f 48%, #cf6205 72%, #5b2300 100%)',
            opacity: status === 'listening' ? 0.4 : 0,
          }}
        />
        <span
          className="relative h-6 w-6 rounded-full animate-pulse"
          style={{
            background: 'radial-gradient(circle at 38% 34%, #fff7cb 0%, #ffd45a 18%, #ff980f 48%, #cf6205 72%, #5b2300 100%)',
            boxShadow: '0 0 10px rgba(255, 167, 31, 0.8), 0 0 20px rgba(255, 152, 15, 0.4)',
          }}
        />
      </span>
    </button>
  );
}

function clearRestart(restartTimerRef: React.MutableRefObject<number | null>): void {
  if (restartTimerRef.current === null) return;
  window.clearTimeout(restartTimerRef.current);
  restartTimerRef.current = null;
}

function stopRecognition(
  recognitionRef: React.MutableRefObject<WakeSpeechRecognition | null>,
): void {
  const recognition = recognitionRef.current;
  if (!recognition) return;
  recognitionRef.current = null;
  recognition.onend = null;
  try {
    recognition.abort();
  } catch {
    try {
      recognition.stop();
    } catch {
      // no-op
    }
  }
}
