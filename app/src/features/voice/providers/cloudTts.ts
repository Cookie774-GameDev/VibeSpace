/**
 * Cloud TTS providers (openai_tts / deepgram_tts / elevenlabs_tts).
 *
 * These NEVER hold a company API key. They POST to the secure `tts-speak`
 * Supabase Edge Function with the user's JWT; the function enforces auth,
 * subscription, quota, and rate limits, then returns base64 audio.
 *
 * On any non-OK response (quota_exceeded, cloud_unavailable, etc.) we throw a
 * coded error so the TtsService can fall back to local Kokoro / system voice.
 */
import type { SpeakChunkOptions, VoiceProvider } from './types';
import type { VoiceProviderId } from '../voicePlans';
import { playBase64Audio } from '../audioPlayback';
import { getSupabaseClient } from '@/lib/supabase';

const CLOUD_TIMEOUT_MS = 20_000;

interface TtsSpeakResponse {
  audio: string;
  mime: string;
  seconds: number;
  remaining_seconds: number | null;
}

export class CloudTtsProvider implements VoiceProvider {
  readonly id: VoiceProviderId;
  private stopFn: (() => void) | null = null;

  constructor(id: 'openai_tts' | 'deepgram_tts' | 'elevenlabs_tts') {
    this.id = id;
  }

  async isAvailable(): Promise<boolean> {
    // Available iff the user has an authenticated Supabase session. Quota is
    // enforced server-side; we discover quota_exceeded at speak time and fall back.
    try {
      const client = getSupabaseClient();
      if (!client) return false;
      const { data } = await client.auth.getSession();
      return Boolean(data.session?.access_token);
    } catch {
      return false;
    }
  }

  async speakChunk(text: string, options: SpeakChunkOptions): Promise<void> {
    if (options.signal.aborted) return;
    const client = getSupabaseClient();
    if (!client) throw new Error('cloud_unauthenticated');
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error('cloud_unauthenticated');

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tts-speak`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), CLOUD_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, provider: this.id, voicePreset: options.preset }),
        signal: timeout.signal,
      });
    } catch {
      throw new Error('cloud_unavailable');
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    }

    if (!res.ok) {
      // 402 quota_exceeded, 502 cloud_unavailable, 401, etc. -> caller falls back.
      let code = `cloud_${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) code = String(body.error);
      } catch {
        /* ignore */
      }
      throw new Error(code);
    }

    const body = (await res.json()) as TtsSpeakResponse;
    if (options.signal.aborted) return;
    const stop = await playBase64Audio(body.audio, body.mime || 'audio/mpeg', {
      volume: options.volume ?? 1,
      signal: options.signal,
    });
    this.stopFn = stop;
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
  }
}

export const openaiTtsProvider = new CloudTtsProvider('openai_tts');
export const elevenlabsTtsProvider = new CloudTtsProvider('elevenlabs_tts');
