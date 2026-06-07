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
