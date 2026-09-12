import type * as React from 'react';
import { subscribeJarvisPlaybackEnergy } from './jarvisPlaybackEnergy';

interface SignalTrack {
  stop(): void;
}

interface SignalStream {
  getTracks(): SignalTrack[];
}

interface SignalSource {
  connect(node: SignalAnalyser): void;
  disconnect(): void;
}

interface SignalAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  frequencyBinCount: number;
  getByteTimeDomainData(samples: Uint8Array): void;
  disconnect(): void;
}

interface SignalAudioContext {
  state: string;
  createMediaStreamSource(stream: SignalStream): SignalSource;
  createAnalyser(): SignalAnalyser;
  close(): Promise<void>;
}

export interface VoiceSignalDependencies {
  getUserMedia(constraints: MediaStreamConstraints): Promise<SignalStream>;
  createAudioContext(): SignalAudioContext | null;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(frame: number): void;
}

export interface VoiceSignalController {
  startListening(): Promise<void>;
  startSpeaking(): void;
  stop(): void;
}

export const VOICE_SIGNAL_GATE = 0.018;
export const VOICE_SIGNAL_CEILING = 0.24;
export const VOICE_SIGNAL_ATTACK = 0.42;
export const VOICE_SIGNAL_RELEASE = 0.12;

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function computeRms(samples: ArrayLike<number>, center = 128, scale = 128): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = (samples[index] - center) / scale;
    squareSum += centered * centered;
  }
  return Math.sqrt(squareSum / samples.length);
}

export function normalizeVoiceLevel(
  rms: number,
  gate = VOICE_SIGNAL_GATE,
  ceiling = VOICE_SIGNAL_CEILING,
): number {
  if (!Number.isFinite(rms) || rms <= gate) return 0;
  return clampUnit((rms - gate) / Math.max(0.0001, ceiling - gate));
}

export function smoothVoiceLevel(
  current: number,
  target: number,
  attack = VOICE_SIGNAL_ATTACK,
  release = VOICE_SIGNAL_RELEASE,
): number {
  const rate = target > current ? attack : release;
  return clampUnit(current + (target - current) * rate);
}

export function waveformBarWeight(index: number, count: number): number {
  if (count <= 1) return 1;
  return Math.pow(Math.sin((index / (count - 1)) * Math.PI), 1.35);
}

function browserDependencies(): VoiceSignalDependencies {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createAudioContext: () => {
      const AudioContextCtor = window.AudioContext;
      return AudioContextCtor ? (new AudioContextCtor() as unknown as SignalAudioContext) : null;
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (frame) => window.cancelAnimationFrame(frame),
  };
}

/**
 * Owns only the visualization signal. Speech recognition remains the authority
 * for transcription; this controller samples a parallel mic stream and always
 * releases it on mode changes.
 */
export function createVoiceSignalController(
  levelRef: React.MutableRefObject<number>,
  dependencies: VoiceSignalDependencies = browserDependencies(),
): VoiceSignalController {
  let generation = 0;
  let frame: number | null = null;
  let stream: SignalStream | null = null;
  let source: SignalSource | null = null;
  let analyser: SignalAnalyser | null = null;
  let audioContext: SignalAudioContext | null = null;
  let unsubscribePlayback: (() => void) | null = null;

  const cancelAnimation = () => {
    if (frame !== null) dependencies.cancelFrame(frame);
    frame = null;
  };

  const releaseAudio = () => {
    source?.disconnect();
    analyser?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    void audioContext?.close().catch(() => undefined);
    source = null;
    analyser = null;
    stream = null;
    audioContext = null;
  };

  const reset = () => {
    generation += 1;
    cancelAnimation();
    unsubscribePlayback?.();
    unsubscribePlayback = null;
    releaseAudio();
    levelRef.current = 0;
  };

  const startListening = async () => {
    reset();
    const activeGeneration = generation;
    let acquiredStream: SignalStream | null = null;
    try {
      acquiredStream = await dependencies.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (generation !== activeGeneration) {
        for (const track of acquiredStream.getTracks()) track.stop();
        return;
      }
      const context = dependencies.createAudioContext();
      if (!context) {
        for (const track of acquiredStream.getTracks()) track.stop();
        return;
      }
      stream = acquiredStream;
      audioContext = context;
      source = context.createMediaStreamSource(acquiredStream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);

      const sample = () => {
        if (generation !== activeGeneration || !analyser) return;
        analyser.getByteTimeDomainData(samples);
        let squareSum = 0;
        for (const value of samples) {
          const centered = (value - 128) / 128;
          squareSum += centered * centered;
        }
        const rms = computeRms(samples);
        const normalized = normalizeVoiceLevel(rms);
        levelRef.current = smoothVoiceLevel(levelRef.current, normalized);
        frame = dependencies.requestFrame(sample);
      };
      frame = dependencies.requestFrame(sample);
    } catch {
      if (generation === activeGeneration) {
        if (stream) releaseAudio();
        else for (const track of acquiredStream?.getTracks() ?? []) track.stop();
        levelRef.current = 0;
      }
    }
  };

  const startSpeaking = () => {
    reset();
    const activeGeneration = generation;
    unsubscribePlayback = subscribeJarvisPlaybackEnergy((energy) => {
      if (generation !== activeGeneration) return;
      levelRef.current = smoothVoiceLevel(levelRef.current, clampUnit(energy));
    });
  };

  return { startListening, startSpeaking, stop: reset };
}
