import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PLANS,
  BILLING_PLAN_ORDER,
  messageUsageCopy,
  callUsageCopy,
  bucketUsageCopy,
  usagePercent,
  formatUsageResetDate,
  unifiedCreditsFromCombined,
  unifiedCreditCopy,
  CREDITS_PER_PHONE_MINUTE,
  CREDITS_PER_SMS,
  type CombinedUsage,
  type UsageBucket,
} from './planLimits';

function bucket(
  partial: Partial<UsageBucket> & Pick<UsageBucket, 'included' | 'used'>,
): UsageBucket {
  return {
    remaining: Math.max(0, partial.included - partial.used),
    remaining_now: Math.max(0, partial.included - partial.used),
    window_5h_remaining:
      partial.window_5h_remaining ?? Math.max(0, partial.included - partial.used),
    window_weekly_remaining:
      partial.window_weekly_remaining ?? Math.max(0, partial.included - partial.used),
    available: partial.included > 0,
    ...partial,
  };
}

describe('PUBLIC_PLANS', () => {
  it('has correct prices and friendly limits (no raw dollar budgets)', () => {
    expect(PUBLIC_PLANS.free.priceUsd).toBe(0);
    expect(PUBLIC_PLANS.starter.priceUsd).toBe(10);
    expect(PUBLIC_PLANS.pro.priceUsd).toBe(50);
    expect(PUBLIC_PLANS.ultra.priceUsd).toBe(100);
    expect(PUBLIC_PLANS.apex.priceUsd).toBe(200);

    expect(PUBLIC_PLANS.free.messageCredits).toBe(0);
    expect(PUBLIC_PLANS.starter.messageCredits).toBe(1485);
    expect(PUBLIC_PLANS.pro.messageCredits).toBe(7425);
    expect(PUBLIC_PLANS.ultra.messageCredits).toBe(14850);
    expect(PUBLIC_PLANS.apex.messageCredits).toBe(29700);

    expect(PUBLIC_PLANS.starter.callMinutes).toBe(14);
    expect(PUBLIC_PLANS.pro.callMinutes).toBe(70);
    expect(PUBLIC_PLANS.ultra.callMinutes).toBe(140);
    expect(PUBLIC_PLANS.apex.callMinutes).toBe(280);

    expect(PUBLIC_PLANS.free.smsTexts).toBe(0);
    expect(PUBLIC_PLANS.starter.smsTexts).toBe(41);
    expect(PUBLIC_PLANS.pro.smsTexts).toBe(206);
    expect(PUBLIC_PLANS.ultra.smsTexts).toBe(412);
    expect(PUBLIC_PLANS.apex.smsTexts).toBe(825);
  });

  it('orders plans free -> apex', () => {
    expect(BILLING_PLAN_ORDER).toEqual(['free', 'starter', 'pro', 'ultra', 'apex']);
  });
});

it('uses explicit server-authoritative shared credit totals when available', () => {
  const usage = {
    plan: 'starter' as const,
    admin_unlimited: false,
    reset_date: null,
    message: bucket({ included: 1, used: 1 }),
    call: bucket({ included: 1, used: 1 }),
    sms: bucket({ included: 1, used: 1 }),
    credits_included: 5_500,
    credits_used: 275,
    credits_remaining: 5_225,
  };

  expect(unifiedCreditsFromCombined(usage)).toMatchObject({
    included: 5_500,
    used: 275,
    remaining: 5_225,
    percent: 5,
  });
});

describe('messageUsageCopy', () => {
  it('free plan says not included', () => {
    expect(messageUsageCopy(null, 'free')).toMatch(/not included/i);
  });
  it('paid plan shows credits used/included', () => {
    const copy = messageUsageCopy(
      {
        plan: 'starter',
        message_credits_included: 1485,
        message_credits_used: 100,
        message_credits_remaining: 1385,
        company_messaging_available: true,
      },
      'starter',
    );
    expect(copy).toContain('1,485');
    expect(copy).toContain('100');
    expect(copy).not.toContain('$');
  });
});

