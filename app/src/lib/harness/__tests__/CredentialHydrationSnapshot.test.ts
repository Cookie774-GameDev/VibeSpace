import { describe, expect, it } from 'vitest';
import { CredentialHydrationSnapshot, redactCredentialMap } from '../CredentialHydrationSnapshot';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CredentialHydrationSnapshot', () => {
  it('retains the last verified credential snapshot on timeout', async () => {
    let now = 100;
    const snapshot = new CredentialHydrationSnapshot(5, () => now);
    expect(await snapshot.hydrate(async () => ({ openai: 'secret' }))).toMatchObject({
      stale: false,
      lastVerifiedAt: 100,
    });
    now = 200;
    const result = await snapshot.hydrate(() => new Promise(() => undefined));
    expect(result).toMatchObject({ stale: true, warning: 'timeout', lastVerifiedAt: 100 });
    expect(result.values.openai).toBe('secret');
    expect(redactCredentialMap(result.values)).toEqual({ openai: '[REDACTED]' });
  });

  it('prevents an older hydration from overwriting a newer verified result', async () => {
    const snapshot = new CredentialHydrationSnapshot(100);
    const older = snapshot.hydrate(async () => {
      await delay(20);
      return { openai: 'old' };
    });
    const newer = snapshot.hydrate(async () => ({ openai: 'new' }));
    expect((await newer).values.openai).toBe('new');
    expect(await older).toMatchObject({ stale: true, warning: 'superseded' });
    expect(snapshot.current().values.openai).toBe('new');
  });

  it('allows an explicit successful empty result to clear provider keys', async () => {
    const snapshot = new CredentialHydrationSnapshot(100);
    await snapshot.hydrate(async () => ({ openai: 'secret' }));
    expect((await snapshot.hydrate(async () => ({}))).values).toEqual({});
  });


  it('merges provider-scoped refreshes without losing unrelated credentials', async () => {
    const snapshot = new CredentialHydrationSnapshot(50, () => 10);
    await snapshot.hydrate(async () => ({ openai: 'a', qwen: 'q' }));
    await snapshot.hydrate(async () => ({ openai: 'b' }), { mode: 'merge' });
    expect(snapshot.current().values).toEqual({ openai: 'b', qwen: 'q' });
    snapshot.removeProviders(['qwen']);
    expect(snapshot.current().values).toEqual({ openai: 'b' });
  });
  it('supersedes a slow hydration when an authoritative user mutation lands', async () => {
    const snapshot = new CredentialHydrationSnapshot(100);
    snapshot.mergeVerified({ openai: 'initial' });
    const slow = snapshot.hydrate(async () => {
      await delay(20);
      return { openai: 'stale' };
    }, { mode: 'merge' });
    snapshot.mergeVerified({ openai: 'user-new' });
    expect(await slow).toMatchObject({ stale: true, warning: 'superseded' });
    expect(snapshot.current().values.openai).toBe('user-new');
  });

});
