import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDeepgramVoiceKey } from './deepgramSpeak';

describe('testDeepgramVoiceKey', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the read-only projects endpoint instead of synthesizing billable audio', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"projects":[]}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetcher);

    await expect(testDeepgramVoiceKey('private-key')).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/projects',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Token private-key' },
      }),
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('returns false for revoked keys and network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(testDeepgramVoiceKey('revoked')).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    await expect(testDeepgramVoiceKey('offline')).resolves.toBe(false);
  });
});
