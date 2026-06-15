/**
 * @file Tests for the per-tier Stripe checkout URL resolver.
 *
 * The resolver is the bridge between "which env vars are set" and
 * "what does the Plans card render". Mistakes here ship as a button
 * that looks active but goes nowhere, or — worse — sends users to a
 * checkout for the wrong price. The tests pin:
 *   - per-tier env vars resolving to the matching URL,
 *   - free tier always returning undefined,
 *   - the legacy `VITE_STRIPE_CHECKOUT_URL` working as a fallback,
 *   - per-tier values winning over the legacy fallback.
 *
 * `import.meta.env` is a build-time constant in production but Vitest
 * exposes it as a plain object we can mutate. We `delete` keys in
 * `beforeEach` rather than assigning `undefined`, because Vite's
 * `define`-style env coercion turns `undefined` into the literal
 * string "undefined" — which would defeat the very emptiness check
 * we're trying to test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getCheckoutUrl, isStripeConfigured } from '@/lib/billing/stripe';

const ENV_KEYS = [
  'VITE_STRIPE_CHECKOUT_URL',
  'VITE_STRIPE_CHECKOUT_STARTER',
  'VITE_STRIPE_CHECKOUT_PRO',
  'VITE_STRIPE_CHECKOUT_ULTRA',
  'VITE_STRIPE_CHECKOUT_APEX',
] as const;

function clearEnv() {
  const env = import.meta.env as Record<string, unknown>;
  for (const key of ENV_KEYS) {
    delete env[key];
  }
}

function setEnv(key: string, value: string) {
  (import.meta.env as Record<string, unknown>)[key] = value;
}

beforeEach(() => {
  clearEnv();
});

describe('getCheckoutUrl', () => {
  it('returns undefined for the free tier no matter what is configured', () => {
    setEnv('VITE_STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/legacy');
    expect(getCheckoutUrl('free')).toBeUndefined();
  });

  it('returns the per-tier env var when set', () => {
    setEnv('VITE_STRIPE_CHECKOUT_PRO', 'https://buy.stripe.com/pro-link');
    expect(getCheckoutUrl('pro')).toBe('https://buy.stripe.com/pro-link');
  });

  it('returns the Apex/Supernova checkout URL when configured', () => {
    setEnv('VITE_STRIPE_CHECKOUT_APEX', 'https://buy.stripe.com/apex-link');
    expect(getCheckoutUrl('apex')).toBe('https://buy.stripe.com/apex-link');
  });

  it('falls back to VITE_STRIPE_CHECKOUT_URL when the per-tier var is unset', () => {
    setEnv('VITE_STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/legacy');
    expect(getCheckoutUrl('starter')).toBe('https://buy.stripe.com/legacy');
    expect(getCheckoutUrl('ultra')).toBe('https://buy.stripe.com/legacy');
  });

  it('prefers the per-tier var over the legacy fallback', () => {
    setEnv('VITE_STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/legacy');
    setEnv('VITE_STRIPE_CHECKOUT_PRO', 'https://buy.stripe.com/pro');
    expect(getCheckoutUrl('pro')).toBe('https://buy.stripe.com/pro');
    // Other tiers without their own var keep using the legacy fallback.
    expect(getCheckoutUrl('starter')).toBe('https://buy.stripe.com/legacy');
  });

  it('treats whitespace-only env values as unset', () => {
    setEnv('VITE_STRIPE_CHECKOUT_PRO', '   ');
    expect(getCheckoutUrl('pro')).toBeUndefined();
  });

  it('trims surrounding whitespace from a configured URL', () => {
    setEnv('VITE_STRIPE_CHECKOUT_PRO', '  https://buy.stripe.com/pro  ');
    expect(getCheckoutUrl('pro')).toBe('https://buy.stripe.com/pro');
  });
});

describe('isStripeConfigured', () => {
  it('reports true when the legacy var is set', () => {
    setEnv('VITE_STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/legacy');
    expect(isStripeConfigured()).toBe(true);
  });

  it('reports true when any per-tier var is set', () => {
    setEnv('VITE_STRIPE_CHECKOUT_ULTRA', 'https://buy.stripe.com/ultra');
    expect(isStripeConfigured()).toBe(true);
  });

  it('reports false when nothing is configured', () => {
    expect(isStripeConfigured()).toBe(false);
  });
});
