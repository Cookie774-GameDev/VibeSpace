// @ts-nocheck
// create-checkout-session: starts a Stripe Checkout for a selected plan.
// The client sends ONLY a plan id ('starter'|'pro'|'ultra'); the price is
// resolved server-side from secrets. Never trust a client-supplied amount.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { json } from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'https://cookie774-gamedev.github.io/Jarivs-One';

const PRICE_FOR_PLAN: Record<string, string | undefined> = {
  starter: Deno.env.get('STRIPE_STARTER_PRICE_ID') ?? Deno.env.get('STRIPE_PRICE_STARTER'),
  pro: Deno.env.get('STRIPE_PRO_PRICE_ID') ?? Deno.env.get('STRIPE_PRICE_PRO'),
  ultra: Deno.env.get('STRIPE_ULTRA_PRICE_ID') ?? Deno.env.get('STRIPE_PRICE_ULTRA'),
};

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
  if (!STRIPE_SECRET_KEY) return json({ error: 'billing_unconfigured' }, 500, origin);

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const user = userData.user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  const plan = String(body.plan ?? '');
  const priceId = PRICE_FOR_PLAN[plan];
  if (!priceId) return json({ error: 'invalid_plan' }, 400, origin);

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Reuse an existing Stripe customer if we have one mapped on the profile.
  const { data: profile } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .maybeSingle();
  let customerId = profile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await admin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_BASE_URL}/billing/success`,
    cancel_url: `${APP_BASE_URL}/billing/cancel`,
    client_reference_id: user.id,
    metadata: { supabase_user_id: user.id, plan },
  });

  return json({ url: session.url }, 200, origin);
});
