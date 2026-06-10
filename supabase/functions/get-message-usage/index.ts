// @ts-nocheck
// get-message-usage: returns the authenticated user's message-AI usage as
// friendly credits (never raw dollar budgets).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import { USD_PER_MESSAGE_CREDIT } from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error } = await userClient.auth.getUser(jwt);
  if (error || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: usage } = await admin
    .from('message_usage')
    .select('plan, monthly_budget_usd, used_usd')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  const { data: limits } = await admin
    .from('subscription_plan_limits')
    .select('message_credits')
    .eq('plan', usage?.plan ?? 'free')
    .maybeSingle();

  const budget = usage?.monthly_budget_usd ?? 0;
  const used = usage?.used_usd ?? 0;
  const creditsIncluded = limits?.message_credits ?? 0;
  const creditsUsed = Math.min(creditsIncluded, Math.round(used / USD_PER_MESSAGE_CREDIT));

  return json(
    {
      plan: usage?.plan ?? 'free',
      message_credits_included: creditsIncluded,
      message_credits_used: creditsUsed,
      message_credits_remaining: Math.max(0, creditsIncluded - creditsUsed),
      company_messaging_available: budget > 0 && used < budget,
    },
    200,
    origin,
  );
});
