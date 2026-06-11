/**
 * Incremental TTS while the AI response is still streaming.
 */
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { pullNewSpeechSegments, pullRemainingSpeech } from './textCleanup';
import { speakWithSettings, stopAllVoiceOutput } from './voiceRouter';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
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
  private activeSegments = 0;
  private readonly engine: VoiceEngine;
  private readonly voicePreset: VoicePresetId;

  constructor(options: StreamingVoiceOptions = {}) {
    const state = useAuthStore.getState();
    this.engine = options.voiceEngine ?? state.voiceEngine ?? 'system';
    this.voicePreset = options.voicePreset ?? state.voicePreset ?? 'jarvis-prime';
  }

  onDelta(accumulatedRaw: string): void {
    if (this.stopped || !accumulatedRaw.trim()) return;
    const { segments, nextSpokenCleanLength } = pullNewSpeechSegments(
      accumulatedRaw,
      this.spokenCleanLength,
    );
    if (segments.length === 0) return;
    this.spokenCleanLength = nextSpokenCleanLength;
    for (const segment of segments) {
      this.enqueue(segment);
    }
  }

  async onComplete(finalRaw: string): Promise<void> {
    if (this.stopped) return;
    const { remainder, nextSpokenCleanLength } = pullRemainingSpeech(
      finalRaw,
      this.spokenCleanLength,
    );
    this.spokenCleanLength = nextSpokenCleanLength;
    if (remainder.trim()) {
      this.enqueue(remainder);
    }
    await this.queue;
    if (this.started && this.activeSegments === 0) {
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
  }

  stop(): void {
    this.stopped = true;
    stopAllVoiceOutput();
    if (this.started) {
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
  }

  private enqueue(text: string): void {
    this.activeSegments += 1;
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      if (!this.started) {
        this.started = true;
        window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
      }
      await speakWithSettings(text, {
        voiceEngine: this.engine,
        voicePreset: this.voicePreset,
      });
    });
    this.queue = this.queue.finally(() => {
      this.activeSegments = Math.max(0, this.activeSegments - 1);
    });
  }
}

export function createStreamingVoiceSession(
  options?: StreamingVoiceOptions,
): StreamingVoiceSession {
  return new StreamingVoiceSession(options);
}
