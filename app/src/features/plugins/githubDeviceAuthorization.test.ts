import { describe, expect, it, vi } from 'vitest';
import { createGitHubDeviceAuthorizationAuthority } from './githubDeviceAuthorization';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub device authorization authority', () => {
  it('returns a token-free provider receipt and completes through the private credential callback', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'opaque-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'github-private-access-token',
          token_type: 'bearer',
          scope: 'read:user,repo',
        }),
      );
    const onConnected = vi.fn(async () => undefined);
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: 'Iv1.publicvibespace',
      request,
      wait: vi.fn(async () => undefined),
      now: vi.fn(() => 1_000),
      onConnected,
      onFailed: vi.fn(async () => undefined),
    });

    const receipt = await authority.begin({
      accountId: 'account-a',
      pluginId: 'github',
      path: 'device_authorization',
      scopes: ['read:user', 'repo'],
    });
    expect(receipt).toEqual({
      ok: true,
      state: 'awaiting_approval',
      authorizationUrl: 'https://github.com/login/device',
      userCode: 'ABCD-EFGH',
    });

    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected).toHaveBeenCalledWith({
      accountId: 'account-a',
      pluginId: 'github',
      credential: 'github-private-access-token',
    });
    expect(JSON.stringify(receipt)).not.toContain('github-private-access-token');
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://github.com/login/device/code',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain('client_id=Iv1.publicvibespace');
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain('scope=read%3Auser+repo');
  });

  it('fails closed without a registered VibeSpace client id and never contacts GitHub', async () => {
    const request = vi.fn();
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: undefined,
      request,
      onConnected: vi.fn(async () => undefined),
      onFailed: vi.fn(async () => undefined),
    });

    await expect(
      authority.begin({
        accountId: 'account-a',
        pluginId: 'github',
        path: 'device_authorization',
        scopes: ['read:user'],
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'GitHub authorization requires a registered VibeSpace OAuth client.',
      setupUrl:
        'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a forged verification origin without starting token polling', async () => {
    const onFailed = vi.fn(async () => undefined);
    const request = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        device_code: 'opaque-device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://attacker.example/login/device',
        expires_in: 900,
        interval: 5,
      }),
    );
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: 'Iv1.publicvibespace',
      request,
      onConnected: vi.fn(async () => undefined),
      onFailed,
    });

    await expect(
      authority.begin({
        accountId: 'account-a',
        pluginId: 'github',
        path: 'device_authorization',
        scopes: ['read:user'],
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'GitHub returned an invalid authorization response.',
      setupUrl:
        'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('cancels an active poll without persisting a token or reporting a provider failure', async () => {
    let releaseWait!: () => void;
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
    );
    const onConnected = vi.fn(async () => undefined);
    const onFailed = vi.fn(async () => undefined);
    const request = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        device_code: 'opaque-device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    );
    const authority = createGitHubDeviceAuthorizationAuthority({
      clientId: 'Iv1.publicvibespace',
      request,
      wait,
      onConnected,
      onFailed,
    });

    await authority.begin({
      accountId: 'account-a',
      pluginId: 'github',
      path: 'device_authorization',
      scopes: ['read:user'],
    });
    await authority.cancel({ accountId: 'account-a', pluginId: 'github' });
    releaseWait();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});


it('does not save a late GitHub token after cancellation while the network response is pending', async () => {
  let finishToken!: (response: Response) => void;
  const request = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ device_code: 'opaque-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }))
    .mockReturnValueOnce(new Promise<Response>(resolve => { finishToken = resolve; }));
  const onConnected = vi.fn(async () => undefined);
  const onFailed = vi.fn(async () => undefined);
  const authority = createGitHubDeviceAuthorizationAuthority({ clientId: 'Iv1.publicvibespace', request, wait: async () => undefined, onConnected, onFailed });
  await authority.begin({ accountId: 'account-a', pluginId: 'github', path: 'device_authorization', scopes: ['read:user'] });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await authority.cancel({ accountId: 'account-a', pluginId: 'github' });
  finishToken(jsonResponse({ access_token: 'synthetic-late-token', token_type: 'bearer' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onConnected).not.toHaveBeenCalled();
  expect(onFailed).not.toHaveBeenCalled();
});

it('does not return a browser handoff when cancelled before the device-code response arrives', async () => {
  let finish!: (response: Response) => void;
  const request = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const wait = vi.fn(async () => undefined);
  const authority = createGitHubDeviceAuthorizationAuthority({ clientId: 'Iv1.publicvibespace', request, wait, onConnected: vi.fn(async () => undefined), onFailed: vi.fn(async () => undefined) });
  const result = authority.begin({ accountId: 'account-a', pluginId: 'github', path: 'device_authorization', scopes: ['read:user'] });
  await authority.cancel({ accountId: 'account-a', pluginId: 'github' });
  finish(jsonResponse({ device_code: 'opaque-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }));
  expect((await result).ok).toBe(false);
  expect(wait).not.toHaveBeenCalled();
});
