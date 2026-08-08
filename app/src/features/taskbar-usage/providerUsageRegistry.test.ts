import { describe, expect, it } from 'vitest';
import type { ProviderUsageAdapter, ProviderUsageSnapshot } from './providerUsageTypes';
import {
  PROVIDER_USAGE_DEFINITIONS,
  normalizeProviderUsageSnapshot,
  refreshProviderUsageAdapters,
} from './providerUsageRegistry';

function workingAdapter(id: string): ProviderUsageAdapter {
  const value: ProviderUsageSnapshot = {
    providerId: id,
    displayName: id,
    connected: true,
    hidden: false,
    activeRequests: 0,
    usageValue: 12,
    usageLimit: null,
    usageUnit: 'requests',
    usagePercent: null,
    requestsPerMinute: null,
    updatedAt: 10,
    freshness: 'fresh',
    source: 'local-events',
  };
  return {
    id,
    detect: async () => true,
    getCachedSnapshot: () => value,
    refreshQuota: async () => value,
    subscribeToActivity: () => () => undefined,
  };
}

describe('provider usage registry', () => {
  it('defines at least 35 unique provider identities without pretending every provider has usage APIs', () => {
    expect(PROVIDER_USAGE_DEFINITIONS).toHaveLength(35);
    expect(new Set(PROVIDER_USAGE_DEFINITIONS.map(({ id }) => id)).size).toBe(35);
    expect(PROVIDER_USAGE_DEFINITIONS.every(({ routes }) => routes.length > 0)).toBe(true);
    expect(
      PROVIDER_USAGE_DEFINITIONS.some(({ usageCapability }) => usageCapability === 'unsupported'),
    ).toBe(true);
    expect(PROVIDER_USAGE_DEFINITIONS.find(({ id }) => id === 'deepgram')).toMatchObject({
      category: 'speech',
      usageCapability: 'partial',
    });
  });

  it('preserves zero as provider-reported zero but never converts unknown into zero', () => {
    const zero = normalizeProviderUsageSnapshot({
      ...workingAdapter('deepgram').getCachedSnapshot()!,
      usageValue: 0,
      usageLimit: 100,
      usagePercent: null,
      source: 'provider-api',
    });
    const unknown = normalizeProviderUsageSnapshot({
      ...zero,
      usageValue: null,
      usageLimit: null,
      usagePercent: null,
    });

    expect(zero).toMatchObject({ usageValue: 0, usagePercent: 0 });
    expect(unknown).toMatchObject({
      usageValue: null,
      usageLimit: null,
      usagePercent: null,
    });
  });

  it('isolates one adapter failure and preserves working providers', async () => {
    const broken = workingAdapter('broken');
    broken.refreshQuota = async () => {
      throw new Error('authorization header must never be displayed');
    };

    const snapshots = await refreshProviderUsageAdapters(
      [workingAdapter('openai'), broken],
      new AbortController().signal,
      20,
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ providerId: 'openai', freshness: 'fresh' });
    expect(snapshots[1]).toMatchObject({
      providerId: 'broken',
      freshness: 'error',
      errorCode: 'PROVIDER_USAGE_UNAVAILABLE',
    });
    expect(JSON.stringify(snapshots)).not.toContain('authorization header');
  });
});
