export type MicrophonePermissionState = PermissionState | 'unsupported';
export type MicrophoneCaptureErrorKind =
  | 'denied'
  | 'no_device'
  | 'unavailable'
  | 'unsupported'
  | 'unknown';
export type MicrophoneTestVerdict = 'pass' | 'silent' | 'noisy';

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}

export interface MicrophoneTestResult {
  verdict: MicrophoneTestVerdict;
  passed: boolean;
  peakLevel: number;
  averageLevel: number;
  recording: Blob | null;
}

const SILENCE_PEAK_THRESHOLD = 0.015;
const NOISE_AVERAGE_THRESHOLD = 0.45;
const CAPTURE_DURATION_MS = 3_000;
const SAMPLE_INTERVAL_MS = 50;

export function classifyMicrophoneLevels(
  levels: readonly number[],
): Omit<MicrophoneTestResult, 'recording'> {
  const safeLevels = levels.map((level) => Math.max(0, Math.min(1, level)));
  const peakLevel = safeLevels.length > 0 ? Math.max(...safeLevels) : 0;
  const averageLevel =
    safeLevels.length > 0
      ? safeLevels.reduce((total, level) => total + level, 0) / safeLevels.length
      : 0;
  if (peakLevel < SILENCE_PEAK_THRESHOLD) {
    return { verdict: 'silent', passed: false, peakLevel, averageLevel };
  }
  if (averageLevel > NOISE_AVERAGE_THRESHOLD) {
    return { verdict: 'noisy', passed: false, peakLevel, averageLevel };
  }
  return { verdict: 'pass', passed: true, peakLevel, averageLevel };
}

export function microphoneCaptureErrorKind(error: unknown): MicrophoneCaptureErrorKind {
  const name =
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) {
    return 'denied';
  }
  if (['DevicesNotFoundError', 'NotFoundError', 'OverconstrainedError'].includes(name)) {
    return 'no_device';
  }
  if (['AbortError', 'NotReadableError', 'TrackStartError'].includes(name)) {
    return 'unavailable';
  }
  if (name === 'NotSupportedError') return 'unsupported';
  return 'unknown';
}

export async function readMicrophonePermission(): Promise<MicrophonePermissionState> {
  if (!navigator.permissions?.query) return 'unsupported';
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

export async function listMicrophoneDevices(): Promise<MicrophoneDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  let index = 0;
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => {
      index += 1;
      return {
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index}`,
      };
    });
}

function getAudioContextConstructor(): typeof AudioContext | null {
  const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function rmsLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let squareSum = 0;
  for (const value of buffer) {
    const normalized = (value - 128) / 128;
    squareSum += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(squareSum / buffer.length) * 2);
}

export async function captureMicrophoneSample(options: {
  deviceId?: string;
  durationMs?: number;
  onLevel?: (level: number) => void;
}): Promise<MicrophoneTestResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('Microphone API unavailable', 'NotSupportedError');
  }
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    throw new DOMException('Web Audio unavailable', 'NotSupportedError');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: options.deviceId ? { deviceId: { exact: options.deviceId } } : true,
  });
  const context = new AudioContextConstructor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.35;
  source.connect(analyser);

  const samples: number[] = [];
  const buffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  const chunks: Blob[] = [];
  const Recorder = typeof MediaRecorder === 'undefined' ? null : MediaRecorder;
  const recorder = Recorder ? new Recorder(stream) : null;
  if (recorder) {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();
  }

  const sampleTimer = window.setInterval(() => {
    const level = rmsLevel(analyser, buffer);
    samples.push(level);
    options.onLevel?.(level);
  }, SAMPLE_INTERVAL_MS);

  try {
    const durationMs = Math.max(1_000, Math.min(5_000, options.durationMs ?? CAPTURE_DURATION_MS));
    await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }
    const analysis = classifyMicrophoneLevels(samples);
    return {
      ...analysis,
      recording:
        chunks.length > 0
          ? new Blob(chunks, { type: recorder?.mimeType || chunks[0]?.type || 'audio/webm' })
          : null,
    };
  } finally {
    window.clearInterval(sampleTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    source.disconnect();
    await context.close().catch(() => undefined);
    stream.getTracks().forEach((track) => track.stop());
    options.onLevel?.(0);
  }
}
