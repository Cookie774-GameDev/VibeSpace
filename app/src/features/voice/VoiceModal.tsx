import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Mic, UserRound, X } from 'lucide-react';
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
  const visibleTranscript = transcript;

  return (
    <AnimatePresence>
      <motion.aside
        initial={{ opacity: 0, x: 24, y: -8, scale: 0.96 }}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        exit={{ opacity: 0, x: 20, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30 }}
        className="fixed right-5 top-5 z-[90] w-[min(338px,calc(100vw-24px))] overflow-hidden rounded-[14px] border border-border-mid/80 bg-elevated/95 shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_30px_hsl(var(--accent-copper)/0.1)] backdrop-blur-xl"
        aria-label="Jarvis voice session"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Close Jarvis voice session"
          title="Close"
        >
          <X className="h-3 w-3" />
        </button>

        <div className="flex items-center gap-3 px-4 pb-2.5 pt-4">
          <div className="relative flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border border-accent-copper/80 bg-background/70 shadow-[inset_0_0_13px_hsl(var(--accent-copper)/0.58),0_0_15px_hsl(var(--accent-copper)/0.7),0_0_28px_hsl(var(--accent-copper)/0.24)]">
            <div className="absolute inset-1.5 rounded-full border border-accent-amber/70 shadow-[inset_0_0_7px_hsl(var(--accent-amber)/0.55)]" />
            <div className="h-[34px] w-[34px] rounded-full bg-[radial-gradient(circle_at_38%_34%,#fff7cb_0%,#ffd45a_18%,#ff980f_48%,#cf6205_72%,#5b2300_100%)] shadow-[0_0_12px_rgba(255,167,31,0.92)]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[21px] font-medium leading-6 text-foreground">
              {personaCfg.name}
            </div>
            <div
              className={cn(
                'mt-0.5 flex items-center gap-1.5 text-[16px] leading-5',
                state === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'h-2.5 w-2.5 rounded-full',
                  state === 'error'
                    ? 'bg-destructive'
                    : 'bg-success shadow-[0_0_8px_hsl(var(--success)/0.75)]',
                )}
              />
              <span className="truncate">
                {state === 'error' && errorMessage ? errorMessage : STATE_LABEL[state]}
              </span>
            </div>
          </div>
          <div className="mr-2 flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full border border-border bg-background/60 shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04)]">
            <Mic className="h-5 w-5 text-muted-foreground" strokeWidth={1.8} />
          </div>
        </div>

        <div className="px-4 pb-2 pt-0">
          <VoiceActivityWaveform levelRef={levelRef} active={state === 'listening'} />
        </div>

        <div
          ref={transcriptRef}
          className="max-h-[190px] min-h-[66px] space-y-2 overflow-y-auto px-4 pb-4 pt-0"
        >
          {transcript.length === 0 && !partial ? (
            <div className="flex h-[58px] items-center justify-center text-center text-[14px] text-muted-foreground">
              {activeChatId
                ? 'Listening for your first request.'
                : 'Open a chat, then speak to Jarvis.'}
            </div>
          ) : null}
          {visibleTranscript.map((message) => {
            const user = message.role === 'user';
            return (
              <div
                key={message.id}
                className="grid grid-cols-[24px_66px_1fr] items-center gap-1.5 text-[15px] leading-6"
              >
                <span
                  className={cn(
                    'flex h-[23px] w-[23px] items-center justify-center rounded-full border',
                    user
                      ? 'border-info/80 text-info'
                      : 'border-accent-copper/80 text-accent-copper',
                  )}
                >
                  {user ? <UserRound className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                </span>
                <span className={cn('font-medium', user ? 'text-info' : 'text-accent-copper')}>
                  {user ? 'You' : 'Jarvis:'}
                </span>
                <span className="min-w-0 truncate text-foreground/80">{message.displayText}</span>
              </div>
            );
          })}
          {partial ? (
            <div className="grid grid-cols-[24px_66px_1fr] items-center gap-1.5 text-[15px] leading-6">
              <span className="flex h-[23px] w-[23px] items-center justify-center rounded-full border border-info/80 text-info">
                <UserRound className="h-3.5 w-3.5" />
              </span>
              <span className="font-medium text-info">You</span>
              <span className="min-w-0 truncate text-foreground/70">{partial}</span>
            </div>
          ) : null}
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}
