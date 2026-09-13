import {
  nativeDictationHotkey,
  useDictationHotkey,
} from '@/features/global-dictation/dictationHotkey';
import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { formatJarvisVerifiedNarration } from '@/lib/jarvis/response/templates';
import { useUIStore } from '@/stores/ui';
import {
  COMPOSER_STT_STOP_EVENT,
  COMPOSER_STT_TOGGLE_EVENT,
  requestComposerSttToggle,
  type ComposerSttToggleSource,
} from './composerSttService';
import { createSelectedSttSession, type SelectedSttSession } from './selectedSttSession';
import {
  insertTextIntoEditable,
  isGlobalSttEditable,
  mountSttFocusTracking,
  rememberSttEditableFromFocus,
  resolveGlobalSttEditable,
} from './insertText';
import {
  captureSttFieldSnapshot,
  commitSttInField,
  previewSttInField,
  revertSttPreview,
  type SttFieldSnapshot,
} from './sttInterimEditor';
import { startSttVolumeMeter, stopSttVolumeMeter } from './sttVolume';

const FINALIZE_GRACE_MS = 2_500;
const GLOBAL_STT_START_FAILURE = formatJarvisVerifiedNarration({
  kind: 'failure',
  actionLabel: 'Global speech recognition startup',
  reason:
    'Voice-to-text could not start for the focused field. Check microphone access, then try again',
}).text;
const GLOBAL_STT_TARGET_UNAVAILABLE_FAILURE = formatJarvisVerifiedNarration({
  kind: 'failure',
  actionLabel: 'Dictation insertion',
  reason: 'The spoken text could not be inserted because the target field is no longer available',
}).text;
const GLOBAL_STT_INSERTION_REJECTED_FAILURE = formatJarvisVerifiedNarration({
  kind: 'failure',
  actionLabel: 'Dictation insertion',
  reason: 'The spoken text could not be inserted because the focused field did not accept input',
}).text;

