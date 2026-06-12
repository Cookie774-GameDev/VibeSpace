/**
 * TtsService — the text-to-speech orchestrator described in the master plan.
 *
 * Responsibilities:
 *   - speak(text, options): clean -> chunk -> enqueue -> play, starting the
 *     first chunk ASAP.
 *   - stop / pause / resume / setProvider / setVoicePreset / getUsage /
 *     testVoice / getAvailableVoices / preload / warmup.
 *   - Provider selection with graceful fallback:
 *       cloud (openai/deepgram/elevenlabs) -> kokoro_local -> system_tts_fallback
 *   - Phrase cache for common short acknowledgements.
 *   - No duplicate playback, no hung audio, abortable at any time.
 *
 * The conversational STT singleton lives in VoiceService.ts (separate concern).
 * This is the *speaking* side and is exported as `TtsService`.
 */
import {
  DEFAULT_VOICE_TTS_PRESET,
  FALLBACK_MESSAGES,
  type VoiceProviderId,
  type VoiceTtsPreset,
} from './voicePlans';
import type { VoiceProvider } from './providers/types';
import { systemFallbackProvider } from './providers/systemFallback';
import { kokoroLocalProvider } from './providers/kokoroLocal';
import { deepgramTtsProvider } from './providers/deepgramTts';
import { elevenlabsTtsProvider, openaiTtsProvider } from './providers/cloudTts';
import { prepareForSpeech, type CleanupOptions } from './textCleanup';

export interface SpeakOptions extends CleanupOptions {
  preset?: VoiceTtsPreset;
  provider?: VoiceProviderId;
  volume?: number;
  /** Skip cleanup/chunking (e.g. cached phrases). */
  raw?: boolean;
}

export interface DeepgramPromoSnapshot {
  active: boolean;
  seconds_limit: number;
  seconds_used: number;
  remaining_seconds: number;
  one_time: boolean;
}

export interface VoiceUsageSnapshot {
  plan: string;
  monthly_seconds_limit: number;
  monthly_seconds_used: number;
  remaining_seconds: number;
  local_voice_available: boolean;
  cloud_voice_available: boolean;
  deepgram_promo?: DeepgramPromoSnapshot;
}

export type TtsStatus = 'idle' | 'speaking' | 'paused';

const CACHED_PHRASES = new Set(['Task complete.', 'Systems online.', 'Diagnostics complete.', "I'm ready."]);

const PROVIDERS: Record<VoiceProviderId, VoiceProvider> = {
  kokoro_local: kokoroLocalProvider,
  openai_tts: openaiTtsProvider,
  deepgram_tts: deepgramTtsProvider,
  elevenlabs_tts: elevenlabsTtsProvider,
  system_tts_fallback: systemFallbackProvider,
};

type StatusListener = (status: TtsStatus) => void;
type NoticeListener = (message: string) => void;

class TtsServiceImpl {
  private provider: VoiceProviderId = 'kokoro_local';
  private preset: VoiceTtsPreset = DEFAULT_VOICE_TTS_PRESET;
  private status: TtsStatus = 'idle';
  private abort: AbortController | null = null;
  private queue: string[] = [];
  private paused = false;
  private warmed = false;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly noticeListeners = new Set<NoticeListener>();

  // ── config ────────────────────────────────────────────────────────────────
  setProvider(provider: VoiceProviderId): void {
    this.provider = provider;
  }
  getProvider(): VoiceProviderId {
    return this.provider;
  }
  setVoicePreset(preset: VoiceTtsPreset): void {
    this.preset = preset;
  }
  getVoicePreset(): VoiceTtsPreset {
    return this.preset;
  }
  getStatus(): TtsStatus {
    return this.status;
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  onNotice(fn: NoticeListener): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }
  private setStatus(s: TtsStatus): void {
    this.status = s;
    this.statusListeners.forEach((fn) => {
      try {
        fn(s);
      } catch {
        /* ignore */
      }
    });
  }
  private notify(message: string): void {
    this.noticeListeners.forEach((fn) => {
      try {
        fn(message);
      } catch {
        /* ignore */
      }
    });
  }

