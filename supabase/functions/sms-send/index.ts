// @ts-nocheck
// sms-send: secure outbound SMS to the user's OWN verified phone number.
//
// This is the canonical billed SMS path (replaces the phone-jarvis cloud
// /outbound/message route, which bypassed billing).
//
// Flow:
//   1. Require Supabase JWT; reject anonymous.
//   2. Validate body: { message } non-empty, <= MAX_SMS_CHARS.
//   3. Destination = phone_settings.user_phone_number for the AUTHENTICATED
//      user only. The client can NEVER supply a destination number.
//   4. Rate-limit per user (fail closed).
//   5. Admins skip budget; everyone else reserves via reserve_sms_budget
//      (atomic; monthly + weekly 25% + 5-hour 8% windows).
//   6. Send via Twilio REST API with the hidden company credentials.
//   7. Settle actual cost from Twilio's segment count; record an sms_event.
//
// Twilio signature validation is NOT needed here: this is an outbound API
// call we originate, not a Twilio webhook.
//
// Company keys live ONLY in Supabase secrets. 503 sms_not_configured when the
// TWILIO_* secrets are absent (they are provisioned separately).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import {
  estimateSmsCostUsd,
  isE164,
  MAX_SMS_CHARS,
  smsSegments,
} from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER') ?? '';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5; // SMS is expensive + annoying; keep the per-minute cap tight
const TWILIO_TIMEOUT_MS = 15_000;
// CTIA STOP-compliance footer, appended to the first text of each cycle.
const STOP_FOOTER = ' Reply STOP to opt out.';

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  // 1. Auth
  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  // 2. Validate body. Only `message` is accepted — no destination override.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  const message = String(body.message ?? '').trim();
  if (!message) return json({ error: 'empty_message' }, 400, origin);
  if (message.length > MAX_SMS_CHARS) {
    return json({ error: 'message_too_long', max: MAX_SMS_CHARS }, 413, origin);
  }

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return json({ error: 'sms_not_configured' }, 503, origin);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Destination: the authenticated user's own number, server-side lookup.
  const { data: phone } = await admin
    .from('phone_settings')
    .select('user_phone_number, twilio_phone_number')
    .eq('user_id', userId)
    .maybeSingle();
  const toNumber = String(phone?.user_phone_number ?? '').trim();
  if (!toNumber) return json({ error: 'no_phone_number' }, 400, origin);
  if (!isE164(toNumber)) return json({ error: 'invalid_phone_number' }, 400, origin);
  const fromNumber = String(phone?.twilio_phone_number ?? '').trim() || TWILIO_PHONE_NUMBER;
  if (!fromNumber || !isE164(fromNumber)) {
    return json({ error: 'sms_not_configured' }, 503, origin);
  }

  const { data: appAdminFlag } = await admin.rpc('is_app_admin', { p_user_id: userId });
  const appAdmin = Boolean(appAdminFlag);

  // 4. Rate limit (fail closed).
  const windowStart = new Date(Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS).toISOString();
  const { data: rl, error: rlErr } = await admin.rpc('sms_rate_limit_hit', {
    p_user_id: userId, p_window_start: windowStart, p_chars: message.length, p_max_requests: RATE_MAX,
  });
  if (rlErr) return json({ error: 'usage_unavailable' }, 503, origin);
  if ((rl as { limited?: boolean } | null)?.limited) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  // STOP compliance: append the opt-out footer to the first text of the cycle.
  const { data: usageRow } = await admin
    .from('sms_usage')
    .select('used_count')
    .eq('user_id', userId)
    .maybeSingle();
  const isFirstOfCycle = Number(usageRow?.used_count ?? 0) === 0;
  const finalMessage = isFirstOfCycle && !message.toUpperCase().includes('STOP')
    ? `${message}${STOP_FOOTER}`
    : message;

  // 5. Reserve budget (skipped for admins; the RPC enforces all three windows).
  const estSegments = smsSegments(finalMessage);
  const estCost = estimateSmsCostUsd(estSegments);
  if (!appAdmin) {
    const { data: reservation, error: reserveErr } = await admin.rpc('reserve_sms_budget', {
      p_user_id: userId, p_estimate_usd: estCost, p_count: 1,
    });
    if (reserveErr) return json({ error: 'usage_unavailable' }, 500, origin);
    const reserved = reservation as { ok: boolean; reason?: string; retry_after?: string } | null;
    if (!reserved?.ok) {
      await admin.rpc('record_usage_event', {
        p_kind: 'sms', p_user_id: userId,
        p_payload: {
          to_last4: toNumber.slice(-4), segments: estSegments, message_chars: finalMessage.length,
          status: 'blocked', error_code: reserved?.reason ?? 'budget',
        },
      });
      const reason = reserved?.reason ?? 'budget';
      const isWindow = reason === 'window_5h_exceeded' || reason === 'window_weekly_exceeded';
      return json(
        {
          error: isWindow ? 'rate_window_exceeded' : 'budget_exceeded',
          reason,
          retry_after: reserved?.retry_after ?? null,
        },
        isWindow ? 429 : 402,
        origin,
      );
    }
  }

  // 6. Twilio send (company credentials; never exposed to the client).
  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: toNumber, From: fromNumber, Body: finalMessage });
  let twilioRes: Response;
  let twilioBody: Record<string, unknown> = {};
  try {
    twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: timeoutSignal(TWILIO_TIMEOUT_MS),
      },
    );
    twilioBody = await twilioRes.json().catch(() => ({}));
  } catch {
    if (!appAdmin) {
      await admin.rpc('settle_sms_budget', {
        p_user_id: userId, p_reserved: estCost, p_actual: 0, p_count_delta: -1,
      });
    }
    await admin.rpc('record_usage_event', {
      p_kind: 'sms', p_user_id: userId,
      p_payload: {
        to_last4: toNumber.slice(-4), segments: estSegments, message_chars: finalMessage.length,
        status: 'error', error_code: 'twilio_unreachable',
      },
    });
    return json({ error: 'sms_unavailable' }, 502, origin);
  }

  if (!twilioRes.ok) {
    if (!appAdmin) {
      await admin.rpc('settle_sms_budget', {
        p_user_id: userId, p_reserved: estCost, p_actual: 0, p_count_delta: -1,
      });
    }
    await admin.rpc('record_usage_event', {
      p_kind: 'sms', p_user_id: userId,
      p_payload: {
        to_last4: toNumber.slice(-4), segments: estSegments, message_chars: finalMessage.length,
        status: 'error', error_code: `twilio_${twilioRes.status}`,
      },
    });
    return json({ error: 'sms_failed' }, 502, origin);
  }

  // 7. Settle actual cost (Twilio reports the real segment count) + record.
  const actualSegments = Math.max(1, Number(twilioBody.num_segments ?? estSegments) || estSegments);
  const actualCost = estimateSmsCostUsd(actualSegments);
  if (!appAdmin) {
    await admin.rpc('settle_sms_budget', {
      p_user_id: userId, p_reserved: estCost, p_actual: actualCost, p_count_delta: 0,
    });
  }
  await admin.rpc('record_usage_event', {
    p_kind: 'sms', p_user_id: userId,
    p_payload: {
      to_last4: toNumber.slice(-4), segments: actualSegments, message_chars: finalMessage.length,
      twilio_sid: typeof twilioBody.sid === 'string' ? twilioBody.sid : null,
      estimated_cost_usd: appAdmin ? 0 : estCost,
      actual_cost_usd: appAdmin ? 0 : actualCost,
      status: 'ok',
    },
  });

  return json({ ok: true, segments: actualSegments }, 200, origin);
});
