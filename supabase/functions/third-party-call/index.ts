// @ts-nocheck
// Authenticated Call Anyone orchestration. This function prepares and approves
// jobs, then starts Telnyx using only the server-stored approved job.

import {
  approvalFingerprint,
  buildOpeningDisclosure,
  normalizeE164,
  validateThirdPartyCallDraft,
} from '../_shared/callAnyone.ts';

const MAX_BODY_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{16,128}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://vibespaceos.com',
      'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

function bearer(req: Request): string | null {
  return req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

function maskPhone(value: string): string {
  const last4 = value.replace(/\D/g, '').slice(-4);
  return `+* (***) ***-${last4}`;
}

function publicJob(job: any): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    destinationType: job.destination_type ?? job.destinationType,
    destinationDisplayName: job.destination_display_name ?? job.destinationDisplayName,
    destinationMasked: maskPhone(
      job.destination_phone_e164 ?? job.destinationPhoneE164 ?? '+00000000',
    ),
    goal: job.goal,
    purpose: job.purpose,
    approvedScript: job.approved_script ?? job.approvedScript,
    openingDisclosure: job.opening_disclosure ?? job.openingDisclosure,
    allowedActions: job.allowed_actions ?? job.allowedActions ?? [],
    maximumDurationSeconds: job.maximum_duration_seconds ?? job.maximumDurationSeconds,
    maximumCreditReservation: job.maximum_credit_reservation ?? job.maximumCreditReservation,
    reservedCredits: job.reserved_credits ?? 0,
    settledCredits: job.settled_credits ?? 0,
    providerStatus: job.provider_status ?? null,
    pendingActionSummary: job.pending_action_summary ?? null,
    pendingActionDecision: job.pending_action_decision ?? null,
    resultSummary: job.result_summary ?? null,
    failureReason: job.failure_reason ?? null,
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
  };
}

function publicContact(contact: any): Record<string, unknown> {
  return {
    id: contact.id,
    displayName: contact.display_name,
    destinationType: contact.destination_type,
    destinationMasked: maskPhone(contact.phone_number_e164),
    relationship: contact.relationship ?? null,
    notes: contact.notes ?? null,
    profileImageUrl: contact.profile_image_url ?? null,
  };
}

