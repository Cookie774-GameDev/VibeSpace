import { getDeepgramVoiceKey } from '@/lib/security/voiceKeys';

export interface DictationEvents {
  onOpen?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export function deepgramListenUrl(): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    interim_results: 'true',
    punctuate: 'true',
    endpointing: '800',
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

export async function createDeepgramDictationSession(events: DictationEvents = {}) {
  const apiKey = await getDeepgramVoiceKey();
  if (!apiKey) throw new Error('Add your Deepgram key in Settings -> Voice first.');
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Microphone capture is not available in this runtime.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const socket = new WebSocket(deepgramListenUrl(), ['token', apiKey]);
  const recorderOptions =
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : undefined;
  const recorder = new MediaRecorder(stream, recorderOptions);

  let closed = false;
  let lastFinal = '';
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {}
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {}
    stream.getTracks().forEach((track) => track.stop());
    events.onClose?.();
  };

  recorder.ondataavailable = async (event) => {
    if (event.data.size === 0 || socket.readyState !== WebSocket.OPEN) return;
    socket.send(await event.data.arrayBuffer());
  };

  socket.onopen = () => {
    events.onOpen?.();
    recorder.start(250);
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as {
        channel?: { alternatives?: Array<{ transcript?: string }> };
        is_final?: boolean;
        speech_final?: boolean;
      };
      const transcript = payload.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
      if (!transcript) return;
      events.onLevel?.(Math.min(1, transcript.length / 48));
      if (payload.is_final || payload.speech_final) {
        lastFinal = `${lastFinal} ${transcript}`.trim();
        events.onFinal?.(lastFinal);
      } else {
        events.onPartial?.(transcript);
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
