import * as React from 'react';
import { AnimatePresence, motion, useMotionValue } from 'motion/react';
import { Bot, ChevronDown, ChevronUp, Mic, UserRound, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { messageRepo } from '@/lib/db';
import { useChatMessages } from '@/features/chat/hooks';
import { ensureActiveChat } from '@/features/chat/chatLifecycle';
import type { ChatId, Message } from '@/types';
import type { VoiceState } from './store';
import { useVoiceStore } from './store';
import { VoiceService } from './VoiceService';
import { SPEECH_SYNTHESIS_END_EVENT, SPEECH_SYNTHESIS_START_EVENT } from './speechSynthesis';
import { PERSONAS } from './personas';
import { VoiceActivityWaveform } from './VoiceActivityWaveform';
import { stopAllVoiceOutput } from './voiceRouter';

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

const SymbioteOrb = React.memo(function SymbioteOrb({
  state,
  size = 40,
}: {
  state: VoiceState;
  size?: number;
}) {
  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';
  const isThinking = state === 'thinking';
  const active = isSpeaking || isListening || isThinking;
  const showTendrils = active;

  const coreSize = size * 0.65;
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
          inset: -size * 0.25,
          background: 'radial-gradient(circle, rgba(255,167,31,0.4) 0%, rgba(207,98,5,0.15) 45%, transparent 70%)',
          filter: 'blur(6px)',
        }}
        animate={{
          scale: isSpeaking
            ? [1, 1.6, 1.15, 1.7, 1.3, 1.55, 1]
            : isListening ? [1, 1.25, 1.08, 1.2, 1] : [1, 1.06, 1],
          opacity: isSpeaking
            ? [0.5, 1, 0.7, 1, 0.6, 0.9, 0.5]
            : isListening ? [0.4, 0.7, 0.4] : [0.25, 0.4, 0.25],
        }}
        transition={{
          duration: isSpeaking ? 0.5 : isListening ? 2 : 3.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Symbiote tendrils — only while active to keep the rest of the app responsive */}
      {showTendrils
        ? TENDRIL_SEEDS.map((seed, i) => {
        const rad = (seed.angle * Math.PI) / 180;
        const maxLen = half * seed.lenScale * (isSpeaking ? 2.2 : isListening ? 1.2 : isThinking ? 0.7 : 0.35);
        const duration = seed.durationBase * (isSpeaking ? 0.22 : isListening ? 0.55 : isThinking ? 0.7 : 1);
        const w = seed.widthBase * (isSpeaking ? 1.5 : isListening ? 1.1 : 0.8);
        const cx = half;
        const cy = half;
        const tipX1 = Math.cos(rad) * maxLen;
        const tipY1 = Math.sin(rad) * maxLen;
        const tipX2 = Math.cos(rad + 0.4) * maxLen * 0.7;
        const tipY2 = Math.sin(rad + 0.4) * maxLen * 0.7;
        const tipX3 = Math.cos(rad - 0.3) * maxLen * 0.9;
        const tipY3 = Math.sin(rad - 0.3) * maxLen * 0.9;
        const tipX4 = Math.cos(rad + 0.15) * maxLen * 0.5;
        const tipY4 = Math.sin(rad + 0.15) * maxLen * 0.5;

        return (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              left: cx,
              top: cy,
              width: w,
              height: w,
              background:
                'radial-gradient(circle at 35% 30%, #4a4a48 0%, #111 28%, #020202 72%, #000 100%)',
              boxShadow: `0 0 ${w * 1.8}px rgba(255,174,44,${isSpeaking ? 0.35 : isListening ? 0.2 : 0.08}), inset 0 0 ${w}px rgba(255,255,255,0.16)`,
              transformOrigin: 'center center',
            }}
            animate={{
              x: [0, tipX1, tipX2, tipX4, tipX3, 0],
              y: [0, tipY1, tipY2, tipY4, tipY3, 0],
              scaleX: isSpeaking
                ? [1, 5, 2.5, 4, 3, 1]
                : isListening ? [1, 2.5, 1.5, 2, 1] : [1, 1.3, 1],
              scaleY: isSpeaking
                ? [1, 0.4, 0.7, 0.35, 0.6, 1]
                : [1, 0.7, 1],
              opacity: isSpeaking
                ? [0.2, 1, 0.6, 0.9, 0.7, 0.2]
                : isListening ? [0.1, 0.7, 0.3, 0.6, 0.1] : active ? [0.05, 0.2, 0.05] : [0.03, 0.1, 0.03],
              rotate: [0, seed.angle, seed.angle + 20, seed.angle - 15, seed.angle + 8, 0],
            }}
            transition={{
              duration,
              repeat: Infinity,
              ease: [0.42, 0, 0.58, 1],
              delay: i * 0.09,
            }}
          />
        );
      })
        : null}

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
            ? ['50%', '38% 62% 58% 42% / 58% 38% 62% 42%', '62% 38% 42% 58% / 38% 58% 42% 62%', '42% 58% 52% 48% / 52% 42% 58% 48%', '55% 45% 48% 52% / 48% 55% 45% 52%', '50%']
            : isListening
              ? ['50%', '44% 56% 54% 46% / 54% 44% 56% 46%', '56% 44% 46% 54% / 44% 54% 46% 56%', '50%']
              : ['50%', '47% 53% 51% 49% / 51% 47% 53% 49%', '50%'],
          x: isSpeaking ? [0, 3, -2, 3.5, -2.5, 1, 0] : isListening ? [0, 1, -0.5, 0] : 0,
          y: isSpeaking ? [0, -2, 3, -3.5, 2, -1, 0] : isListening ? [0, -0.5, 1, 0] : 0,
          scale: isSpeaking
            ? [1, 1.14, 0.88, 1.18, 0.92, 1.06, 1]
            : isListening ? [1, 1.06, 0.97, 1] : [1, 1.02, 1],
        }}
        transition={{
          duration: isSpeaking ? 0.55 : isListening ? 2 : 4,
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
});

