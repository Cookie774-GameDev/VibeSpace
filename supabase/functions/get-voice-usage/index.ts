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
  const { data: usage } = await admin
    .from('voice_usage')
    .select('plan, provider, monthly_seconds_limit, monthly_seconds_used, reset_date')
    .eq('user_id', userId)
    .maybeSingle();

  const plan = usage?.plan ?? 'free';
  const limit = usage?.monthly_seconds_limit ?? 0;
  const used = usage?.monthly_seconds_used ?? 0;
  const remaining = Math.max(0, limit - used);

  return json(
    {
      plan,
      subscription_status: plan === 'free' ? 'free' : 'active',
      provider: usage?.provider ?? 'kokoro_local',
      monthly_seconds_limit: limit,
      monthly_seconds_used: used,
      remaining_seconds: remaining,
      reset_date: usage?.reset_date ?? null,
      local_voice_available: true,
      cloud_voice_available: limit > 0 && remaining > 0,
    },
    200,
    origin,
  );
});
