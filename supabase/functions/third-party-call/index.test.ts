import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleThirdPartyCall } from './index.ts';

const user = { id: '11111111-1111-4111-8111-111111111111' };
const job = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: user.id,
  status: 'awaiting_user_approval',
  destination_phone_e164: '+13125550192',
  destination_display_name: "Mario's Pizza",
  purpose: 'Ask when the restaurant closes.',
  approved_script: 'Ask for today’s closing time.',
  opening_disclosure: 'Hello, I am the VibeSPACE AI assistant.',
  maximum_duration_seconds: 300,
  maximum_credit_reservation: 480,
  allowed_actions: ['ask_questions'],
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls: any[] = [];
  return {
    calls,
    config: {
      telnyxApiKey: 'KEY_test',
      telnyxConnectionId: 'conn_test',
      telnyxFromNumber: '+13125550000',
      telnyxWebhookUrl: 'https://edge.test/telnyx-call-webhook',
      telnyxStreamUrl: 'wss://voice.test/telnyx/media',
      maximumCreditsPerMinute: 96,
    },
    authenticate: async () => user,
    getCallerDisplayName: async () => 'Alex',
    getJob: async () => job,
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === 'prepare_outbound_call_job') return job;
      if (name === 'approve_outbound_call_job') return { ...job, status: 'approved' };
      if (name === 'reserve_outbound_call_job')
        return { ok: true, reserved_credits: 480, remaining_credits: 5_020 };
      if (name === 'cancel_outbound_call_job') return { ok: true, status: 'cancelled' };
      if (name === 'resolve_outbound_call_live_approval')
        return { ...job, status: args.p_approved ? 'in_progress' : 'cancelled' };
      throw new Error(`unexpected rpc ${name}`);
    },
    createTelnyxCall: async (input: unknown, idempotencyKey: string) => {
      calls.push({ name: 'telnyx', input, idempotencyKey });
      return { data: { call_control_id: 'v3:telnyx-call-id' } };
    },
    markProviderQueued: async (jobId: string, callId: string) => {
      calls.push({ name: 'queued', jobId, callId });
    },
    hangupTelnyxCall: async (callId: string, idempotencyKey: string) => {
      calls.push({ name: 'hangup', callId, idempotencyKey });
    },
    ...overrides,
  };
}

