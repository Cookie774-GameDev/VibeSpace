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
  PHONE_MINUTES_BY_PLAN,
  UNLIMITED_LOCAL_KOKORO_LINE,
} from '@/lib/callVoiceMarketing';

export type BillingPlanId = 'free' | 'starter' | 'pro' | 'ultra';

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
    blurb: `${UNLIMITED_LOCAL_KOKORO_LINE}. Bring your own keys — no company-paid cloud AI, calling, SMS, or cloud voice.`,
  },
  starter: {
    id: 'starter',
    label: 'Starter',
    priceUsd: 10,
    messageCredits: 3100,
    callMinutes: PHONE_MINUTES_BY_PLAN.starter,
    smsTexts: 100,
    blurb: `${callVoiceBucketLine('starter')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Plus AI messages and SMS.`,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    priceUsd: 50,
    messageCredits: 15500,
    callMinutes: PHONE_MINUTES_BY_PLAN.pro,
    smsTexts: 500,
    blurb: `${callVoiceBucketLine('pro')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Plus more AI messages and SMS.`,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra',
    priceUsd: 100,
    messageCredits: 31000,
    callMinutes: PHONE_MINUTES_BY_PLAN.ultra,
    smsTexts: 1000,
    blurb: `${callVoiceBucketLine('ultra')}. ${UNLIMITED_LOCAL_KOKORO_LINE}. Maximum AI messages and SMS.`,
  },
};

export const BILLING_PLAN_ORDER: ReadonlyArray<BillingPlanId> = ['free', 'starter', 'pro', 'ultra'];

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
