import { getAudioContextCtor } from '@/features/composer-stt/audio';
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
  /** Confirmed provider turn completion, delivered after the final transcript. */
  onTurnEnd?: () => void;
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
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const apiKey = await getDeepgramVoiceKey();
  options.signal?.throwIfAborted();
  if (!apiKey) throw new Error('Connect Deepgram in Settings ? Providers or Speech to Text first.');
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error('Microphone capture is not available in this runtime.');
  }
  const option = getDeepgramSttOption(optionId);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let socket: WebSocket | undefined;
  let recorder: MediaRecorder | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let frame: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let stopping = false;
  let captureReleased = false;
  let lastFinal = '';
  let openedAt: number | undefined;
  let failure: Error | undefined;
  let sendChain = Promise.resolve();
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const tracks = stream.getTracks();
  const releaseCapture = () => {
    if (captureReleased) return;
    captureReleased = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    try { source?.disconnect(); } catch { /* Already disconnected. */ }
    try { analyser?.disconnect(); } catch { /* Already disconnected. */ }
    try { void context?.close().catch(() => undefined); } catch { /* Closed context. */ }
    for (const track of tracks) {
      track.removeEventListener('ended', onDeviceEnded);
      try { track.stop(); } catch { /* Release the other tracks too. */ }
    }
    events.onLevel?.(0);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Cleanup continues. */ }
    }
    releaseCapture();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(); } catch { /* Closed socket. */ }
    }
    if (openedAt !== undefined) recordDeepgramLocalUsage(Math.max(0, (Date.now() - openedAt) / 1000), option.priceUsdPerMinute);
    resolveFinished();
    events.onClose?.();
  };
  const fail = (message: string) => {
    if (closed) return;
    failure = new Error(message);
    try { events.onError?.(message); } finally { close(); }
  };
  const cancel = () => { lastFinal = ''; close(); };
  const onDeviceEnded = () => fail('Deepgram microphone became unavailable. Select an available input and retry.');
  const finishSending = () => {
    void sendChain.then(() => {
      if (closed) return;
      if (socket?.readyState !== WebSocket.OPEN) {
        fail('Deepgram dictation connection closed before the final transcript.');
        return;
      }
      // Both supported endpoints flush buffered audio before closing the stream.
      socket.send(JSON.stringify({ type: 'CloseStream' }));
    }).catch(() => fail('Deepgram dictation connection failed.'));
  };
  try {
    options.signal?.throwIfAborted();
    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) throw new Error('Microphone level monitoring is unavailable in this runtime.');
    context = new AudioCtor();
    // Meter readiness must not hold up the speech connection on autoplay gates.
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    options.signal?.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      if (closed || captureReleased || !analyser) return;
      analyser.getByteTimeDomainData(samples);
      let squares = 0;
      for (const sample of samples) squares += ((sample - 128) / 128) ** 2;
      events.onLevel?.(Math.min(1, Math.sqrt(squares / samples.length) * 8));
      if (!closed && !captureReleased) frame = requestAnimationFrame(measure);
    };
    const recorderOptions = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' } : undefined;
    recorder = new MediaRecorder(stream, recorderOptions);
    socket = new WebSocket(deepgramListenUrl(optionId), ['token', apiKey]);
    for (const track of tracks) track.addEventListener('ended', onDeviceEnded);
    options.signal?.addEventListener('abort', cancel, { once: true });
    deadline = setTimeout(() => fail('Deepgram dictation connection did not become ready. Check the connection and retry.'), 10_000);
    recorder.ondataavailable = (event) => {
      if (closed || event.data.size === 0) return;
      sendChain = sendChain.then(async () => {
        const bytes = await event.data.arrayBuffer();
        if (!closed && socket?.readyState === WebSocket.OPEN) socket.send(bytes);
      });
      void sendChain.catch(() => fail('Deepgram dictation connection failed.'));
    };
    recorder.onstop = () => { if (stopping && !closed) finishSending(); };
    recorder.onerror = () => fail('Deepgram microphone capture failed. Check the input and retry.');
    socket.onopen = () => {
      if (closed || stopping) return;
      clearTimeout(deadline);
      try {
        recorder!.start(option.endpointVersion === 'v2' ? 80 : 250);
        openedAt = Date.now();
        frame = requestAnimationFrame(measure);
        events.onOpen?.();
      } catch { fail('Deepgram microphone capture failed. Check the input and retry.'); }
    };
    socket.onmessage = (event) => {
      if (closed) return;
      let payload: unknown;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if ((payload as { type?: unknown } | null)?.type === 'Error') {
        fail('Deepgram rejected the selected speech route. Check its model and connection, then retry.');
        return;
      }
      const parsed = parseDeepgramMessage(payload);
      if (parsed.kind === 'final') {
        lastFinal = (lastFinal + ' ' + parsed.transcript).trim();
        events.onFinal?.(parsed.transcript);
        const turn = payload as { type?: unknown; event?: unknown };
        if (!closed && turn.type === 'TurnInfo' && turn.event === 'EndOfTurn') {
          events.onTurnEnd?.();
        }
      } else if (parsed.kind === 'partial') events.onPartial?.(parsed.transcript);
    };
    socket.onerror = () => fail('Deepgram dictation connection failed.');
    socket.onclose = () => {
      if (!stopping && !closed) fail('Deepgram dictation connection closed before capture finished.');
      else close();
    };
  } catch (error) { close(); throw error; }
  return {
    async stop(): Promise<void> {
      if (!closed && !stopping) {
        stopping = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => fail('Deepgram final transcription timed out. Retry the dictation.'), 10_000);
        try {
          if (recorder?.state !== 'inactive') recorder?.stop();
          else finishSending();
        } catch { fail('Deepgram microphone capture failed. Check the input and retry.'); }
        releaseCapture();
      }
      await finished;
      if (failure) throw failure;
    },
    cancel,
    getFinalText: () => lastFinal.trim(),
  };
}
