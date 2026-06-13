import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast, Toaster } from '@/components/ui/toast';
import { VoiceActivityWaveform } from '@/features/voice/VoiceActivityWaveform';
import { createDeepgramDictationSession } from './deepgramDictation';

type DictationSession = Awaited<ReturnType<typeof createDeepgramDictationSession>>;

export function GlobalDictationOverlay() {
  const [listening, setListening] = React.useState(false);
  const [partial, setPartial] = React.useState('');
  const [finalText, setFinalText] = React.useState('');
  const levelRef = React.useRef(0);
  const sessionRef = React.useRef<DictationSession | null>(null);
  const latestInterimRef = React.useRef('');

  const stop = React.useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.stop();
    setListening(false);
    setPartial('');
    levelRef.current = 0;
    const baseText = (session?.getFinalText() || finalText).trim();
    const interimText = latestInterimRef.current.trim();
    const text =
      baseText && interimText && !baseText.endsWith(interimText)
        ? `${baseText} ${interimText}`
        : baseText || interimText;
    setFinalText('');
    latestInterimRef.current = '';
    if (!text) return;
    try {
      await getCurrentWindow().hide();
      window.setTimeout(() => {
        void invoke('dictation_paste_text', { text }).catch((err) => {
          toast.error('Dictation paste failed', err instanceof Error ? err.message : String(err));
        });
      }, 120);
    } catch (err) {
      toast.error('Dictation paste failed', err instanceof Error ? err.message : String(err));
    }
  }, [finalText]);

  const start = React.useCallback(async () => {
    if (sessionRef.current) {
      await stop();
      return;
    }
    setPartial('Listening...');
    setFinalText('');
    latestInterimRef.current = '';
    try {
      sessionRef.current = await createDeepgramDictationSession({
        onOpen: () => setListening(true),
        onPartial: (text) => {
          latestInterimRef.current = text;
          setPartial(text);
        },
        onFinal: (text) => {
          latestInterimRef.current = '';
          setFinalText(text);
          setPartial(text);
        },
        onLevel: (level) => {
          levelRef.current = level;
        },
        onError: (message) => toast.error('Dictation error', message),
        onClose: () => setListening(false),
      });
    } catch (err) {
      setListening(false);
      setPartial('');
      toast.error('Dictation unavailable', err instanceof Error ? err.message : String(err));
    }
  }, [stop]);

  React.useEffect(() => {
    const onToggle = () => {
      void getCurrentWindow().show();
      void getCurrentWindow().setFocus();
      void start();
    };
    let unlisten: (() => void) | undefined;
    void listen('jarvis:global-dictation-toggle', onToggle).then((off) => {
      unlisten = off;
    });
    window.addEventListener('jarvis:global-dictation-toggle', onToggle);
    return () => {
      unlisten?.();
      window.removeEventListener('jarvis:global-dictation-toggle', onToggle);
    };
  }, [start]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        sessionRef.current?.stop();
        sessionRef.current = null;
        setListening(false);
        setPartial('');
        setFinalText('');
        latestInterimRef.current = '';
        void getCurrentWindow().hide();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-transparent p-2">
      <div
        data-tauri-drag-region
        className={cn(
          'w-[198px] select-none rounded-2xl border border-accent-copper/45',
          'bg-background/94 px-3 py-2 text-foreground shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl',
        )}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => (listening ? void stop() : void start())}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
              listening
                ? 'border-accent-copper bg-accent-copper/18 text-accent-copper'
                : 'border-border bg-panel text-muted-foreground hover:text-foreground',
            )}
            aria-label={listening ? 'Stop dictation' : 'Start dictation'}
          >
            {listening ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </button>
          <div data-tauri-drag-region className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-copper">
              VibeSpace Dictation
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {partial || 'Ctrl+CapsLock'}
            </div>
          </div>
        </div>
        <VoiceActivityWaveform levelRef={levelRef} active={listening} />
        <div className="text-center text-[9px] text-muted-foreground">
          Enter paste · Esc cancel · drag to move
        </div>
      </div>
      <Toaster />
    </div>
  );
}
