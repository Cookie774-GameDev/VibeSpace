// @ts-nocheck
// stripe-webhook: verifies Stripe signatures, maps price IDs -> plans
// server-side, updates profiles.tier + subscriptions, and seeds voice_usage.
// Idempotent via subscription_events.event_id unique constraint.
//
// Security:
//   - Signature verified against the RAW request body (req.text()).
//   - Invalid/modified signatures -> 400.
//   - Duplicate event ids -> short-circuit (no double-credit).
//   - Plan is ALWAYS derived from the Stripe price id, never the client.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { planForPriceId } from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

function admin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function planFromSubscription(sub: Stripe.Subscription): string | null {
  for (const item of sub.items?.data ?? []) {
    const p = planForPriceId(item?.price?.id);
    if (p) return p;
  }
  return null;
}

async function applyPlan(customerId: string, plan: string, sub: Stripe.Subscription | null) {
  const db = admin();
  const { data: profile } = await db
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (!profile?.id) return;

  // profiles.tier change fires the voice_usage sync trigger automatically.
  await db.from('profiles').update({ tier: plan, updated_at: new Date().toISOString() }).eq('id', profile.id);

  if (sub) {
    await db.from('subscriptions').upsert({
      id: sub.id,
      user_id: profile.id,
      stripe_customer_id: customerId,
      status: sub.status,
      plan,
      price_id: sub.items?.data?.[0]?.price?.id ?? null,
      current_period_start: sub.current_period_start
        ? new Date(sub.current_period_start * 1000).toISOString() : null,
      current_period_end: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      updated_at: new Date().toISOString(),
    });
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'GET') return new Response('Jarvis Stripe webhook up.\n', { status: 200 });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET_KEY) {
    return new Response('Webhook not configured', { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('Missing stripe-signature', { status: 400 });

  const rawBody = await req.text(); // raw body required for signature verification
  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Signature verification failed: ${(err as Error).message}`, { status: 400 });
  }

  const db = admin();

  // Idempotency: unique event_id. If insert conflicts, we've seen it -> skip.
  const { error: dupErr } = await db.from('subscription_events').insert({
    event_id: event.id,
    event_type: event.type,
    payload: event as unknown as Record<string, unknown>,
    processed: false,
  });
  if (dupErr) {
    // Unique violation => already processed.
    return new Response('duplicate', { status: 200 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (customerId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(String(session.subscription));
          const plan = planFromSubscription(sub);
          if (plan) await applyPlan(customerId, plan, sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        if (customerId) {
          if (sub.status === 'active' || sub.status === 'trialing') {
            const plan = planFromSubscription(sub);
            if (plan) await applyPlan(customerId, plan, sub);
          } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'past_due') {
            await applyPlan(customerId, 'free', sub);
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        if (customerId) await applyPlan(customerId, 'free', sub);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (customerId) await applyPlan(customerId, 'free', null);
        break;
      }
      case 'invoice.payment_succeeded':
        // Period renewal: reserve_voice_seconds resets usage lazily on next call.
        break;
      default:
        break;
    }

    await db.from('subscription_events').update({ processed: true }).eq('event_id', event.id);
    return new Response('ok', { status: 200 });
  } catch (err) {
    // 500 -> Stripe retries with backoff.
    return new Response(`Handler error: ${(err as Error).message}`, { status: 500 });
  }
});
