import { describe, expect, it } from 'vitest';
import { formatAuthError, isLikelyExistingAccountSignUp } from './authErrors';

describe('formatAuthError', () => {
  it.each(['User not found', 'Unable to validate email address'])(
    'uses non-enumerating copy for %s',
    (message) => {
      const result = formatAuthError(new Error(message));
      expect(result).not.toMatch(/no account|found|exists|registered|sent|delivery/i);
      expect(result).toMatch(/unable to continue/i);
    },
  );

  it('does not pass arbitrary concise provider copy through verbatim', () => {
    const providerCopy = 'Mailbox owner secret state';
    const result = formatAuthError(new Error(providerCopy), 'Unable to continue. Try again.');
    expect(result).toBe('Unable to continue. Try again.');
    expect(result).not.toContain(providerCopy);
  });
  it('maps common Supabase auth failures', () => {
    expect(formatAuthError({ message: 'Invalid login credentials' })).toMatch(
      /incorrect email or password/i,
    );
    expect(formatAuthError({ message: 'Email not confirmed' })).toMatch(/confirm your email/i);
    expect(formatAuthError({ message: 'User already registered' })).toMatch(
      /unable to complete sign-up/i,
    );
    expect(formatAuthError({ message: 'User already registered' })).not.toMatch(
      /already|exists|registered/i,
    );
    expect(formatAuthError({ message: 'Token has expired or is invalid' })).toMatch(
      /invalid or expired|expired/i,
    );
    expect(formatAuthError({ message: 'over_email_send_rate_limit' })).toMatch(/too many emails/i);
  });

  it('falls back for empty errors', () => {
    expect(formatAuthError(null)).toMatch(/try again/i);
  });
});

describe('isLikelyExistingAccountSignUp', () => {
  it('detects empty identities without a session', () => {
    expect(isLikelyExistingAccountSignUp({ user: { identities: [] }, session: null })).toBe(true);
    expect(
      isLikelyExistingAccountSignUp({
        user: { identities: [{ id: '1' }] },
        session: null,
      }),
    ).toBe(false);
    expect(
      isLikelyExistingAccountSignUp({
        user: { identities: [] },
        session: { access_token: 'x' },
      }),
    ).toBe(false);
  });
});
