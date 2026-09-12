import { describe, expect, it, vi } from 'vitest';
import { checkCallCloudReadiness, normalizeCallCloudUrl } from './config';

describe('call cloud configuration', () => {
  it('rejects missing, malformed, and insecure remote URLs', () => {
    expect(normalizeCallCloudUrl('')).toEqual({ ok: false, reason: 'missing' });
    expect(normalizeCallCloudUrl('not a url')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeCallCloudUrl('http://example.com')).toEqual({
      ok: false,
      reason: 'insecure',
    });
    expect(normalizeCallCloudUrl('http://127.0.0.1:8000/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8000',
    });
  });

  it('probes the real health endpoint and reports configured transports', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            transports: { livekit: true, telnyx: true, call_anyone: true, supabase: true },
          }),
          { status: 200 },
        ),
    );

    await expect(
      checkCallCloudReadiness('https://calls.vibespaceos.com/', { fetcher }),
    ).resolves.toMatchObject({
      state: 'ready',
      url: 'https://calls.vibespaceos.com',
      transports: { livekit: true, telnyx: true, callAnyone: true, supabase: true },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://calls.vibespaceos.com/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('distinguishes a reachable but incomplete backend from a network failure', async () => {
    await expect(
      checkCallCloudReadiness('https://calls.vibespaceos.com', {
        fetcher: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                ok: true,
                transports: { livekit: true, telnyx: false, call_anyone: false, supabase: true },
              }),
            ),
        ),
      }),
    ).resolves.toMatchObject({ state: 'partial' });

    await expect(
      checkCallCloudReadiness('https://calls.vibespaceos.com', {
        fetcher: vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }),
      }),
    ).resolves.toMatchObject({ state: 'unreachable', message: 'Failed to fetch' });
  });
});
