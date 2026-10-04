import { useDictationHotkey } from './dictationHotkey';
import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { DictationLevelMeter } from './DictationLevelMeter';
import { createGlobalDictationSession, type GlobalDictationSession } from './dictationSession';
import {
  formatGlobalDictationPasteFailure,
  formatGlobalDictationSessionFailure,
  formatGlobalDictationStartupFailure,
} from './dictationFailures';

/**
 * VibeSpace global dictation overlay (the configured global shortcut).
 *
 * Transcribes through the same STT pipeline as VibeSpace chat (local
 * faster-whisper / Web Speech / Deepgram per Settings) and pastes the
 * transcript into the focused app. Never routes through OS dictation (Win+H).
 */

type OverlayState = 'ready' | 'starting' | 'listening' | 'transcribing' | 'pasting' | 'error';

const STATE_HINT: Record<OverlayState, string> = {
  ready: 'VibeSpace STT',
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
  const [statusMessage, setStatusMessage] = React.useState('');
  const [engineLabel, setEngineLabel] = React.useState('');
  const [closeMenuOpen, setCloseMenuOpen] = React.useState(false);
  const levelRef = React.useRef(0);
  const sessionRef = React.useRef<GlobalDictationSession | null>(null);
  // Delivery can fail after recognition succeeds. Keep that take for the next
  // confirmation instead of opening a new microphone and erasing its words.
  const pendingPasteRef = React.useRef('');
  const latestInterimRef = React.useRef('');
  const stateRef = React.useRef<OverlayState>('ready');
  const generationRef = React.useRef(0);
  const startingRef = React.useRef(false);
  const finishWhenReadyRef = React.useRef(false);
  const finalizeRef = React.useRef<() => Promise<void>>(async () => {});
  const clearedTextRef = React.useRef('');
  const updateState = React.useCallback((next: OverlayState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const resetTranscript = React.useCallback(() => {
    pendingPasteRef.current = '';
    setPartial('');
    setFinalText('');
    setStatusMessage('');
    latestInterimRef.current = '';
    levelRef.current = 0;
  }, []);

  const teardownSession = React.useCallback(() => {
    generationRef.current += 1;
    finishWhenReadyRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.cancel();
  }, []);

  const failVisible = React.useCallback(
    (message: string) => {
      // A provider interruption must not erase words already recognized during
      // a long take. Snapshot them before cancelling the provider session.
      let confirmed = sessionRef.current?.getFinalText().trim() ?? '';
      if (clearedTextRef.current && confirmed.startsWith(clearedTextRef.current))
        confirmed = confirmed.slice(clearedTextRef.current.length).trim();
      const interim = latestInterimRef.current.trim();
      pendingPasteRef.current =
        confirmed && interim && !confirmed.endsWith(interim)
          ? `${confirmed} ${interim}`
          : confirmed || interim || pendingPasteRef.current;
      teardownSession();
      setStatusMessage('');
      updateState('error');
      setErrorMessage(
        pendingPasteRef.current
          ? `${message} Recognized words are kept; confirm to insert them into the original text box.`
          : message,
      );
      void getCurrentWindow()
        .show()
        .catch(() => undefined);
    },
    [teardownSession, updateState],
  );

  const start = React.useCallback(async () => {
    if (
      startingRef.current ||
      pendingPasteRef.current ||
      sessionRef.current ||
      ['starting', 'transcribing', 'pasting'].includes(stateRef.current)
    )
      return;
    startingRef.current = true;
    const generation = ++generationRef.current;
    const current = () => generationRef.current === generation;
    clearedTextRef.current = '';
    setCloseMenuOpen(false);
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
        onStatus: (message) => {
          if (current()) setStatusMessage(message);
        },
        onFinal: (text) => {
          if (!current()) return;
          if (clearedTextRef.current && text.startsWith(clearedTextRef.current))
            text = text.slice(clearedTextRef.current.length).trim();
          latestInterimRef.current = '';
          setStatusMessage('');
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
    if (
      (!session && !pendingPasteRef.current) ||
      ['transcribing', 'pasting'].includes(stateRef.current)
    )
      return;
    const generation = generationRef.current;
    updateState('transcribing');
    if (session) {
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
      pendingPasteRef.current = text;
    }
    const text = pendingPasteRef.current;
    if (!text) {
      resetTranscript();
      setCloseMenuOpen(false);
      updateState('ready');
      void invoke('dictation_cancel').catch(() => undefined);
      void getCurrentWindow()
        .hide()
        .catch(() => undefined);
      return;
    }
    updateState('pasting');
    // Native delivery already waits for released shortcut keys and verifies
    // the original destination captured at startup. No renderer timer is needed.
    try {
      await getCurrentWindow().hide();
      if (generationRef.current !== generation) return;
      await invoke('dictation_paste_text', { text });
      if (generationRef.current === generation) {
        resetTranscript();
        setCloseMenuOpen(false);
        updateState('ready');
      }
    } catch (err) {
      if (generationRef.current === generation) {
        session?.markDeliveryFailed?.();
        updateState('error');
        setErrorMessage(
          `${formatGlobalDictationPasteFailure(err)} Your transcript is kept. Return to the original text box and press your dictation shortcut to retry.`,
        );
        void getCurrentWindow()
          .show()
          .catch(() => undefined);
      }
    }
  }, [failVisible, finalText, resetTranscript, updateState]);
  finalizeRef.current = confirmAndPaste;

  const cancelAndHide = React.useCallback(async () => {
    teardownSession();
    resetTranscript();
    setErrorMessage('');
    setCloseMenuOpen(false);
    updateState('ready');
    void invoke('dictation_cancel').catch(() => undefined);
    // Hiding must not wait for native target cleanup or a provider callback.
    // A transient native window failure should still close on the same click.
    try {
      await getCurrentWindow().hide();
    } catch {
      try {
        await getCurrentWindow().hide();
      } catch {
        updateState('error');
        setErrorMessage('Could not close dictation. Click Close or press Esc to retry.');
        setCloseMenuOpen(true);
      }
    }
  }, [resetTranscript, teardownSession, updateState]);

  /** Clear the transcript but keep dictating. */
  const clearTranscript = React.useCallback(() => {
    clearedTextRef.current = sessionRef.current?.getFinalText() ?? '';
    sessionRef.current?.clearRecoveryText?.();
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
    if (sessionRef.current || pendingPasteRef.current) void confirmAndPaste();
    else {
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
        void cancelAndHide();
      }
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;
        event.preventDefault();
        if (sessionRef.current || pendingPasteRef.current) void confirmAndPaste();
        else if (stateRef.current === 'error') void start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelAndHide, confirmAndPaste, runtimeEffectsEnabled, start]);

  const listening = state === 'listening' || state === 'starting';
  const busy = state === 'transcribing' || state === 'pasting';

  const dictationHotkey = useDictationHotkey();
  const hint =
    state === 'error'
      ? errorMessage
      : busy
        ? STATE_HINT[state]
        : statusMessage ||
          partial ||
          (state === 'ready' ? `${dictationHotkey} · VibeSpace STT` : STATE_HINT[state]);
  return (
    <div
      data-tauri-drag-region
      data-monochrome-surface="global-dictation"
      aria-label="VibeSpace Dictation — drag to move"
      onContextMenu={(event) => {
        event.preventDefault();
        setCloseMenuOpen(true);
      }}
      title={`${hint}${engineLabel ? ` · ${engineLabel}` : ''}\nSpace / ${dictationHotkey}: finish · Esc: cancel · Drag to move`}
      className={cn(
        'flex h-[30px] w-[120px] cursor-grab items-center gap-2 overflow-hidden rounded-full border-0 bg-background px-2 shadow-none outline-none active:cursor-grabbing',
        '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-background',
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
      {closeMenuOpen ? (
        <button
          type="button"
          aria-label="Close dictation menu"
          onClick={() => void cancelAndHide()}
          className="min-w-0 flex-1 rounded-full bg-muted px-1 py-0.5 text-center text-[11px] font-medium leading-none text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring [html[data-theme=monochrome]_&]:rounded-sm"
        >
          Close
        </button>
      ) : (
        <div aria-hidden="true" className="pointer-events-none min-w-0 flex-1 [&_canvas]:!h-5">
          {busy ? (
            <div
              data-dictation-progress={state}
              className="flex h-5 items-center justify-center gap-1"
            >
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className="h-1 w-1 animate-pulse rounded-full bg-accent-cyan motion-reduce:animate-none"
                  style={{ animationDelay: `${index * 180}ms` }}
                />
              ))}
            </div>
          ) : listening ? (
            <DictationLevelMeter levelRef={levelRef} />
          ) : (
            <div
              className={cn(
                'h-px rounded-full bg-accent-copper/50',
                state === 'error' && 'bg-destructive',
              )}
            />
          )}
        </div>
      )}
      <div className="sr-only">
        <span>VibeSpace Dictation</span>
        <span role="status">{hint}</span>
        {engineLabel && <span>{engineLabel}</span>}
        <button
          type="button"
          onClick={() => (pendingPasteRef.current ? void confirmAndPaste() : void start())}
          disabled={busy || listening}
          aria-label={state === 'error' ? 'Retry dictation' : 'Start dictation'}
        >
          Retry
        </button>
        <button type="button" onClick={() => void cancelAndHide()} aria-label="Close dictation">
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
