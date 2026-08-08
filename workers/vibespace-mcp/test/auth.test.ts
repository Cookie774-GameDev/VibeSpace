import { describe, expect, it } from 'vitest';

import { issueRelayTicket, verifyRelayTicket } from '../src/auth';

const secret = 'a-secure-test-key-that-is-at-least-thirty-two-bytes';
const subject = '99f194ac-1822-4ff8-b3b1-8a7338365646';

describe('relay tickets', () => {
  it('issues a short-lived account-scoped ticket', async () => {
    const ticket = await issueRelayTicket(subject, secret, 100);
    const parsed = await verifyRelayTicket(ticket, secret, 120);

    expect(parsed.sub).toBe(subject);
    expect(parsed.exp).toBe(160);
    expect(parsed.jti).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('rejects tampering, expiration, and weak signing keys', async () => {
    const ticket = await issueRelayTicket(subject, secret, 100);
    await expect(verifyRelayTicket(`${ticket}x`, secret, 120)).rejects.toThrow(
      /invalid relay ticket/i,
    );
    await expect(verifyRelayTicket(ticket, secret, 161)).rejects.toThrow(/invalid relay ticket/i);
    await expect(issueRelayTicket(subject, 'weak', 100)).rejects.toThrow(/not configured/i);
  });
});
