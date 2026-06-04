import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Mic } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { HOTKEYS } from '@/lib/hotkeys';
import { cn, renderHotkey } from '@/lib/utils';
import { Orb } from './Orb';
import type { VoiceState } from './store';
import { useVoiceStore } from './store';
import { VoiceService } from './VoiceService';
import { PERSONAS } from './personas';

/**
 * The voice modal: a bottom-anchored Dialog showcasing the orb, persona,
 * live transcript, and ambient session controls.
 *
 * Render once at the App root. The component is its own controller:
 *  - subscribes to `useUIStore.voiceModalOpen` to mount/unmount
 *  - drives `useUIStore.voiceListening` so the GlowBorder lights up
 *  - bridges VoiceService events into the voice store while open
 *  - hooks Cmd+Space (Mod+Space) to toggle, even from text inputs
 *
 * Lifecycle is owned by a single effect keyed on `open` so the listener
 * wiring, the listening state machine, and the GlowBorder flag rise and
 * fall as one unit. Closing the modal (Esc, overlay click, hotkey toggle,
 * or Tauri window close) tears everything down.
 */

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Tap to speak',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Voice error',
};

export function VoiceModal() {
  const open = useUIStore((s) => s.voiceModalOpen);
  const setOpen = useUIStore((s) => s.setVoiceModalOpen);

  const state = useVoiceStore((s) => s.state);
  const partial = useVoiceStore((s) => s.partialTranscript);
  const finals = useVoiceStore((s) => s.finalTranscript);
  const persona = useVoiceStore((s) => s.persona);
  const errorMessage = useVoiceStore((s) => s.errorMessage);

  const personaCfg = PERSONAS[persona];

  useEffect(() => {
    if (!open) return;

    // Feature-detect first so the visual mic-state never lies about
    // the engine. Pre-check audit (#1): on hosts without Web Speech
    // we used to flip `voiceListening: true` and label the modal
    // "Listening" even though startListening() bailed with an
    // 'unsupported' error a tick later. Now we only light up the
    // glow + state when the engine can actually run.
    const supported = VoiceService.isSupported();
    if (supported) {
      useUIStore.getState().setVoiceListening(true);
      useVoiceStore.getState().setState('listening');
    } else {
      useVoiceStore.getState().setState('error', 'Built-in speech recognition is not available in this runtime.');
    }

    const offs = [
      VoiceService.on('voice:partial', ({ text }) => {
        useVoiceStore.getState().setPartialTranscript(text);
      }),
      VoiceService.on('voice:final', ({ text }) => {
        useVoiceStore.getState().pushFinalTranscript(text);
      }),
      VoiceService.on('voice:error', ({ kind, message }) => {
        if (kind === 'unsupported') {
          // Mirror to state so the modal shows the message inline,
          // not just a fleeting toast.
          useUIStore.getState().setVoiceListening(false);
          useVoiceStore.getState().setState('error', message);
          toast.info('Voice preview', message);
        } else if (kind === 'no_speech' || kind === 'aborted') {
          // Routine - the engine restarts itself; don't surface noise.
        } else if (
          kind === 'permission_denied' ||
          kind === 'service_not_allowed' ||
          kind === 'audio_capture'
        ) {
          // Terminal — VoiceService has already cleared wantsActive,
          // so we just reflect that in the UI and let the user reopen
          // the modal to retry once they've granted permission.
          useUIStore.getState().setVoiceListening(false);
          useVoiceStore.getState().setState('error', message);
        } else {
          useVoiceStore.getState().setState('error', message);
        }
      }),
      VoiceService.on('voice:timeout', ({ reason }) => {
        useUIStore.getState().setVoiceListening(false);
        useVoiceStore.getState().setState('idle');
        toast.info('Voice paused', reason);
      }),
    ];

    // Always attempt - VoiceService emits 'unsupported' if Web Speech is missing
    // and the listener above converts that into a toast + error state.
    if (supported) VoiceService.startListening();

    return () => {
      offs.forEach((off) => off());
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore.getState().setState('idle');
    };
  }, [open]);

  const lastFinal = finals[finals.length - 1];
  const liveText = partial.trim() || lastFinal?.text || '';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className={cn(
          // Override the default top-1/2 centre with a bottom-anchored placement.
          'top-auto bottom-12 translate-y-0',
          // Wider feel than a standard dialog, but capped for ergonomics.
          'max-w-[460px] w-[92vw] gap-0 p-0',
          // Frosted surface that lets the GlowBorder peek through.
          'border-border/60 bg-elevated/90 backdrop-blur-xl',
          'data-[state=open]:animate-slide-up',
        )}
        hideClose
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {/* Required by Radix for screen readers; visually hidden. */}
        <DialogTitle className="sr-only">Jarvis voice session</DialogTitle>
        <DialogDescription className="sr-only">
          Speak to Jarvis. Press Escape to close. {personaCfg.description}
        </DialogDescription>

        <div className="flex flex-col items-center gap-5 px-6 pb-6 pt-7">
          <Orb state={state} size={170} />

          <div className="flex flex-col items-center gap-1 text-center">
            <div className="text-ui-strong text-foreground tracking-tight">{personaCfg.name}</div>
            <div
              className={cn(
                'text-secondary',
                state === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
              aria-live="polite"
            >
              {state === 'error' && errorMessage ? errorMessage : STATE_LABEL[state]}
            </div>
          </div>

          {/* Live transcript area. Reserve a fixed minimum height so the modal
              doesn't jump as text streams in. */}
          <div className="min-h-[44px] w-full px-2 text-center text-body text-foreground/90">
            <AnimatePresence mode="wait">
              {liveText ? (
                <motion.div
                  key={liveText}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  className="line-clamp-3"
                >
                  &ldquo;{liveText}&rdquo;
                </motion.div>
              ) : (
                <motion.div
                  key="hint"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-secondary text-muted-foreground/70 italic"
                >
                  {personaCfg.tone}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-center gap-2 text-metadata text-muted-foreground">
            <span className="flex items-center gap-1">
              <Mic className="h-3 w-3" /> mic
            </span>
            <span className="opacity-50">·</span>
            <span className="flex items-center gap-1.5">
              <span className="kbd">Esc</span> close
            </span>
            <span className="opacity-50">·</span>
            <span className="flex items-center gap-1.5">
              <span className="kbd">{renderHotkey(HOTKEYS.PUSH_TO_TALK)}</span> toggle
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
