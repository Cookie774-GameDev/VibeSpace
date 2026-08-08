import { describe, expect, it } from 'vitest';
import { boundedMap } from './boundedMap';

describe('boundedMap', () => {
  it('preserves result order while limiting simultaneous work', async () => {
    let active = 0;
    let peak = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const resultPromise = boundedMap([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      if (value <= 2) await firstWave;
      active -= 1;
      return value * 10;
    });

    await Promise.resolve();
    expect(active).toBe(2);
    expect(peak).toBe(2);
    releaseFirstWave();

    await expect(resultPromise).resolves.toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('handles empty input without invoking the mapper', async () => {
    let calls = 0;
    await expect(
      boundedMap([], 4, async () => {
        calls += 1;
        return 'unused';
      }),
    ).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects invalid concurrency and propagates mapper failures', async () => {
    await expect(boundedMap([1], 0, async (value) => value)).rejects.toThrow(/concurrency/i);
    await expect(
      boundedMap([1, 2], 1, async (value) => {
        if (value === 2) throw new Error('mapped failure');
        return value;
      }),
    ).rejects.toThrow('mapped failure');
  });
});
