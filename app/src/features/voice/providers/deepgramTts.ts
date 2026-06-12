import type { SpeakChunkOptions, VoiceProvider } from './types';
import { getDeepgramVoiceKey } from '@/lib/security/voiceKeys';
import { getSupabaseClient } from '@/lib/supabase';
import { playBase64Audio } from '../audioPlayback';
import { speakDeepgramWithKey } from './deepgramSpeak';

const CLOUD_TIMEOUT_MS = 20_000;

interface TtsSpeakResponse {
  audio: string;
  mime: string;
}

async function speakViaCloudEdge(
  text: string,
  options: SpeakChunkOptions,
): Promise<(() => void) | undefined> {
  const client = getSupabaseClient();
  if (!client) throw new Error('cloud_unauthenticated');
  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('cloud_unauthenticated');

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CLOUD_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tts-speak`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, provider: 'deepgram_tts', voicePreset: options.preset }),
      signal: timeout.signal,
    });
  } catch {
    throw new Error('cloud_unavailable');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
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
  if (options.signal.aborted) return undefined;
  return playBase64Audio(body.audio, body.mime || 'audio/mpeg', {
    volume: options.volume ?? 1,
    signal: options.signal,
  });
}

class DeepgramTtsProvider implements VoiceProvider {
  readonly id = 'deepgram_tts' as const;
  private stopFn: (() => void) | null = null;

  async isAvailable(): Promise<boolean> {
    if (await getDeepgramVoiceKey()) return true;
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
    const apiKey = await getDeepgramVoiceKey();
    if (apiKey) {
      this.stopFn = await speakDeepgramWithKey(
        apiKey,
        text,
        options.preset,
        options.signal,
        options.volume ?? 1,
      );
      return;
    }
    this.stopFn = (await speakViaCloudEdge(text, options)) ?? null;
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
  }
}

export const deepgramTtsProvider = new DeepgramTtsProvider();