  // ── ordered fallback chain for a requested provider ─────────────────────────
  private fallbackChain(requested: VoiceProviderId): VoiceProviderId[] {
    const chain: VoiceProviderId[] = [requested];
    if (requested !== 'kokoro_local') chain.push('kokoro_local');
    if (requested !== 'system_tts_fallback') chain.push('system_tts_fallback');
    return chain;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async warmup(): Promise<void> {
    if (this.warmed) return;
    this.warmed = true;
    try {
      await kokoroLocalProvider.warmup?.();
    } catch {
      /* best effort */
    }
  }
  async preload(): Promise<void> {
    await this.warmup();
  }

  async getAvailableVoices(): Promise<Record<VoiceProviderId, boolean>> {
    const ids = Object.keys(PROVIDERS) as VoiceProviderId[];
    const entries = await Promise.all(
      ids.map(async (id) => [id, await PROVIDERS[id].isAvailable().catch(() => false)] as const),
    );
    return Object.fromEntries(entries) as Record<VoiceProviderId, boolean>;
  }

  // ── speaking ─────────────────────────────────────────────────────────────────
  async testVoice(preset?: VoiceTtsPreset): Promise<void> {
    const p = preset ?? this.preset;
    await this.speak(`This is the ${p} voice for VibeSpace.`, { preset: p, raw: true });
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    const preset = options.preset ?? this.preset;
    const requested = options.provider ?? this.provider;

    // Stop anything currently playing — new command interrupts old (no overlap).
    this.stop();

    const chunks =
      options.raw || CACHED_PHRASES.has(text.trim())
        ? [text.trim()]
        : prepareForSpeech(text, options);
    if (chunks.length === 0) return;

    this.queue = chunks;
    this.paused = false;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.setStatus('speaking');

    try {
      while (this.queue.length > 0) {
        if (signal.aborted) break;
        while (this.paused && !signal.aborted) {
          await delay(80);
        }
        if (signal.aborted) break;
        const chunk = this.queue.shift()!;
        await this.speakChunkWithFallback(chunk, requested, preset, signal, options.volume);
      }
    } finally {
      if (!signal.aborted) this.setStatus('idle');
    }
  }

  /** Try the requested provider, then fall back down the chain on coded errors. */
  private async speakChunkWithFallback(
    chunk: string,
    requested: VoiceProviderId,
    preset: VoiceTtsPreset,
    signal: AbortSignal,
    volume?: number,
  ): Promise<void> {
    const chain = this.fallbackChain(requested);
    let lastErr: unknown = null;
    for (let i = 0; i < chain.length; i++) {
      const id = chain[i];
      const provider = PROVIDERS[id];
      try {
        if (!(await provider.isAvailable())) {
          continue;
        }
        await provider.speakChunk(chunk, { preset, signal, volume });
        // Emit a user-facing notice when we degraded from the requested provider.
        if (i > 0 && !signal.aborted) {
          this.notifyDowngrade(requested, id, lastErr);
        }
        return;
      } catch (err) {
        lastErr = err;
        if (signal.aborted) return;
        // try next provider in the chain
      }
    }
    // Whole chain failed.
    if (!signal.aborted) this.notify(FALLBACK_MESSAGES.allFailed);
  }

  private notifyDowngrade(requested: VoiceProviderId, used: VoiceProviderId, err: unknown): void {
    const code = err instanceof Error ? err.message : '';
    if (requested !== 'kokoro_local' && requested !== 'system_tts_fallback') {
      if (code === 'quota_exceeded') this.notify(FALLBACK_MESSAGES.quotaExceeded);
      else this.notify(FALLBACK_MESSAGES.cloudFailure);
    } else if (used === 'system_tts_fallback') {
      this.notify(FALLBACK_MESSAGES.modelDownloading);
    }
  }

  stop(): void {
    this.queue = [];
    this.paused = false;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    Object.values(PROVIDERS).forEach((p) => {
      try {
        p.stop();
      } catch {
        /* ignore */
      }
    });
    this.setStatus('idle');
  }

  pause(): void {
    if (this.status === 'speaking') {
      this.paused = true;
      this.setStatus('paused');
      try {
        window.speechSynthesis?.pause();
      } catch {
        /* ignore */
      }
    }
  }
  resume(): void {
    if (this.status === 'paused') {
      this.paused = false;
      this.setStatus('speaking');
      try {
        window.speechSynthesis?.resume();
      } catch {
        /* ignore */
      }
    }
  }

  // ── usage ────────────────────────────────────────────────────────────────────
  async getUsage(): Promise<VoiceUsageSnapshot | null> {
    try {
      const { getSupabaseClient } = await import('@/lib/supabase');
      const client = getSupabaseClient();
      if (!client) return null;
      const { data: sessionData } = await client.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return null;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-voice-usage`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      return (await res.json()) as VoiceUsageSnapshot;
    } catch {
      return null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const TtsService = new TtsServiceImpl();
export type { TtsServiceImpl };
