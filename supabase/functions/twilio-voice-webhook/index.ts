// @ts-nocheck
// twilio-voice-webhook: Twilio fetches TwiML from here when a call connects.
// Signature-verified. Returns minimal TwiML that greets and caps the call.
// Deploy with --no-verify-jwt (Twilio signs it, not Supabase).

import { verifyTwilioSignature } from '../_shared/budget.ts';
import { MAX_CALL_SECONDS } from '../_shared/budget.ts';

const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? '';

function twiml(xml: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
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
  const url = `${APP_BASE_URL}/functions/v1/twilio-voice-webhook`;
  const valid = await verifyTwilioSignature(TWILIO_AUTH_TOKEN, signature, url, params);
  if (!valid) return new Response('invalid signature', { status: 403 });

  // Minimal greeting + hard time cap. A fuller agent loop (STT->LLM->TTS) would
  // stream here via <Connect>/<Stream> to the media pipeline.
  return twiml(
    `<Say voice="Polly.Matthew">Jarvis is connecting. This call is time limited.</Say>` +
      `<Pause length="1"/>` +
      `<Say>Goodbye.</Say>`,
  );
});
