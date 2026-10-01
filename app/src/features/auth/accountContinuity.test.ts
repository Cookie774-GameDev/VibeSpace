import { describe, expect, it, vi } from 'vitest';

import {
  consumeAuthorizationCallback,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  type PendingAuthorization,
} from './accountContinuity';

const config = {
  supabaseUrl: 'https://project.example',
  clientId: 'desktop-public-client',
  redirectUri: 'vibespace://auth/callback',
};

describe('account continuity PKCE contract', () => {
  it('creates a short-lived authorization request without putting credentials in the URL', async () => {
    const request = await createAuthorizationRequest(config, {
      now: 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const url = new URL(request.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe('https://project.example/auth/v1/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(request.pending.state);
    expect(request.pending.expiresAt).toBe(301_000);
    expect(request.pending.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(request.authorizationUrl).not.toMatch(/access_token|refresh_token|anon_key|cookie/iu);
  });

  it('rejects expired, mismatched, and replayed callbacks before token exchange', () => {
    const pending: PendingAuthorization = {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: 'expected-state',
      codeVerifier: 'v'.repeat(43),
      expiresAt: 2_000,
    };
    const consumedStates = new Set<string>();

    expect(() =>
      consumeAuthorizationCallback(
        'vibespace://auth/callback?code=once&state=wrong-state',
        pending,
        consumedStates,
        1_500,
      ),
    ).toThrow(/state/iu);
    expect(() =>
      consumeAuthorizationCallback(
        'https://attacker.example/callback?code=once&state=expected-state',
        pending,
        consumedStates,
        1_500,
      ),
    ).toThrow(/redirect/iu);
    expect(() =>
      consumeAuthorizationCallback(
        'vibespace://auth/callback?code=late&state=expected-state',
        pending,
        consumedStates,
        2_001,
      ),
    ).toThrow(/expired/iu);

    const result = consumeAuthorizationCallback(
      'vibespace://auth/callback?code=once&state=expected-state',
      pending,
      consumedStates,
      1_500,
    );
    expect(result.code).toBe('once');
    expect(() =>
      consumeAuthorizationCallback(
        'vibespace://auth/callback?code=once&state=expected-state',
        pending,
        consumedStates,
        1_500,
      ),
    ).toThrow(/already been used/iu);
  });

  it('exchanges the one-time code in the request body and accepts any 2xx response', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'returned-only-in-body',
          refresh_token: 'returned-only-in-body',
          expires_in: 3600,
          token_type: 'bearer',
        }),
        { status: 202 },
      ),
    );
    const pending: PendingAuthorization = {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: 'expected-state',
      codeVerifier: 'v'.repeat(43),
      expiresAt: 2_000,
    };

    await exchangeAuthorizationCode(config.supabaseUrl, 'one-time-code', pending, fetcher);

    const [requestedUrl, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(requestedUrl).toBe('https://project.example/auth/v1/oauth/token');
    expect(requestedUrl).not.toContain('one-time-code');
    expect(options.method).toBe('POST');
    expect(String(options.body)).toContain('code=one-time-code');
    expect(String(options.body)).toContain(`code_verifier=${'v'.repeat(43)}`);
  });
});
