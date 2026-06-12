/**
 * Pure helpers mirroring get-voice-usage + tts-speak promo gating.
 * Server remains source of truth; these power tests and UI edge cases.
 */

export interface PromoPoolSnapshot {
  active: boolean;
  used_usd: number;
  pause_at_usd: number;
  budget_usd?: number;
}

export interface PromoUsageSnapshot {
  seconds_limit: number;
  used_seconds: number;
}

export function isPromoPoolActive(pool: PromoPoolSnapshot | null | undefined): boolean {
  if (!pool) return false;
  return Boolean(pool.active) && pool.used_usd < pool.pause_at_usd;
}

export function promoRemainingSeconds(usage: PromoUsageSnapshot | null | undefined): number {
  if (!usage) return 0;
  return Math.max(0, usage.seconds_limit - usage.used_seconds);
}

export function isDeepgramPromoAvailable(
  pool: PromoPoolSnapshot | null | undefined,
  usage: PromoUsageSnapshot | null | undefined,
): boolean {
  return isPromoPoolActive(pool) && promoRemainingSeconds(usage) > 0;
}

export function isCloudVoiceAvailable(params: {
  pool: PromoPoolSnapshot | null | undefined;
  promoUsage: PromoUsageSnapshot | null | undefined;
  monthlyBudgetUsd: number;
  monthlyUsedUsd: number;
}): boolean {
  const remainingUsd = Math.max(0, params.monthlyBudgetUsd - params.monthlyUsedUsd);
  return (
    isDeepgramPromoAvailable(params.pool, params.promoUsage) ||
    (params.monthlyBudgetUsd > 0 && remainingUsd > 0)
  );
}

export type TtsBillingRoute =
  | { action: 'deepgram_promo' }
  | { action: 'reject_free_promo_exhausted' }
  | { action: 'call_budget' };

/** Mirrors tts-speak billing fallback after reserve_deepgram_promo. */
export function resolveDeepgramTtsBilling(params: {
  provider: string;
  promoReserveOk: boolean;
  promoAttempted: boolean;
  tier: string;
}): TtsBillingRoute {
  if (params.provider !== 'deepgram_tts') {
    return { action: 'call_budget' };
  }
  if (params.promoReserveOk) {
    return { action: 'deepgram_promo' };
  }
  if (params.promoAttempted && params.tier === 'free') {
    return { action: 'reject_free_promo_exhausted' };
  }
  return { action: 'call_budget' };
}
