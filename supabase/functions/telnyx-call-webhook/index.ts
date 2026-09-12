// @ts-nocheck
// Public Telnyx webhook. Supabase JWT verification is disabled for this one
// endpoint; every mutation is gated by a fresh Ed25519 signature.

import { verifyTelnyxSignature } from '../_shared/callAnyone.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function handleTelnyxCallWebhook(req: Request, deps: any): Promise<Response> {
  if (req.method === 'GET') return text('VibeSPACE Telnyx webhook up.\n', 200);
  if (req.method !== 'POST') return text('method_not_allowed', 405);
  const declared = req.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return text(Number(declared) > MAX_BODY_BYTES ? 'payload_too_large' : 'bad_request', 413);
  }
  const timestamp = req.headers.get('telnyx-timestamp') ?? '';
  const signature = req.headers.get('telnyx-signature-ed25519') ?? '';
  if (!timestamp || !signature || !deps.config?.telnyxPublicKey) {
    return text('invalid_signature', 400);
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return text('payload_too_large', 413);
  const valid = await verifyTelnyxSignature({
    publicKeyBase64: deps.config.telnyxPublicKey,
    signatureBase64: signature,
    timestamp,
    rawBody,
  });
  if (!valid) return text('invalid_signature', 400);

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return text('bad_request', 400);
  }
  const data = event?.data;
  const payload = data?.payload;
  const eventId = data?.id;
  const eventType = data?.event_type;
  const callControlId = payload?.call_control_id;
  const occurredAt = data?.occurred_at;
  if (
    typeof eventId !== 'string' ||
    !EVENT_ID_RE.test(eventId) ||
    typeof eventType !== 'string' ||
    !EVENT_ID_RE.test(eventType) ||
    typeof callControlId !== 'string' ||
    !EVENT_ID_RE.test(callControlId) ||
    typeof occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    return text('bad_request', 400);
  }
  const claim = await deps.claimEvent(
    eventId,
    callControlId,
    eventType,
    occurredAt,
    await sha256(rawBody),
  );
  if (claim === 'duplicate') return text('duplicate', 200);

  const job = await deps.getJob(callControlId);
  if (!job) return text('unknown_call', 200);
  if (eventType === 'call.hangup' && !job.started_at) {
    await deps.failUndialedJob(job.id, String(payload?.hangup_cause ?? 'provider_hangup'));
    return text('ok', 200);
  }
  await deps.applyEvent(job, {
    eventId,
    eventType,
    callControlId,
    occurredAt,
    hangupCause:
      typeof payload?.hangup_cause === 'string' ? payload.hangup_cause.slice(0, 120) : null,
  });
  return text('ok', 200);
}

if (import.meta.main) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.46.2');
  const env = Deno.env;
  const admin = createClient(
    env.get('SUPABASE_URL') ?? '',
    env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const deps = {
    config: { telnyxPublicKey: env.get('TELNYX_PUBLIC_KEY') ?? '' },
    claimEvent: async (
      eventId: string,
      providerCallId: string,
      eventType: string,
      occurredAt: string,
      payloadSha256: string,
    ) => {
      const { error } = await admin.from('outbound_call_provider_events').insert({
        provider_event_id: eventId,
        provider_call_id: providerCallId,
        event_type: eventType,
        occurred_at: occurredAt,
        payload_sha256: payloadSha256,
      });
      if (!error) return 'claimed';
      if (error.code === '23505') return 'duplicate';
      throw error;
    },
    getJob: async (providerCallId: string) => {
      const { data, error } = await admin
        .from('outbound_call_jobs')
        .select('*')
        .eq('provider_call_id', providerCallId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    applyEvent: async (job: any, event: any) => {
      const statusForEvent: Record<string, string> = {
        'call.initiated': 'dialing',
        'call.ringing': 'ringing',
        'call.answered': 'in_progress',
      };
      const update: Record<string, unknown> = {
        provider_status:
          event.eventType === 'call.hangup'
            ? `hangup:${event.hangupCause ?? 'unknown'}`
            : event.eventType,
        provider_status_updated_at: event.occurredAt,
        updated_at: new Date().toISOString(),
      };
      if (statusForEvent[event.eventType]) update.status = statusForEvent[event.eventType];
      if (event.eventType === 'call.answered') update.started_at = event.occurredAt;
      const { data, error } = await admin
        .from('outbound_call_jobs')
        .update(update)
        .eq('id', job.id)
        .or(`provider_status_updated_at.is.null,provider_status_updated_at.lte.${event.occurredAt}`)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      const { error: eventError } = await admin
        .from('outbound_call_provider_events')
        .update({ call_job_id: job.id })
        .eq('provider_event_id', event.eventId);
      if (eventError) throw eventError;
      return data;
    },
    failUndialedJob: async (jobId: string, reason: string) => {
      const { data: job, error: readError } = await admin
        .from('outbound_call_jobs')
        .select('user_id')
        .eq('id', jobId)
        .single();
      if (readError) throw readError;
      const { error } = await admin.rpc('complete_outbound_call_job', {
        p_job_id: jobId,
        p_status: 'failed',
        p_actual_credits: 0,
        p_duration_seconds: 0,
        p_provider_call_id: null,
        p_provider_status: 'hangup_before_answer',
        p_result_summary: null,
        p_failure_reason: reason.slice(0, 500),
      });
      if (error) throw error;
    },
  };
  Deno.serve((req: Request) =>
    handleTelnyxCallWebhook(req, deps).catch(() => text('handler_error', 500)),
  );
}
