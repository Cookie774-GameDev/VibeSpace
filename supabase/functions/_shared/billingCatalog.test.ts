import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_PLANS,
  resolveCheckoutLineItems,
  resolveStripeEntitlement,
} from './billingCatalog.ts';

const config = {
  addonPriceIds: {
    starter: 'price_orbit',
    pro: 'price_nova',
    ultra: 'price_singularity',
    apex: 'price_supernova',
  },
} as const;

describe('owner-approved billing catalog', () => {
  it('keeps the exact Access, credit, and provider-budget contract', () => {
    assert.deepEqual(
      Object.values(BILLING_PLANS).map((plan) => [
        plan.id,
        plan.displayName,
        plan.totalUsd,
        plan.monthlyCredits,
        plan.usageBudgetUsd,
      ]),
      [
        ['free', 'Spark', 20, 1_000, 1],
        ['starter', 'Orbit', 30, 5_500, 5.5],
        ['pro', 'Nova', 70, 27_500, 27.5],
        ['ultra', 'Singularity', 120, 55_000, 55],
        ['apex', 'Supernova', 220, 110_000, 110],
      ],
    );
  });

  it('keeps feature-plan checkout separate from Access checkout', () => {
    assert.deepEqual(resolveCheckoutLineItems('free', config), {
      ok: false,
      error: 'invalid_plan',
    });
    assert.deepEqual(resolveCheckoutLineItems('pro', config), {
      ok: true,
      plan: BILLING_PLANS.pro,
      lineItems: [{ price: 'price_nova', quantity: 1 }],
    });
  });

  it('fails closed on unknown plans or incomplete server configuration', () => {
    assert.deepEqual(resolveCheckoutLineItems('enterprise', config), {
      ok: false,
      error: 'invalid_plan',
    });
    assert.deepEqual(
      resolveCheckoutLineItems('pro', {
        ...config,
        addonPriceIds: { ...config.addonPriceIds, pro: '' },
      }),
      { ok: false, error: 'billing_unconfigured' },
    );
  });

  it('derives feature entitlements only from exactly one known feature price', () => {
    assert.deepEqual(resolveStripeEntitlement(['price_orbit'], config), {
      ok: true,
      plan: BILLING_PLANS.starter,
      priceId: 'price_orbit',
    });
    assert.deepEqual(resolveStripeEntitlement(['price_nova'], config), {
      ok: true,
      plan: BILLING_PLANS.pro,
      priceId: 'price_nova',
    });
    assert.deepEqual(resolveStripeEntitlement(['price_orbit', 'price_nova'], config), {
      ok: false,
      error: 'ambiguous_plan',
    });
    assert.deepEqual(resolveStripeEntitlement(['price_access'], config), {
      ok: false,
      error: 'unknown_price',
    });
  });
});
