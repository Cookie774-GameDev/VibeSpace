// @ts-nocheck
// get-call-usage: returns the authenticated user's calling usage as friendly
// minutes (never raw dollar budgets).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';

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
    .from('call_usage')
    .select('plan, monthly_budget_usd, used_usd, used_seconds')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  const { data: limits } = await admin
    .from('subscription_plan_limits')
    .select('call_minutes')
    .eq('plan', usage?.plan ?? 'free')
    .maybeSingle();

  const budget = usage?.monthly_budget_usd ?? 0;
  const used = usage?.used_usd ?? 0;
  const minutesIncluded = limits?.call_minutes ?? 0;
  const minutesUsed = Math.round((usage?.used_seconds ?? 0) / 60);

  return json(
    {
      plan: usage?.plan ?? 'free',
      call_minutes_included: minutesIncluded,
      call_minutes_used: minutesUsed,
      call_minutes_remaining: Math.max(0, minutesIncluded - minutesUsed),
      company_calling_available: budget > 0 && used < budget,
    },
    200,
    origin,
  );
});
