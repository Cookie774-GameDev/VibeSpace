/**
 * Voice provider abstraction. Each provider knows how to turn a single cleaned
 * text chunk into audible speech. The TtsService orchestrates cleanup,
 * chunking, queueing, and fallback across providers.
 */
import type { VoiceProviderId, VoiceTtsPreset } from '../voicePlans';

export interface SpeakChunkOptions {
  preset: VoiceTtsPreset;
  signal: AbortSignal;
  /** 0..1 playback volume. */
  volume?: number;
}

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  /** Cheap readiness probe (does not download). */
  isAvailable(): Promise<boolean>;
  /** Optional warmup to reduce first-chunk latency. */
  warmup?(): Promise<void>;
  /** Speak a single already-cleaned chunk. Resolves when playback finishes. */
  speakChunk(text: string, options: SpeakChunkOptions): Promise<void>;
  /** Stop any in-flight playback for this provider. */
  stop(): void;
}

export type ProviderResult =
  | { ok: true }
  | { ok: false; code: string; fallback?: VoiceProviderId };