describe('bucketUsageCopy', () => {
  it('free plan says not included', () => {
    expect(bucketUsageCopy('SMS texts', 'texts', null, 'free')).toMatch(/not included/i);
  });
  it('paid plan shows monthly + weekly + 5h remainders and never dollars', () => {
    const copy = bucketUsageCopy(
      'SMS texts',
      'texts',
      {
        included: 100,
        used: 7,
        remaining: 93,
        remaining_now: 7,
        window_5h_remaining: 7,
        window_weekly_remaining: 18,
        available: true,
      },
      'starter',
    );
    expect(copy).toContain('100');
    expect(copy).toContain('18');
    expect(copy).toContain('5h');
    expect(copy).not.toContain('$');
  });
});

describe('usagePercent', () => {
  it('clamps and handles zero included', () => {
    expect(usagePercent(0, 0)).toBe(0);
    expect(usagePercent(50, 100)).toBe(50);
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(-1, 100)).toBe(0);
  });
});

describe('formatUsageResetDate', () => {
  it('returns null for empty/invalid', () => {
    expect(formatUsageResetDate(null)).toBeNull();
    expect(formatUsageResetDate('not-a-date')).toBeNull();
  });
  it('formats a valid ISO date', () => {
    const label = formatUsageResetDate('2026-08-01T00:00:00.000Z');
    expect(label).toBeTruthy();
    expect(label).toMatch(/2026|Aug|8/);
  });
});

describe('unifiedCreditsFromCombined', () => {
  it('rolls DeepSeek, phone, and SMS into one credit pool', () => {
    const usage: CombinedUsage = {
      plan: 'starter',
      admin_unlimited: false,
      reset_date: null,
      message: bucket({ included: 1485, used: 100 }),
      call: bucket({ included: 14, used: 2 }),
      sms: bucket({ included: 41, used: 5 }),
    };
    const pool = unifiedCreditsFromCombined(usage);
    expect(pool).not.toBeNull();
    // 1485 + 14*100 + 41*10 = 1485 + 1400 + 410 = 3295
    expect(pool!.included).toBe(1485 + 14 * CREDITS_PER_PHONE_MINUTE + 41 * CREDITS_PER_SMS);
    // 100 + 2*100 + 5*10 = 100 + 200 + 50 = 350
    expect(pool!.used).toBe(100 + 2 * CREDITS_PER_PHONE_MINUTE + 5 * CREDITS_PER_SMS);
    expect(pool!.remaining).toBe(pool!.included - pool!.used);
    expect(unifiedCreditCopy(pool, 'starter')).toMatch(/shared pool/i);
    expect(unifiedCreditCopy(pool, 'starter')).not.toContain('$');
  });

  it('free / empty plans stay at zero', () => {
    const usage: CombinedUsage = {
      plan: 'free',
      admin_unlimited: false,
      reset_date: null,
      message: bucket({ included: 0, used: 0 }),
      call: bucket({ included: 0, used: 0 }),
      sms: bucket({ included: 0, used: 0 }),
    };
    const pool = unifiedCreditsFromCombined(usage);
    expect(pool!.included).toBe(0);
    expect(unifiedCreditCopy(pool, 'free')).toMatch(/not included/i);
  });
});

describe('callUsageCopy', () => {
  it('free plan says not included', () => {
    expect(callUsageCopy(null, 'free')).toMatch(/not included/i);
  });
  it('paid plan shows minutes and never dollars', () => {
    const copy = callUsageCopy(
      {
        plan: 'pro',
        call_minutes_included: 125,
        call_minutes_used: 10,
        call_minutes_remaining: 115,
        company_calling_available: true,
      },
      'pro',
    );
    expect(copy).toContain('125');
    expect(copy).toContain('10');
    expect(copy).not.toContain('$');
  });
});
