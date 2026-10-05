import { describe, expect, it, vi } from 'vitest';

import { createAccountHydrationAuthority } from './accountHydrationAuthority';

describe('Jarvis account hydration authority', () => {
  it('deduplicates concurrent hydration and retains successful readiness', async () => {
    const hydrate = vi.fn(async () => undefined);
    const authority = createAccountHydrationAuthority(hydrate);
    await Promise.all([authority.ready('account-a'), authority.ready('account-a')]);
    await authority.ready('account-a');
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('fails closed and evicts a failed attempt so the next request retries', async () => {
    const hydrate = vi
      .fn<(_accountId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(undefined);
    const authority = createAccountHydrationAuthority(hydrate);
    await expect(authority.ready('account-a')).resolves.toBe(false);
    await expect(authority.ready('account-a')).resolves.toBe(true);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('invalidates successful readiness at an account boundary', async () => {
    const hydrate = vi.fn(async () => undefined);
    const authority = createAccountHydrationAuthority(hydrate);
    await authority.ready('account-a');
    authority.invalidate();
    await authority.ready('account-a');
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('does not authorize a pending hydration invalidated by an account boundary', async () => {
    let finish: () => void = () => undefined;
    const authority = createAccountHydrationAuthority(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = authority.ready('account-a');
    authority.invalidate();
    finish();
    await expect(pending).resolves.toBe(false);
  });

  it('does not let an older failure evict a replacement hydration attempt', async () => {
    let rejectOld: (error: Error) => void = () => undefined;
    let finishCurrent: () => void = () => undefined;
    const hydrate = vi
      .fn<(_accountId: string) => Promise<void>>(async () => undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishCurrent = resolve;
          }),
      );
    const authority = createAccountHydrationAuthority(hydrate);
    const oldAttempt = authority.ready('account-a');
    authority.invalidate();
    const currentAttempt = authority.ready('account-a');
    rejectOld(new Error('old load unavailable'));
    await expect(oldAttempt).resolves.toBe(false);
    expect(authority.ready('account-a')).toBe(currentAttempt);
    finishCurrent();
    await expect(currentAttempt).resolves.toBe(true);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });
});
