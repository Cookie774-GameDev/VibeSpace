// @ts-nocheck
// create-customer-portal: authenticated, account-scoped Stripe portal.

import { handleCustomerPortal } from './handler.ts';

if (import.meta.main) {
  const [{ createClient }, stripeMod] = await Promise.all([
    import('https://esm.sh/@supabase/supabase-js@2.46.2'),
    import('https://esm.sh/stripe@14.21.0?target=deno'),
  ]);
  const Stripe = stripeMod.default;
  const env = Deno.env;
  const SUPABASE_URL = env.get('SUPABASE_URL') ?? '';
  const SUPABASE_ANON_KEY = env.get('SUPABASE_ANON_KEY') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const STRIPE_SECRET_KEY = env.get('STRIPE_SECRET_KEY') ?? '';
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
  const deps = {
    config: {
      stripeSecretKey: STRIPE_SECRET_KEY,
      appBaseUrl: env.get('APP_BASE_URL') ?? 'https://vibespaceos.com',
    },
    authenticate: async (jwt: string) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data, error } = await client.auth.getUser(jwt);
      if (error) throw error;
      return data.user;
    },
    getProfile: async (userId: string) => {
      const { data, error } = await admin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    createPortal: (params: unknown) => stripe.billingPortal.sessions.create(params),
  };
  Deno.serve((req: Request) =>
    handleCustomerPortal(req, deps).catch(
      () =>
        new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}
