import { describe, expect, it, vi } from 'vitest';
import { createUsageRefreshCoordinator } from './usageRefreshCoordinator';

describe('usage refresh coordinator', () => {
  it('deduplicates in-flight refreshes and respects the provider TTL', async () => {
    let now = 1_000;
    const coordinator = createUsageRefreshCoordinator({ now: () => now, random: () => 0.5 });
    let resolve!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );

    const first = coordinator.run('openai:api', operation, { ttlMs: 60_000 });
    const duplicate = coordinator.run('openai:api', operation, { ttlMs: 60_000 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(duplicate).toBe(first);
    resolve('fresh');
    await expect(first).resolves.toBe('fresh');

    now += 5_000;
    await expect(
      coordinator.run('openai:api', operation, { ttlMs: 60_000 }),
    ).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('pauses remote work offline and backs off retryable failures without deleting cached state', async () => {
    let now = 10_000;
    const coordinator = createUsageRefreshCoordinator({ now: () => now, random: () => 0.5 });
    const operation = vi.fn().mockRejectedValueOnce(new Error('provider failed'));

    coordinator.setOnline(false);
    await expect(
      coordinator.run('deepgram:api', operation, { ttlMs: 60_000 }),
    ).resolves.toBeUndefined();
    expect(operation).not.toHaveBeenCalled();

    coordinator.setOnline(true);
    await expect(coordinator.run('deepgram:api', operation, { ttlMs: 60_000 })).rejects.toThrow(
      'provider failed',
    );
    expect(coordinator.getState('deepgram:api')).toMatchObject({
      failures: 1,
      nextRetryAt: 15_000,
    });

    now = 14_999;
    await expect(
      coordinator.run('deepgram:api', operation, { ttlMs: 60_000 }),
    ).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent provider work and starts queued refreshes as capacity opens', async () => {
    const coordinator = createUsageRefreshCoordinator({
      maxConcurrent: 2,
      random: () => 0.5,
    });
    const resolvers: Array<(value: string) => void> = [];
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = coordinator.run('one', operation, { ttlMs: 60_000 });
    const second = coordinator.run('two', operation, { ttlMs: 60_000 });
    const third = coordinator.run('three', operation, { ttlMs: 60_000 });
    expect(operation).toHaveBeenCalledTimes(2);

    resolvers[0]('one');
    await first;
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    resolvers[1]('two');
    resolvers[2]('three');
    await Promise.all([second, third]);
  });
});
