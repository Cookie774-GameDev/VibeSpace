/**
 * Frontend plan-limits + usage display helpers.
 *
 * DISPLAY ONLY. The server (subscription_plan_limits + Edge Functions) is the
 * authoritative source for entitlements and quota enforcement. These constants
 * mirror the public-facing credits/minutes/texts so the UI can render plan
 * cards and usage bars. Raw dollar budgets are intentionally NOT exposed here.
 */

import {
  callVoiceBucketLine,
  FOUNDER_REWARD_HEADLINE,
  FOUNDER_WELCOME_TRY_LINE,
  PHONE_MINUTES_BY_PLAN,
  SPARK_NO_FREE_CREDIT_LINE,
  SPARK_PHASE2_HEADLINE,
  UNLIMITED_LOCAL_KOKORO_LINE,
} from '@/lib/callVoiceMarketing';

export type BillingPlanId = 'free' | 'starter' | 'pro' | 'ultra' | 'apex';

export interface PublicPlan {
  id: BillingPlanId;
  label: string;
  priceUsd: number;
  /** Friendly monthly AI message credits (0 = not included). */
  messageCredits: number;
  /** Friendly monthly AI call minutes (0 = not included). */
  callMinutes: number;
  /** Friendly monthly SMS texts (0 = not included). */
  smsTexts: number;
  blurb: string;
}

export const PUBLIC_PLANS: Record<BillingPlanId, PublicPlan> = {
  free: {
    id: 'free',
    label: 'Free',
    priceUsd: 0,
    messageCredits: 0,
    callMinutes: 0,
    smsTexts: 0,
    blurb: `${FOUNDER_REWARD_HEADLINE} ${FOUNDER_WELCOME_TRY_LINE} ${SPARK_NO_FREE_CREDIT_LINE}. ${SPARK_PHASE2_HEADLINE}.`,
  },
  starter: {
    id: 'starter',
    label: 'Orbit',
    priceUsd: 10,
    /** DeepSeek credits @ $0.001 — 45% of 33% sticker COGS. */
    messageCredits: 1485,
    callMinutes: PHONE_MINUTES_BY_PLAN.starter,
    smsTexts: 41,
    blurb: `${callVoiceBucketLine('starter')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Plus DeepSeek chat credits and SMS.`,
  },
  pro: {
    id: 'pro',
    label: 'Nova',
    priceUsd: 50,
    messageCredits: 7425,
    callMinutes: PHONE_MINUTES_BY_PLAN.pro,
    smsTexts: 206,
    blurb: `${callVoiceBucketLine('pro')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Plus more DeepSeek credits and SMS.`,
  },
  ultra: {
    id: 'ultra',
    label: 'Singularity',
    priceUsd: 100,
    messageCredits: 14850,
    callMinutes: PHONE_MINUTES_BY_PLAN.ultra,
    smsTexts: 412,
    blurb: `${callVoiceBucketLine('ultra')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Maximum DeepSeek credits and SMS.`,
  },
  apex: {
    id: 'apex',
    label: 'Supernova',
    priceUsd: 200,
    messageCredits: 29700,
    callMinutes: PHONE_MINUTES_BY_PLAN.apex,
    smsTexts: 825,
    blurb: `${callVoiceBucketLine('apex')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Double Singularity for heavy voice + chat.`,
  },
};

export const BILLING_PLAN_ORDER: ReadonlyArray<BillingPlanId> = [
  'free',
  'starter',
  'pro',
  'ultra',
  'apex',
];

/** One spend bucket as returned by the get-message-usage edge function. */
export interface UsageBucket {
  included: number;
  used: number;
  remaining: number;
  /** Effective remaining right now (tightest of 5h / weekly / monthly windows). */
  remaining_now: number;
  window_5h_remaining: number;
  window_weekly_remaining: number;
  available: boolean;
}

/** Combined response from get-message-usage (v2). */
export interface CombinedUsage {
  plan: BillingPlanId;
  admin_unlimited: boolean;
  reset_date: string | null;
  message: UsageBucket;
  call: UsageBucket;
  sms: UsageBucket;
  /** Shared company pool (1 credit ≈ $0.001). Optional for older edge builds. */
  credits_included?: number;
  credits_used?: number;
  credits_remaining?: number;
}

export interface MessageUsage {
  plan: BillingPlanId;
  message_credits_included: number;
  message_credits_used: number;
  message_credits_remaining: number;
  company_messaging_available: boolean;
}

export interface CallUsage {
  plan: BillingPlanId;
  call_minutes_included: number;
  call_minutes_used: number;
  call_minutes_remaining: number;
  company_calling_available: boolean;
}

/** Friendly usage copy. Never shows dollar budgets. */
export function messageUsageCopy(u: MessageUsage | null, plan: BillingPlanId): string {
  if (plan === 'free' || !u || u.message_credits_included === 0) {
    return 'Company AI messages not included. Bring your own key or use a local model.';
  }
  return `AI messages: ${u.message_credits_used.toLocaleString()} used / ${u.message_credits_included.toLocaleString()} included.`;
}

export function callUsageCopy(u: CallUsage | null, plan: BillingPlanId): string {
  if (plan === 'free' || !u || u.call_minutes_included === 0) {
    return 'AI calling not included on this plan.';
  }
  return `AI phone minutes: ${u.call_minutes_used} min used / ${u.call_minutes_included} min included (worst-case phone burn).`;
}

