/**
 * Stripe checkout URL helpers.
 *
 * Jarvis stays neutral on payments — we don't bundle a Stripe SDK and
 * we don't process cards. Each paid tier has a Stripe Checkout link
 * (https://buy.stripe.com/...) configured in the build's environment.
 * When the user hits "Upgrade", we open that URL in their browser;
 * Stripe takes the payment, then a Supabase edge function (see
 * `supabase/functions/stripe-webhook`) flips the user's tier on the
 * `profiles` row. The next page load reads the new tier from the
 * profile and unlocks the gated features.
 *
 * This module is the plumbing between "the user clicked upgrade" and
 * "we have a URL to send them to" — nothing more. It deliberately
 * avoids importing the Supabase client (the Plans card has to render
 * even when cloud sync is disabled) and the Tauri shell (the Settings
 * tab calls `openExternal` itself so the URL hop stays auditable in
 * one place).
 *
 * Env vars consumed (all optional — missing means "not configured"):
 *
 *   VITE_STRIPE_CHECKOUT_URL         legacy single-URL fallback used
 *                                    by the older HostedJarvis card
 *   VITE_STRIPE_CHECKOUT_STARTER     per-tier override for $5 Starter
 *   VITE_STRIPE_CHECKOUT_PRO         per-tier override for $20 Pro
 *   VITE_STRIPE_CHECKOUT_ULTRA       per-tier override for $100 Ultra
 *   VITE_STRIPE_CHECKOUT_APEX        per-tier override for $200 Supernova
 *
 * The per-tier values win over the legacy fallback, so a deployment
 * with the new four-tier ladder doesn't need to special-case the env.
 */

import type { PlanId } from '@/lib/entitlements';

/**
 * Map of tier ids to the env var name that holds their Stripe checkout
 * URL. `free` is intentionally missing — there's nothing to upgrade
 * to, and a stray env var here would be a footgun.
 */
const TIER_ENV: Partial<Record<PlanId, string>> = {
  starter: 'VITE_STRIPE_CHECKOUT_STARTER',
  pro: 'VITE_STRIPE_CHECKOUT_PRO',
  ultra: 'VITE_STRIPE_CHECKOUT_ULTRA',
  apex: 'VITE_STRIPE_CHECKOUT_APEX',
};

/**
 * Read a Vite env var. Wrapped in a try/catch so test runners that
 * don't define `import.meta.env` (or that stub it as `undefined`)
 * don't crash the module on import.
 */
function readEnv(key: string): string | undefined {
  try {
    const env = import.meta.env as Record<string, string | undefined>;
    const v = env?.[key];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Stripe checkout URL for a given tier.
 *
 * Returns `undefined` when:
 *   - The tier is `free` (nothing to charge).
 *   - No env var is set for the tier and there's no legacy fallback.
 *
 * Callers render an "Available soon" badge when the URL is undefined,
 * a real CTA when it's set.
 */
export function getCheckoutUrl(tier: PlanId): string | undefined {
  if (tier === 'free') return undefined;
  const envVar = TIER_ENV[tier];
  if (envVar) {
    const direct = readEnv(envVar);
    if (direct) return direct;
  }
  // Legacy single-URL fallback. The old HostedJarvis "Plus" card was
  // the only consumer; we honour it for backward compatibility but
  // recommend per-tier vars in `.env.example`.
  return readEnv('VITE_STRIPE_CHECKOUT_URL');
}

/**
 * Cheap "is any Stripe URL configured" probe. Used by the Plans page
 * footer so the "When billing ships" copy can swap to "Stripe is wired
 * up" once the deploy has env vars in place.
 */
export function isStripeConfigured(): boolean {
  if (readEnv('VITE_STRIPE_CHECKOUT_URL')) return true;
  for (const envVar of Object.values(TIER_ENV)) {
    if (envVar && readEnv(envVar)) return true;
  }
  return false;
}
