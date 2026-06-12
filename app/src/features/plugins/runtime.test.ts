import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callPluginTool, testPluginConnection } from './runtime';

describe('plugin runtime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the deterministic mock connector end to end', async () => {
    await expect(testPluginConnection('mock-connector')).resolves.toEqual({
      ok: true,
      accountLabel: 'Local test connector',
    });
    await expect(callPluginTool('mock-connector', 'ping')).resolves.toEqual({
      ok: true,
      pluginId: 'mock-connector',
      tool: 'ping',
      message: 'pong',
    });
  });

  it('builds provider-specific auth headers for multi-field connectors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.includes('twilio.com')) {
        expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123.json');
        expect(headers.get('Authorization')).toBe(`Basic ${btoa('AC123:secret-token')}`);
        return new Response(JSON.stringify({ friendly_name: 'Test Workspace' }), { status: 200 });
      }
      if (url.includes('mailchimp.com')) {
        expect(url).toBe('https://us19.api.mailchimp.com/3.0/ping');
        expect(headers.get('Authorization')).toBe('Bearer key-us19');
        return new Response('{}', { status: 200 });
      }
      if (url.includes('stripe.com')) {
        expect(headers.get('Authorization')).toBe(`Basic ${btoa('sk_test_abc:')}`);
        return new Response(JSON.stringify({ object: 'balance' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const { setPluginCredential } = await import('./credentials');

    await setPluginCredential('twilio', 'account_sid', 'AC123');
    await setPluginCredential('twilio', 'auth_token', 'secret-token');
    await expect(testPluginConnection('twilio')).resolves.toMatchObject({
      ok: true,
      accountLabel: 'Test Workspace',
    });

    await setPluginCredential('mailchimp', 'api_key', 'key-us19');
    await expect(testPluginConnection('mailchimp')).resolves.toMatchObject({ ok: true });

    await setPluginCredential('stripe', 'secret_key', 'sk_test_abc');
    await expect(testPluginConnection('stripe')).resolves.toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenCalled();
  });

  it('returns a readable invalid-credential error without logging the secret', async () => {
    const secret = 'github_pat_invalid_super_secret';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad credentials', { status: 401 }),
    );
    const { setPluginCredential } = await import('./credentials');
    await setPluginCredential('github', 'token', secret);
    const result = await testPluginConnection('github');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).not.toContain(secret);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
  });
});
