import { getDeepgramVoiceKey } from '@/lib/security/voiceKeys';
import {
  deepgramListenUrl as buildDeepgramListenUrl,
  getDeepgramSttOption,
  readDeepgramSttOption,
  recordDeepgramLocalUsage,
  type DeepgramSttOptionId,
} from '@/lib/deepgram';

export interface DictationEvents {
  onOpen?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export function deepgramListenUrl(id: DeepgramSttOptionId = readDeepgramSttOption()): string {
  return buildDeepgramListenUrl(id);
}

export type ParsedDeepgramMessage =
  | { kind: 'partial' | 'final'; transcript: string }
  | { kind: 'ignore'; transcript: '' };

export function parseDeepgramMessage(payload: unknown): ParsedDeepgramMessage {
  const message = payload as {
    type?: unknown;
    event?: unknown;
    transcript?: unknown;
    channel?: { alternatives?: Array<{ transcript?: unknown }> };
    is_final?: unknown;
    speech_final?: unknown;
  };
  if (message?.type === 'TurnInfo') {
    const transcript = typeof message.transcript === 'string' ? message.transcript.trim() : '';
    if (!transcript) return { kind: 'ignore', transcript: '' };
    return {
      kind: message.event === 'EndOfTurn' ? 'final' : 'partial',
      transcript,
    };
  }
  const transcript =
    typeof message?.channel?.alternatives?.[0]?.transcript === 'string'
      ? message.channel.alternatives[0].transcript.trim()
      : '';
  if (!transcript) return { kind: 'ignore', transcript: '' };
  return {
    kind: message.is_final || message.speech_final ? 'final' : 'partial',
    transcript,
  };
}

export async function createDeepgramDictationSession(
  events: DictationEvents = {},
  optionId: DeepgramSttOptionId = readDeepgramSttOption(),
) {
  const apiKey = await getDeepgramVoiceKey();
  if (!apiKey) throw new Error('Connect Deepgram in Settings → Providers or Speech to Text first.');
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Microphone capture is not available in this runtime.');
  }

  const option = getDeepgramSttOption(optionId);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const socket = new WebSocket(deepgramListenUrl(optionId), ['token', apiKey]);
  const recorderOptions =
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : undefined;
  const recorder = new MediaRecorder(stream, recorderOptions);

  let closed = false;
  let lastFinal = '';
  let openedAt: number | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {}
    try {
      if (socket.readyState === WebSocket.OPEN && option.endpointVersion === 'v2') {
        socket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {}
    stream.getTracks().forEach((track) => track.stop());
    if (openedAt !== undefined) {
      recordDeepgramLocalUsage(
        Math.max(0, (Date.now() - openedAt) / 1000),
        option.priceUsdPerMinute,
      );
    }
    events.onClose?.();
  };

  recorder.ondataavailable = async (event) => {
    if (event.data.size === 0 || socket.readyState !== WebSocket.OPEN) return;
    socket.send(await event.data.arrayBuffer());
  };

  socket.onopen = () => {
    openedAt = Date.now();
    events.onOpen?.();
    recorder.start(option.endpointVersion === 'v2' ? 80 : 250);
  };

  socket.onmessage = (event) => {
    try {
      const parsed = parseDeepgramMessage(JSON.parse(String(event.data)));
      if (parsed.kind === 'ignore') return;
      events.onLevel?.(Math.min(1, parsed.transcript.length / 48));
      if (parsed.kind === 'final') {
        lastFinal = `${lastFinal} ${parsed.transcript}`.trim();
        events.onFinal?.(lastFinal);
      } else {
        events.onPartial?.(parsed.transcript);
      }
    } catch {
      /* Ignore Deepgram keepalive/control frames we do not consume. */
    }
  };

  socket.onerror = () => {
    events.onError?.('Deepgram dictation connection failed.');
    close();
  };
  socket.onclose = () => {
    if (!closed) close();
  };

  return {
    stop: close,
    getFinalText: () => lastFinal.trim(),
  };
}
