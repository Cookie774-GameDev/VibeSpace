import { describe, expect, it, vi } from 'vitest';
import {
  QWEN_COMPATIBLE_BASE_URLS,
  activeQwenCompatibleBaseUrl,
  probeQwenApiCredential,
  qwenCatalogIdentity,
  reconcileNativeProbeState,
  resetActiveQwenCompatibleBaseUrlForTests,
  verifiedQwenCompatibleBaseUrl,
} from './nativeConnectionProbe';

describe('probeQwenApiCredential', () => {
  beforeEach(() => resetActiveQwenCompatibleBaseUrlForTests());

  it('marks a rejected saved key unauthenticated', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 401 }));
    await expect(probeQwenApiCredential('saved-but-invalid', fetcher)).resolves.toEqual({
      available: false,
      auth: 'unauthenticated',
    });
    expect(fetcher).toHaveBeenCalledTimes(QWEN_COMPATIBLE_BASE_URLS.length);
    expect((fetcher.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      method: 'POST',
    });
    expect(verifiedQwenCompatibleBaseUrl()).toBeUndefined();
  });

  it('marks only a successful provider response ready', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(probeQwenApiCredential('valid', fetcher)).resolves.toEqual({
      available: true,
      auth: 'authenticated',
    });
  });

  it('tries every official region and routes later chat calls through the authenticated one', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith('https://dashscope-intl.aliyuncs.com/')
        ? new Response('{}', { status: 200 })
        : new Response('', { status: 401 }),
    );

    await expect(probeQwenApiCredential('singapore-key', fetcher)).resolves.toEqual({
      available: true,
      auth: 'authenticated',
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    ]);
    expect(activeQwenCompatibleBaseUrl()).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(verifiedQwenCompatibleBaseUrl()).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(qwenCatalogIdentity()).toEqual({
      region: 'intl',
      billingMode: 'payg',
      endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
    expect(
      qwenCatalogIdentity('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),
    ).toEqual({
      region: 'ap-southeast-1',
      billingMode: 'token-plan',
      endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    });
    expect(qwenCatalogIdentity('https://coding-intl.dashscope.aliyuncs.com/v1')).toEqual({
      region: 'intl',
      billingMode: 'coding-plan',
      endpoint: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    });
  });

  it('clears a previously verified endpoint when the current credential is rejected', async () => {
    await probeQwenApiCredential(
      'first-valid-key',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    expect(verifiedQwenCompatibleBaseUrl()).toBe(QWEN_COMPATIBLE_BASE_URLS[0]);

    await probeQwenApiCredential(
      'replacement-invalid-key',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    expect(verifiedQwenCompatibleBaseUrl()).toBeUndefined();
  });

  it('does not let an older successful probe restore an endpoint after a replacement key is rejected', async () => {
    let finishOlderProbe: ((response: Response) => void) | undefined;
    const olderFetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishOlderProbe = resolve;
        }),
    );

    const olderProbe = probeQwenApiCredential('older-valid-key', olderFetcher);
    await vi.waitFor(() => expect(olderFetcher).toHaveBeenCalledTimes(1));

    await expect(
      probeQwenApiCredential(
        'replacement-invalid-key',
        vi.fn(async () => new Response('', { status: 401 })),
      ),
    ).resolves.toEqual({ available: false, auth: 'unauthenticated' });

    finishOlderProbe?.(new Response('{}', { status: 200 }));
    await expect(olderProbe).resolves.toEqual({ available: false, auth: 'unknown' });
    expect(verifiedQwenCompatibleBaseUrl()).toBeUndefined();
  });

  it('keeps transport failures unavailable without claiming auth loss', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(probeQwenApiCredential('unverified', fetcher)).resolves.toEqual({
      available: false,
      auth: 'unknown',
    });
  });

  it('does not erase a definitive rejected-key result with a later transient failure', () => {
    expect(
      reconcileNativeProbeState(
        { available: false, auth: 'unauthenticated' },
        { available: false, auth: 'unknown' },
      ),
    ).toEqual({ available: false, auth: 'unauthenticated' });
  });
});
