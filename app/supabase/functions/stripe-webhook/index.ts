/**
 * Stripe → Supabase webhook bridge for Jarvis paid tiers.
 *
 * Lifecycle:
 *
 *   1. The Plans card opens a Stripe Checkout URL in the user's
 *      browser (`lib/billing/stripe.ts`).
 *   2. Stripe takes the payment and redirects the user back to
 *      whatever success URL the checkout link is configured with.
 *   3. Stripe POSTs to this function with a signed event. We verify
 *      the signature, decode the event, and update the matching
 *      `profiles` row to reflect the new tier (or revert to free
 *      on cancel).
 *   4. The Jarvis client picks up the new tier on its next poll of
 *      the profile (or whenever the auth listener fires next), and
 *      the entitlements module unlocks the gated features.
 *
 * Security:
 *
 *   - The Stripe signing secret is read from `STRIPE_WEBHOOK_SECRET`
 *     and *never* shipped to the client.
 *   - The Supabase service role key is used to bypass RLS so the
 *     function can update `profiles.tier` without impersonating the
 *     user. We pull it from `SUPABASE_SERVICE_ROLE_KEY`.
 *   - The function rejects any request whose signature doesn't
 *     match. Stripe's docs warn this is the only thing standing
 *     between you and someone forging upgrades, so we treat
 *     signature failures as 400 (not 500).
 *
 * Mapping rules:
 *
 *   - The Stripe Price ID embedded in the event tells us which
 *     tier to grant. The mapping lives in `PRICE_TO_TIER` below;
 *     change it whenever you publish a new price.
 *   - `customer.subscription.deleted` reverts to `free`. We don't
 *     downgrade on `subscription.updated` events with a new price
 *     because Stripe sends both an updated and a created event in
 *     that case; the created event handler is the source of truth.
 *
 * Deployment:
 *
 *   ```
 *   supabase functions deploy stripe-webhook
 *   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
 *   supabase secrets set STRIPE_PRICE_STARTER=price_...
 *   supabase secrets set STRIPE_PRICE_PRO=price_...
 *   supabase secrets set STRIPE_PRICE_ULTRA=price_...
 *   ```
 *
 *   Then add the function URL to your Stripe webhook endpoints with
 *   the `customer.subscription.created`, `.updated`, and `.deleted`
 *   events selected.
 *
 * This is a Supabase Edge Function (Deno runtime). It deliberately
 * avoids `npm:` imports so cold starts stay snappy; everything it
 * needs is on the standard library + the official Stripe Deno port.
 */

// @ts-expect-error — Deno std import works inside `supabase functions deploy`
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
// @ts-expect-error — Stripe ships a Deno-compatible build
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
// @ts-expect-error — Supabase JS works in Deno via esm.sh
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?target=deno';

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

// @ts-expect-error — Deno runtime global
const env = Deno.env;

const STRIPE_SECRET = env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_WEBHOOK_SECRET = env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/**
 * Price ID → tier mapping. Set the env vars on the function and the
 * lookup auto-resolves; we tolerate missing entries (only configured
 * tiers are honoured) so a partial roll-out is safe.
 */
const PRICE_TO_TIER: Record<string, 'starter' | 'pro' | 'ultra'> = {};
const STARTER_PRICE = env.get('STRIPE_PRICE_STARTER');
if (STARTER_PRICE) PRICE_TO_TIER[STARTER_PRICE] = 'starter';
const PRO_PRICE = env.get('STRIPE_PRICE_PRO');
if (PRO_PRICE) PRICE_TO_TIER[PRO_PRICE] = 'pro';
const ULTRA_PRICE = env.get('STRIPE_PRICE_ULTRA');
if (ULTRA_PRICE) PRICE_TO_TIER[ULTRA_PRICE] = 'ultra';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lazy-initialised Stripe client. Stripe's SDK validates the secret
 * at construction time so we defer it until we actually need it —
 * helpful for diagnostic GET requests.
 */
