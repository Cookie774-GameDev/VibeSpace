// @ts-nocheck
// call-status: Twilio status callback fired when a call completes. Verifies the
// signature, then settles the real call duration against the user's call budget.
// Deploy with --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { verifyTwilioSignature, estimateCallCostUsd } from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? '';

const MIN_RESERVE_SECONDS = 60;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const signature = req.headers.get('x-twilio-signature');
  const url = `${APP_BASE_URL}/functions/v1/call-status`;
  if (!(await verifyTwilioSignature(TWILIO_AUTH_TOKEN, signature, url, params))) {
    return new Response('invalid signature', { status: 403 });
  }

  const callSid = params.CallSid;
  const duration = parseInt(params.CallDuration ?? '0', 10) || 0;
  if (!callSid) return new Response('ok', { status: 200 });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Find the originating event to resolve the user.
  const { data: ev } = await admin
    .from('call_events')
    .select('user_id, estimated_cost_usd')
    .eq('call_sid', callSid)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!ev?.user_id) return new Response('ok', { status: 200 });

  const reserved = estimateCallCostUsd(MIN_RESERVE_SECONDS);
  const actual = estimateCallCostUsd(duration);
  await admin.rpc('settle_call_budget', {
    p_user_id: ev.user_id, p_reserved: reserved, p_actual: actual, p_seconds: duration,
  });
  await admin.rpc('record_usage_event', {
    p_kind: 'call', p_user_id: ev.user_id,
    p_payload: {
      call_sid: callSid, direction: 'outbound', duration_seconds: duration,
      actual_cost_usd: actual, status: 'completed',
    },
  });
  return new Response('ok', { status: 200 });
});
