export type JarvisPlaybackEnergyListener = (energy: number) => void;

const listeners = new Set<JarvisPlaybackEnergyListener>();
let currentEnergy = 0;

export function getJarvisPlaybackEnergy(): number {
  return currentEnergy;
}

export function setJarvisPlaybackEnergy(energy: number): void {
  const next = Number.isFinite(energy) ? Math.min(1, Math.max(0, energy)) : 0;
  currentEnergy = next;
  for (const listener of listeners) listener(next);
}

export function subscribeJarvisPlaybackEnergy(
  listener: JarvisPlaybackEnergyListener,
): () => void {
  listeners.add(listener);
  listener(currentEnergy);
  return () => {
    listeners.delete(listener);
  };
}

export function resetJarvisPlaybackEnergy(): void {
  setJarvisPlaybackEnergy(0);
}

interface PlaybackTapDependencies {
  createAudioContext(): AudioContext | null;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(frame: number): void;
}

function browserTapDependencies(): PlaybackTapDependencies {
  return {
    createAudioContext: () => {
      const AudioContextCtor = window.AudioContext;
      return AudioContextCtor ? new AudioContextCtor() : null;
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (frame) => window.cancelAnimationFrame(frame),
  };
}

let sharedContext: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;

export function tapJarvisPlaybackElement(
  audio: HTMLAudioElement,
  dependencies: PlaybackTapDependencies = browserTapDependencies(),
): () => void {
  let frame: number | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let disposed = false;

  try {
    if (!sharedContext || sharedContext.state === 'closed') {
      sharedContext = dependencies.createAudioContext();
      sharedAnalyser = sharedContext?.createAnalyser() ?? null;
      if (sharedAnalyser) {
        sharedAnalyser.fftSize = 256;
        sharedAnalyser.smoothingTimeConstant = 0.18;
      }
    }
    if (!sharedContext || !sharedAnalyser) return () => undefined;
    void sharedContext.resume().catch(() => undefined);
    source = sharedContext.createMediaElementSource(audio);
    source.connect(sharedAnalyser);
    sharedAnalyser.connect(sharedContext.destination);
    const samples = new Uint8Array(sharedAnalyser.frequencyBinCount);

    const sample = () => {
      if (disposed || !sharedAnalyser) return;
      sharedAnalyser.getByteTimeDomainData(samples);
      let squareSum = 0;
      for (const value of samples) {
        const centered = (value - 128) / 128;
        squareSum += centered * centered;
      }
      const rms = Math.sqrt(squareSum / Math.max(1, samples.length));
      const gated = rms <= 0.012 ? 0 : Math.min(1, Math.max(0, (rms - 0.012) / 0.22));
      setJarvisPlaybackEnergy(gated);
      frame = dependencies.requestFrame(sample);
    };
    frame = dependencies.requestFrame(sample);
  } catch {
    return () => undefined;
  }

  return () => {
    disposed = true;
    if (frame !== null) dependencies.cancelFrame(frame);
    try {
      source?.disconnect();
    } catch {
      /* already disconnected */
    }
    resetJarvisPlaybackEnergy();
  };
}
