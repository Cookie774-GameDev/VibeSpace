// @ts-nocheck
// create-customer-portal: returns a Stripe billing portal URL for the user.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { json } from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'https://cookie774-gamedev.github.io/VibeSpace';

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

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userData.user.id)
    .maybeSingle();
  const customerId = profile?.stripe_customer_id as string | undefined;
  if (!customerId) return json({ error: 'no_customer' }, 404, origin);

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_BASE_URL}/account`,
  });

  return json({ url: portal.url }, 200, origin);
});
