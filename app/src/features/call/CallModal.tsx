import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, PhoneOff, Lock, Unlock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { Orb } from '@/features/voice/Orb';
import { PERSONAS } from '@/features/voice/personas';
import { useCallStore, type CallStatus } from './store';
import { getCallService } from './CallService';

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: 'Ready',
  connecting: 'Connecting…',
  ringing: 'Ringing Sage',
  'in-call': 'On a call',
  ending: 'Hanging up',
  error: 'Call failed',
};

/**
 * In-call modal for Path C voice (in-app WebRTC).
 *
 * Lifecycle:
 *  - Mounts when useUIStore.callModalOpen is true.
 *  - On open, if callStore.status === 'idle', starts the call via CallService.
 *  - Renders the persona's orb, status, transcript, mute, and hangup.
 *  - Closes on hangup OR Esc; the call ends if it was active.
 *
 * The transcript is the cumulative `useCallStore.transcript`. Pipecat in the
 * cloud publishes data messages with role + text on every utterance; we
 * just render them here.
 */
export function CallModal() {
  const open = useUIStore((s) => s.callModalOpen);
  const setOpen = useUIStore((s) => s.setCallModalOpen);

  const status = useCallStore((s) => s.status);
  const errorMessage = useCallStore((s) => s.errorMessage);
  const persona = useCallStore((s) => s.persona);
  const muted = useCallStore((s) => s.muted);
  const transcript = useCallStore((s) => s.transcript);
  const awaitingConfirm = useCallStore((s) => s.awaitingConfirm);
  const unlockActive = useCallStore((s) => s.unlockActive);
  const callId = useCallStore((s) => s.callId);

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Auto-start when the modal opens with no call yet.
  useEffect(() => {
    if (!open) return;
    if (status === 'idle') {
      void getCallService().start(persona);
    }
  }, [open, status, persona]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript.length]);

  // Close on Esc only when not in an active call (avoid accidental hangup)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'in-call') {
        void getCallService().stop();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, status, setOpen]);

  const personaCfg = PERSONAS[persona] ?? PERSONAS.jarvis;

  const handleHangup = async () => {
    await getCallService().stop();
    setOpen(false);
  };

  const handleMute = () => {
    getCallService().setMuted(!muted);
  };

  const orbState = (() => {
    switch (status) {
      case 'connecting':
      case 'ringing':
        return 'thinking';
      case 'in-call':
        return 'listening';
      case 'ending':
        return 'idle';
      case 'error':
        return 'error';
      default:
        return 'idle';
    }
  })() as 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && status === 'in-call') return; setOpen(v); }}>
      <DialogContent className="sm:max-w-[520px] p-0 overflow-hidden">
        <div className="px-6 pt-6 pb-4 flex flex-col items-center gap-3">
          <DialogTitle className="text-base font-semibold tracking-tight">
            {personaCfg.name}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {personaCfg.tone}
          </DialogDescription>

          <div className="my-4">
            <Orb state={orbState} size={140} />
          </div>

          <div className="flex items-center gap-2 text-sm">
            <div
              className={cn(
                'h-2 w-2 rounded-full',
                status === 'in-call' && 'bg-emerald-500 animate-pulse',
                (status === 'connecting' || status === 'ringing') && 'bg-amber-400 animate-pulse',
                status === 'error' && 'bg-rose-500',
                (status === 'idle' || status === 'ending') && 'bg-muted-foreground',
              )}
            />
            <span className="font-medium">{STATUS_LABEL[status]}</span>
            {callId && status === 'in-call' && (
              <span className="text-[10px] text-muted-foreground/70 font-mono ml-1">
                {callId.slice(-6)}
              </span>
            )}
          </div>

          {errorMessage && (
            <div className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-400 max-w-full break-words">
              {errorMessage}
            </div>
          )}

          {unlockActive && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-500">
              <Unlock className="h-3 w-3" /> Shell unlocked for this call
            </div>
          )}
        </div>

        {/* Transcript */}
        <div
          ref={transcriptRef}
          className="px-6 py-3 max-h-[260px] min-h-[120px] overflow-y-auto bg-muted/40 border-y border-border/40 text-sm space-y-2"
        >
          {transcript.length === 0 && status !== 'in-call' && (
            <p className="text-xs text-muted-foreground text-center py-6">
              {status === 'connecting' && 'Setting up the call…'}
              {status === 'ringing' && `${personaCfg.name} is joining…`}
              {status === 'idle' && 'Waiting…'}
              {status === 'error' && 'See error above.'}
            </p>
          )}

          <AnimatePresence initial={false}>
            {transcript.map((entry, idx) => (
              <motion.div
                key={`${entry.ts}-${idx}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  'flex gap-2 leading-snug',
                  entry.role === 'user' ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="shrink-0 text-[10px] uppercase tracking-wider mt-0.5 w-[42px]">
                  {entry.role === 'user' ? 'You' : personaCfg.name}
                </span>
                <span className="flex-1">{entry.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Confirm banner */}
        {awaitingConfirm && (
          <div className="px-6 py-3 bg-amber-500/10 border-b border-amber-500/30 text-xs flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-amber-500" />
            <span>
              <strong>{awaitingConfirm.tool}</strong>: {awaitingConfirm.summary}. Say <em>yes</em> to confirm.
            </span>
          </div>
        )}

        {/* Controls */}
        <div className="px-6 py-4 flex items-center justify-center gap-3">
          <Button
            variant={muted ? 'default' : 'outline'}
            size="icon"
            onClick={handleMute}
            disabled={status !== 'in-call' && status !== 'ringing'}
            aria-label={muted ? 'Unmute' : 'Mute'}
            className="h-10 w-10 rounded-full"
          >
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>

          <Button
            variant="default"
            size="icon"
            onClick={handleHangup}
            aria-label="Hang up"
            className="h-12 w-12 rounded-full bg-rose-600 hover:bg-rose-500 text-white"
          >
            <PhoneOff className="h-5 w-5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
