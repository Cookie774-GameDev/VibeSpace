/**
 * Display-only call + cloud voice marketing copy.
 *
 * Mirrors server budgets in `supabase/functions/_shared/budget.ts` and the
 * in-app cloud voice burn rate in `supabase/functions/_shared/voice.ts`
 * (`COST_PER_SECOND_USD` → ~$0.015/min). Enforcement stays server-side;
 * these helpers only format honest plan-card / pricing text.
 */

export type CallVoicePlanId = 'free' | 'starter' | 'pro' | 'ultra';

/** Worst-case phone burn: Twilio + STT + LLM + TTS stack (~$0.10/min). */
export const USD_PER_PHONE_MINUTE_DISPLAY = 0.1;

/** In-app cloud TTS burn against the shared bucket (~$0.015/min). */
export const USD_PER_CLOUD_VOICE_MINUTE_DISPLAY = 0.015;

/** Monthly call/voice bucket (USD) — mirrors `PLAN_LIMITS.callBudgetUsd`. */
export const CALL_VOICE_BUDGET_USD: Record<CallVoicePlanId, number> = {
  free: 0,
  starter: 2.17,
  pro: 10.85,
  ultra: 21.7,
};

/** Phone-minute headline at worst-case burn (`budget / 0.10`). */
export const PHONE_MINUTES_BY_PLAN: Record<CallVoicePlanId, number> = {
  free: 0,
  starter: 22,
  pro: 109,
  ultra: 217,
};

/** Launch Deepgram promo (one-time), mirrors `DEEPGRAM_LAUNCH_PROMO`. */
export const DEEPGRAM_PROMO_LABEL: Record<CallVoicePlanId, string | null> = {
  free: '1 min launch Deepgram promo (one-time)',
  starter: '30 min launch Deepgram promo (one-time)',
  pro: '90 min launch Deepgram promo (one-time)',
  ultra: '3 hr launch Deepgram promo (one-time)',
};

export function maxCloudVoiceMinutes(budgetUsd: number): number {
  if (budgetUsd <= 0) return 0;
  return Math.floor(budgetUsd / USD_PER_CLOUD_VOICE_MINUTE_DISPLAY);
}

/** Rounded-down friendly label, e.g. `~1,400+`. */
export function formatCloudVoiceMaxLabel(budgetUsd: number): string {
  const raw = maxCloudVoiceMinutes(budgetUsd);
  if (raw <= 0) return '';
  if (raw >= 1000) {
    const rounded = Math.floor(raw / 50) * 50;
    return `~${rounded.toLocaleString('en-US')}+`;
  }
  if (raw >= 100) {
    const rounded = Math.floor(raw / 10) * 10;
    return `~${rounded}+`;
  }
  return `~${raw}+`;
}

/** One line for plan cards: phone headline + cloud voice secondary. */
export function callVoiceBucketLine(plan: CallVoicePlanId): string | null {
  const phone = PHONE_MINUTES_BY_PLAN[plan];
  const budget = CALL_VOICE_BUDGET_USD[plan];
  if (phone <= 0 || budget <= 0) return null;
  const cloud = formatCloudVoiceMaxLabel(budget);
  return `${phone} AI phone min/mo · up to ${cloud} min in-app cloud voice`;
}

export const UNLIMITED_LOCAL_KOKORO_LINE = 'Unlimited local Kokoro voice on every plan';
