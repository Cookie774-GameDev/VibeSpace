// @ts-nocheck
// call-start: authorize an AI call for the authenticated user.
//
// The desktop app NEVER holds the Twilio auth token. It calls this function,
// which verifies auth + active subscription + remaining call budget, reserves
// a minimum estimate, and (when Twilio is configured) initiates the call. The
// real per-second cost is settled by call-status when the call ends.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import { estimateCallCostUsd, MAX_CALL_SECONDS } from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? '';

const MIN_RESERVE_SECONDS = 60; // reserve at least 1 minute up front

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  const toNumber = String(body.to ?? '').trim();
  // Basic E.164 validation; reject anything that isn't a plausible phone number.
  if (!/^\+[1-9]\d{6,14}$/.test(toNumber)) return json({ error: 'invalid_number' }, 400, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Reserve a minimum estimate atomically; denies free users / exhausted budgets.
  const estCost = estimateCallCostUsd(MIN_RESERVE_SECONDS);
  const { data: reservation, error: reserveErr } = await admin
    .rpc('reserve_call_budget', { p_user_id: userId, p_estimate_usd: estCost });
  if (reserveErr) return json({ error: 'usage_unavailable' }, 500, origin);
  const reserved = reservation as { ok: boolean; reason?: string } | null;
  if (!reserved?.ok) {
    return json({ error: 'budget_exceeded', reason: reserved?.reason ?? 'budget' }, 402, origin);
  }

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    // Release the reservation; calling isn't configured yet.
    await admin.rpc('settle_call_budget', {
      p_user_id: userId, p_reserved: estCost, p_actual: 0, p_seconds: 0,
    });
    return json({ error: 'calling_unconfigured' }, 503, origin);
  }

  // Initiate the call via Twilio. TwiML/voice handling lives in twilio-voice-webhook.
  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({
    To: toNumber,
    From: TWILIO_PHONE_NUMBER,
    Url: `${APP_BASE_URL}/functions/v1/twilio-voice-webhook`,
    StatusCallback: `${APP_BASE_URL}/functions/v1/call-status`,
    StatusCallbackEvent: 'completed',
    Timeout: '30',
    TimeLimit: String(MAX_CALL_SECONDS),
  });
  let twilioRes: Response;
  try {
    twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    );
  } catch {
    await admin.rpc('settle_call_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0, p_seconds: 0 });
    return json({ error: 'call_provider_unavailable' }, 502, origin);
  }
  if (!twilioRes.ok) {
    await admin.rpc('settle_call_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0, p_seconds: 0 });
    return json({ error: 'call_failed' }, 502, origin);
  }
  const call = await twilioRes.json();
  await admin.rpc('record_usage_event', {
    p_kind: 'call', p_user_id: userId,
    p_payload: { call_sid: call.sid, direction: 'outbound', status: 'initiated', estimated_cost_usd: estCost },
  });
  return json({ call_sid: call.sid, status: 'initiated', max_seconds: MAX_CALL_SECONDS }, 200, origin);
});
