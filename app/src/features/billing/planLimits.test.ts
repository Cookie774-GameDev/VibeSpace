import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PLANS,
  BILLING_PLAN_ORDER,
  messageUsageCopy,
  callUsageCopy,
} from './planLimits';

describe('PUBLIC_PLANS', () => {
  it('has correct prices and friendly limits (no raw dollar budgets)', () => {
    expect(PUBLIC_PLANS.free.priceUsd).toBe(0);
    expect(PUBLIC_PLANS.starter.priceUsd).toBe(10);
    expect(PUBLIC_PLANS.pro.priceUsd).toBe(50);
    expect(PUBLIC_PLANS.ultra.priceUsd).toBe(100);

    expect(PUBLIC_PLANS.free.messageCredits).toBe(0);
    expect(PUBLIC_PLANS.starter.messageCredits).toBe(2500);
    expect(PUBLIC_PLANS.pro.messageCredits).toBe(12500);
    expect(PUBLIC_PLANS.ultra.messageCredits).toBe(25000);

    expect(PUBLIC_PLANS.starter.callMinutes).toBe(25);
    expect(PUBLIC_PLANS.pro.callMinutes).toBe(125);
    expect(PUBLIC_PLANS.ultra.callMinutes).toBe(250);
  });

  it('orders plans free -> ultra', () => {
    expect(BILLING_PLAN_ORDER).toEqual(['free', 'starter', 'pro', 'ultra']);
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
        message_credits_included: 2500,
        message_credits_used: 100,
        message_credits_remaining: 2400,
        company_messaging_available: true,
      },
      'starter',
    );
    expect(copy).toContain('2,500');
    expect(copy).toContain('100');
    expect(copy).not.toContain('$');
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