function fingerprintMaterial(job: any): Record<string, unknown> {
  return {
    destinationPhoneE164: job.destination_phone_e164,
    purpose: job.purpose,
    approvedScript: job.approved_script,
    openingDisclosure: job.opening_disclosure,
    maximumDurationSeconds: job.maximum_duration_seconds,
    maximumCreditReservation: job.maximum_credit_reservation,
    allowedActions: job.allowed_actions ?? [],
  };
}

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  try {
    const raw = await req.text();
    if (!raw || raw.length > MAX_BODY_BYTES) return null;
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function actionOf(req: Request, body: Record<string, unknown>): string {
  if (typeof body.action === 'string') return body.action;
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

export async function handleThirdPartyCall(req: Request, deps: any): Promise<Response> {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: json({}).headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const jwt = bearer(req);
  if (!jwt) return json({ error: 'unauthorized' }, 401);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);
  const body = await bodyOf(req);
  if (!body) return json({ error: 'bad_request' }, 400);
  const action = actionOf(req, body);

  if (action === 'prepare') {
    const contactId =
      typeof body.contactId === 'string' && UUID_RE.test(body.contactId) ? body.contactId : null;
    const contact = contactId ? await deps.getContact(user.id, contactId) : null;
    if (contactId && !contact) return json({ error: 'contact_not_found' }, 404);
    const destinationPhone = normalizeE164(
      body.destinationPhone ?? body.destinationPhoneE164 ?? contact?.phone_number_e164,
    );
    if (!destinationPhone) {
      return json({ error: 'prohibited_destination' }, 400);
    }
    const duration = Number(body.maximumDurationSeconds);
    const creditsPerMinute = Number(deps.config?.maximumCreditsPerMinute);
    if (
      !Number.isInteger(duration) ||
      duration < 30 ||
      duration > 1_800 ||
      !Number.isFinite(creditsPerMinute) ||
      creditsPerMinute <= 0 ||
      creditsPerMinute > 100_000
    ) {
      return json({ error: 'calling_unconfigured' }, 503);
    }
    const maximumCreditReservation = Math.ceil((duration / 60) * creditsPerMinute);
    const callerDisplayName = await deps.getCallerDisplayName(user.id);
    const validation = validateThirdPartyCallDraft({
      ...body,
      destinationPhone,
      destinationDisplayName:
        body.destinationDisplayName ?? contact?.display_name ?? 'Saved contact',
      destinationType: body.destinationType ?? contact?.destination_type,
      maximumCreditReservation,
      openingDisclosure: buildOpeningDisclosure(callerDisplayName, body.purpose),
    });
    if (!validation.ok) return json({ error: validation.error }, 400);
    const key = req.headers.get('idempotency-key');
    if (!key || !IDEMPOTENCY_RE.test(key)) {
      return json({ error: 'invalid_idempotency_key' }, 400);
    }
    const value = validation.value;
    const row = await deps.rpc('prepare_outbound_call_job', {
      p_user_id: user.id,
      p_contact_id: contactId,
      p_destination_type: value.destinationType,
      p_destination_phone: value.destinationPhoneE164,
      p_destination_display_name: value.destinationDisplayName,
      p_goal: value.goal,
      p_purpose: value.purpose,
      p_user_instructions: value.userInstructions,
      p_approved_script: value.approvedScript,
      p_opening_disclosure: value.openingDisclosure,
      p_allowed_actions: value.allowedActions,
      p_maximum_duration_seconds: value.maximumDurationSeconds,
      p_maximum_credit_reservation: value.maximumCreditReservation,
      p_idempotency_key: key,
    });
    return json({ job: publicJob(row) });
  }

  if (action === 'contact') {
    const phone = normalizeE164(body.phone);
    const profileImageUrl =
      typeof body.profileImageUrl === 'string' ? body.profileImageUrl.trim() : '';
    if (!phone || typeof body.displayName !== 'string') {
      return json({ error: 'invalid_contact' }, 400);
    }
    if (
      profileImageUrl &&
      (profileImageUrl.length > 2_048 || !/^https:\/\//.test(profileImageUrl))
    ) {
      return json({ error: 'invalid_profile_image_url' }, 400);
    }
    const row = await deps.userRpc(jwt, 'upsert_jarvis_contact', {
      p_user_id: user.id,
      p_contact_id:
        typeof body.contactId === 'string' && UUID_RE.test(body.contactId) ? body.contactId : null,
      p_display_name: body.displayName,
      p_phone: phone,
      p_destination_type: body.destinationType === 'business' ? 'business' : 'saved_contact',
      p_allow_ai_calls: body.allowAiCalls === true,
      p_allow_ai_messages: body.allowAiMessages === true,
      p_consent_status: typeof body.consentStatus === 'string' ? body.consentStatus : 'unknown',
      p_optional: {
        ...(body.optional && typeof body.optional === 'object' ? body.optional : {}),
        relationship: typeof body.relationship === 'string' ? body.relationship : '',
        notes: typeof body.notes === 'string' ? body.notes : '',
        profile_image_url: profileImageUrl,
      },
    });
    return json({
      contact: {
        id: row.id,
        displayName: row.display_name,
        destinationType: row.destination_type,
        destinationMasked: maskPhone(row.phone_number_e164),
        allowAiCalls: row.allow_ai_calls,
        allowAiMessages: row.allow_ai_messages,
        consentStatus: row.consent_status,
        relationship: row.relationship ?? null,
        notes: row.notes ?? null,
        profileImageUrl: row.profile_image_url ?? null,
      },
    });
  }

  if (action === 'list-contacts') {
    const rows = await deps.listContacts(user.id);
    return json({ contacts: rows.slice(0, 20).map(publicContact) });
  }

  if (action === 'history') {
    const rows = await deps.listHistory(user.id);
    return json({ history: rows.slice(0, 20).map(publicJob) });
  }

  const jobId = typeof body.jobId === 'string' && UUID_RE.test(body.jobId) ? body.jobId : null;
  if (!jobId) return json({ error: 'invalid_call_job' }, 400);
  const job = await deps.getJob(user.id, jobId);
  if (!job) return json({ error: 'call_job_not_found' }, 404);

  if (action === 'approve') {
    const fingerprint = await approvalFingerprint(fingerprintMaterial(job));
    const row = await deps.rpc('approve_outbound_call_job', {
      p_user_id: user.id,
      p_job_id: jobId,
      p_fingerprint: fingerprint,
    });
    return json({ job: publicJob(row) });
  }

  if (action === 'cancel') {
    if (
      job.provider_call_id &&
      !['completed', 'failed', 'cancelled', 'blocked'].includes(job.status)
    ) {
      try {
        await deps.hangupTelnyxCall(job.provider_call_id, `vibespace-hangup:${job.id}`);
      } catch {
        return json({ error: 'provider_unavailable' }, 502);
      }
    }
    const result = await deps.rpc('cancel_outbound_call_job', {
      p_user_id: user.id,
      p_job_id: jobId,
      p_reason: 'user_cancelled',
    });
    return json(result);
  }

  if (action === 'get') return json({ job: publicJob(job) });

  if (action === 'approve-live' || action === 'decline-live') {
    if (job.status !== 'awaiting_live_approval') {
      return json({ error: 'live_approval_not_pending' }, 409);
    }
    const row = await deps.rpc('resolve_outbound_call_live_approval', {
      p_user_id: user.id,
      p_job_id: jobId,
      p_approved: action === 'approve-live',
    });
    return json({ job: publicJob(row) });
  }

  if (action === 'start') {
    if (
      !deps.config?.telnyxApiKey ||
      !deps.config?.telnyxConnectionId ||
      !normalizeE164(deps.config.telnyxFromNumber) ||
      !/^https:\/\//.test(deps.config.telnyxWebhookUrl ?? '') ||
      !/^wss:\/\//.test(deps.config.telnyxStreamUrl ?? '')
    ) {
      return json({ error: 'calling_unconfigured' }, 503);
    }
    const fingerprint = await approvalFingerprint(fingerprintMaterial(job));
    if (job.approval_fingerprint && job.approval_fingerprint !== fingerprint) {
      return json({ error: 'approval_required' }, 409);
    }
    const reservation = await deps.rpc('reserve_outbound_call_job', {
      p_user_id: user.id,
      p_job_id: jobId,
      p_fingerprint: fingerprint,
    });
    if (!reservation?.ok) {
      const status = reservation?.reason === 'budget_exceeded' ? 402 : 409;
      return json(
        {
          error: reservation?.reason ?? 'reservation_failed',
          availableCredits:
            typeof reservation?.remaining_credits === 'number'
              ? reservation.remaining_credits
              : undefined,
        },
        status,
      );
    }
    try {
      const provider = await deps.createTelnyxCall(
        {
          connection_id: deps.config.telnyxConnectionId,
          to: job.destination_phone_e164,
          from: deps.config.telnyxFromNumber,
          webhook_url: deps.config.telnyxWebhookUrl,
          webhook_url_method: 'POST',
          stream_url: deps.config.telnyxStreamUrl,
          stream_track: 'both_tracks',
          client_state: btoa(JSON.stringify({ job_id: job.id })),
          timeout_secs: Math.min(60, Math.max(10, job.maximum_duration_seconds)),
        },
        `vibespace-call:${job.id}`,
      );
      const providerCallId = provider?.data?.call_control_id;
      if (typeof providerCallId !== 'string' || providerCallId.length > 160) {
        throw new Error('invalid_provider_response');
      }
      await deps.markProviderQueued(job.id, providerCallId);
      return json({
        job: {
          ...publicJob({ ...job, status: 'queued' }),
          reservedCredits: reservation.reserved_credits,
          remainingCredits: reservation.remaining_credits,
        },
      });
    } catch {
      await deps.rpc('cancel_outbound_call_job', {
        p_user_id: user.id,
        p_job_id: jobId,
        p_reason: 'provider_start_failed',
      });
      return json({ error: 'provider_unavailable' }, 502);
    }
  }

  return json({ error: 'unknown_action' }, 404);
}

if (import.meta.main) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.46.2');
  const env = Deno.env;
  const SUPABASE_URL = env.get('SUPABASE_URL') ?? '';
  const SUPABASE_ANON_KEY = env.get('SUPABASE_ANON_KEY') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const config = {
    telnyxApiKey: env.get('TELNYX_API_KEY') ?? '',
    telnyxConnectionId: env.get('TELNYX_CALL_CONTROL_CONNECTION_ID') ?? '',
    telnyxFromNumber: env.get('TELNYX_PHONE_NUMBER') ?? '',
    telnyxWebhookUrl: env.get('TELNYX_CALL_WEBHOOK_URL') ?? '',
    telnyxStreamUrl: env.get('TELNYX_MEDIA_STREAM_URL') ?? '',
    maximumCreditsPerMinute: Number(env.get('CALL_ANYONE_MAX_CREDITS_PER_MINUTE') ?? '0'),
  };
  const deps = {
    config,
    authenticate: async (jwt: string) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data, error } = await client.auth.getUser(jwt);
      if (error) throw error;
      return data.user;
    },
    rpc: async (name: string, args: unknown) => {
      const { data, error } = await admin.rpc(name, args);
      if (error) throw error;
      return data;
    },
    userRpc: async (jwt: string, name: string, args: unknown) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { data, error } = await client.rpc(name, args);
      if (error) throw error;
      return data;
    },
    getJob: async (userId: string, jobId: string) => {
      const { data, error } = await admin
        .from('outbound_call_jobs')
        .select('*')
        .eq('id', jobId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    getContact: async (userId: string, contactId: string) => {
      const { data, error } = await admin
        .from('jarvis_contacts')
        .select('id,display_name,destination_type,phone_number_e164')
        .eq('id', contactId)
        .eq('user_id', userId)
        .is('blocked_at', null)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    listContacts: async (userId: string) => {
      const { data, error } = await admin
        .from('jarvis_contacts')
        .select(
          'id,display_name,destination_type,phone_number_e164,relationship,notes,profile_image_url',
        )
        .eq('user_id', userId)
        .is('blocked_at', null)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
    listHistory: async (userId: string) => {
      const { data, error } = await admin
        .from('outbound_call_jobs')
        .select(
          'id,status,destination_type,destination_display_name,destination_phone_e164,goal,purpose,maximum_duration_seconds,maximum_credit_reservation,reserved_credits,settled_credits,provider_status,result_summary,failure_reason,created_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
    getCallerDisplayName: async (userId: string) => {
      const { data, error } = await admin
        .from('profiles')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data?.display_name ?? '';
    },
    createTelnyxCall: async (input: unknown, idempotencyKey: string) => {
      const response = await fetch('https://api.telnyx.com/v2/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.telnyxApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('telnyx_call_failed');
      return response.json();
    },
    hangupTelnyxCall: async (callId: string, idempotencyKey: string) => {
      const response = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/actions/hangup`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.telnyxApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok && response.status !== 409) throw new Error('telnyx_hangup_failed');
    },
    markProviderQueued: async (jobId: string, callId: string) => {
      const { error } = await admin
        .from('outbound_call_jobs')
        .update({
          status: 'queued',
          provider_call_id: callId,
          provider_status: 'queued',
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('status', 'credits_reserved');
      if (error) throw error;
    },
  };
  Deno.serve((req: Request) =>
    handleThirdPartyCall(req, deps).catch(() => json({ error: 'internal_error' }, 500)),
  );
}
