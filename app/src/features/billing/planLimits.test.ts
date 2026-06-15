import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PLANS,
  BILLING_PLAN_ORDER,
  messageUsageCopy,
  callUsageCopy,
  bucketUsageCopy,
} from './planLimits';

describe('PUBLIC_PLANS', () => {
  it('has correct prices and friendly limits (no raw dollar budgets)', () => {
    expect(PUBLIC_PLANS.free.priceUsd).toBe(0);
    expect(PUBLIC_PLANS.starter.priceUsd).toBe(10);
    expect(PUBLIC_PLANS.pro.priceUsd).toBe(50);
    expect(PUBLIC_PLANS.ultra.priceUsd).toBe(100);
    expect(PUBLIC_PLANS.apex.priceUsd).toBe(200);

    expect(PUBLIC_PLANS.free.messageCredits).toBe(0);
    expect(PUBLIC_PLANS.starter.messageCredits).toBe(3100);
    expect(PUBLIC_PLANS.pro.messageCredits).toBe(15500);
    expect(PUBLIC_PLANS.ultra.messageCredits).toBe(31000);
    expect(PUBLIC_PLANS.apex.messageCredits).toBe(62000);

    expect(PUBLIC_PLANS.starter.callMinutes).toBe(22);
    expect(PUBLIC_PLANS.pro.callMinutes).toBe(109);
    expect(PUBLIC_PLANS.ultra.callMinutes).toBe(217);
    expect(PUBLIC_PLANS.apex.callMinutes).toBe(434);

    expect(PUBLIC_PLANS.free.smsTexts).toBe(0);
    expect(PUBLIC_PLANS.starter.smsTexts).toBe(100);
    expect(PUBLIC_PLANS.pro.smsTexts).toBe(500);
    expect(PUBLIC_PLANS.ultra.smsTexts).toBe(1000);
    expect(PUBLIC_PLANS.apex.smsTexts).toBe(1860);
  });

  it('orders plans free -> apex', () => {
    expect(BILLING_PLAN_ORDER).toEqual(['free', 'starter', 'pro', 'ultra', 'apex']);
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
        message_credits_included: 3100,
        message_credits_used: 100,
        message_credits_remaining: 3000,
        company_messaging_available: true,
      },
      'starter',
    );
    expect(copy).toContain('3,100');
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
