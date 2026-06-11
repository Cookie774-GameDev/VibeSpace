// @ts-nocheck
// twilio-message-webhook: inbound SMS handler. Verifies Twilio signature,
// handles STOP/HELP opt-out keywords, records a message event, and returns
// empty TwiML. Deploy with --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { verifyTwilioSignature } from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? '';

const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

function twiml(message?: string): Response {
  const body = message ? `<Message>${message}</Message>` : '';
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200,
    headers: { 'content-type': 'text/xml' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const signature = req.headers.get('x-twilio-signature');
  const url = `${APP_BASE_URL}/functions/v1/twilio-message-webhook`;
  if (!(await verifyTwilioSignature(TWILIO_AUTH_TOKEN, signature, url, params))) {
    return new Response('invalid signature', { status: 403 });
  }

  const from = params.From ?? '';
  const bodyText = (params.Body ?? '').trim().toUpperCase();

  if (OPT_OUT.has(bodyText)) {
    // Twilio handles carrier-level opt-out automatically; acknowledge politely.
    return twiml('You have been unsubscribed. Reply START to opt back in.');
  }
  if (bodyText === 'HELP') {
    return twiml('VibeSpace messaging. Reply STOP to unsubscribe.');
  }

  // Record inbound message (no LLM reply here — kept minimal & safe).
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('phone', from)
    .maybeSingle();
  if (profile?.id) {
    await admin.rpc('record_usage_event', {
      p_kind: 'message', p_user_id: profile.id,
      p_payload: { provider: 'twilio', model: 'sms-inbound', status: 'ok' },
    });
  }
  return twiml();
});