export function VoiceModal() {
  const open = useUIStore((state) => state.voiceModalOpen);
  const setOpen = useUIStore((state) => state.setVoiceModalOpen);
  const activeChatId = useUIStore((state) => state.activeChatId);
  const voiceAutoListenOnOpen = useAuthStore((state) => state.voiceAutoListenOnOpen);
  const voiceSilenceDelayMs = useAuthStore((state) => state.voiceSilenceDelayMs);
  const [showTranscript, setShowTranscript] = React.useState(false);
  const messages = useChatMessages(open && showTranscript ? activeChatId : null);
  const state = useVoiceStore((voice) => voice.state);
  const partial = useVoiceStore((voice) => voice.partialTranscript);
  const persona = useVoiceStore((voice) => voice.persona);
  const errorMessage = useVoiceStore((voice) => voice.errorMessage);
  const levelRef = React.useRef(0);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const pendingUtteranceRef = React.useRef('');
  const utteranceTimerRef = React.useRef<number | null>(null);
  const speakingRef = React.useRef(false);
  const listeningArmedRef = React.useRef(false);
  const personaCfg = PERSONAS[persona];

  // Drag state — primary-button drag on the panel chrome, clamped to viewport
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const isDragging = React.useRef(false);
  const dragStart = React.useRef({ x: 0, y: 0, mx: 0, my: 0 });
  const panelRef = React.useRef<HTMLDivElement>(null);

  const handleDragStart = React.useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
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

  const stopListening = React.useCallback((nextState: VoiceState = 'idle') => {
    listeningArmedRef.current = false;
    VoiceService.stopListening();
    useUIStore.getState().setVoiceListening(false);
    useVoiceStore.getState().setPartialTranscript('');
    useVoiceStore.getState().setState(nextState);
  }, []);

  const startListening = React.useCallback(() => {
    const supported = VoiceService.isSupported();
    if (!supported) {
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore
        .getState()
        .setState('error', 'Speech recognition is unavailable in this runtime.');
      return false;
    }
    listeningArmedRef.current = true;
    const started = VoiceService.startListening();
    useUIStore.getState().setVoiceListening(started);
    if (started) {
      useVoiceStore.getState().setState('listening');
    } else {
      listeningArmedRef.current = false;
    }
    return started;
  }, []);

  const toggleListening = React.useCallback(() => {
    if (state === 'listening' || useUIStore.getState().voiceListening) {
      stopListening('idle');
      return;
    }
    if (!voiceAutoListenOnOpen) {
      listeningArmedRef.current = true;
    }
    startListening();
  }, [startListening, state, stopListening, voiceAutoListenOnOpen]);

  React.useEffect(() => {
    if (!open) return;
    listeningArmedRef.current = voiceAutoListenOnOpen;
    if (voiceAutoListenOnOpen) startListening();
    else useVoiceStore.getState().setState('idle');

    const handsFree = () => useAuthStore.getState().voiceAutoListenOnOpen;

    const restartListening = () => {
      if (!useUIStore.getState().voiceModalOpen || speakingRef.current || !listeningArmedRef.current) return;
      if (!handsFree() && !listeningArmedRef.current) return;
      window.setTimeout(() => {
        if (!useUIStore.getState().voiceModalOpen || speakingRef.current || !listeningArmedRef.current) return;
        startListening();
      }, 180);
    };

    const disarmPushToTalk = () => {
      if (handsFree()) return;
      listeningArmedRef.current = false;
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
    };

    const flushUtterance = () => {
      utteranceTimerRef.current = null;
      const text = pendingUtteranceRef.current.trim();
      pendingUtteranceRef.current = '';
      if (!text) return;

      disarmPushToTalk();
      useVoiceStore.getState().setState('thinking');
      void (async () => {
        let chatId = useUIStore.getState().activeChatId;
        if (!chatId) {
          chatId = (await ensureActiveChat({ titleHint: text })) as string | null;
        }
        if (!chatId) {
          useVoiceStore.getState().setState('error', 'Open a chat first.');
          return;
        }

        try {
          await messageRepo.create({
            chat_id: chatId as ChatId,
            role: 'user',
            parts: [{ kind: 'text', text }],
          });
          window.dispatchEvent(
            new CustomEvent('jarvis:send', {
              detail: { chatId, text, speakReply: true },
            }),
          );
        } catch (error) {
          toast.error(
            'Voice message failed',
            error instanceof Error ? error.message : 'Could not send.',
          );
          useVoiceStore.getState().setState('error', 'Could not send the voice message.');
        }
      })();
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
        const delay = useAuthStore.getState().voiceSilenceDelayMs;
        utteranceTimerRef.current = window.setTimeout(flushUtterance, delay);
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
      if (handsFree()) {
        listeningArmedRef.current = true;
        restartListening();
      } else {
        useVoiceStore.getState().setState('idle');
      }
    };
    window.addEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);

    return () => {
      offs.forEach((off) => off());
      if (utteranceTimerRef.current !== null) window.clearTimeout(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
      pendingUtteranceRef.current = '';
      listeningArmedRef.current = false;
      window.removeEventListener(SPEECH_SYNTHESIS_START_EVENT, onSpeechStart);
      window.removeEventListener(SPEECH_SYNTHESIS_END_EVENT, onSpeechEnd);
      VoiceService.stopListening();
      useUIStore.getState().setVoiceListening(false);
      useVoiceStore.getState().setState('idle');
      stopAllVoiceOutput();
    };
  }, [open, startListening, voiceAutoListenOnOpen, voiceSilenceDelayMs]);

  React.useEffect(() => {
    if (!open || state !== 'listening' || !navigator.mediaDevices?.getUserMedia) {
      levelRef.current = 0;
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let animationFrame = 0;
    let lastSample = 0;

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
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const update = (time: number) => {
          if (disposed) return;
          if (time - lastSample >= 48) {
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (const value of data) sum += value;
            levelRef.current = Math.min(1, sum / Math.max(1, data.length) / 40);
            lastSample = time;
          }
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
  }, [open, state]);

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
        className="jarvis-voice-panel fixed right-3 top-3 z-[90] w-[286px] overflow-hidden rounded-[9px] border border-white/10 bg-[#090909]/95 backdrop-blur-xl"
        aria-label="Jarvis voice session"
      >
        {/* Primary-button drag handle — single compact row */}
        <div
          className="jarvis-voice-drag-row cursor-grab active:cursor-grabbing"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-1.5 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Close Jarvis voice session"
            title="Close"
          >
            <X className="h-2.5 w-2.5" />
          </button>

          <div className="relative z-[1] flex items-center gap-1.5 pl-2 pr-5 py-1">
            <button
              type="button"
              onClick={toggleListening}
              className={cn(
                'jarvis-voice-orb-button flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/70',
                (state === 'listening' || state === 'speaking') && 'is-active',
              )}
              aria-label={
                state === 'listening'
                  ? 'Stop listening'
                  : voiceAutoListenOnOpen
                    ? 'Listening active'
                    : 'Click to talk'
              }
              title={
                state === 'listening'
                  ? 'Stop listening'
                  : voiceAutoListenOnOpen
                    ? 'Hands-free — just speak'
                    : 'Click to let Jarvis hear you'
              }
            >
              <SymbioteOrb state={state} size={30} />
            </button>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[11px] font-medium leading-4 text-foreground">
                {personaCfg.name}
              </span>
              <span
                className={cn(
                  'flex items-center gap-1 text-[9px] leading-3',
                  state === 'error' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    state === 'error'
                      ? 'bg-destructive'
                      : 'bg-success shadow-[0_0_5px_hsl(var(--success)/0.75)]',
                  )}
                />
                {state === 'error' && errorMessage ? errorMessage : STATE_LABEL[state]}
              </span>
            </div>
            <div className="mx-auto min-w-0 flex-1">
              <VoiceActivityWaveform levelRef={levelRef} active={state === 'listening'} />
            </div>
            <div className="jarvis-voice-mic flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full">
              <Mic className="h-2.5 w-2.5 text-muted-foreground" strokeWidth={1.8} />
            </div>
          </div>
        </div>

        {/* Transcript dropdown toggle */}
        <button
          type="button"
          onClick={() => setShowTranscript((v) => !v)}
          className="relative z-[1] flex w-full items-center justify-center gap-1 border-t border-white/[0.06] px-2 py-px text-[8px] text-muted-foreground/55 transition-colors hover:bg-white/[0.035] hover:text-muted-foreground"
        >
          <span>Transcript</span>
          {showTranscript
            ? <ChevronUp className="h-2 w-2" />
            : <ChevronDown className="h-2 w-2" />
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
                className="max-h-[60px] space-y-0.5 overflow-y-auto px-2 pb-1.5 pt-0.5"
              >
                {transcript.length === 0 && !partial ? (
                  <div className="flex h-[20px] items-center justify-center text-center text-[8px] text-muted-foreground">
                    {activeChatId ? 'Listening...' : 'Open a chat first.'}
                  </div>
                ) : null}
                {visibleTranscript.map((message) => {
                  const user = message.role === 'user';
                  return (
                    <div
                      key={message.id}
                      className="grid grid-cols-[12px_32px_1fr] items-center gap-0.5 text-[8px] leading-3"
                    >
                      <span
                        className={cn(
                          'flex h-[12px] w-[12px] items-center justify-center rounded-full border',
                          user
                            ? 'border-info/80 text-info'
                            : 'border-accent-copper/80 text-accent-copper',
                        )}
                      >
                        {user ? <UserRound className="h-1.5 w-1.5" /> : <Bot className="h-1.5 w-1.5" />}
                      </span>
                      <span className={cn('text-[8px] font-medium', user ? 'text-info' : 'text-accent-copper')}>
                        {user ? 'You' : 'Jarvis:'}
                      </span>
                      <span className="min-w-0 truncate text-foreground/80">{message.displayText}</span>
                    </div>
                  );
                })}
                {partial ? (
                  <div className="grid grid-cols-[12px_32px_1fr] items-center gap-0.5 text-[8px] leading-3">
                    <span className="flex h-[12px] w-[12px] items-center justify-center rounded-full border border-info/80 text-info">
                      <UserRound className="h-1.5 w-1.5" />
                    </span>
                    <span className="text-[8px] font-medium text-info">You</span>
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
