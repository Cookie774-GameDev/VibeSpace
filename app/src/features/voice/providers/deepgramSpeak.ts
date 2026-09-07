import type { VoiceTtsPreset } from '../voicePlans';
import { playBase64Audio } from '../audioPlayback';

const PRESET_MODEL: Record<VoiceTtsPreset, string> = {
  jarvis: 'aura-orion-en',
  friday: 'aura-luna-en',
};

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export async function speakDeepgramWithKey(
  apiKey: string,
  text: string,
  preset: VoiceTtsPreset,
  signal: AbortSignal,
  volume = 1,
): Promise<() => void> {
  if (signal.aborted) return () => {};
  const model = PRESET_MODEL[preset] ?? PRESET_MODEL.jarvis;
  const request = new AbortController();
  const onAbort = () => request.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, 20_000);
  let audio: ArrayBuffer;
  let mime: string;
  try {
    const res = await fetch(
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: request.signal,
      },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 120);
      throw new Error(detail ? `deepgram_${res.status}: ${detail}` : `deepgram_${res.status}`);
    }
    audio = await res.arrayBuffer();
    mime = res.headers.get('content-type') || 'audio/mpeg';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) return () => {};
  return playBase64Audio(bufToBase64(audio), mime, { volume, signal });
}

export async function testDeepgramVoiceKey(apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch('https://api.deepgram.com/v1/projects', {
      method: 'GET',
      headers: { Authorization: `Token ${apiKey.trim()}` },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