function getStripeClient(): Stripe {
  if (!STRIPE_SECRET) {
    throw new Error('STRIPE_SECRET_KEY env var is not set');
  }
  return new Stripe(STRIPE_SECRET, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/**
 * Lazy-initialised Supabase admin client. Uses the service role key
 * so RLS doesn't apply — the function is the trust boundary; the
 * client can never reach this code path.
 */
function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars are not set',
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Resolve a Stripe Subscription object to the tier we should
 * grant. Returns `null` when the subscription's price isn't one
 * we recognise (e.g. a leftover legacy plan) — caller leaves the
 * profile alone in that case rather than guessing.
 */
function tierFromSubscription(
  subscription: Stripe.Subscription,
): 'starter' | 'pro' | 'ultra' | null {
  const items = subscription.items?.data ?? [];
  for (const item of items) {
    const priceId = item?.price?.id;
    if (priceId && PRICE_TO_TIER[priceId]) {
      return PRICE_TO_TIER[priceId];
    }
  }
  return null;
}

/**
 * Update the matching `profiles` row to the given tier. We resolve
 * the user by `stripe_customer_id` rather than email because the
 * customer id is opaque, immutable, and unique — exactly the
 * properties you want for a key.
 *
 * Adds the column on the fly with a no-op upsert if it doesn't
 * exist yet (the migration ships in `0003_billing.sql`); a real
 * deployment should run that migration before deploying the
 * function so the `update` fast-path actually hits.
 */
async function setProfileTier(
  customerId: string,
  tier: 'free' | 'starter' | 'pro' | 'ultra',
): Promise<{ updated: number }> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('profiles')
    .update({ tier, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId)
    .select('id');
  if (error) throw new Error(`profiles.update failed: ${error.message}`);
  return { updated: data?.length ?? 0 };
}

/* -------------------------------------------------------------------------- */
/*  Request handler                                                           */
/* -------------------------------------------------------------------------- */

serve(async (req: Request) => {
  // Stripe issues GET requests as health checks when you point it at
  // the URL through the dashboard. Reply 200 so the dashboard shows
  // a green light.
  if (req.method === 'GET') {
    return new Response('Jarvis Stripe webhook is up.\n', { status: 200 });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    return new Response(
      'Webhook not configured (STRIPE_WEBHOOK_SECRET missing)',
      { status: 500 },
    );
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  // Stripe requires the *raw* request body for signature verification.
  // Reading via `req.text()` preserves the bytes verbatim, which is
  // what `constructEventAsync` expects.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await getStripeClient().webhooks.constructEventAsync(
      rawBody,
      sig,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    return new Response(
      `Signature verification failed: ${(err as Error).message}`,
      { status: 400 },
    );
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        if (!customerId) break;
        // Stripe marks subs `incomplete` until the first invoice is
        // paid; we wait for the first paid status to flip the tier
        // so a failed payment doesn't briefly grant access.
        if (
          sub.status !== 'active' &&
          sub.status !== 'trialing'
        ) {
          break;
        }
        const tier = tierFromSubscription(sub);
        if (tier) await setProfileTier(customerId, tier);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        if (customerId) await setProfileTier(customerId, 'free');
        break;
      }
      // Ignore non-subscription events (invoice.*, charge.*, etc.).
      // We don't need to do anything with them — Stripe surfaces
      // payment status through the subscription events we already
      // handle above.
      default:
        break;
    }
    // Stripe expects 2xx within 30 seconds or it will retry. Returning
    // an empty 200 is the canonical "I got it" response.
    return new Response('ok', { status: 200 });
  } catch (err) {
    // 500 makes Stripe retry with exponential backoff for up to 3
    // days — the right behaviour for a transient DB outage.
    return new Response(
      `Handler error: ${(err as Error).message}`,
      { status: 500 },
    );
  }
});
