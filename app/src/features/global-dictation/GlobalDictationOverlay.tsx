import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Mic, MicOff, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { Toaster } from '@/components/ui/toast';
import { VoiceActivityWaveform } from '@/features/voice/VoiceActivityWaveform';
import { createGlobalDictationSession, type GlobalDictationSession } from './dictationSession';
import {
  formatGlobalDictationEmptyFailure,
  formatGlobalDictationPasteFailure,
  formatGlobalDictationSessionFailure,
  formatGlobalDictationStartupFailure,
} from './dictationFailures';

/**
 * VibeSpace global dictation overlay (Ctrl+Space).
 *
 * Transcribes through the same STT pipeline as VibeSpace chat (local
 * faster-whisper / Web Speech / Deepgram / Groq per Settings) and pastes the
 * transcript into the focused app. Never routes through OS dictation (Win+H).
 */

type OverlayState = 'ready' | 'starting' | 'listening' | 'transcribing' | 'pasting' | 'error';

const STATE_HINT: Record<OverlayState, string> = {
  ready: 'Ctrl+Space · VibeSpace STT',
  starting: 'Starting microphone…',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  pasting: 'Pasting…',
  error: 'Dictation stopped',
};

export interface GlobalDictationOverlayProps {
  runtimeEffectsEnabled?: boolean;
}

