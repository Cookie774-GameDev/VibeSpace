/**
 * Incremental TTS while the AI response is still streaming.
 */
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import type { JarvisResponseEnvelope } from '@/lib/jarvis/contracts';
import { useAuthStore } from '@/stores/auth';
import { pullNewSpeechSegments, pullRemainingSpeech } from './textCleanup';
import {
  createJarvisStreamingPlayer,
  registerActiveStreamingVoiceSession,
  speakWithSettings,
  stopAllVoiceOutput,
  canVoiceModuleSpeak,
  getActiveVoiceSessionId,
  type JarvisStreamingPlayer,
} from './voiceRouter';
import {
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  STREAMING_VOICE_END_EVENT,
  STREAMING_VOICE_START_EVENT,
} from './speechSynthesis';
import { validateSpeechChunk, type ValidatedSpeechChunk } from './speechGate';

export interface StreamingVoiceOptions {
  voiceEngine?: VoiceEngine;
  voicePreset?: VoicePresetId;
}

export class StreamingVoiceSession {
  private spokenCleanLength = 0;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private validatedSpokenText = '';
  private readonly playbackAbort = new AbortController();
  private readonly engine: VoiceEngine;
  private readonly voicePreset: VoicePresetId;
  private readonly jarvisStream: JarvisStreamingPlayer | null;
  private readonly sessionId: number;

  constructor(options: StreamingVoiceOptions = {}) {
    const state = useAuthStore.getState();
    this.engine = options.voiceEngine ?? state.voiceEngine ?? 'jarvis';
    this.voicePreset = options.voicePreset ?? state.voicePreset ?? 'jarvis-prime';
    this.sessionId = getActiveVoiceSessionId();
    this.jarvisStream =
      this.engine === 'jarvis' ? createJarvisStreamingPlayer(this.voicePreset) : null;
    registerActiveStreamingVoiceSession(this);
  }

  private isSessionLive(): boolean {
    return (
      !this.stopped &&
      this.sessionId > 0 &&
      this.sessionId === getActiveVoiceSessionId() &&
      canVoiceModuleSpeak()
    );
  }

  /** @deprecated Temporary raw compatibility boundary; Task 16B removes its final caller. */
  onDelta(accumulatedRaw: string): void {
    if (!this.isSessionLive() || !accumulatedRaw.trim()) return;
    const { segments, nextSpokenCleanLength } = pullNewSpeechSegments(
      accumulatedRaw,
      this.spokenCleanLength,
    );
    if (segments.length === 0) return;
    this.spokenCleanLength = nextSpokenCleanLength;
    const batch = segments.join(' ').trim();
    if (batch) this.enqueueSpeechText(batch);
  }

  async onComplete(finalRaw: string): Promise<void> {
    if (!this.isSessionLive()) return;
    const { remainder, nextSpokenCleanLength } = pullRemainingSpeech(
      finalRaw,
      this.spokenCleanLength,
    );
    this.spokenCleanLength = nextSpokenCleanLength;
    if (remainder.trim()) {
      this.enqueueSpeechText(remainder);
    }
    if (this.jarvisStream) {
      await this.jarvisStream.complete();
    } else {
      await this.queue;
    }
    if (!this.stopped) {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
  }

  enqueueValidatedChunk(chunk: ValidatedSpeechChunk): void {
    const text = chunk.trim();
    if (!text || !this.isSessionLive()) return;
    this.validatedSpokenText = [this.validatedSpokenText, text].filter(Boolean).join(' ');
    this.enqueueSpeechText(text);
  }

  async completeValidated(
    response: Readonly<Pick<JarvisResponseEnvelope, 'spokenText' | 'mode' | 'executionState'>>,
  ): Promise<void> {
    if (!this.isSessionLive()) return;
    const finalText = response.spokenText?.trim() ?? '';
    if (finalText) {
      const decision = validateSpeechChunk({
        text: finalText,
        completeSentence: true,
        insideFence: false,
        mode: response.mode,
        ...(response.executionState ? { executionState: response.executionState } : {}),
        lintViolations: [],
      });
      if (!decision.allowed) throw new Error(`validated_speech_rejected:${decision.reason}`);
      const prefix = this.validatedSpokenText;
      const remainder =
        prefix && finalText.startsWith(`${prefix} `)
          ? finalText.slice(prefix.length).trim()
          : finalText === prefix
            ? ''
            : finalText;
      if (remainder) this.enqueueValidatedChunk(remainder as ValidatedSpeechChunk);
    }
    if (this.jarvisStream) await this.jarvisStream.complete();
    else await this.queue;
    if (!this.stopped) {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
  }

  /** Stop playback without clearing the global streaming session registry. */
  haltPlayback(): void {
    const wasActive = this.started && !this.stopped;
    this.stopped = true;
    this.playbackAbort.abort();
    if (wasActive) {
      window.dispatchEvent(new CustomEvent(STREAMING_VOICE_END_EVENT));
      window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_END_EVENT));
    }
    this.jarvisStream?.stop();
  }

  stop(): void {
    registerActiveStreamingVoiceSession(null);
    this.haltPlayback();
    stopAllVoiceOutput();
  }

