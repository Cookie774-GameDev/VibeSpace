// @ts-nocheck
// get-voice-usage: returns the authenticated user's voice quota/usage.
// Local Kokoro voice is always available; cloud availability depends on plan + remaining quota.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Cloud voice draws from the SHARED call/voice budget (call_usage), so report
  // remaining from there. COST_PER_SECOND_USD converts dollars -> seconds.
  const { data: usage } = await admin
    .from('call_usage')
    .select('plan, monthly_budget_usd, used_usd')
    .eq('user_id', userId)
    .maybeSingle();

  const plan = usage?.plan ?? 'free';
  const budget = Number(usage?.monthly_budget_usd ?? 0);
  const used = Number(usage?.used_usd ?? 0);
  const remainingUsd = Math.max(0, budget - used);
  const COST_PER_SECOND_USD = 0.00025;
  const limit = Math.floor(budget / COST_PER_SECOND_USD);
  const usedSecs = Math.floor(used / COST_PER_SECOND_USD);
  const remaining = Math.floor(remainingUsd / COST_PER_SECOND_USD);

  return json(
    {
      plan,
      subscription_status: plan === 'free' ? 'free' : 'active',
      provider: 'shared_call_voice',
      monthly_seconds_limit: limit,
      monthly_seconds_used: usedSecs,
      remaining_seconds: remaining,
      reset_date: null,
      local_voice_available: true,
      cloud_voice_available: budget > 0 && remainingUsd > 0,
    },
    200,
    origin,
  );
});
