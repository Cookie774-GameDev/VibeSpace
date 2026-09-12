import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvalFingerprint,
  buildOpeningDisclosure,
  normalizeE164,
  validateThirdPartyCallDraft,
  verifyTelnyxSignature,
} from './callAnyone.ts';

describe('Call Anyone contract', () => {
  it('normalizes supported North American and international numbers to E.164', () => {
    assert.equal(normalizeE164('(312) 555-0192'), '+13125550192');
    assert.equal(normalizeE164('1-312-555-0192'), '+13125550192');
    assert.equal(normalizeE164('+44 20 7946 0958'), '+442079460958');
    assert.equal(normalizeE164('911'), null);
    assert.equal(normalizeE164('+012345678'), null);
  });

  it('builds disclosure from only server-authoritative profile and approved purpose', () => {
    assert.equal(
      buildOpeningDisclosure('Alex', 'ask when the restaurant closes.'),
      'Hello, I am the VibeSPACE AI assistant calling on behalf of Alex. I am calling to ask when the restaurant closes.',
    );
    assert.doesNotMatch(buildOpeningDisclosure('', 'ask about public hours'), /undefined|null/i);
  });

  it('requires a bounded, non-emergency, non-binding approved call draft', () => {
    const valid = validateThirdPartyCallDraft({
      destinationType: 'business',
      destinationPhone: '+13125550192',
      destinationDisplayName: "Mario's Pizza",
      goal: 'business_information',
      purpose: 'Ask when the restaurant closes.',
      userInstructions: 'Only ask about public business hours.',
      approvedScript: 'Ask for today’s closing time.',
      openingDisclosure: 'Hello, I’m the VibeSPACE AI assistant calling on behalf of Alex.',
      maximumDurationSeconds: 300,
      maximumCreditReservation: 480,
    });
    assert.equal(valid.ok, true);
    assert.deepEqual(
      validateThirdPartyCallDraft({
        ...(valid.ok ? valid.value : {}),
        allowedActions: ['run_shell'],
      }),
      { ok: false, error: 'invalid_allowed_actions' },
    );

    for (const [field, value, expected] of [
      ['destinationPhone', '911', 'prohibited_destination'],
      ['goal', 'purchase', 'unsupported_goal'],
      ['maximumDurationSeconds', 3_600, 'invalid_maximum_duration'],
      ['maximumCreditReservation', 0, 'invalid_credit_reservation'],
      ['openingDisclosure', 'Hello, I am Alex.', 'missing_ai_disclosure'],
    ] as const) {
      assert.deepEqual(
        validateThirdPartyCallDraft({
          ...(valid.ok ? valid.value : {}),
          [field]: value,
        }),
        { ok: false, error: expected },
      );
    }
  });

  it('invalidates approval when any material call field changes', async () => {
    const base = {
      destinationPhoneE164: '+13125550192',
      purpose: 'Ask for hours',
      approvedScript: 'Ask when they close',
      openingDisclosure: 'I am the VibeSPACE AI assistant.',
      maximumDurationSeconds: 300,
      maximumCreditReservation: 480,
      allowedActions: ['ask_questions'],
    };
    const original = await approvalFingerprint(base);
    assert.equal(original, await approvalFingerprint({ ...base }));
    assert.notEqual(original, await approvalFingerprint({ ...base, purpose: 'Reserve a table' }));
    assert.notEqual(
      original,
      await approvalFingerprint({ ...base, maximumCreditReservation: 481 }),
    );
  });

  it('verifies fresh Telnyx Ed25519 signatures and rejects replay or tampering', async () => {
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
      'base64',
    );
    const body = '{"data":{"event_type":"call.hangup"}}';
    const timestamp = '1785686400';
    const message = new TextEncoder().encode(`${timestamp}|${body}`);
    const signature = Buffer.from(
      await crypto.subtle.sign('Ed25519', keys.privateKey, message),
    ).toString('base64');

    assert.equal(
      await verifyTelnyxSignature({
        publicKeyBase64: publicKey,
        signatureBase64: signature,
        timestamp,
        rawBody: body,
        nowSeconds: Number(timestamp) + 10,
      }),
      true,
    );
    assert.equal(
      await verifyTelnyxSignature({
        publicKeyBase64: publicKey,
        signatureBase64: signature,
        timestamp,
        rawBody: `${body} `,
        nowSeconds: Number(timestamp) + 10,
      }),
      false,
    );
    assert.equal(
      await verifyTelnyxSignature({
        publicKeyBase64: publicKey,
        signatureBase64: signature,
        timestamp,
        rawBody: body,
        nowSeconds: Number(timestamp) + 301,
      }),
      false,
    );
  });
});
