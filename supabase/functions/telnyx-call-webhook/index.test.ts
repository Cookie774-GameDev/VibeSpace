import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTelnyxCallWebhook } from './index.ts';

async function signedRequest(
  event: unknown,
  keys: CryptoKeyPair,
  timestamp = String(Math.floor(Date.now() / 1_000)),
) {
  const body = JSON.stringify(event);
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      new TextEncoder().encode(`${timestamp}|${body}`),
    ),
  ).toString('base64');
  return new Request('https://edge.test/telnyx-call-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': timestamp,
      'telnyx-signature-ed25519': signature,
    },
    body,
  });
}

describe('Telnyx call webhook', () => {
  it('verifies Ed25519 before applying an idempotent provider event', async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
      'base64',
    );
    const calls: any[] = [];
    const deps = {
      config: { telnyxPublicKey: publicKey },
      claimEvent: async (...args: unknown[]) => {
        calls.push(['claim', ...args]);
        return 'claimed';
      },
      getJob: async () => ({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'queued',
        started_at: null,
      }),
      applyEvent: async (...args: unknown[]) => calls.push(['apply', ...args]),
      failUndialedJob: async (...args: unknown[]) => calls.push(['fail', ...args]),
    };
    const event = {
      data: {
        id: 'evt_telnyx_1',
        event_type: 'call.ringing',
        occurred_at: new Date().toISOString(),
        payload: { call_control_id: 'v3:call_1' },
      },
    };
    const response = await handleTelnyxCallWebhook(await signedRequest(event, keys), deps);
    assert.equal(response.status, 200);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['claim', 'apply'],
    );

    const invalid = await signedRequest(event, keys);
    invalid.headers.set('telnyx-signature-ed25519', Buffer.alloc(64).toString('base64'));
    assert.equal((await handleTelnyxCallWebhook(invalid, deps)).status, 400);
    assert.equal(calls.length, 2);
  });

  it('acknowledges duplicates and releases an undialed hangup reservation once', async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
      'base64',
    );
    const calls: any[] = [];
    const event = {
      data: {
        id: 'evt_telnyx_hangup',
        event_type: 'call.hangup',
        occurred_at: new Date().toISOString(),
        payload: {
          call_control_id: 'v3:call_1',
          hangup_cause: 'no_answer',
        },
      },
    };
    const base = {
      config: { telnyxPublicKey: publicKey },
      getJob: async () => ({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'ringing',
        started_at: null,
      }),
      applyEvent: async () => undefined,
      failUndialedJob: async (...args: unknown[]) => calls.push(args),
    };
    assert.equal(
      (
        await handleTelnyxCallWebhook(await signedRequest(event, keys), {
          ...base,
          claimEvent: async () => 'duplicate',
        })
      ).status,
      200,
    );
    assert.equal(calls.length, 0);

    assert.equal(
      (
        await handleTelnyxCallWebhook(await signedRequest(event, keys), {
          ...base,
          claimEvent: async () => 'claimed',
        })
      ).status,
      200,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'no_answer');
  });

  it('rejects stale replays and oversized bodies before database work', async () => {
    const calls: unknown[] = [];
    const deps = {
      config: { telnyxPublicKey: Buffer.alloc(32).toString('base64') },
      claimEvent: async () => calls.push('claim'),
    };
    const stale = new Request('https://edge.test/telnyx-call-webhook', {
      method: 'POST',
      headers: {
        'telnyx-timestamp': '1000000000',
        'telnyx-signature-ed25519': Buffer.alloc(64).toString('base64'),
      },
      body: '{}',
    });
    assert.equal((await handleTelnyxCallWebhook(stale, deps)).status, 400);
    const oversized = new Request('https://edge.test/telnyx-call-webhook', {
      method: 'POST',
      headers: {
        'content-length': String(1_048_577),
        'telnyx-timestamp': String(Math.floor(Date.now() / 1_000)),
        'telnyx-signature-ed25519': Buffer.alloc(64).toString('base64'),
      },
      body: '{}',
    });
    assert.equal((await handleTelnyxCallWebhook(oversized, deps)).status, 413);
    assert.equal(calls.length, 0);
  });
});
