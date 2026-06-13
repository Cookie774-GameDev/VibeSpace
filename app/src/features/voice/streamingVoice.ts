/**
 * Incremental TTS while the AI response is still streaming.
 */
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { pullNewSpeechSegments, pullRemainingSpeech } from './textCleanup';
import {
  registerActiveStreamingVoiceSession,
  speakWithSettings,
  stopAllVoiceOutput,
} from './voiceRouter';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';

export interface StreamingVoiceOptions {
  voiceEngine?: VoiceEngine;
  voicePreset?: VoicePresetId;
}

export class StreamingVoiceSession {
  private spokenCleanLength = 0;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private readonly engine: VoiceEngine;
  private readonly voicePreset: VoicePresetId;

  constructor(options: StreamingVoiceOptions = {}) {
    const state = useAuthStore.getState();
    this.engine = options.voiceEngine ?? state.voiceEngine ?? 'system';
    this.voicePreset = options.voicePreset ?? state.voicePreset ?? 'jarvis-prime';
    registerActiveStreamingVoiceSession(this);
  }

  onDelta(accumulatedRaw: string): void {
    if (this.stopped || !accumulatedRaw.trim()) return;
    if (!useUIStore.getState().voiceModalOpen) {
      this.haltPlayback();
      return;
    }
    const { segments, nextSpokenCleanLength } = pullNewSpeechSegments(
      accumulatedRaw,
      this.spokenCleanLength,
    );
    if (segments.length === 0) return;
    this.spokenCleanLength = nextSpokenCleanLength;
    const batch = segments.join(' ').trim();
    if (batch) this.enqueue(batch);
  }

  async onComplete(finalRaw: string): Promise<void> {
    if (this.stopped || !useUIStore.getState().voiceModalOpen) return;
    const { remainder, nextSpokenCleanLength } = pullRemainingSpeech(
      finalRaw,
      this.spokenCleanLength,
    );
    this.spokenCleanLength = nextSpokenCleanLength;
    if (remainder.trim()) {
      this.enqueue(remainder);
    }
    await this.queue;
    if (this.started && !this.stopped) {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
  }

  /** Stop playback without clearing the global streaming session registry. */
  haltPlayback(): void {
    const wasActive = this.started && !this.stopped;
    this.stopped = true;
    if (wasActive) {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
  }

  stop(): void {
    registerActiveStreamingVoiceSession(null);
    this.haltPlayback();
    stopAllVoiceOutput();
  }

  private enqueue(text: string): void {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      if (!this.started) {
        this.started = true;
        window.dispatchEvent(new CustomEvent(STREAMING_VOICE_START_EVENT));
        window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
      }
      await speakWithSettings(text, {
        voiceEngine: this.engine,
        voicePreset: this.voicePreset,
      });
    });
  }
}

export function createStreamingVoiceSession(
  options?: StreamingVoiceOptions,
): StreamingVoiceSession {
  return new StreamingVoiceSession(options);
}
