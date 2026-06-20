/**
 * Tests for the dynamic Supabase Edge Function billing helpers.
 *
 * callCheckoutSession  — calls create-checkout-session and returns a URL
 * callCustomerPortal   — calls create-customer-portal and returns a URL
 * isBackendBillingConfigured — true when supabase env is present
 *
 * We mock the Supabase client's `functions.invoke` to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── module-level mock ─────────────────────────────────────────────────────────
const mockInvoke = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({
    functions: { invoke: mockInvoke },
  }),
  isCloudSyncConfigured: () => true,
}));

import {
  callCheckoutSession,
  callCustomerPortal,
  isBackendBillingConfigured,
} from './checkout';

beforeEach(() => {
  mockInvoke.mockReset();
});

// ── callCheckoutSession ───────────────────────────────────────────────────────

describe('callCheckoutSession', () => {
  it('invokes the edge function with the correct plan and returns the URL', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { url: 'https://checkout.stripe.com/pay/cs_test_abc123' },
      error: null,
    });

    const result = await callCheckoutSession('pro');

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith('create-checkout-session', {
      body: { plan: 'pro' },
    });
    expect(result).toEqual({
      ok: true,
      url: 'https://checkout.stripe.com/pay/cs_test_abc123',
    });
  });

  it('returns ok:false when the edge function returns an error', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'billing_unconfigured' },
    });

    const result = await callCheckoutSession('starter');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/billing_unconfigured/);
  });

  it('returns ok:false when the response has no URL', async () => {
    mockInvoke.mockResolvedValueOnce({ data: {}, error: null });

    const result = await callCheckoutSession('ultra');

    expect(result.ok).toBe(false);
  });

  it('returns ok:false for free tier without calling the function', async () => {
    const result = await callCheckoutSession('free');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for apex tier and propagates url correctly', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { url: 'https://checkout.stripe.com/pay/cs_apex' },
      error: null,
    });

    const result = await callCheckoutSession('apex');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe('https://checkout.stripe.com/pay/cs_apex');
  });

  it('returns ok:false and an error message if the network call throws', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Network error'));

    const result = await callCheckoutSession('pro');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Network error/);
  });
});

// ── callCustomerPortal ────────────────────────────────────────────────────────

describe('callCustomerPortal', () => {
  it('invokes the edge function with no body and returns the portal URL', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { url: 'https://billing.stripe.com/session/portal_test' },
      error: null,
    });

    const result = await callCustomerPortal();

    expect(mockInvoke).toHaveBeenCalledWith('create-customer-portal', {});
    expect(result).toEqual({
      ok: true,
      url: 'https://billing.stripe.com/session/portal_test',
    });
  });

  it('returns ok:false when no customer exists', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'no_customer' },
    });

    const result = await callCustomerPortal();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no_customer/);
  });
});

// ── isBackendBillingConfigured ────────────────────────────────────────────────

describe('isBackendBillingConfigured', () => {
  it('returns true when supabase cloud sync is configured', () => {
    expect(isBackendBillingConfigured()).toBe(true);
  });
});
