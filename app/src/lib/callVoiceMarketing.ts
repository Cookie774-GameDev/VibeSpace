/**
 * Launch rewards + subscription marketing copy (migration 0022).
 * All welcome credits are Deepgram-only: calls, Jarvis voice, global STT.
 */

export type CallVoicePlanId = 'free' | 'starter' | 'pro' | 'ultra' | 'apex';
export type PromoPhase = 'launch_1k' | 'scale_5k';

export const USD_PER_PHONE_MINUTE_DISPLAY = 0.1;
export const USD_PER_CLOUD_VOICE_MINUTE_DISPLAY = 0.015;
export const USD_PER_STT_MINUTE_DISPLAY = 0.008;

export const CALL_VOICE_BUDGET_USD: Record<CallVoicePlanId, number> = {
  free: 0,
  starter: 2.17,
  pro: 10.85,
  ultra: 21.7,
  apex: 43.4,
};

export const PHONE_MINUTES_BY_PLAN: Record<CallVoicePlanId, number> = {
  free: 0,
  starter: 22,
  pro: 109,
  ultra: 217,
  apex: 434,
};

export const DEEPGRAM_PROMO_POOL_USD: Record<PromoPhase, number> = {
  launch_1k: 1200, // $1.2k ceiling — $1k normal stop + $200 admin-reward headroom
  scale_5k: 5000,
};

/** Normal promo spend hard-stop per phase (admin-rewarded users get headroom). */
export const DEEPGRAM_PROMO_STOP_USD: Record<PromoPhase, number> = {
  launch_1k: 1000,
  scale_5k: 4500,
};

/** Phase 1 ($1k pool): first 200 signups only. */
export const LAUNCH_FOUNDER_SLOTS = 200;
export const FOUNDER_WELCOME_VOICE_USD = 5;
export const FOUNDER_WELCOME_SECONDS = 26667;
/** Spark promos ($5 founder + $2 phase-2) must be spent within this window. */
export const SPARK_PROMO_SPEND_DAYS = 7;

/** Phase 2 ($5k pool): first 1,000 Spark users only — NOT before $5k. */
export const LAUNCH_SPARK_PROMO_SLOTS = 1000;
export const SPARK_PROMO_VOICE_USD = 2;
export const SPARK_PROMO_SECONDS = 10667;

export const DEEPGRAM_PROMO_SECONDS: Record<PromoPhase, Record<CallVoicePlanId, number>> = {
  launch_1k: {
    free: 0,
    starter: 1800,
    pro: 5400,
    ultra: 10800,
    apex: 21600,
  },
  scale_5k: {
    free: SPARK_PROMO_SECONDS,
    starter: 10800,
    pro: 32400,
    ultra: 54000,
    apex: 108000,
  },
};

export const DEEPGRAM_PROMO_MINUTES_DISPLAY: Record<PromoPhase, Record<CallVoicePlanId, number>> = {
  launch_1k: {
    free: 0,
    starter: 30,
    pro: 90,
    ultra: 180,
    apex: 360,
  },
  scale_5k: {
    free: 120,
    starter: 180,
    pro: 540,
    ultra: 900,
    apex: 1800,
  },
};

export const CURRENT_PROMO_PHASE: PromoPhase = 'launch_1k';

const DEEPGRAM_USES = 'Deepgram credit — AI calls, talk to Jarvis & speech-to-text';

export function deepgramPromoMinutes(plan: CallVoicePlanId, phase: PromoPhase = CURRENT_PROMO_PHASE): number {
  return DEEPGRAM_PROMO_MINUTES_DISPLAY[phase][plan];
}

export function deepgramPromoLabel(
  plan: CallVoicePlanId,
  phase: PromoPhase = CURRENT_PROMO_PHASE,
): string | null {
  if (plan === 'free') {
    if (phase === 'launch_1k') {
      return null;
    }
    return `$${SPARK_PROMO_VOICE_USD} Spark promo (${DEEPGRAM_USES}) — first ${LAUNCH_SPARK_PROMO_SLOTS.toLocaleString()} users`;
  }
  const mins = deepgramPromoMinutes(plan, phase);
  if (mins < 60) return `${mins} min launch ${DEEPGRAM_USES} (one-time)`;
  if (mins < 180) return `${Math.round(mins / 60)} hr launch ${DEEPGRAM_USES} (one-time)`;
  return `${Math.round(mins / 60)} hr launch ${DEEPGRAM_USES} (one-time)`;
}

export const DEEPGRAM_PROMO_LABEL: Record<CallVoicePlanId, string | null> = {
  free: null,
  starter: deepgramPromoLabel('starter'),
  pro: deepgramPromoLabel('pro'),
  ultra: deepgramPromoLabel('ultra'),
  apex: deepgramPromoLabel('apex'),
};

export const FOUNDER_REWARD_HEADLINE =
  `First ${LAUNCH_FOUNDER_SLOTS} users: $${FOUNDER_WELCOME_VOICE_USD} FREE ${DEEPGRAM_USES}. Use within ${SPARK_PROMO_SPEND_DAYS} days. No card.`;

export const FOUNDER_WELCOME_TRY_LINE =
  '$5 Deepgram credit — ~50 min AI calls · ~5+ hr speech-to-text · ~110+ min Jarvis voice';

export const SPARK_PHASE2_HEADLINE =
  `At $5k pool: first ${LAUNCH_SPARK_PROMO_SLOTS.toLocaleString()} Spark users get $${SPARK_PROMO_VOICE_USD} ${DEEPGRAM_USES}`;

export const SPARK_PHASE2_TRY_LINE =
  '$2 Deepgram credit — ~20 min AI calls · ~2+ hr speech-to-text · ~45+ min Jarvis voice';

export const SCALE_5K_PAID_PROMO_LINE =
  'At $5k pool — Orbit 3 hr · Nova 9 hr · Singularity 15 hr · Supernova 30 hr launch Deepgram credit (subscriptions)';

export const SPARK_NO_FREE_CREDIT_LINE =
  'Unlimited local Kokoro · BYOK for cloud · first 200 get $5 Deepgram launch credit';

export const GLOBAL_DICTATION_LINE =
  'Global speech-to-text (Ctrl+CapsLock) — uses Deepgram launch credit when you have it';

export const UNLIMITED_LOCAL_KOKORO_LINE = 'Unlimited local Kokoro voice on every plan';

export function maxCloudVoiceMinutes(budgetUsd: number): number {
  if (budgetUsd <= 0) return 0;
  return Math.floor(budgetUsd / USD_PER_CLOUD_VOICE_MINUTE_DISPLAY);
}

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

export function callVoiceBucketLine(plan: CallVoicePlanId): string | null {
  const phone = PHONE_MINUTES_BY_PLAN[plan];
  const budget = CALL_VOICE_BUDGET_USD[plan];
  if (phone <= 0 || budget <= 0) return null;
  const cloud = formatCloudVoiceMaxLabel(budget);
  return `${phone} AI phone min/mo · up to ${cloud} min in-app cloud voice`;
}
