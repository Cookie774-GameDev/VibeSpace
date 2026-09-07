import type { MutableRefObject } from 'react';
import { getAudioContextCtor } from './audio';

/** Shared mic level (0?1) for toolbar and Composer waveforms. */
export const sttVolumeRef: MutableRefObject<number> = { current: 0 };
type MicVolumeMeter = { stop: () => void };
let activeMeter: MicVolumeMeter | null = null;
let generation = 0;

export function resetSttVolume(): void {
  sttVolumeRef.current = 0;
}
export function setSttVolumeLevel(level: number): void {
  sttVolumeRef.current = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}
export function stopSttVolumeMeter(): void {
  generation += 1;
  const meter = activeMeter;
  activeMeter = null;
  meter?.stop();
  resetSttVolume();
}

/** Sample the microphone; cancelled permission requests never adopt a new stream. */
export async function startSttVolumeMeter(): Promise<void> {
  stopSttVolumeMeter();
  const ownGeneration = generation;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let rafId: number | null = null;
  let alive = true;
  const stop = () => {
    if (!alive) return;
    alive = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    try {
      source?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    try {
      analyser?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    try {
      void context?.close().catch(() => undefined);
    } catch {
      /* Closed context. */
    }
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* Release every remaining owned track. */
      }
    }
    if (activeMeter?.stop === stop) activeMeter = null;
    if (generation === ownGeneration) resetSttVolume();
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== ownGeneration) {
      stop();
      return;
    }
    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) {
      stop();
      return;
    }
    context = new AudioCtor();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!alive || generation !== ownGeneration || !analyser) return;
      analyser.getByteFrequencyData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample;
      setSttVolumeLevel(sum / Math.max(1, samples.length) / 48);
      rafId = requestAnimationFrame(tick);
    };
    activeMeter = { stop };
    rafId = requestAnimationFrame(tick);
  } catch {
    stop();
  }
}