function request(action: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://edge.test/functions/v1/third-party-call/${action}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer jwt',
      'content-type': 'application/json',
      'idempotency-key': 'call-request-0000000000001',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('third-party call orchestration', () => {
  it('persists and lists only account-owned scheduled call projections', async () => {
    const fingerprint = await (
      await import('../_shared/callAnyone.ts')
    ).approvalFingerprint({
      destinationPhoneE164: job.destination_phone_e164,
      purpose: job.purpose,
      approvedScript: job.approved_script,
      openingDisclosure: job.opening_disclosure,
      maximumDurationSeconds: job.maximum_duration_seconds,
      maximumCreditReservation: job.maximum_credit_reservation,
      allowedActions: job.allowed_actions,
    });
    const schedule = {
      id: '44444444-4444-4444-8444-444444444444',
      call_job_id: job.id,
      user_id: user.id,
      status: 'scheduled',
      scheduled_for: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      revision: 1,
      destination_display_name: 'Clinic',
      destination_phone_e164: '+13125550110',
      purpose: 'Ask about office hours.',
    };
    const deps = makeDeps({
      getJob: async () => ({ ...job, status: 'approved', approval_fingerprint: fingerprint }),
      listScheduled: async (userId: string) => {
        assert.equal(userId, user.id);
        return [schedule];
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, 'schedule_outbound_call');
        assert.equal(args.p_user_id, user.id);
        return schedule;
      },
    });

    const created = await handleThirdPartyCall(
      request('schedule', { jobId: job.id, scheduledFor: schedule.scheduled_for }),
      deps,
    );
    const listed = await handleThirdPartyCall(request('list-scheduled', {}), deps);
    assert.equal((await created.json()).schedule.destinationMasked, '+* (***) ***-0110');
    assert.doesNotMatch(JSON.stringify(await listed.json()), /\+13125550110/);
  });

  it('claims one exact due revision and revalidates job approval before one provider dispatch', async () => {
    const scheduleId = '44444444-4444-4444-8444-444444444444';
    const fingerprint = await (
      await import('../_shared/callAnyone.ts')
    ).approvalFingerprint({
      destinationPhoneE164: job.destination_phone_e164,
      purpose: job.purpose,
      approvedScript: job.approved_script,
      openingDisclosure: job.opening_disclosure,
      maximumDurationSeconds: job.maximum_duration_seconds,
      maximumCreditReservation: job.maximum_credit_reservation,
      allowedActions: job.allowed_actions,
    });
    const deps = makeDeps({
      getJob: async () => ({ ...job, status: 'approved', approval_fingerprint: fingerprint }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        deps.calls.push({ name, args });
        if (name === 'claim_scheduled_outbound_call') {
          return {
            ok: true,
            job_id: job.id,
            dispatch_token: '55555555-5555-4555-8555-555555555555',
            revision: 8,
            approval_fingerprint: fingerprint,
          };
        }
        if (name === 'reserve_outbound_call_job') {
          return { ok: true, reserved_credits: 480, remaining_credits: 5_020 };
        }
        if (name === 'finish_scheduled_outbound_call_claim') {
          return {
            id: scheduleId,
            call_job_id: job.id,
            status: 'queued',
            revision: 9,
          };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    });

    const response = await handleThirdPartyCall(
      request('dispatch-scheduled', { scheduleId, expectedRevision: 7 }),
      deps,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      deps.calls.map((call) => call.name),
      [
        'claim_scheduled_outbound_call',
        'reserve_outbound_call_job',
        'telnyx',
        'queued',
        'finish_scheduled_outbound_call_claim',
      ],
    );
  });

  it('fails closed on a stale schedule revision without dialing', async () => {
    const deps = makeDeps({
      rpc: async (name: string) => {
        assert.equal(name, 'claim_scheduled_outbound_call');
        return { ok: false, reason: 'schedule_revision_conflict' };
      },
    });
    const response = await handleThirdPartyCall(
      request('dispatch-scheduled', {
        scheduleId: '44444444-4444-4444-8444-444444444444',
        expectedRevision: 4,
      }),
      deps,
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'schedule_revision_conflict');
    assert.equal(
      deps.calls.some((call) => call.name === 'telnyx'),
      false,
    );
  });

  it('does not consume a due claim when the real provider is unavailable', async () => {
    const deps = makeDeps({
      config: {
        telnyxApiKey: '',
        telnyxConnectionId: '',
        telnyxFromNumber: '',
        telnyxWebhookUrl: '',
        telnyxStreamUrl: '',
        maximumCreditsPerMinute: 96,
      },
    });
    const response = await handleThirdPartyCall(
      request('dispatch-scheduled', {
        scheduleId: '44444444-4444-4444-8444-444444444444',
        expectedRevision: 4,
      }),
      deps,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'calling_unconfigured');
    assert.equal(deps.calls.length, 0);
  });

  it('fails the claimed schedule when live job approval drifts before reservation', async () => {
    const scheduleId = '44444444-4444-4444-8444-444444444444';
    const deps = makeDeps({
      getJob: async () => ({ ...job, status: 'cancelled', approval_fingerprint: 'a'.repeat(64) }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        deps.calls.push({ name, args });
        if (name === 'claim_scheduled_outbound_call') {
          return {
            ok: true,
            job_id: job.id,
            dispatch_token: '55555555-5555-4555-8555-555555555555',
            revision: 8,
            approval_fingerprint: 'a'.repeat(64),
          };
        }
        if (name === 'finish_scheduled_outbound_call_claim') {
          assert.equal(args.p_status, 'failed');
          assert.equal(args.p_reason, 'approval_drift');
          return { id: scheduleId, call_job_id: job.id, status: 'failed', revision: 9 };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    });
    const response = await handleThirdPartyCall(
      request('dispatch-scheduled', { scheduleId, expectedRevision: 7 }),
      deps,
    );
    assert.equal(response.status, 409);
    assert.equal(
      deps.calls.some((call) => call.name === 'telnyx'),
      false,
    );
    assert.deepEqual(
      deps.calls.map((call) => call.name),
      ['claim_scheduled_outbound_call', 'finish_scheduled_outbound_call_claim'],
    );
  });

  it('cancels one exact scheduled row transactionally without a provider call', async () => {
    const scheduleId = '44444444-4444-4444-8444-444444444444';
    const deps = makeDeps({
      rpc: async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, 'cancel_scheduled_outbound_call');
        assert.equal(args.p_schedule_id, scheduleId);
        assert.equal(args.p_expected_revision, 6);
        return { id: scheduleId, call_job_id: job.id, status: 'cancelled', revision: 7 };
      },
    });
    const response = await handleThirdPartyCall(
      request('cancel-scheduled', { scheduleId, expectedRevision: 6 }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schedule.status, 'cancelled');
    assert.equal(
      deps.calls.some((call) => call.name === 'telnyx'),
      false,
    );
  });
  it('rejects non-HTTPS contact images before the account RPC', async () => {
    let rpcCalled = false;
    const deps = makeDeps({
      userRpc: async () => {
        rpcCalled = true;
        return {};
      },
    });
    const response = await handleThirdPartyCall(
      request('contact', {
        displayName: 'Sam',
        phone: '+13125550192',
        destinationType: 'saved_contact',
        profileImageUrl: 'file:///private/avatar.png',
      }),
      deps,
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_profile_image_url');
    assert.equal(rpcCalled, false);
  });

  it('returns only bounded masked contacts and recent call history for the authenticated account', async () => {
    const deps = makeDeps({
      listContacts: async (userId: string) => {
        assert.equal(userId, user.id);
        return [
          {
            id: 'contact-1',
            display_name: 'Sam',
            destination_type: 'saved_contact',
            phone_number_e164: '+13125550192',
            relationship: 'Friend',
            notes: 'Prefers afternoon calls.',
            profile_image_url: 'https://images.example/sam.png',
          },
        ];
      },
      listHistory: async (userId: string) => {
        assert.equal(userId, user.id);
        return [{ ...job, status: 'completed', created_at: '2026-08-03T04:00:00.000Z' }];
      },
    });

    const contacts = await handleThirdPartyCall(request('list-contacts', {}), deps);
    const history = await handleThirdPartyCall(request('history', {}), deps);
    const contactPayload = await contacts.json();
    const historyPayload = await history.json();

    assert.equal(contactPayload.contacts[0].destinationMasked, '+* (***) ***-0192');
    assert.doesNotMatch(JSON.stringify(contactPayload), /\+13125550192/);
    assert.equal(historyPayload.history[0].createdAt, '2026-08-03T04:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(historyPayload), /\+13125550192/);
  });

  it('prepares but never dials a valid third-party call', async () => {
    const deps = makeDeps();
    const response = await handleThirdPartyCall(
      request('prepare', {
        destinationType: 'business',
        destinationPhone: '+1 (312) 555-0192',
        destinationDisplayName: "Mario's Pizza",
        goal: 'business_information',
        purpose: 'Ask when the restaurant closes.',
        userInstructions: 'Only ask for public hours.',
        approvedScript: 'Ask for today’s closing time.',
        openingDisclosure: 'Hello, I am the VibeSPACE AI assistant.',
        maximumDurationSeconds: 300,
        maximumCreditReservation: 1,
        allowedActions: ['ask_questions'],
      }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.equal(deps.calls[0].name, 'prepare_outbound_call_job');
    assert.equal(deps.calls[0].args.p_maximum_credit_reservation, 480);
    assert.equal(
      deps.calls[0].args.p_opening_disclosure,
      'Hello, I am the VibeSPACE AI assistant calling on behalf of Alex. I am calling to Ask when the restaurant closes.',
    );
    assert.equal(
      deps.calls.some((call) => call.name === 'telnyx'),
      false,
    );
    assert.doesNotMatch(await response.text(), /\+13125550192/);
  });

  it('resolves a saved contact server-side without returning its raw phone to the renderer', async () => {
    const contactId = '33333333-3333-4333-8333-333333333333';
    const deps = makeDeps({
      getContact: async (userId: string, requestedId: string) => {
        assert.equal(userId, user.id);
        assert.equal(requestedId, contactId);
        return {
          id: contactId,
          phone_number_e164: '+13125550192',
          display_name: 'Sam',
          destination_type: 'saved_contact',
        };
      },
    });
    const response = await handleThirdPartyCall(
      request('prepare', {
        contactId,
        destinationType: 'saved_contact',
        destinationDisplayName: 'Sam',
        goal: 'relay_message',
        purpose: 'Share an update.',
        userInstructions: '',
        approvedScript: 'Share an update.',
        maximumDurationSeconds: 300,
        allowedActions: ['ask_questions'],
      }),
      deps,
    );

    assert.equal(response.status, 200);
    assert.equal(deps.calls[0].args.p_destination_phone, '+13125550192');
    assert.doesNotMatch(await response.text(), /\+13125550192/);
  });

  it('hangs up an active provider call before releasing its reservation', async () => {
    const deps = makeDeps({
      getJob: async () => ({
        ...job,
        status: 'in_progress',
        provider_call_id: 'v3:telnyx-call-id',
      }),
    });
    const response = await handleThirdPartyCall(request('cancel', { jobId: job.id }), deps);
    assert.equal(response.status, 200);
    assert.deepEqual(
      deps.calls.map((call) => call.name),
      ['hangup', 'cancel_outbound_call_job'],
    );
  });

  it('records a user decision for a protected action without starting another call', async () => {
    const deps = makeDeps({
      getJob: async () => ({
        ...job,
        status: 'awaiting_live_approval',
        pending_action_summary: '$20 cancellation deposit',
      }),
    });
    const response = await handleThirdPartyCall(request('approve-live', { jobId: job.id }), deps);
    assert.equal(response.status, 200);
    assert.equal(deps.calls[0].name, 'resolve_outbound_call_live_approval');
    assert.equal(
      deps.calls.some((call) => call.name === 'telnyx'),
      false,
    );
  });

  it('accepts an explicit action for standard Supabase function invocation', async () => {
    const deps = makeDeps();
    const response = await handleThirdPartyCall(
      request('third-party-call', {
        action: 'approve',
        jobId: job.id,
      }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.equal(deps.calls[0].name, 'approve_outbound_call_job');
  });

  it('stores approval using a server-derived fingerprint', async () => {
    const deps = makeDeps();
    const response = await handleThirdPartyCall(request('approve', { jobId: job.id }), deps);
    assert.equal(response.status, 200);
    const approval = deps.calls.find((call) => call.name === 'approve_outbound_call_job');
    assert.match(approval.args.p_fingerprint, /^[a-f0-9]{64}$/);
  });

  it('reserves credits before placing exactly one provider call from stored job data', async () => {
    const deps = makeDeps({
      getJob: async () => ({ ...job, status: 'approved' }),
    });
    const response = await handleThirdPartyCall(
      request('start', {
        jobId: job.id,
        destinationPhone: '+19999999999',
        telnyxConnectionId: 'attacker',
      }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      deps.calls.map((call) => call.name),
      ['reserve_outbound_call_job', 'telnyx', 'queued'],
    );
    const provider = deps.calls[1];
    assert.equal(provider.input.to, job.destination_phone_e164);
    assert.equal(provider.input.connection_id, 'conn_test');
    assert.doesNotMatch(JSON.stringify(provider), /attacker|\+19999999999/);
  });

  it('releases the reservation when provider call creation fails', async () => {
    const deps = makeDeps({
      getJob: async () => ({ ...job, status: 'approved' }),
      createTelnyxCall: async () => {
        throw new Error('provider secret should not leak');
      },
    });
    const response = await handleThirdPartyCall(request('start', { jobId: job.id }), deps);
    assert.equal(response.status, 502);
    assert.equal(
      deps.calls.some(
        (call) =>
          call.name === 'cancel_outbound_call_job' &&
          call.args.p_reason === 'provider_start_failed',
      ),
      true,
    );
    assert.equal(await response.text(), '{"error":"provider_unavailable"}');
  });

  it('rejects missing authentication and emergency destinations before side effects', async () => {
    const deps = makeDeps();
    const unauthorized = request('prepare', {}, { authorization: '' });
    assert.equal((await handleThirdPartyCall(unauthorized, deps)).status, 401);
    assert.equal(
      (
        await handleThirdPartyCall(
          request('prepare', {
            destinationType: 'one_time_number',
            destinationPhone: '911',
          }),
          deps,
        )
      ).status,
      400,
    );
    assert.equal(deps.calls.length, 0);
  });
});
