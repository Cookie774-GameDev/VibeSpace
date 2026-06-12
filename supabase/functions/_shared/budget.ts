// Shared budget/plan/Twilio helpers for messaging + calling + SMS Edge Functions.
// Deno runtime. Server-side only. Never bundled into the desktop app.

import { json } from './voice.ts';

export { json };

export type PlanId = 'free' | 'starter' | 'pro' | 'ultra';

// Server-authoritative budgets (USD/month). Mirror of subscription_plan_limits.
// The DB table is the source of truth at runtime; this is a typed fallback.
// Economics: 38% gross margin; 62% COGS split 50/35/15 AI/calls/SMS.
export const PLAN_LIMITS: Record<PlanId, {
  messageBudgetUsd: number;
  callBudgetUsd: number;
  smsBudgetUsd: number;
  messageCredits: number;
  callMinutes: number;
  smsCount: number;
}> = {
  free: { messageBudgetUsd: 0, callBudgetUsd: 0, smsBudgetUsd: 0, messageCredits: 0, callMinutes: 0, smsCount: 0 },
  starter: { messageBudgetUsd: 3.10, callBudgetUsd: 2.17, smsBudgetUsd: 0.93, messageCredits: 3100, callMinutes: 22, smsCount: 93 },
  pro: { messageBudgetUsd: 15.50, callBudgetUsd: 10.85, smsBudgetUsd: 4.65, messageCredits: 15500, callMinutes: 109, smsCount: 465 },
  ultra: { messageBudgetUsd: 31.00, callBudgetUsd: 21.70, smsBudgetUsd: 9.30, messageCredits: 31000, callMinutes: 217, smsCount: 930 },
};

// Triple rate windows: each spend bucket is capped per rolling window as a
// fraction of the monthly budget. Enforced server-side in the reserve RPCs.
export const WINDOW_5H_FRACTION = 0.08;
export const WINDOW_WEEK_FRACTION = 0.25;

export const MAX_PROMPT_CHARS = 100_000;
export const MAX_CALL_SECONDS = 1_800; // 30 min hard cap per call
export const MAX_SMS_CHARS = 1_000; // hard cap per request (~7 GSM segments)

// 1 message credit ≈ $0.001 of company spend (so Starter $3.10 → 3100 credits).
export const USD_PER_MESSAGE_CREDIT = 0.001;
// Estimated company cost per call-minute (Twilio + STT + LLM + TTS), USD.
export const USD_PER_CALL_MINUTE = 0.1; // Starter $2.17 → ~22 min
// Estimated company cost per SMS segment (Twilio outbound + overhead), USD.
export const USD_PER_SMS = 0.01; // Starter $0.93 → ~93 texts

// DeepSeek V4 Flash pricing (model `deepseek-chat`):
//   input  $0.14 / 1M tokens (cache miss)
//   input  $0.0028 / 1M tokens (cache hit)
//   output $0.28 / 1M tokens
export const DEEPSEEK_IN_MISS_PER_TOKEN = 0.14 / 1_000_000;
export const DEEPSEEK_IN_HIT_PER_TOKEN = 0.0028 / 1_000_000;
export const DEEPSEEK_OUT_PER_TOKEN = 0.28 / 1_000_000;

/** Conservative reservation estimate: assume every input token is a cache miss. */
export function estimateMessageCostUsd(promptTokens: number, completionTokens: number): number {
  return Math.max(0, promptTokens) * DEEPSEEK_IN_MISS_PER_TOKEN
    + Math.max(0, completionTokens) * DEEPSEEK_OUT_PER_TOKEN;
}

/** Exact DeepSeek cost from a usage block (cache-hit aware). */
export function deepseekActualCostUsd(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}): number {
  const prompt = Math.max(0, usage.prompt_tokens ?? 0);
  const completion = Math.max(0, usage.completion_tokens ?? 0);
  const hit = Math.max(0, usage.prompt_cache_hit_tokens ?? 0);
  const miss = Math.max(0, usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit));
  return miss * DEEPSEEK_IN_MISS_PER_TOKEN
    + hit * DEEPSEEK_IN_HIT_PER_TOKEN
    + completion * DEEPSEEK_OUT_PER_TOKEN;
}

export function estimateCallCostUsd(seconds: number): number {
  return (Math.max(0, seconds) / 60) * USD_PER_CALL_MINUTE;
}

/** GSM-7 texts split at 153 chars/segment (160 if single); UCS-2 at 67 (70). */
export function smsSegments(text: string): number {
  const len = text.length;
  if (len === 0) return 0;
  // deno-lint-ignore no-control-regex
  const isUcs2 = /[^\x00-\x7F]/.test(text);
  const single = isUcs2 ? 70 : 160;
  const multi = isUcs2 ? 67 : 153;
  if (len <= single) return 1;
  return Math.ceil(len / multi);
}

export function estimateSmsCostUsd(segments: number): number {
  return Math.max(0, segments) * USD_PER_SMS;
}

/** Strict E.164 (+ then 8–15 digits, no leading zero). */
export function isE164(num: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(num);
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
