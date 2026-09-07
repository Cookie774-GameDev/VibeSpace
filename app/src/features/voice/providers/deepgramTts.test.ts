import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepgramTtsProvider } from './deepgramTts';

const h = vi.hoisted(() => ({ key: vi.fn(), session: vi.fn(), speak: vi.fn(), play: vi.fn() }));
vi.mock('@/lib/security/voiceKeys', () => ({ getDeepgramVoiceKey: h.key }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: h.session } }),
}));
vi.mock('./deepgramSpeak', () => ({ speakDeepgramWithKey: h.speak }));
vi.mock('../audioPlayback', () => ({ playBase64Audio: h.play }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  h.key.mockResolvedValue('test-key');
  h.speak.mockResolvedValue(() => {});
});
afterEach(() => {
  deepgramTtsProvider.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Deepgram speech lifecycle', () => {
  it('uses the current key and selected preset for each chunk', async () => {
    h.key.mockResolvedValueOnce('first-key').mockResolvedValueOnce('second-key');
    for (const preset of ['jarvis', 'friday'] as const)
      await deepgramTtsProvider.speakChunk('Hello', {
        preset,
        signal: new AbortController().signal,
      });
    expect(h.speak.mock.calls.map((args) => [args[0], args[2]])).toEqual([
      ['first-key', 'jarvis'],
      ['second-key', 'friday'],
    ]);
  });

  it.each(['abort', 'stop'] as const)(
    'does not submit speech after %s during key lookup',
    async (action) => {
      let resolveKey!: (key: string) => void;
      h.key.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveKey = resolve;
        }),
      );
      const controller = new AbortController();
      const speaking = deepgramTtsProvider.speakChunk('Cancelled text', {
        preset: 'jarvis',
        signal: controller.signal,
      });
      if (action === 'abort') controller.abort();
      else deepgramTtsProvider.stop();
      resolveKey('test-key');
      await speaking;
      expect(h.speak).not.toHaveBeenCalled();
    },
  );

  it('does not send a cloud request after cancellation during session lookup', async () => {
    h.key.mockResolvedValue(undefined);
    let resolveSession!: (value: unknown) => void;
    h.session.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const fetcher = vi.fn(async () => new Response('{"audio":"","mime":"audio/mpeg"}'));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const speaking = deepgramTtsProvider.speakChunk('Cancelled text', {
      preset: 'jarvis',
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    resolveSession({ data: { session: { access_token: 'fixture-token' } } });
    await speaking;
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
  });

  it('keeps the cloud timeout active while the audio body is stalled', async () => {
    h.key.mockResolvedValue(undefined);
    h.session.mockResolvedValue({ data: { session: { access_token: 'fixture-token' } } });
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requestSignal = init.signal;
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) =>
              requestSignal!.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              ),
            ),
        };
      }),
    );
    const caller = new AbortController();
    const speaking = deepgramTtsProvider
      .speakChunk('Hello', { preset: 'jarvis', signal: caller.signal })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(requestSignal?.aborted).toBe(true);
    await speaking;
    expect(h.play).not.toHaveBeenCalled();
  });
});
