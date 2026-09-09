import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubDeviceAuthorizationAuthority,
  VIBESPACE_GITHUB_OAUTH_CLIENT_ID,
} from './githubDeviceAuthorization';

const start = {
  accountId: 'oauth-fixture',
  pluginId: 'github',
  path: 'device_authorization' as const,
  scopes: ['read:user'],
};
const device = {
  device_code: 'synthetic-device',
  user_code: 'TEST-CODE',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.useRealTimers());

describe('GitHub OAuth response cancellation', () => {
  it('starts the device flow with the shipped public client without a client secret', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(device));
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: VIBESPACE_GITHUB_OAUTH_CLIENT_ID,
      request,
      wait: () => new Promise(() => undefined),
      onConnected: vi.fn(async () => undefined),
      onFailed: vi.fn(async () => undefined),
    });
    const result = await authority.begin(start);
    expect(result).toMatchObject({
      ok: true,
      authorizationUrl: 'https://github.com/login/device',
      userCode: 'TEST-CODE',
    });
    const body = new URLSearchParams(request.mock.calls[0][1].body);
    expect(body.get('client_id')).toBe('Ov23li5E2zk5XnjmrKTE');
    expect(body.has('client_secret')).toBe(false);
    await authority.cancel(start);
  });
  it('does not persist a token if cancellation happens while its JSON body is still loading', async () => {
    let finish!: (value: unknown) => void;
    const body = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const tokenResponse = json({});
    tokenResponse.json = body;
    const request = vi
      .fn()
      .mockResolvedValueOnce(json(device))
      .mockResolvedValueOnce(tokenResponse);
    const onConnected = vi.fn(async () => undefined);
    const onFailed = vi.fn(async () => undefined);
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: 'Iv1.testfixture',
      request,
      wait: async () => undefined,
      onConnected,
      onFailed,
    });
    await authority.begin(start);
    await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
    await authority.cancel(start);
    finish({ access_token: 'synthetic-token', token_type: 'bearer' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConnected).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('cancels the real polling delay without sending another token request', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(json(device))
      .mockResolvedValue(json({ error: 'authorization_pending' }));
    const onConnected = vi.fn(async () => undefined);
    const onFailed = vi.fn(async () => undefined);
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: 'Iv1.testfixture',
      request,
      onConnected,
      onFailed,
    });
    await authority.begin(start);
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(2);
    await authority.cancel(start);
    await vi.advanceTimersByTimeAsync(15000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
