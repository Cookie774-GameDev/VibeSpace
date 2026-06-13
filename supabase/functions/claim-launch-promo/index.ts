// @ts-nocheck — Supabase Deno runtime (URL imports + Deno globals); not type-checked
// by the app's Node tsc. See supabase/functions/README.md.
//
// claim-launch-promo: idempotently claims the launch Deepgram promo for the
// authenticated user.
//
// Flow:
//   1. Require a valid Supabase JWT (reject anonymous).
//   2. Using the service role, attempt the founder $5 claim (first 200).
//   3. If the user is not a founder and phase 2 is live, attempt the Spark $2
//      claim (first 1,000).
//
// All eligibility, slot caps, verified-email checks, pool guards and 7-day
// expiry are enforced inside the SECURITY DEFINER RPCs (migration 0023). This
// function is a thin, safe trigger — calling it repeatedly is a no-op once a
// reward is claimed (`already_claimed`) and returns `promo_inactive` when the
// promo has not been launched yet.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: { ...json({}, 200, origin).headers } });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let result: Record<string, unknown> = { ok: false, reason: 'unknown' };

  try {
    const { data: founder, error: founderErr } = await service.rpc('claim_launch_founder_reward', {
      p_user_id: userId,
    });
    if (founderErr) {
      return json({ ok: false, reason: 'rpc_error' }, 200, origin);
    }
    result = (founder as Record<string, unknown>) ?? { ok: false };

    // Not a founder (slots full / not the promo) → try the phase-2 Spark promo.
    const reason = String((result as { reason?: string }).reason ?? '');
    if (!result.ok && (reason === 'founder_slots_exhausted' || reason === 'spark_promo_not_active')) {
      const { data: spark, error: sparkErr } = await service.rpc('claim_launch_spark_promo', {
        p_user_id: userId,
      });
      if (!sparkErr && spark) {
        const sparkResult = spark as Record<string, unknown>;
        if (sparkResult.ok) result = sparkResult;
      }
    }
  } catch {
    return json({ ok: false, reason: 'unexpected_error' }, 200, origin);
  }

  return json(result, 200, origin);
});
