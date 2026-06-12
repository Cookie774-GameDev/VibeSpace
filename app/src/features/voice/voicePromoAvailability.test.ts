import { describe, expect, it } from 'vitest';
import {
  isCloudVoiceAvailable,
  isDeepgramPromoAvailable,
  isPromoPoolActive,
  promoRemainingSeconds,
  resolveDeepgramTtsBilling,
} from './voicePromoAvailability';

const ACTIVE_POOL = { active: true, used_usd: 0, pause_at_usd: 900, budget_usd: 1000 };
const PAUSED_POOL = { active: false, used_usd: 901, pause_at_usd: 900, budget_usd: 1000 };
const KILL_THRESHOLD_POOL = { active: true, used_usd: 900, pause_at_usd: 900, budget_usd: 1000 };

describe('isPromoPoolActive', () => {
  it('is true when active and below pause_at', () => {
    expect(isPromoPoolActive(ACTIVE_POOL)).toBe(true);
  });

  it('is false at the 90% kill threshold', () => {
    expect(isPromoPoolActive(KILL_THRESHOLD_POOL)).toBe(false);
  });

  it('is false when active flag is cleared', () => {
    expect(isPromoPoolActive(PAUSED_POOL)).toBe(false);
  });
});

describe('isDeepgramPromoAvailable', () => {
  const freeUsage = { seconds_limit: 60, used_seconds: 0 };

  it('allows promo when pool and user allowance remain', () => {
    expect(isDeepgramPromoAvailable(ACTIVE_POOL, freeUsage)).toBe(true);
  });

  it('blocks when pool is paused even if user has seconds left', () => {
    expect(isDeepgramPromoAvailable(PAUSED_POOL, freeUsage)).toBe(false);
  });

  it('blocks when user promo seconds are exhausted', () => {
    expect(isDeepgramPromoAvailable(ACTIVE_POOL, { seconds_limit: 60, used_seconds: 60 })).toBe(
      false,
    );
  });
});

describe('isCloudVoiceAvailable', () => {
  const freeUsage = { seconds_limit: 60, used_seconds: 0 };

  it('free users rely on promo only', () => {
    expect(
      isCloudVoiceAvailable({
        pool: ACTIVE_POOL,
        promoUsage: freeUsage,
        monthlyBudgetUsd: 0,
        monthlyUsedUsd: 0,
      }),
    ).toBe(true);
    expect(
      isCloudVoiceAvailable({
        pool: PAUSED_POOL,
        promoUsage: freeUsage,
        monthlyBudgetUsd: 0,
        monthlyUsedUsd: 0,
      }),
    ).toBe(false);
  });

  it('paid users fall back to subscription budget when promo ends', () => {
    expect(
      isCloudVoiceAvailable({
        pool: PAUSED_POOL,
        promoUsage: { seconds_limit: 1800, used_seconds: 0 },
        monthlyBudgetUsd: 2.5,
        monthlyUsedUsd: 0,
      }),
    ).toBe(true);
    expect(
      isCloudVoiceAvailable({
        pool: PAUSED_POOL,
        promoUsage: { seconds_limit: 1800, used_seconds: 1800 },
        monthlyBudgetUsd: 2.5,
        monthlyUsedUsd: 2.5,
      }),
    ).toBe(false);
  });
});

describe('promoRemainingSeconds', () => {
  it('never returns negative values', () => {
    expect(promoRemainingSeconds({ seconds_limit: 60, used_seconds: 90 })).toBe(0);
  });
});

describe('resolveDeepgramTtsBilling', () => {
  it('uses promo when reserve succeeds', () => {
    expect(
      resolveDeepgramTtsBilling({
        provider: 'deepgram_tts',
        promoReserveOk: true,
        promoAttempted: true,
        tier: 'free',
      }),
    ).toEqual({ action: 'deepgram_promo' });
  });

  it('rejects free users when promo fails (no call_budget fallback)', () => {
    expect(
      resolveDeepgramTtsBilling({
        provider: 'deepgram_tts',
        promoReserveOk: false,
        promoAttempted: true,
        tier: 'free',
      }),
    ).toEqual({ action: 'reject_free_promo_exhausted' });
  });

  it('falls back to call_budget for paid users when promo fails', () => {
    expect(
      resolveDeepgramTtsBilling({
        provider: 'deepgram_tts',
        promoReserveOk: false,
        promoAttempted: true,
        tier: 'starter',
      }),
    ).toEqual({ action: 'call_budget' });
  });

  it('skips promo path for non-Deepgram providers', () => {
    expect(
      resolveDeepgramTtsBilling({
        provider: 'openai_tts',
        promoReserveOk: false,
        promoAttempted: false,
        tier: 'free',
      }),
    ).toEqual({ action: 'call_budget' });
  });
});
