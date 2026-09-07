import { afterEach, describe, expect, it, vi } from 'vitest';
import { speakDeepgramWithKey, testDeepgramVoiceKey } from './deepgramSpeak';
import { playBase64Audio } from '../audioPlayback';

vi.mock('../audioPlayback', () => ({ playBase64Audio: vi.fn(async () => () => {}) }));

describe('Deepgram synthesis request', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not send an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => new Response('audio'));
    vi.stubGlobal('fetch', fetcher);
    await speakDeepgramWithKey('test-key', 'Hello', 'jarvis', controller.signal);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds a stalled response body', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requestSignal = init.signal;
        return {
          ok: true,
          arrayBuffer: () =>
            new Promise((_resolve, reject) =>
              requestSignal!.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              ),
            ),
        };
      }),
    );
    const speaking = speakDeepgramWithKey(
      'test-key',
      'Hello',
      'jarvis',
      new AbortController().signal,
    ).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(requestSignal?.aborted).toBe(true);
    await speaking;
  });

  it('preserves the selected voice and volume and does not cut off long playback', async () => {
    vi.useFakeTimers();
    let finishPlayback!: () => void;
    vi.mocked(playBase64Audio).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPlayback = () => resolve(() => {});
        }),
    );
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const caller = new AbortController();
    let finished = false;
    const speaking = speakDeepgramWithKey('test-key', 'Hello', 'friday', caller.signal, 0.4).then(
      () => {
        finished = true;
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher.mock.calls[0]?.[0]).toContain('model=aura-luna-en');
    expect(playBase64Audio).toHaveBeenLastCalledWith('AQID', 'audio/mpeg', {
      volume: 0.4,
      signal: caller.signal,
    });
    expect(finished).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    finishPlayback();
    await speaking;
  });
});

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
