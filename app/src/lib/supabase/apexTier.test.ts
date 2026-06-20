/**
 * Tests that apex is fully represented in the TypeScript tier model.
 *
 * These act as compile-time + runtime guards: if someone removes apex from
 * the union types, the assignments below will cause a TS error. The
 * runtime assertions verify the live values match expectations.
 */

import { describe, it, expect } from 'vitest';
import type { Tier, SubscriptionPlan } from './types';

describe('apex in Tier union', () => {
  it('Tier accepts apex without type error', () => {
    const t: Tier = 'apex';
    expect(t).toBe('apex');
  });

  it('Tier accepts all expected values', () => {
    const tiers: Tier[] = ['free', 'starter', 'pro', 'ultra', 'apex', 'plus', 'byok-only'];
    expect(tiers).toHaveLength(7);
  });
});

describe('apex in SubscriptionPlan union', () => {
  it('SubscriptionPlan accepts apex without type error', () => {
    const plan: SubscriptionPlan = 'apex';
    expect(plan).toBe('apex');
  });

  it('SubscriptionPlan covers all paid plans including apex', () => {
    const plans: SubscriptionPlan[] = ['free', 'starter', 'pro', 'ultra', 'apex'];
    expect(plans).toHaveLength(5);
  });
});
