import { describe, expect, it } from 'vitest';
import { isNewsBenchmarkDiscoveryStale } from './NewsModelBenchmarkLane';

describe('news benchmark lane freshness projection', () => {
  it('marks retained ready payloads and error fallbacks stale', () => {
    expect(isNewsBenchmarkDiscoveryStale({ status: 'ready', stale: true, pair: {} as never })).toBe(
      true,
    );
    expect(isNewsBenchmarkDiscoveryStale({ status: 'error', message: 'unavailable' })).toBe(true);
    expect(
      isNewsBenchmarkDiscoveryStale({ status: 'ready', stale: false, pair: {} as never }),
    ).toBe(false);
  });
});
