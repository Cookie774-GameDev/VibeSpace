// Read-only invoice projection. No checkout, charge, subscription or webhook writes.
import { createClient } from 'npm:@supabase/supabase-js@2.46.2';
import { handleBillingReceipts } from './handler.ts';
const base = Deno.env.get('SUPABASE_URL') ?? '';
const auth = createClient(base, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
const admin = createClient(base, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve((req: Request) =>
  handleBillingReceipts(req, {
    authenticate: async (jwt) => {
      const { data, error } = await auth.auth.getUser(jwt);
      if (error) throw error;
      return data.user;
    },
    getProfile: async (id) => {
      const { data, error } = await admin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    listInvoices: async (customer) => {
      const key = Deno.env.get('STRIPE_SECRET_KEY');
      if (!key) throw Error('billing_unconfigured');
      const url = new URL('https://api.stripe.com/v1/invoices');
      url.searchParams.set('customer', customer);
      url.searchParams.set('limit', '24');
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2026-07-29.dahlia' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('invoice_unavailable');
      }
      return response.json();
    },
  }),
);