export function GlobalDictationOverlay({
  runtimeEffectsEnabled = true,
}: GlobalDictationOverlayProps = {}) {
  const [state, setState] = React.useState<OverlayState>('ready');
  const [partial, setPartial] = React.useState('');
  const [finalText, setFinalText] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState('');
  const [engineLabel, setEngineLabel] = React.useState('');
  const levelRef = React.useRef(0);
  const sessionRef = React.useRef<GlobalDictationSession | null>(null);
  const latestInterimRef = React.useRef('');
  const stateRef = React.useRef<OverlayState>('ready');
  const generationRef = React.useRef(0);
  const startingRef = React.useRef(false);
  const finishWhenReadyRef = React.useRef(false);
  const finalizeRef = React.useRef<() => Promise<void>>(async () => {});
  const pasteTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedTextRef = React.useRef('');
  const updateState = React.useCallback((next: OverlayState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const resetTranscript = React.useCallback(() => {
    setPartial('');
    setFinalText('');
    latestInterimRef.current = '';
    levelRef.current = 0;
  }, []);

  const teardownSession = React.useCallback(() => {
    generationRef.current += 1;
    finishWhenReadyRef.current = false;
    if (pasteTimerRef.current !== null) clearTimeout(pasteTimerRef.current);
    pasteTimerRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.cancel();
  }, []);

  const failVisible = React.useCallback(
    (message: string) => {
      teardownSession();
      updateState('error');
      setErrorMessage(message);
    },
    [teardownSession, updateState],
  );

  const start = React.useCallback(async () => {
    if (
      startingRef.current ||
      sessionRef.current ||
      ['starting', 'transcribing', 'pasting'].includes(stateRef.current)
    )
      return;
    startingRef.current = true;
    const generation = ++generationRef.current;
    const current = () => generationRef.current === generation;
    clearedTextRef.current = '';
    resetTranscript();
    setErrorMessage('');
    updateState('starting');
    try {
      // The hidden WebView outlives Settings changes in the main window.
      await useAuthStore.persist.rehydrate();
      if (!current()) return;
      const session = await createGlobalDictationSession({
        onOpen: () => {
          if (current()) updateState('listening');
        },
        onPartial: (text) => {
          if (!current()) return;
          latestInterimRef.current = text;
          setPartial(text);
        },
        onFinal: (text) => {
          if (!current()) return;
          if (clearedTextRef.current && text.startsWith(clearedTextRef.current))
            text = text.slice(clearedTextRef.current.length).trim();
          latestInterimRef.current = '';
          setFinalText(text);
          setPartial(text);
        },
        onLevel: (level) => {
          if (current()) levelRef.current = level;
        },
        onError: (message) => {
          if (current()) failVisible(formatGlobalDictationSessionFailure(message));
        },
        onClose: () => {
          if (current() && stateRef.current === 'listening') updateState('ready');
        },
      });
      if (!current()) {
        session.cancel();
        return;
      }
      sessionRef.current = session;
      setEngineLabel(session.engineLabel);
      if (finishWhenReadyRef.current) {
        finishWhenReadyRef.current = false;
        void finalizeRef.current();
      }
    } catch (err) {
      if (current()) failVisible(formatGlobalDictationStartupFailure(err));
    } finally {
      startingRef.current = false;
    }
  }, [failVisible, resetTranscript, updateState]);

  /** Finalize the session and paste the transcript into the focused app. */
  const confirmAndPaste = React.useCallback(async () => {
    const session = sessionRef.current;
    if (!session || ['transcribing', 'pasting'].includes(stateRef.current)) return;
    const generation = generationRef.current;
    updateState('transcribing');
    try {
      await session.stop();
    } catch {
      if (generationRef.current === generation)
        failVisible(formatGlobalDictationSessionFailure(''));
      return;
    }
    if (generationRef.current !== generation) return;
    sessionRef.current = null;

    let baseText = (session.getFinalText() || finalText).trim();
    if (clearedTextRef.current && baseText.startsWith(clearedTextRef.current))
      baseText = baseText.slice(clearedTextRef.current.length).trim();
    const interimText = latestInterimRef.current.trim();
    const text =
      baseText && interimText && !baseText.endsWith(interimText)
        ? `${baseText} ${interimText}`
        : baseText || interimText;
    if (!text) {
      if (stateRef.current !== 'error') {
        failVisible(formatGlobalDictationEmptyFailure());
      }
      return;
    }
    updateState('pasting');
    try {
      await getCurrentWindow().hide();
      if (generationRef.current !== generation) return;
      pasteTimerRef.current = setTimeout(() => {
        pasteTimerRef.current = null;
        if (generationRef.current !== generation) return;
        void invoke('dictation_paste_text', { text })
          .then(() => {
            if (generationRef.current === generation) {
              resetTranscript();
              updateState('ready');
            }
          })
          .catch(async (err) => {
            if (generationRef.current !== generation) return;
            // The overlay is hidden at this point - bring it back so the
            // failure is visible instead of vanishing into a hidden toast.
            await getCurrentWindow()
              .show()
              .catch(() => undefined);
            if (generationRef.current === generation)
              failVisible(formatGlobalDictationPasteFailure(err));
          });
      }, 120);
    } catch (err) {
      failVisible(formatGlobalDictationPasteFailure(err));
    }
  }, [failVisible, finalText, resetTranscript, updateState]);
  finalizeRef.current = confirmAndPaste;

  const cancelAndHide = React.useCallback(() => {
    teardownSession();
    resetTranscript();
    setErrorMessage('');
    updateState('ready');
    void getCurrentWindow().hide();
  }, [resetTranscript, teardownSession, updateState]);

  /** Clear the transcript but keep dictating. */
  const clearTranscript = React.useCallback(() => {
    clearedTextRef.current = sessionRef.current?.getFinalText() ?? '';
    resetTranscript();
    const session = sessionRef.current;
    if (session && !session.streaming) {
      // Batch engines buffer raw audio - restart the recorder for a clean take.
      teardownSession();
      updateState('ready');
      void start();
    }
  }, [resetTranscript, start, teardownSession, updateState]);

  const toggleRef = React.useRef(() => {});
  toggleRef.current = () => {
    if (startingRef.current) {
      finishWhenReadyRef.current = true;
      return;
    }
    if (['transcribing', 'pasting'].includes(stateRef.current)) return;
    if (sessionRef.current) void confirmAndPaste();
    else {
      void getCurrentWindow().show();
      void getCurrentWindow().setFocus();
      void start();
    }
  };

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    const onToggle = () => toggleRef.current();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('jarvis:global-dictation-toggle', onToggle).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    window.addEventListener('jarvis:global-dictation-toggle', onToggle);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('jarvis:global-dictation-toggle', onToggle);
    };
  }, [runtimeEffectsEnabled]);

  React.useEffect(() => () => teardownSession(), [teardownSession]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelAndHide();
      }
      if (event.key === 'Enter' && !event.repeat) {
        event.preventDefault();
        if (sessionRef.current) void confirmAndPaste();
        else if (stateRef.current === 'error') void start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelAndHide, confirmAndPaste, runtimeEffectsEnabled, start]);

  const listening = state === 'listening' || state === 'starting';
  const busy = state === 'transcribing' || state === 'pasting';

  return (
    <div className="flex min-h-screen items-center justify-center bg-transparent p-1">
      <div
        data-tauri-drag-region
        data-monochrome-surface="global-dictation"
        className={cn(
          'w-full max-w-[228px] max-h-[112px] overflow-y-auto select-none rounded-2xl border border-accent-copper/45',
          'bg-background/94 px-2.5 py-1.5 text-foreground shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl',
          '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none',
        )}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (sessionRef.current) void confirmAndPaste();
              else void start();
            }}
            disabled={busy || state === 'starting'}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-60',
              listening
                ? 'border-accent-copper bg-accent-copper/18 text-accent-copper'
                : 'border-border bg-panel text-muted-foreground hover:text-foreground',
            )}
            aria-label={sessionRef.current ? 'Stop dictation' : 'Start dictation'}
          >
            {listening ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </button>
          <div data-tauri-drag-region className="min-w-0 flex-1">
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-copper">
              VibeSpace Dictation
            </div>
            <div
              title={state === 'error' ? errorMessage : partial || STATE_HINT[state]}
              role="status"
              className={cn(
                'truncate text-[11px]',
                state === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {state === 'error' ? errorMessage || STATE_HINT.error : partial || STATE_HINT[state]}
            </div>
          </div>
        </div>

        {engineLabel && state !== 'error' && (
          <div className="mt-1 truncate text-[9px] text-muted-foreground/80">{engineLabel}</div>
        )}

        {state === 'error' ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void start()}
                className="flex flex-1 items-center justify-center gap-1 rounded-md border border-accent-copper/50 bg-accent-copper/12 px-2 py-1 text-[10px] font-semibold text-accent-copper hover:bg-accent-copper/20"
                aria-label="Retry dictation"
              >
                <RotateCcw className="h-3 w-3" /> Retry
              </button>
              <button
                type="button"
                onClick={cancelAndHide}
                className="flex items-center justify-center gap-1 rounded-md border border-border bg-panel px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                aria-label="Close dictation"
              >
                <X className="h-3 w-3" /> Close
              </button>
            </div>
            <div className="text-center text-[9px] text-muted-foreground">
              Fix engines in VibeSpace → Settings → Speech to Text
            </div>
          </div>
        ) : (
          <>
            <div className="h-5 [&_canvas]:!h-5">
              <VoiceActivityWaveform levelRef={levelRef} active={listening} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={clearTranscript}
                disabled={busy || (!partial && !finalText)}
                className="rounded-md border border-border bg-panel px-2 py-0.5 text-[9px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                aria-label="Clear transcript"
              >
                Clear
              </button>
              <div className="text-center text-[9px] text-muted-foreground">
                Ctrl+Space paste · Esc cancel
              </div>
            </div>
          </>
        )}
      </div>
      <Toaster />
    </div>
  );
}
