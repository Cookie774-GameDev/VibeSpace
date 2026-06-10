// Shared budget/plan/Twilio helpers for messaging + calling Edge Functions.
// Deno runtime. Server-side only. Never bundled into the desktop app.

import { json } from './voice.ts';

export { json };

export type PlanId = 'free' | 'starter' | 'pro' | 'ultra';

// Server-authoritative budgets (USD/month). Mirror of subscription_plan_limits.
// The DB table is the source of truth at runtime; this is a typed fallback.
export const PLAN_LIMITS: Record<PlanId, {
  messageBudgetUsd: number;
  callBudgetUsd: number;
  messageCredits: number;
  callMinutes: number;
}> = {
  free: { messageBudgetUsd: 0, callBudgetUsd: 0, messageCredits: 0, callMinutes: 0 },
  starter: { messageBudgetUsd: 2.5, callBudgetUsd: 2.5, messageCredits: 2500, callMinutes: 25 },
  pro: { messageBudgetUsd: 12.5, callBudgetUsd: 12.5, messageCredits: 12500, callMinutes: 125 },
  ultra: { messageBudgetUsd: 25, callBudgetUsd: 25, messageCredits: 25000, callMinutes: 250 },
};

export const MAX_PROMPT_CHARS = 100_000;
export const MAX_CALL_SECONDS = 1_800; // 30 min hard cap per call

// 1 message credit ≈ $0.001 of company spend (so Starter $2.50 → 2500 credits).
export const USD_PER_MESSAGE_CREDIT = 0.001;
// Estimated company cost per call-minute (Twilio + STT + LLM + TTS), USD.
export const USD_PER_CALL_MINUTE = 0.1; // Starter $2.50 → 25 min

export function estimateMessageCostUsd(promptTokens: number, completionTokens: number): number {
  // Conservative blended estimate (~$0.6/1M in, $2.4/1M out) for budget reservation.
  return (promptTokens * 0.6 + completionTokens * 2.4) / 1_000_000;
}

export function estimateCallCostUsd(seconds: number): number {
  return (Math.max(0, seconds) / 60) * USD_PER_CALL_MINUTE;
}

// Verify a Twilio webhook signature (X-Twilio-Signature). Twilio signs the full
// URL + sorted POST params with HMAC-SHA1 using the auth token.
// https://www.twilio.com/docs/usage/security#validating-requests
export async function verifyTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!authToken || !signature) return false;
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const key of sorted) data += key + params[key];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Constant-time-ish comparison.
  if (b64.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < b64.length; i++) diff |= b64.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
