// @ts-nocheck
// tts-speak: secure cloud TTS proxy.
//
// Flow:
//   1. Require Supabase JWT; reject anonymous.
//   2. Validate body (text non-empty, <= MAX_TTS_CHARS, approved provider/preset).
//   3. Rate-limit per user (sliding 60s window).
//   4. Atomically reserve estimated seconds (reserve_voice_seconds RPC) — this
//      is what prevents 20 parallel calls from bypassing quota.
//   5. Call the selected provider with the hidden company key.
//   6. Record a voice_event; settle reserved vs actual seconds.
//   7. Return audio (base64) + metadata. On any failure return a safe error so
//      the client can fall back to local Kokoro.
//
// Company keys live ONLY in Supabase secrets. Never returned to the client.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import {
  APPROVED_PRESETS,
  APPROVED_PROVIDERS,
  estimateSeconds,
  json,
  MAX_TTS_CHARS,
} from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';
const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY') ?? '';
const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY') ?? '';

const CLOUD_TIMEOUT_MS = 20_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;

const OPENAI_VOICE_INSTRUCTIONS: Record<string, string> = {
  jarvis:
    'Speak as an original futuristic AI assistant with a calm, refined, British-inspired tone. Sound precise, intelligent, composed, and slightly warm. Do not imitate any real actor, movie character, or copyrighted voice. Keep responses short and confident.',
  friday:
    'Speak as an original futuristic female AI assistant with a clean tactical tone. Sound fast, focused, professional, and composed. Do not imitate any real actor, movie character, or copyrighted voice. Keep responses clear and efficient.',
};

// Preset -> per-provider voice id. These are provider voice names, not the
// movie characters — "jarvis"/"friday" are our preset labels.
const PRESET_VOICE: Record<string, Record<string, string>> = {
  openai_tts: { jarvis: 'onyx', friday: 'nova' },
  deepgram_tts: { jarvis: 'aura-orion-en', friday: 'aura-luna-en' },
  elevenlabs_tts: { jarvis: 'pNInz6obpgDQGcFmaJgB', friday: 'EXAVITQu4vr4xnSDxMaL' },
};

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function callOpenAI(text: string, preset: string): Promise<ArrayBuffer> {
  if (!OPENAI_API_KEY) throw new Error('provider_unconfigured');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: PRESET_VOICE.openai_tts[preset],
      input: text,
      instructions: OPENAI_VOICE_INSTRUCTIONS[preset],
      response_format: 'mp3',
    }),
    signal: timeoutSignal(CLOUD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`provider_error_${res.status}`);
  return await res.arrayBuffer();
}

async function callDeepgram(text: string, preset: string): Promise<ArrayBuffer> {
  if (!DEEPGRAM_API_KEY) throw new Error('provider_unconfigured');
  const model = PRESET_VOICE.deepgram_tts[preset];
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${model}`, {
    method: 'POST',
    headers: { authorization: `Token ${DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: timeoutSignal(CLOUD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`provider_error_${res.status}`);
  return await res.arrayBuffer();
}

async function callElevenLabs(text: string, preset: string): Promise<ArrayBuffer> {
  if (!ELEVENLABS_API_KEY) throw new Error('provider_unconfigured');
  const voiceId = PRESET_VOICE.elevenlabs_tts[preset];
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=2`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
      signal: timeoutSignal(CLOUD_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`provider_error_${res.status}`);
  return await res.arrayBuffer();
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: { ...json({}, 200, origin).headers } });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  // 1. Auth
  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  // 2. Validate body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  const text = String(body.text ?? '').trim();
  const provider = String(body.provider ?? '');
  const preset = String(body.voicePreset ?? '');
  if (!text) return json({ error: 'empty_text' }, 400, origin);
  if (text.length > MAX_TTS_CHARS) return json({ error: 'text_too_long', max: MAX_TTS_CHARS }, 413, origin);
  if (!APPROVED_PROVIDERS.has(provider)) return json({ error: 'invalid_provider' }, 400, origin);
  if (!APPROVED_PRESETS.has(preset)) return json({ error: 'invalid_preset' }, 400, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Rate limit (atomic increment over a sliding 60s window)
  const windowStart = new Date(
    Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS,
  ).toISOString();
  const { data: rlData, error: rlErr } = await admin.rpc('voice_rate_limit_hit', {
    p_user_id: userId,
    p_window_start: windowStart,
    p_chars: text.length,
    p_max_requests: RATE_MAX_REQUESTS,
  });
  if (!rlErr && (rlData as { limited?: boolean } | null)?.limited) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  // 4. Atomic quota reservation
  const estSecs = estimateSeconds(text.length);
  const { data: reservation, error: reserveErr } = await admin
    .rpc('reserve_voice_seconds', { p_user_id: userId, p_estimate_secs: estSecs });
  if (reserveErr) return json({ error: 'usage_unavailable' }, 500, origin);
  const reserved = reservation as { ok: boolean; reason?: string; remaining?: number } | null;
  if (!reserved?.ok) {
    // Quota gone / no plan -> client falls back to Kokoro.
    await admin.from('voice_events').insert({
      user_id: userId, provider, voice_preset: preset, text_chars: text.length,
      estimated_seconds: estSecs, status: 'blocked', error_code: reserved?.reason ?? 'quota',
    });
    return json({ error: 'quota_exceeded', reason: reserved?.reason ?? 'quota', fallback: 'kokoro_local' }, 402, origin);
  }

  // 5. Call provider
  let audio: ArrayBuffer;
  try {
    if (provider === 'openai_tts') audio = await callOpenAI(text, preset);
    else if (provider === 'deepgram_tts') audio = await callDeepgram(text, preset);
    else audio = await callElevenLabs(text, preset);
  } catch (e) {
    // Release the reservation and record a safe error (no provider secret leak).
    await admin.rpc('settle_voice_seconds', { p_user_id: userId, p_reserved: estSecs, p_actual: 0 });
    const code = (e as Error).message?.startsWith('provider') ? (e as Error).message : 'provider_failed';
    await admin.from('voice_events').insert({
      user_id: userId, provider, voice_preset: preset, text_chars: text.length,
      estimated_seconds: estSecs, actual_seconds: 0, status: 'error', error_code: code,
    });
    return json({ error: 'cloud_unavailable', fallback: 'kokoro_local' }, 502, origin);
  }

  // 6. Settle + event. Actual seconds ~ estimate (provider doesn't return duration cheaply).
  const actualSecs = estSecs;
  await admin.from('voice_events').insert({
    user_id: userId, provider, voice_preset: preset, text_chars: text.length,
    estimated_seconds: estSecs, actual_seconds: actualSecs,
    estimated_cost_usd: actualSecs * 0.00025, status: 'ok',
  });

  // 7. Return audio
  return json(
    { audio: bufToB64(audio), mime: 'audio/mpeg', provider, preset, seconds: actualSecs,
      remaining_seconds: reserved.remaining ?? null },
    200,
    origin,
  );
});
