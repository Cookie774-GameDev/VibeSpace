import { describe, expect, it, vi } from 'vitest';
import { createThirdPartyCallClient } from './client';

describe('third-party call client', () => {
  it('prepares with an idempotency key and never starts implicitly', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { job: { id: 'job-1', status: 'awaiting_user_approval' } },
      error: null,
    });
    const client = createThirdPartyCallClient({ functions: { invoke } } as never);

    const job = await client.prepare({
      destinationType: 'business',
      destinationPhone: '+13125550192',
      destinationDisplayName: "Mario's Pizza",
      goal: 'business_information',
      purpose: 'Ask for closing time.',
      userInstructions: '',
      approvedScript: 'Ask for today’s closing time.',
      openingDisclosure: 'Hello, I am the VibeSpace AI assistant.',
      allowedActions: ['ask_questions'],
      maximumDurationSeconds: 300,
      maximumCreditReservation: 480,
    });

    expect(job.id).toBe('job-1');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'third-party-call',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'prepare' }),
        headers: expect.objectContaining({
          'Idempotency-Key': expect.stringMatching(/^call-/),
        }),
      }),
    );
  });

  it('requires explicit approve and start calls', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { job: { id: 'job-1', status: 'approved' } },
      error: null,
    });
    const client = createThirdPartyCallClient({ functions: { invoke } } as never);

    await client.approve('job-1');
    await client.start('job-1');

    expect(invoke.mock.calls.map((call) => call[1].body.action)).toEqual(['approve', 'start']);
  });

  it('sends protected-action decisions as separate bounded actions', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: { job: { id: 'job-1', status: 'in_progress' } },
      error: null,
    });
    const client = createThirdPartyCallClient({ functions: { invoke } } as never);
    await client.approveLive('job-1');
    await client.declineLive('job-1');
    expect(invoke.mock.calls.map((call) => call[1].body.action)).toEqual([
      'approve-live',
      'decline-live',
    ]);
  });

  it('returns a bounded service error without leaking provider details', async () => {
    const client = createThirdPartyCallClient({
      functions: {
        invoke: vi.fn().mockResolvedValue({
          data: { error: 'calling_unconfigured', providerSecret: 'must-not-leak' },
          error: { message: 'Edge Function returned a non-2xx status' },
        }),
      },
    } as never);

    await expect(client.start('job-1')).rejects.toThrow('calling_unconfigured');
  });

  it('saves a bounded contact through the authenticated server route', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        contact: {
          id: 'contact-1',
          displayName: 'Clinic',
          destinationType: 'business',
          destinationMasked: '+* (***) ***-0110',
        },
      },
      error: null,
    });
    const client = createThirdPartyCallClient({ functions: { invoke } } as never);
    await expect(
      client.saveContact({
        displayName: 'Clinic',
        phone: '+13125550110',
        destinationType: 'business',
        allowAiCalls: true,
        allowAiMessages: false,
        consentStatus: 'user_asserted',
      }),
    ).resolves.toMatchObject({ id: 'contact-1' });
    expect(invoke).toHaveBeenCalledWith(
      'third-party-call',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'contact' }),
      }),
    );
  });

  it('loads only the bounded account-scoped contacts and recent history returned by the server', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          contacts: [
            {
              id: 'contact-1',
              displayName: 'Sam',
              destinationType: 'saved_contact',
              destinationMasked: '+* (***) ***-0192',
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          history: [
            {
              id: 'job-1',
              status: 'completed',
              destinationDisplayName: 'Sam',
              destinationMasked: '+* (***) ***-0192',
            },
          ],
        },
        error: null,
      });
    const client = createThirdPartyCallClient({ functions: { invoke } } as never);

    await expect(client.listContacts()).resolves.toHaveLength(1);
    await expect(client.listHistory()).resolves.toHaveLength(1);
    expect(invoke.mock.calls.map((call) => call[1]?.body)).toEqual([
      { action: 'list-contacts' },
      { action: 'history' },
    ]);
  });
});
