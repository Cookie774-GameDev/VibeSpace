import * as React from 'react';
import { Mic, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

  const statusCopy: Record<WakeStatus, { title: string; body: string; tone: string }> = {
    listening: {
      title: 'Wake word active',
      body: 'Say "Jarvis" or "Hey Jarvis"',
      tone: 'border-accent-cyan/35 bg-background/70 text-accent-cyan shadow-[0_0_30px_hsl(var(--accent-cyan)/0.18)]',
    },
    heard: {
      title: 'Jarvis awake',
      body: 'Opening voice',
      tone: 'border-success/45 bg-success/10 text-success shadow-[0_0_34px_hsl(var(--success)/0.18)]',
    },
    unsupported: {
      title: 'Wake unavailable',
      body: 'Use Shift+Tab or Mod+Space',
      tone: 'border-warning/40 bg-warning/10 text-warning',
    },
    blocked: {
      title: 'Mic blocked',
      body: 'Allow microphone access',
      tone: 'border-destructive/40 bg-destructive/10 text-destructive',
    },
  };
  const copy = statusCopy[status];

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setVoiceModalOpen(true)}
      className={cn(
        'fixed bottom-4 right-4 z-[70] h-auto overflow-hidden rounded-full border px-3 py-2 backdrop-blur-xl',
        'jarvis-wake-chip',
        'before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:bg-[radial-gradient(circle_at_30%_20%,hsl(var(--accent-cyan)/0.28),transparent_42%),radial-gradient(circle_at_78%_90%,hsl(var(--accent-violet)/0.22),transparent_46%)]',
        'after:pointer-events-none after:absolute after:inset-px after:rounded-full after:border after:border-white/5',
        'hover:bg-elevated/80 focus-visible:ring-2 focus-visible:ring-ring',
        copy.tone,
      )}
      aria-live="polite"
      aria-label={`${copy.title}. ${copy.body}`}
    >
      <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-background/65 shadow-[inset_0_0_14px_hsl(var(--accent-cyan)/0.22)]">
        {status === 'heard' ? <Sparkles className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        {status === 'listening' ? (
          <span className="absolute inset-0 rounded-full border border-accent-cyan/50 animate-ping" />
        ) : null}
      </span>
      <span className="relative z-10 flex flex-col items-start leading-tight">
        <span className="text-metadata font-semibold uppercase tracking-wide">{copy.title}</span>
        <span className="text-xs text-foreground/80">{copy.body}</span>
      </span>
    </Button>
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
