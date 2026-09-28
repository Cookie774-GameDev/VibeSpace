import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VoiceAgentProvider } from '@/stores/auth';
import type { VoiceState } from './store';
import { Orb } from './Orb';
import { VoiceActivityWaveform } from './VoiceActivityWaveform';

export function JarvisVoiceHeader({
  state,
  personaName,
  listeningHint,
  capturePending = false,
  errorMessage,
  voiceAutoListenOnOpen,
  voiceCommitPhrase,
  activeProvider,
  levelRef,
  voiceControlEvidence,
  onClose,
  onToggleListening,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  state: VoiceState;
  personaName: string;
  listeningHint: string;
  capturePending?: boolean;
  errorMessage?: string | null;
  voiceAutoListenOnOpen: boolean;
  voiceCommitPhrase: string;
  activeProvider?: VoiceAgentProvider;
  levelRef: React.RefObject<number>;
  voiceControlEvidence?: string;
  onClose: () => void;
  onToggleListening: () => void;
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onPointerMove: React.PointerEventHandler<HTMLDivElement>;
  onPointerUp: React.PointerEventHandler<HTMLDivElement>;
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>;
}) {
  const errorDetailId = React.useId();
  const controlLabel = capturePending
    ? 'Cancel microphone request'
    : state === 'thinking' || state === 'speaking'
      ? 'Stop response'
      : state === 'listening'
        ? 'Stop listening'
        : state === 'paused'
          ? 'Resume listening'
          : voiceAutoListenOnOpen
            ? 'Start listening'
            : 'Click to talk';
  const controlTitle = capturePending
    ? 'Cancel microphone request'
    : state === 'thinking' || state === 'speaking'
      ? 'Stop Jarvis mid-reply and ask something else'
      : state === 'listening'
        ? 'Stop listening'
        : state === 'paused'
          ? 'Listening paused after silence — click to resume'
          : voiceAutoListenOnOpen
            ? `Hands-free — say "${voiceCommitPhrase}" to send`
            : 'Click to let Jarvis hear you';

  const statusLabel =
    state === 'error' ? 'Voice error' : state === 'listening' ? 'Listening' : listeningHint;

  return (
    <div
      className="jarvis-voice-drag-row cursor-grab active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="jarvis-voice-instrument relative z-[1] flex items-center">
        <button
          type="button"
          onClick={onToggleListening}
          className={cn(
            'jarvis-voice-orb-button flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-copper/80',
            state === 'speaking' && 'is-speaking',
            state === 'listening' && 'is-listening',
          )}
          aria-label={controlLabel}
          aria-pressed={state === 'listening'}
          data-sik-evidence={voiceControlEvidence}
          title={controlTitle}
        >
          <Orb
            state={state}
            ariaLabel="Jarvis voice activity"
            presentation="signal-globe"
            activeProvider={activeProvider}
            levelRef={levelRef}
            className="jarvis-voice-orb"
          />
        </button>
        <div className="jarvis-voice-identity flex min-w-0 flex-col">
          <span className="jarvis-voice-title truncate font-semibold leading-none text-foreground">
            {personaName}
          </span>
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-describedby={state === 'error' && errorMessage ? errorDetailId : undefined}
            title={state === 'error' && errorMessage ? errorMessage : listeningHint}
            className={cn(
              'jarvis-voice-status flex items-center gap-1.5 leading-none text-foreground',
              state === 'error' && 'is-error',
            )}
            data-voice-status={state}
          >
            <span
              className={cn(
                'h-1 w-1 rounded-full',
                state === 'error' ? 'bg-destructive' : 'jarvis-voice-status-dot',
              )}
              aria-hidden="true"
            />
            {statusLabel}
          </span>
        </div>
        <div className="jarvis-voice-meter mx-auto min-w-0 flex-1">
          <VoiceActivityWaveform
            levelRef={levelRef}
            active={state === 'listening' || state === 'speaking' || state === 'thinking'}
          />
        </div>
        <div className="jarvis-voice-actions flex shrink-0 items-center">
          <button
            type="button"
            onClick={onClose}
            className="jarvis-voice-close flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close Jarvis voice session"
            title="Close"
          >
            <X className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {state === 'error' && errorMessage ? (
        <p id={errorDetailId} role="alert" className="jarvis-voice-error-detail">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
