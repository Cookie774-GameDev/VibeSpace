import { expect, it, vi } from 'vitest';
import { createCodexTurnLease } from './codexTurnLease';
it('serializes owners and removes aborted queued requests', async () => {
  const lease = createCodexTurnLease();
  const first = await lease.acquire();
  const aborter = new AbortController();
  const cancelled = lease.acquire(aborter.signal);
  const rejection = expect(cancelled).rejects.toThrow();
  aborter.abort();
  await rejection;
  const admitted = vi.fn();
  const next = lease.acquire().then((release) => {
    admitted();
    release();
  });
  await Promise.resolve();
  expect(admitted).not.toHaveBeenCalled();
  first();
  first();
  await next;
  expect(admitted).toHaveBeenCalledTimes(1);
});
it('recovers only the remembered native generation after renderer replacement', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const prior = createCodexTurnLease(storage);
  prior.remember('native-generation-one');
  const next = createCodexTurnLease(storage);
  const stop = vi.fn().mockResolvedValue(true);
  await next.recover(stop);
  expect(stop).toHaveBeenCalledWith('native-generation-one');
  await next.recover(stop);
  expect(stop).toHaveBeenCalledTimes(1);
});
it('retains cleanup ownership on failure and cannot clear a replacement generation', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const lease = createCodexTurnLease(storage);
  lease.remember('first');
  await expect(
    lease.recover(async () => {
      throw Error('stop failed');
    }),
  ).rejects.toThrow('stop failed');
  lease.remember('second');
  lease.forget('first');
  const stop = vi.fn().mockResolvedValue(false);
  await lease.recover(stop);
  expect(stop).toHaveBeenCalledWith('second');
});