function isTextInputField(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

/**
 * Focus-aware speech-to-text for any in-app text field that is not the chat
 * composer or an xterm pane. Top-bar mic and Ctrl+CapsLock dispatch the same
 * toggle event; this host handles agent prompts, settings fields, etc.
 */
export function GlobalSttHost() {
  const composerSttEnabled = useUIStore((s) => s.composerStt);
  const setComposerSttListening = useUIStore((s) => s.setComposerSttListening);
  const dictationHotkey = useDictationHotkey();
  const globalDictationEnabled = useUIStore((s) => s.globalDictationEnabled);
  const [listening, setListening] = React.useState(false);
  const targetRef = React.useRef<HTMLElement | null>(null);
  const snapshotRef = React.useRef<SttFieldSnapshot | null>(null);
  const selectedSessionRef = React.useRef<SelectedSttSession | null>(null);
  const sessionGenerationRef = React.useRef(0);
  const finalizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingFinalRef = React.useRef(false);

  const clearFinalizeTimer = React.useCallback(() => {
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
  }, []);

  const revertPreview = React.useCallback(() => {
    const target = targetRef.current;
    const snapshot = snapshotRef.current;
    if (target && snapshot && isTextInputField(target)) {
      revertSttPreview(target, snapshot);
    }
    snapshotRef.current = null;
  }, []);

  const endSession = React.useCallback(
    (revertOnStop: boolean) => {
      clearFinalizeTimer();
      awaitingFinalRef.current = false;
      if (revertOnStop) revertPreview();
      targetRef.current = null;
      setListening(false);
      setComposerSttListening(false);
      stopSttVolumeMeter();
      const selectedSession = selectedSessionRef.current;
      selectedSessionRef.current = null;
      sessionGenerationRef.current += 1;
      selectedSession?.cancel();
    },
    [clearFinalizeTimer, revertPreview, setComposerSttListening],
  );

  const stop = React.useCallback(() => {
    if (!listening && !awaitingFinalRef.current) return;
    setListening(false);
    setComposerSttListening(false);
    stopSttVolumeMeter();
    awaitingFinalRef.current = true;
    const selectedSession = selectedSessionRef.current;
    if (selectedSession) {
      selectedSessionRef.current = null;
      void selectedSession.stop().finally(() => {
        if (!awaitingFinalRef.current) return;
        clearFinalizeTimer();
        finalizeTimerRef.current = setTimeout(() => {
          awaitingFinalRef.current = false;
          revertPreview();
          targetRef.current = null;
        }, FINALIZE_GRACE_MS);
      });
      return;
    }
    // Session startup is async for every selected engine. A quick second
    // toggle cancels a still-pending startup instead of letting it acquire
    // the microphone after the user has stopped dictating.
    sessionGenerationRef.current += 1;
    awaitingFinalRef.current = false;
    clearFinalizeTimer();
    revertPreview();
    targetRef.current = null;
    snapshotRef.current = null;
  }, [clearFinalizeTimer, listening, revertPreview, setComposerSttListening]);

  const start = React.useCallback(
    (target?: HTMLElement | null) => {
      const focused = target ?? resolveGlobalSttEditable();
      if (!focused || !isGlobalSttEditable(focused)) return;

      const insertFinal = (spoken: string) => {
        const trimmed = spoken.trim();
        if (!trimmed) return;
        const field = targetRef.current;
        if (!field || !document.contains(field) || !isGlobalSttEditable(field)) {
          toast.warning('Dictation', GLOBAL_STT_TARGET_UNAVAILABLE_FAILURE);
          return;
        }
        if (isTextInputField(field)) {
          const snapshot = snapshotRef.current ?? captureSttFieldSnapshot(field);
          if (!commitSttInField(field, snapshot, trimmed)) return;
          snapshotRef.current = captureSttFieldSnapshot(field);
        } else if (!insertTextIntoEditable(field, trimmed)) {
          toast.warning('Dictation', GLOBAL_STT_INSERTION_REJECTED_FAILURE);
          return;
        }
        awaitingFinalRef.current = false;
        clearFinalizeTimer();
        rememberSttEditableFromFocus(field);
      };

      // The same selected-engine session is used for every generic field,
      // including built-in system speech. No field may silently substitute
      // the browser engine for a selected Deepgram or local session.
      const generation = ++sessionGenerationRef.current;
      snapshotRef.current = isTextInputField(focused) ? captureSttFieldSnapshot(focused) : null;
      focused.focus();
      targetRef.current = focused;
      setListening(true);
      setComposerSttListening(true);
      void startSttVolumeMeter();
      void createSelectedSttSession({
        onPartial: (partial) => {
          const field = targetRef.current;
          if (!field || !isTextInputField(field)) return;
          const snapshot = snapshotRef.current ?? captureSttFieldSnapshot(field);
          snapshotRef.current = snapshot;
          previewSttInField(field, snapshot, partial);
        },
        onFinal: insertFinal,
        onError: (message) => {
          endSession(true);
          toast.error('Dictation error', message);
        },
        onClose: () => {
          if (!awaitingFinalRef.current) {
            setListening(false);
            setComposerSttListening(false);
            stopSttVolumeMeter();
          }
        },
      })
        .then((session) => {
          if (sessionGenerationRef.current !== generation) {
            session.cancel();
            return;
          }
          selectedSessionRef.current = session;
        })
        .catch(() => {
          if (sessionGenerationRef.current !== generation) return;
          snapshotRef.current = null;
          targetRef.current = null;
          setListening(false);
          setComposerSttListening(false);
          toast.error('Dictation error', GLOBAL_STT_START_FAILURE);
        });
    },
    [clearFinalizeTimer, endSession, setComposerSttListening],
  );

  React.useEffect(() => mountSttFocusTracking(), []);

  // The switch is persisted in React, but registration itself is native. Keep
  // the OS shortcut in sync on startup and every preference change.
  React.useEffect(() => {
    if (!isTauri) return;
    void invoke('set_global_dictation_enabled', {
      enabled: globalDictationEnabled,
      shortcut: nativeDictationHotkey(dictationHotkey),
    }).catch((error) => {
      toast.error('Dictation shortcut unavailable', String(error));
    });
  }, [globalDictationEnabled, dictationHotkey]);

  React.useEffect(() => {
    const onStop = () => {
      if (listening || awaitingFinalRef.current) stop();
    };
    window.addEventListener(COMPOSER_STT_STOP_EVENT, onStop);
    return () => window.removeEventListener(COMPOSER_STT_STOP_EVENT, onStop);
  }, [listening, stop]);

  React.useEffect(() => {
    const onToggle = (event: Event) => {
      if (!composerSttEnabled) return;
      if (event.defaultPrevented) return;

      const detail = (event as CustomEvent<{ source?: ComposerSttToggleSource }>).detail;
      const fromToolbar = detail?.source === 'toolbar' || detail?.source === 'context-menu';
      const target = resolveGlobalSttEditable();

      if (listening) {
        event.preventDefault?.();
        stop();
        return;
      }

      if (!target) {
        if (fromToolbar) {
          toast.info('Focus a text field', 'Click into a text box, then use voice to text.');
        }
        return;
      }

      event.preventDefault?.();
      start(target);
    };

    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, onToggle);
  }, [composerSttEnabled, listening, start, stop]);

  React.useEffect(
    () => () => {
      clearFinalizeTimer();
      endSession(true);
    },
    [clearFinalizeTimer, endSession],
  );

  return null;
}
