import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

async function installSetupOverSentinel() {
  // Never call the actual transport, including when verifying the broken baseline.
  const underlyingFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('Underlying transport sentinel must not be reached');
  });
  globalThis.fetch = underlyingFetch;
  vi.resetModules();
  await import('./setup');
  expect(globalThis.fetch).not.toBe(underlyingFetch);
  return underlyingFetch;
}

describe('offline Vitest fetch default', () => {
  it('rejects an unmocked request without delegating or disclosing request data', async () => {
    const underlyingFetch = await installSetupOverSentinel();
    const error = await globalThis
      .fetch('https://example.invalid/?private=synthetic-request-value', {
        headers: { Authorization: 'Bearer synthetic-header-value' },
        body: 'synthetic-body-value',
        method: 'POST',
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Unmocked fetch is blocked/);
    expect((error as Error).message).not.toMatch(/example|synthetic/);
    expect(underlyingFetch).not.toHaveBeenCalled();
  });

  it('allows an explicit mock and restores the blocked default after unstubbing', async () => {
    const underlyingFetch = await installSetupOverSentinel();
    const blockedFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline fixture')));

    expect(await (await fetch('https://example.invalid/')).text()).toBe('offline fixture');
    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(blockedFetch);
    await expect(fetch('https://example.invalid/')).rejects.toThrow('Unmocked fetch is blocked');
    expect(underlyingFetch).not.toHaveBeenCalled();
  });

  it('keeps blocking after mock reset and restoration', async () => {
    const underlyingFetch = await installSetupOverSentinel();
    const blockedFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('offline fixture'));
    expect(await (await fetch('https://example.invalid/')).text()).toBe('offline fixture');
    vi.restoreAllMocks();
    vi.resetAllMocks();

    expect(globalThis.fetch).toBe(blockedFetch);
    await expect(fetch('https://example.invalid/')).rejects.toThrow('Unmocked fetch is blocked');
    expect(underlyingFetch).not.toHaveBeenCalled();
  });

  it('also blocks the browser fallback of the production native transport', async () => {
    const underlyingFetch = await installSetupOverSentinel();
    const { nativeFetch } = await import('@/lib/nativeFetch');

    await expect(
      nativeFetch('https://example.invalid/', { timeoutMs: 0 }),
    ).rejects.toThrow('Unmocked fetch is blocked');
    expect(underlyingFetch).not.toHaveBeenCalled();
  });
});
