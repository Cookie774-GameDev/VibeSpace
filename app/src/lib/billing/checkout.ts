/**
 * Dynamic billing helpers — frontend side.
 *
 * These call the Supabase Edge Functions that live in
 * `supabase/functions/create-checkout-session` and
 * `supabase/functions/create-customer-portal`. The JWT is attached
 * automatically by the Supabase client's `functions.invoke` method (it
 * reads the active session from auth storage), so no secret keys ever
 * touch the frontend bundle.
 *
 * Usage (Plans CTA):
 *   const result = await callCheckoutSession('pro');
 *   if (result.ok) openExternal(result.url);
 *
 * Usage (Account / manage subscription):
 *   const result = await callCustomerPortal();
 *   if (result.ok) openExternal(result.url);
 */

import type { PlanId } from '@/lib/entitlements';
import { getSupabaseClient, isCloudSyncConfigured } from '@/lib/supabase/client';

// ── Shared result shape ───────────────────────────────────────────────────────

export type BillingResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

// ── callCheckoutSession ───────────────────────────────────────────────────────

/**
 * Starts a Stripe Checkout session for the target plan via the
 * `create-checkout-session` Supabase Edge Function.
 *
 * Returns `{ ok: false }` immediately for the free tier (nothing to charge)
 * or when the Supabase client is unavailable.
 */
export async function callCheckoutSession(tier: PlanId): Promise<BillingResult> {
  if (tier === 'free') {
    return { ok: false, error: 'free tier has no checkout' };
  }

  const supa = getSupabaseClient();
  if (!supa) {
    return { ok: false, error: 'supabase_unconfigured' };
  }

  try {
    const { data, error } = await supa.functions.invoke('create-checkout-session', {
      body: { plan: tier },
    });

    if (error) {
      const msg = typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error);
      return { ok: false, error: msg };
    }

    const url = (data as Record<string, unknown>)?.url;
    if (typeof url !== 'string' || !url) {
      return { ok: false, error: 'no_checkout_url_returned' };
    }

    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'checkout_failed' };
  }
}

// ── callCustomerPortal ────────────────────────────────────────────────────────

/**
 * Opens the Stripe billing portal for the signed-in user via the
 * `create-customer-portal` Supabase Edge Function.
 *
 * Returns `{ ok: false, error: 'no_customer' }` when the user has no
 * Stripe customer ID yet (i.e. they've never had a paid subscription).
 */
export async function callCustomerPortal(): Promise<BillingResult> {
  const supa = getSupabaseClient();
  if (!supa) {
    return { ok: false, error: 'supabase_unconfigured' };
  }

  try {
    const { data, error } = await supa.functions.invoke('create-customer-portal', {});

    if (error) {
      const msg = typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error);
      return { ok: false, error: msg };
    }

    const url = (data as Record<string, unknown>)?.url;
    if (typeof url !== 'string' || !url) {
      return { ok: false, error: 'no_portal_url_returned' };
    }

    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'portal_failed' };
  }
}

// ── isBackendBillingConfigured ────────────────────────────────────────────────

/**
 * True when the Supabase cloud-sync env vars are present, meaning the
 * Edge Functions can be reached and dynamic checkout is available.
 *
 * When this returns false, the Plans page falls back to static hosted
 * Stripe links (env VITE_STRIPE_CHECKOUT_*) where configured.
 */
export function isBackendBillingConfigured(): boolean {
  return isCloudSyncConfigured();
}
