import * as React from 'react';
import { AnimatePresence, motion, useMotionValue } from 'motion/react';
import { Bot, ChevronDown, ChevronUp, Mic, UserRound, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { messageRepo } from '@/lib/db';
import { useChatMessages } from '@/features/chat/hooks';
import type { ChatId, Message } from '@/types';
import type { VoiceState } from './store';
import { useVoiceStore } from './store';
import { VoiceService } from './VoiceService';
import { SPEECH_SYNTHESIS_END_EVENT, SPEECH_SYNTHESIS_START_EVENT } from './speechSynthesis';
import { PERSONAS } from './personas';
import { VoiceActivityWaveform } from './VoiceActivityWaveform';

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Voice error',
};

function messageText(message: Message): string {
  return message.parts
    .filter(
      (part): part is Extract<Message['parts'][number], { kind: 'text' }> => part.kind === 'text',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

const TENDRIL_SEEDS = [
  { angle: 0, lenScale: 1.0, durationBase: 2.3, widthBase: 3 },
  { angle: 45, lenScale: 0.85, durationBase: 2.7, widthBase: 2.5 },
  { angle: 90, lenScale: 0.95, durationBase: 3.1, widthBase: 2 },
  { angle: 135, lenScale: 0.75, durationBase: 2.9, widthBase: 3.5 },
  { angle: 180, lenScale: 1.1, durationBase: 2.1, widthBase: 2.5 },
  { angle: 225, lenScale: 0.9, durationBase: 3.3, widthBase: 2 },
  { angle: 270, lenScale: 0.8, durationBase: 2.5, widthBase: 3 },
  { angle: 315, lenScale: 1.05, durationBase: 2.8, widthBase: 2.5 },
  { angle: 22, lenScale: 0.7, durationBase: 3.7, widthBase: 1.5 },
  { angle: 67, lenScale: 0.65, durationBase: 4.1, widthBase: 1.5 },
  { angle: 157, lenScale: 0.6, durationBase: 3.9, widthBase: 2 },
  { angle: 247, lenScale: 0.75, durationBase: 4.3, widthBase: 1.5 },
];

function SymbioteOrb({ state, size = 40 }: { state: VoiceState; size?: number }) {
  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';
  const isThinking = state === 'thinking';
  const active = isSpeaking || isListening || isThinking;

  const coreSize = size * 0.7;
  const half = size / 2;

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      {/* Ambient halo */}
      <motion.div
        className="absolute rounded-full pointer-events-none"
        style={{
          inset: -size * 0.2,
          background: 'radial-gradient(circle, rgba(255,167,31,0.35) 0%, rgba(207,98,5,0.1) 50%, transparent 70%)',
          filter: 'blur(5px)',
        }}
        animate={{
          scale: isSpeaking ? [1, 1.4, 1.1, 1.5, 1.2, 1] : isListening ? [1, 1.15, 1] : [1, 1.06, 1],
          opacity: isSpeaking ? [0.5, 1, 0.6, 1, 0.5] : [0.3, 0.5, 0.3],
        }}
        transition={{
          duration: isSpeaking ? 0.7 : 3.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Symbiote tendrils */}
      {TENDRIL_SEEDS.map((seed, i) => {
        const rad = (seed.angle * Math.PI) / 180;
        const maxLen = half * seed.lenScale * (isSpeaking ? 1.6 : isListening ? 0.8 : 0.3);
        const duration = seed.durationBase * (isSpeaking ? 0.35 : isListening ? 0.7 : 1);
        const w = seed.widthBase * (isSpeaking ? 1.2 : 0.8);
        const cx = half;
        const cy = half;
        const tipX1 = Math.cos(rad) * maxLen;
        const tipY1 = Math.sin(rad) * maxLen;
        const tipX2 = Math.cos(rad + 0.3) * maxLen * 0.6;
        const tipY2 = Math.sin(rad + 0.3) * maxLen * 0.6;
        const tipX3 = Math.cos(rad - 0.2) * maxLen * 0.85;
        const tipY3 = Math.sin(rad - 0.2) * maxLen * 0.85;

        return (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              left: cx,
              top: cy,
              width: w,
              height: w,
              background: 'radial-gradient(circle, #ff980f 0%, #cf6205 60%, #5b2300 100%)',
              boxShadow: `0 0 ${w * 2}px rgba(255,152,15,${isSpeaking ? 0.7 : 0.3})`,
              transformOrigin: 'center center',
            }}
            animate={{
              x: [0, tipX1, tipX2, tipX3, 0],
              y: [0, tipY1, tipY2, tipY3, 0],
              scaleX: [1, isSpeaking ? 3.5 : 1.5, isSpeaking ? 2 : 1.2, isSpeaking ? 2.8 : 1.3, 1],
              scaleY: [1, 0.6, 0.8, 0.5, 1],
              opacity: active ? [0.15, 0.9, 0.5, 0.8, 0.15] : [0.05, 0.15, 0.05],
              rotate: [0, seed.angle, seed.angle + 15, seed.angle - 10, 0],
            }}
            transition={{
              duration,
              repeat: Infinity,
              ease: [0.42, 0, 0.58, 1],
              delay: i * 0.13,
            }}
          />
        );
      })}

      {/* Core orb - morphing border-radius for organic shape */}
      <motion.div
        className="absolute"
        style={{
          width: coreSize,
          height: coreSize,
          left: (size - coreSize) / 2,
          top: (size - coreSize) / 2,
          background: 'radial-gradient(circle at 38% 34%, #fff7cb 0%, #ffd45a 18%, #ff980f 48%, #cf6205 72%, #5b2300 100%)',
          boxShadow: '0 0 10px rgba(255,167,31,0.9), 0 0 20px rgba(255,152,15,0.4)',
        }}
        animate={{
          borderRadius: isSpeaking
            ? ['50%', '42% 58% 55% 45% / 55% 42% 58% 45%', '58% 42% 45% 55% / 42% 55% 45% 58%', '45% 55% 50% 50% / 50% 45% 55% 50%', '50%']
            : isListening
              ? ['50%', '46% 54% 52% 48% / 52% 46% 54% 48%', '50%']
              : ['50%', '48% 52% 50% 50% / 50% 48% 52% 50%', '50%'],
          x: isSpeaking ? [0, 2, -1.5, 2.5, -2, 0] : 0,
          y: isSpeaking ? [0, -1.5, 2, -2.5, 1, 0] : 0,
          scale: isSpeaking ? [1, 1.08, 0.94, 1.1, 0.96, 1] : isListening ? [1, 1.04, 1] : [1, 1.02, 1],
        }}
        transition={{
          duration: isSpeaking ? 0.8 : isListening ? 2.5 : 4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        <div
          className="absolute rounded-full"
          style={{
            top: '12%', left: '16%', width: '36%', height: '26%',
            background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.08) 60%, transparent 100%)',
            filter: 'blur(1.5px)',
          }}
        />
      </motion.div>
    </div>
  );
}