/** Friendly per-bucket copy with window remainders. Never shows dollars. */
export function bucketUsageCopy(
  label: string,
  unit: string,
  b: UsageBucket | null | undefined,
  plan: BillingPlanId,
): string {
  if (plan === 'free' || !b || b.included === 0) {
    return `${label} not included on this plan.`;
  }
  return (
    `${label}: ${b.used.toLocaleString()} used / ${b.included.toLocaleString()} ${unit} included · ` +
    `${b.window_weekly_remaining.toLocaleString()} left this week · ` +
    `${b.window_5h_remaining.toLocaleString()} left this 5h window.`
  );
}

async function fetchUsage<T>(fn: string): Promise<T | null> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase');
    const client = getSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function getMessageUsage(): Promise<MessageUsage | null> {
  return fetchUsage<MessageUsage>('get-message-usage');
}

export function getCallUsage(): Promise<CallUsage | null> {
  return fetchUsage<CallUsage>('get-call-usage');
}

/** All three buckets (messages / calls / SMS) with window remainders. */
export function getCombinedUsage(): Promise<CombinedUsage | null> {
  return fetchUsage<CombinedUsage>('get-message-usage');
}

/** Progress bar percent (0–100). Safe when included is 0. */
export function usagePercent(used: number, included: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(included) || included <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / included) * 100)));
}

/** Human reset label for usage footers. Returns null when unknown. */
export function formatUsageResetDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Unified company credits — one internal unit for DeepSeek, phone, and SMS.
 * 1 credit ≈ $0.001 company cost (same as a DeepSeek message credit).
 */
export const CREDITS_PER_USD = 1000;
/** Phone minute ≈ $0.10 → 100 credits. */
export const CREDITS_PER_PHONE_MINUTE = 100;
/** SMS text ≈ $0.01 → 10 credits. */
export const CREDITS_PER_SMS = 10;

export interface UnifiedCreditPool {
  included: number;
  used: number;
  remaining: number;
  percent: number;
  /** Soft breakdown for legend (not separate hard caps when pool is fungible). */
  deepseekUsed: number;
  phoneMinutesUsed: number;
  smsUsed: number;
}

/** Convert a CombinedUsage snapshot into one shared credit pool for the UI bar. */
export function unifiedCreditsFromCombined(
  usage: CombinedUsage | null | undefined,
): UnifiedCreditPool | null {
  if (!usage) return null;
  if (usage.admin_unlimited) {
    return {
      included: Number.POSITIVE_INFINITY,
      used: 0,
      remaining: Number.POSITIVE_INFINITY,
      percent: 0,
      deepseekUsed: 0,
      phoneMinutesUsed: 0,
      smsUsed: 0,
    };
  }
  const deepseekUsed = Math.max(0, usage.message?.used ?? 0);
  const phoneMinutesUsed = Math.max(0, usage.call?.used ?? 0);
  const smsUsed = Math.max(0, usage.sms?.used ?? 0);

  const hasExplicitCredits =
    Number.isFinite(usage.credits_included) &&
    Number.isFinite(usage.credits_used) &&
    Number.isFinite(usage.credits_remaining);
  if (hasExplicitCredits) {
    const included = Math.max(0, usage.credits_included ?? 0);
    const used = Math.max(0, usage.credits_used ?? 0);
    const remaining = Math.max(0, usage.credits_remaining ?? included - used);
    return {
      included,
      used: Math.min(used, included || used),
      remaining: Math.min(remaining, included),
      percent: usagePercent(used, included || used || 1),
      deepseekUsed,
      phoneMinutesUsed,
      smsUsed,
    };
  }

  const included =
    Math.max(0, usage.message?.included ?? 0) +
    Math.max(0, usage.call?.included ?? 0) * CREDITS_PER_PHONE_MINUTE +
    Math.max(0, usage.sms?.included ?? 0) * CREDITS_PER_SMS;

  const used =
    deepseekUsed + phoneMinutesUsed * CREDITS_PER_PHONE_MINUTE + smsUsed * CREDITS_PER_SMS;

  if (included <= 0 && used <= 0) {
    return {
      included: 0,
      used: 0,
      remaining: 0,
      percent: 0,
      deepseekUsed,
      phoneMinutesUsed,
      smsUsed,
    };
  }

  const remaining = Math.max(0, included - used);
  return {
    included,
    used: Math.min(used, included || used),
    remaining,
    percent: usagePercent(used, included || used || 1),
    deepseekUsed,
    phoneMinutesUsed,
    smsUsed,
  };
}

export function unifiedCreditCopy(pool: UnifiedCreditPool | null, plan: BillingPlanId): string {
  if (plan === 'free' || !pool || pool.included === 0) {
    return 'Company credits not included on this plan. Use BYOK or local models for chat; subscribe for DeepSeek, phone, and SMS.';
  }
  if (!Number.isFinite(pool.included)) {
    return 'Admin unlimited company credits.';
  }
  return (
    `Shared pool: ${pool.used.toLocaleString()} used / ${pool.included.toLocaleString()} credits · ` +
    `${pool.remaining.toLocaleString()} left. ` +
    `Rates: DeepSeek 1 credit · phone ${CREDITS_PER_PHONE_MINUTE}/min · SMS ${CREDITS_PER_SMS}/text.`
  );
}
