// Shared helpers for VibeSpace voice/subscription Edge Functions.
// Deno runtime (Supabase Edge Functions). Not bundled into the desktop app.

export const COST_PER_SECOND_USD = 0.00025; // ~$0.015/min, OpenAI gpt-4o-mini-tts

export type PlanId = 'free' | 'starter' | 'pro' | 'ultra';

export const PLAN_BUDGET_USD: Record<PlanId, number> = {
  free: 0,
  starter: 2,
  pro: 10,
  ultra: 20,
};

export function secondsForBudget(budgetUsd: number): number {
  return Math.floor((budgetUsd || 0) / COST_PER_SECOND_USD);
}

// Map a Stripe price ID to a plan, server-side only. Never trust the client.
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  const starter = env?.get('STRIPE_STARTER_PRICE_ID') ?? env?.get('STRIPE_PRICE_STARTER');
  const pro = env?.get('STRIPE_PRO_PRICE_ID') ?? env?.get('STRIPE_PRICE_PRO');
  const ultra = env?.get('STRIPE_ULTRA_PRICE_ID') ?? env?.get('STRIPE_PRICE_ULTRA');
  if (priceId === starter) return 'starter';
  if (priceId === pro) return 'pro';
  if (priceId === ultra) return 'ultra';
  return null;
}

// Restrictive CORS: the desktop app runs under tauri://localhost and the dev
// server under http://localhost:1420. Allow those; reject other origins.
const ALLOWED_ORIGINS = new Set<string>([
  'tauri://localhost',
  'http://localhost:1420',
  'http://localhost:5173',
  'https://tauri.localhost',
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'tauri://localhost';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'vary': 'Origin',
  };
}

export function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json' },
  });
}

// Approved provider allow-list. Anything else is rejected.
export const APPROVED_PROVIDERS = new Set(['openai_tts', 'deepgram_tts', 'elevenlabs_tts']);
export const APPROVED_PRESETS = new Set(['jarvis', 'friday']);

export const MAX_TTS_CHARS = 4000;

// Rough audio-seconds estimate from character count (~14 chars/sec speech).
export function estimateSeconds(chars: number): number {
  return Math.max(1, Math.ceil(chars / 14));
}