  private enqueueSpeechText(text: string): void {
    if (!this.isSessionLive()) return;
    if (this.jarvisStream) {
      if (!this.started) {
        this.started = true;
        window.dispatchEvent(new CustomEvent(STREAMING_VOICE_START_EVENT));
        window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
      }
      this.jarvisStream.enqueue(text);
      return;
    }

    this.queue = this.queue.then(async () => {
      if (!this.isSessionLive()) return;
      if (!this.started) {
        this.started = true;
        window.dispatchEvent(new CustomEvent(STREAMING_VOICE_START_EVENT));
        window.dispatchEvent(new CustomEvent(SPEECH_SYNTHESIS_START_EVENT));
      }
      try {
        await speakWithSettings(text, {
          voiceEngine: this.engine,
          voicePreset: this.voicePreset,
          signal: this.playbackAbort.signal,
        });
      } catch (error) {
        if (!this.stopped) throw error;
      }
    });
  }
}

export function createStreamingVoiceSession(
  options?: StreamingVoiceOptions,
): StreamingVoiceSession {
  return new StreamingVoiceSession(options);
}

type CanonicalVoicePlaybackResult = Readonly<{
  tts: Readonly<
    | { state: 'completed'; resultRef: string; observedAt: number }
    | {
        state: 'degraded';
        reason: 'unavailable' | 'failed' | 'stopped';
        resultRef: string;
        observedAt: number;
      }
  >;
  playback: Readonly<
    | { state: 'completed'; resultRef: string; observedAt: number }
    | {
        state: 'degraded';
        reason: 'unavailable' | 'failed' | 'stopped';
        resultRef: string;
        observedAt: number;
      }
  >;
  terminalStatus: 'completed' | 'partial';
}>;

function newOpaqueVoiceId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('voice_crypto_unavailable');
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

/** @internal Trusted adapter consumed only by the closed kernel host composition. */
export function createCanonicalVoicePlaybackAdapter() {
  return Object.freeze({
    prepare(
      input: Readonly<{
        accountId: string;
        runId: string;
        requestId: string;
        attemptNumber: number;
        spokenText: string;
      }>,
    ) {
      const spokenText = input.spokenText.trim();
      if (!spokenText) return null;
      const state = useAuthStore.getState();
      const engine = state.voiceEngine ?? 'jarvis';
      const voicePreset = state.voicePreset ?? 'jarvis-prime';
      const issuedAt = Date.now();
      const receipt = Object.freeze({
        sessionId: newOpaqueVoiceId('vsession'),
        engineId: `${engine}:${voicePreset}`,
        ttsExecutionId: newOpaqueVoiceId('voice_tts'),
        playbackExecutionId: newOpaqueVoiceId('voice_playback'),
        ttsStartedAt: issuedAt,
        playbackStartedAt: issuedAt,
      });
      let session: StreamingVoiceSession | null = null;
      let started = false;
      let settled = false;
      let aborted = false;
      let disposed = false;
      let actualResult: CanonicalVoicePlaybackResult | undefined;

      const makeResult = (
        outcome: 'completed' | 'unavailable' | 'failed' | 'stopped',
      ): CanonicalVoicePlaybackResult => {
        const observedAt = Date.now();
        const engineResult = (prefix: 'voice_tts_result' | 'voice_playback_result') =>
          Object.freeze({
            state: outcome === 'completed' ? ('completed' as const) : ('degraded' as const),
            ...(outcome === 'completed' ? {} : { reason: outcome }),
            resultRef: newOpaqueVoiceId(prefix),
            observedAt,
          }) as CanonicalVoicePlaybackResult['tts'];
        return Object.freeze({
          tts: engineResult('voice_tts_result'),
          playback: engineResult('voice_playback_result'),
          terminalStatus: outcome === 'completed' ? ('completed' as const) : ('partial' as const),
        });
      };

      const controller = Object.freeze({
        receipt,
        async start(): Promise<CanonicalVoicePlaybackResult> {
          if (disposed || started) throw new Error('voice_playback_controller_invalid');
          started = true;
          if (aborted) {
            actualResult = makeResult('stopped');
            settled = true;
            return actualResult;
          }
          if (!canVoiceModuleSpeak()) {
            actualResult = makeResult('unavailable');
            settled = true;
            return actualResult;
          }
          session = new StreamingVoiceSession({ voiceEngine: engine, voicePreset });
          try {
            await session.completeValidated({
              spokenText,
              mode: 'direct_answer',
            });
            actualResult = makeResult(
              aborted ? 'stopped' : canVoiceModuleSpeak() ? 'completed' : 'unavailable',
            );
          } catch {
            actualResult = makeResult(aborted ? 'stopped' : 'failed');
          } finally {
            settled = true;
          }
          return actualResult;
        },
        verify(candidate: CanonicalVoicePlaybackResult): boolean {
          return candidate === actualResult && Object.isFrozen(candidate);
        },
        abort() {
          if (settled || disposed || aborted) return 'already_exited' as const;
          aborted = true;
          session?.stop();
          return 'signal_delivered' as const;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          if (started && !settled) {
            aborted = true;
            session?.stop();
          } else registerActiveStreamingVoiceSession(null);
        },
      });
      return controller;
    },
  });
}
