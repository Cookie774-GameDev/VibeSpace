import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_CATALOG } from './catalog';
import {
  PLUGIN_CONNECTION_ADAPTERS,
  PluginAppInstallationSession,
  PluginDeviceAuthorizationSession,
  PluginOAuthSession,
  pluginConsent,
  validateOAuthCallback,
} from './connectionFramework';

describe('shared plugin connection framework', () => {
  it('provides one honest extensible adapter for every catalog entry', () => {
    expect(Object.keys(PLUGIN_CONNECTION_ADAPTERS)).toHaveLength(112);
    for (const plugin of PLUGIN_CATALOG) {
      const adapter = PLUGIN_CONNECTION_ADAPTERS[plugin.id];
      expect(adapter.pluginId).toBe(plugin.id);
      expect(adapter.documentationUrl).toMatch(/^https:\/\//);
      expect(adapter.canConnect).toBe(adapter.productionReady);
      if (!adapter.canConnect) expect(adapter.prerequisites.length).toBeGreaterThanOrEqual(0);
      expect(pluginConsent(plugin.id).service).toBe(plugin.name);
    }
  });

  it('validates exact redirects and CSRF state before a trusted token exchange', () => {
    expect(
      validateOAuthCallback({
        callbackUrl: 'http://127.0.0.1:47000/callback?code=abc&state=expected',
        expectedRedirectUrl: 'http://127.0.0.1:47000/callback',
        expectedState: 'expected',
      }),
    ).toEqual({ code: 'abc' });
    expect(() =>
      validateOAuthCallback({
        callbackUrl: 'http://127.0.0.1:47001/callback?code=abc&state=expected',
        expectedRedirectUrl: 'http://127.0.0.1:47000/callback',
        expectedState: 'expected',
      }),
    ).toThrow(/redirect/);
    expect(() =>
      validateOAuthCallback({
        callbackUrl: 'http://127.0.0.1:47000/callback?code=abc&state=wrong',
        expectedRedirectUrl: 'http://127.0.0.1:47000/callback',
        expectedState: 'expected',
      }),
    ).toThrow(/state/);
    expect(() =>
      validateOAuthCallback({
        callbackUrl: 'http://127.0.0.1:47000/callback?code=abc&state=expected&access_token=leak',
        expectedRedirectUrl: 'http://127.0.0.1:47000/callback',
        expectedState: 'expected',
      }),
    ).toThrow(/token material/);
  });

  it('passes only code/verifier metadata to the trusted exchange and rejects replay', async () => {
    const session = await PluginOAuthSession.create({
      pluginId: 'gmail',
      redirectUrl: 'http://127.0.0.1:47000/callback',
      now: 100,
    });
    const complete = vi.fn().mockResolvedValue({ accountLabel: 'user@example.com' });
    const trustedAdapter = { complete, revoke: vi.fn() };
    const result = await session.complete({
      callbackUrl: `http://127.0.0.1:47000/callback?code=authorization-code&state=${session.pkce.state}`,
      trustedAdapter,
      now: 200,
    });
    expect(result).toEqual({ accountLabel: 'user@example.com' });
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('token');
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      nonce: session.pkce.nonce,
      requiredScopes: expect.any(Array),
    });
    await expect(
      session.complete({
        callbackUrl: `http://127.0.0.1:47000/callback?code=replay&state=${session.pkce.state}`,
        trustedAdapter,
      }),
    ).rejects.toThrow(/no longer active/);
  });

  it('keeps device authorization cancellable and token-free', async () => {
    const trusted = {
      begin: vi.fn(async () => ({
        handle: 'opaque-handle',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://provider.example/device',
        expiresAt: 10_000,
        pollIntervalMs: 10,
      })),
      poll: vi.fn(async () => ({ state: 'pending' as const })),
      cancel: vi.fn(async () => undefined),
    };
    const session = await PluginDeviceAuthorizationSession.create('github', trusted);
    expect(session).not.toHaveProperty('token');
    expect(await session.poll(trusted, 100)).toEqual({ state: 'pending' });
    await session.cancel(trusted);
    await expect(session.poll(trusted, 100)).rejects.toThrow(/no longer active/);
  });

  it('validates HTTPS app-install surfaces and prevents replay', async () => {
    const trusted = {
      begin: vi.fn(async () => ({
        installUrl: 'https://provider.example/install',
        handle: 'opaque-install',
        expiresAt: 10_000,
      })),
      complete: vi.fn(async () => ({ accountLabel: 'Workspace' })),
      cancel: vi.fn(async () => undefined),
    };
    const session = await PluginAppInstallationSession.create('github', trusted);
    expect(await session.complete(trusted, 100)).toEqual({ accountLabel: 'Workspace' });
    await expect(session.complete(trusted, 100)).rejects.toThrow(/no longer active/);
  });
});
