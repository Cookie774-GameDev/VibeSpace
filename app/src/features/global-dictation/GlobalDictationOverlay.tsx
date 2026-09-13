import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { VoiceActivityWaveform } from '@/features/voice/VoiceActivityWaveform';
import { createGlobalDictationSession, type GlobalDictationSession } from './dictationSession';
import {
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
      void getCurrentWindow()
        .show()
        .catch(() => undefined);
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
      await getCurrentWindow().hide();
    } catch (err) {
      failVisible(formatGlobalDictationPasteFailure(err));
      return;
    }
    if (generationRef.current !== generation) return;
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
      resetTranscript();
      updateState('ready');
      void invoke('dictation_cancel').catch(() => undefined);
      return;
    }
    updateState('pasting');
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
        .catch((err) => {
          if (generationRef.current === generation)
            failVisible(formatGlobalDictationPasteFailure(err));
        });
    }, 120);
  }, [failVisible, finalText, resetTranscript, updateState]);
  finalizeRef.current = confirmAndPaste;

  const cancelAndHide = React.useCallback(() => {
    teardownSession();
    resetTranscript();
    setErrorMessage('');
    updateState('ready');
    void invoke('dictation_cancel').catch(() => undefined);
    void getCurrentWindow()
      .hide()
      .catch(() => undefined);
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

  React.useEffect(
    () => () => {
      teardownSession();
      if (runtimeEffectsEnabled) void invoke('dictation_cancel').catch(() => undefined);
    },
    [runtimeEffectsEnabled, teardownSession],
  );

  React.useLayoutEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') !== 'dictation') return;
    document.documentElement.setAttribute('data-vibespace-dictation', '');
    return () => document.documentElement.removeAttribute('data-vibespace-dictation');
  }, []);

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

  const hint = state === 'error' ? errorMessage : partial || STATE_HINT[state];
  return (
    <div
      data-tauri-drag-region
      data-monochrome-surface="global-dictation"
      aria-label="VibeSpace Dictation — drag to move"
      title={`${hint}${engineLabel ? ` · ${engineLabel}` : ''}\nCtrl+Space: finish · Esc: cancel · Drag to move`}
      className={cn(
        'flex h-[30px] w-[120px] cursor-grab items-center gap-1 overflow-hidden rounded-full border border-accent-copper/45 bg-background/95 px-1 active:cursor-grabbing',
        '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background',
      )}
    >
      <style>{`
        html[data-vibespace-dictation],
        html[data-vibespace-dictation] body,
        html[data-vibespace-dictation] #root {
          background: transparent !important;
          overflow: hidden;
        }
      `}</style>
      <img
        src="/vibespace-icon.png"
        alt=""
        draggable={false}
        className="pointer-events-none h-[18px] w-[18px] shrink-0 rounded-full"
      />
      <div aria-hidden="true" className="pointer-events-none min-w-0 flex-1 [&_canvas]:!h-5">
        {listening ? (
          <VoiceActivityWaveform levelRef={levelRef} active />
        ) : (
          <div
            className={cn(
              'h-px rounded-full bg-accent-copper/50',
              state === 'error' && 'bg-destructive',
              busy && 'opacity-40',
            )}
          />
        )}
      </div>
      <div className="sr-only">
        <span>VibeSpace Dictation</span>
        <span role="status">{hint}</span>
        {engineLabel && <span>{engineLabel}</span>}
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || listening}
          aria-label={state === 'error' ? 'Retry dictation' : 'Start dictation'}
        >
          Retry
        </button>
        <button type="button" onClick={cancelAndHide} aria-label="Close dictation">
          Close
        </button>
        <button
          type="button"
          onClick={clearTranscript}
          disabled={busy || (!partial && !finalText)}
          aria-label="Clear transcript"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