export function VoiceModal() {
  const open = useUIStore((state) => state.voiceModalOpen);
  const setOpen = useUIStore((state) => state.setVoiceModalOpen);
  const activeChatId = useUIStore((state) => state.activeChatId);
  const messages = useChatMessages(open ? activeChatId : null);
  const state = useVoiceStore((voice) => voice.state);
  const partial = useVoiceStore((voice) => voice.partialTranscript);
  const persona = useVoiceStore((voice) => voice.persona);
  const errorMessage = useVoiceStore((voice) => voice.errorMessage);
  const levelRef = React.useRef(0);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const pendingUtteranceRef = React.useRef('');
  const utteranceTimerRef = React.useRef<number | null>(null);
  const speakingRef = React.useRef(false);
  const personaCfg = PERSONAS[persona];
  const [showTranscript, setShowTranscript] = React.useState(false);

  // Drag state — right-click only, clamped to viewport
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const isDragging = React.useRef(false);
  const dragStart = React.useRef({ x: 0, y: 0, mx: 0, my: 0 });
  const panelRef = React.useRef<HTMLDivElement>(null);

  const handleContextMenu = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleDragStart = React.useCallback((e: React.PointerEvent) => {
    if (e.button !== 2) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: dragX.get(), y: dragY.get(), mx: e.clientX, my: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [dragX, dragY]);

  const handleDragMove = React.useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rawX = dragStart.current.x + (e.clientX - dragStart.current.mx);
    const rawY = dragStart.current.y + (e.clientY - dragStart.current.my);
    const minX = -(rect.left - dragX.get() + rawX - rawX) + 8;
    const maxX = vw - rect.width - (rect.left - dragX.get()) - 8;
    const minY = -(rect.top - dragY.get()) + 8;
    const maxY = vh - rect.height - (rect.top - dragY.get()) - 8;
    const baseLeft = rect.left - dragX.get();
    const baseTop = rect.top - dragY.get();
    const clampedX = Math.max(-(baseLeft - 8), Math.min(rawX, vw - rect.width - baseLeft - 8));
    const clampedY = Math.max(-(baseTop - 8), Math.min(rawY, vh - rect.height - baseTop - 8));
    dragX.set(clampedX);
    dragY.set(clampedY);
  }, [dragX, dragY]);

  const handleDragEnd = React.useCallback(() => {
    isDragging.current = false;
  }, []);

  React.useEffect(() => {
    if (!open) return;

    const supported = VoiceService.isSupported();
    if (supported) {
      useUIStore.getState().setVoiceListening(true);
      useVoiceStore.getState().setState('listening');
      VoiceService.startListening();
    } else {
      useVoiceStore
        .getState()
        .setState('error', 'Speech recognition is unavailable in this runtime.');
    }

    const restartListening = () => {
      if (!useUIStore.getState().voiceModalOpen || speakingRef.current) return;
      window.setTimeout(() => {
        if (!useUIStore.getState().voiceModalOpen || speakingRef.current) return;
        const started = VoiceService.startListening();
        useUIStore.getState().setVoiceListening(started);
        if (started) useVoiceStore.getState().setState('listening');
      }, 180);
    };

    const flushUtterance = () => {
      utteranceTimerRef.current = null;
      const text = pendingUtteranceRef.current.trim();
      pendingUtteranceRef.current = '';
      const chatId = useUIStore.getState().activeChatId;
      if (!text || !chatId) return;

      useVoiceStore.getState().setState('thinking');
      void messageRepo
        .create({
          chat_id: chatId as ChatId,
          role: 'user',
          parts: [{ kind: 'text', text }],
        })
        .then(() => {
          window.dispatchEvent(
            new CustomEvent('jarvis:send', {
              detail: { chatId, text, speakReply: true },
            }),
          );
        })
        .catch((error) => {
          toast.error(
            'Voice message failed',
            error instanceof Error ? error.message : 'Could not send.',
          );
          useVoiceStore.getState().setState('error', 'Could not send the voice message.');
        });
    };

    const offs = [
      VoiceService.on('voice:start', () => {
        useUIStore.getState().setVoiceListening(true);
        useVoiceStore.getState().setState('listening');
      }),
      VoiceService.on('voice:partial', ({ text }) => {
        useVoiceStore.getState().setPartialTranscript(text);
      }),
      VoiceService.on('voice:final', ({ text }) => {
        useVoiceStore.getState().pushFinalTranscript(text);
        pendingUtteranceRef.current = `${pendingUtteranceRef.current} ${text}`.trim();
        if (utteranceTimerRef.current !== null) window.clearTimeout(utteranceTimerRef.current);
        utteranceTimerRef.current = window.setTimeout(flushUtterance, 550);
      }),
      VoiceService.on('voice:error', ({ kind, message }) => {
        if (kind === 'no_speech' || kind === 'aborted') {
          restartListening();
          return;
        }
        if (
          kind === 'permission_denied' ||
          kind === 'service_not_allowed' ||
          kind === 'audio_capture'
        ) {
          useUIStore.getState().setVoiceListening(false);
          useVoiceStore.getState().setState('error', message);
          return;
        }
        useVoiceStore.getState().setState('error', message);
      }),
      VoiceService.on('voice:timeout', () => restartListening()),
      VoiceService.on('voice:end', () => restartListening()),
    ];

    const onSpeechStart = () => {
      speakingRef.current = true;
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore.getState().setState('speaking');
    };
    const onSpeechEnd = () => {
      speakingRef.current = false;
      restartListening();
    };
    window.addEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);

    return () => {
      offs.forEach((off) => off());
      if (utteranceTimerRef.current !== null) window.clearTimeout(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
      pendingUtteranceRef.current = '';
      window.removeEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
      window.removeEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore.getState().setState('idle');
    };
  }, [open]);

  React.useEffect(() => {
    if (!open || !navigator.mediaDevices?.getUserMedia) return;

    let disposed = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let animationFrame = 0;

    void navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((nextStream) => {
        if (disposed) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = nextStream;
        const AudioCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtor) return;
        audioContext = new AudioCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const update = () => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (const value of data) sum += value;
          levelRef.current = Math.min(1, sum / Math.max(1, data.length) / 40);
          animationFrame = window.requestAnimationFrame(update);
        };
        animationFrame = window.requestAnimationFrame(update);
      })
      .catch(() => {
        levelRef.current = 0;
      });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      stream?.getTracks().forEach((track) => track.stop());
      if (audioContext) void audioContext.close().catch(() => undefined);
      levelRef.current = 0;
    };
  }, [open]);

  React.useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, partial]);

  if (!open) return null;

  const transcript = messages
    .filter(
      (message) =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'agent',
    )
    .map((message) => ({ ...message, displayText: messageText(message) }))
    .filter((message) => message.displayText);
  const visibleTranscript = transcript.slice(-3);

  return (
    <AnimatePresence>
      <motion.aside
        ref={panelRef}
        initial={{ opacity: 0, x: 16, y: -6, scale: 0.96 }}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        exit={{ opacity: 0, x: 12, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30 }}
        style={{ x: dragX, y: dragY }}
        className="fixed right-3 top-3 z-[90] w-[178px] overflow-hidden rounded-[10px] border border-border-mid/80 bg-elevated/95 shadow-[0_12px_36px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_20px_hsl(var(--accent-copper)/0.1)] backdrop-blur-xl"
        aria-label="Jarvis voice session"
        onContextMenu={handleContextMenu}
      >
        {/* Right-click drag handle */}
        <div
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Close Jarvis voice session"
            title="Close"
          >
            <X className="h-2.5 w-2.5" />
          </button>

          <div className="flex items-center gap-2 px-2.5 pb-1 pt-2.5">
            <SymbioteOrb state={state} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium leading-4 text-foreground">
                {personaCfg.name}
              </div>
              <div
                className={cn(
                  'mt-0.5 flex items-center gap-1 text-[10px] leading-3',
                  state === 'error' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    state === 'error'
                      ? 'bg-destructive'
                      : 'bg-success shadow-[0_0_6px_hsl(var(--success)/0.75)]',
                  )}
                />
                <span className="truncate">
                  {state === 'error' && errorMessage ? errorMessage : STATE_LABEL[state]}
                </span>
              </div>
            </div>
            <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-border bg-background/60 shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04)]">
              <Mic className="h-3 w-3 text-muted-foreground" strokeWidth={1.8} />
            </div>
          </div>
        </div>

        <div className="px-2.5 pb-1 pt-0">
          <VoiceActivityWaveform levelRef={levelRef} active={state === 'listening'} />
        </div>

        {/* Transcript dropdown toggle */}
        <button
          type="button"
          onClick={() => setShowTranscript((v) => !v)}
          className="flex w-full items-center justify-center gap-1 border-t border-border-mid/50 px-2.5 py-1 text-[9px] text-muted-foreground/70 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
        >
          <span>Transcript</span>
          {showTranscript
            ? <ChevronUp className="h-2.5 w-2.5" />
            : <ChevronDown className="h-2.5 w-2.5" />
          }
        </button>

        <AnimatePresence>
          {showTranscript && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div
                ref={transcriptRef}
                className="max-h-[72px] space-y-1 overflow-y-auto px-2.5 pb-2 pt-1"
              >
                {transcript.length === 0 && !partial ? (
                  <div className="flex h-[24px] items-center justify-center text-center text-[9px] text-muted-foreground">
                    {activeChatId ? 'Listening...' : 'Open a chat first.'}
                  </div>
                ) : null}
                {visibleTranscript.map((message) => {
                  const user = message.role === 'user';
                  return (
                    <div
                      key={message.id}
                      className="grid grid-cols-[14px_36px_1fr] items-center gap-0.5 text-[9px] leading-3.5"
                    >
                      <span
                        className={cn(
                          'flex h-[14px] w-[14px] items-center justify-center rounded-full border',
                          user
                            ? 'border-info/80 text-info'
                            : 'border-accent-copper/80 text-accent-copper',
                        )}
                      >
                        {user ? <UserRound className="h-2 w-2" /> : <Bot className="h-2 w-2" />}
                      </span>
                      <span className={cn('text-[9px] font-medium', user ? 'text-info' : 'text-accent-copper')}>
                        {user ? 'You' : 'Jarvis:'}
                      </span>
                      <span className="min-w-0 truncate text-foreground/80">{message.displayText}</span>
                    </div>
                  );
                })}
                {partial ? (
                  <div className="grid grid-cols-[14px_36px_1fr] items-center gap-0.5 text-[9px] leading-3.5">
                    <span className="flex h-[14px] w-[14px] items-center justify-center rounded-full border border-info/80 text-info">
                      <UserRound className="h-2 w-2" />
                    </span>
                    <span className="text-[9px] font-medium text-info">You</span>
                    <span className="min-w-0 truncate text-foreground/70">{partial}</span>
                  </div>
                ) : null}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.aside>
    </AnimatePresence>
  );
}
