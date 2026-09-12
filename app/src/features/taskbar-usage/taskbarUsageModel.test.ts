import { describe, expect, it } from 'vitest';
import type { ProviderUsageSnapshot } from './providerUsageTypes';
import {
  normalizeTaskbarUsagePreferences,
  reconcileProviderAndLocalUsage,
  safeAggregateUsdSpend,
  selectVisibleProviderSnapshots,
  snapshotFreshnessLabel,
} from './taskbarUsageModel';

function snapshot(
  providerId: string,
  overrides: Partial<ProviderUsageSnapshot> = {},
): ProviderUsageSnapshot {
  return {
    providerId,
    displayName: providerId,
    connected: true,
    hidden: false,
    activeRequests: 0,
    usageValue: null,
    usageLimit: null,
    usageUnit: null,
    usagePercent: null,
    requestsPerMinute: null,
    updatedAt: 1_000,
    freshness: 'fresh',
    source: 'local-events',
    ...overrides,
  };
}

describe('taskbar usage model', () => {
  it('shows the first four connected, non-hidden providers in persisted order', () => {
    const visible = selectVisibleProviderSnapshots(
      [
        snapshot('openai'),
        snapshot('codex'),
        snapshot('anthropic'),
        snapshot('deepgram'),
        snapshot('groq'),
        snapshot('offline', { connected: false }),
      ],
      {
        providerOrder: ['anthropic', 'codex', 'openai', 'deepgram', 'groq'],
        hiddenProviderIds: [],
        pinnedProviderIds: [],
      },
    );

    expect(visible.map(({ providerId }) => providerId)).toEqual([
      'anthropic',
      'codex',
      'openai',
      'deepgram',
    ]);
  });

  it('ranks active, warning, and recently synced providers ahead of idle peers by default', () => {
    const visible = selectVisibleProviderSnapshots(
      [
        snapshot('idle', { updatedAt: 1 }),
        snapshot('recent', { updatedAt: 500 }),
        snapshot('warning', { usagePercent: 91, updatedAt: 200 }),
        snapshot('active', { activeRequests: 1, updatedAt: 100 }),
        snapshot('older', { updatedAt: 50 }),
      ],
      {
        providerOrder: [],
        hiddenProviderIds: [],
        pinnedProviderIds: [],
      },
    );

    expect(visible.map(({ providerId }) => providerId)).toEqual([
      'active',
      'warning',
      'recent',
      'older',
    ]);
  });

  it('keeps pinned providers ahead of relevance-ranked providers', () => {
    const visible = selectVisibleProviderSnapshots(
      [
        snapshot('idle-pinned', { updatedAt: 1 }),
        snapshot('active', { activeRequests: 2, updatedAt: 500 }),
      ],
      {
        providerOrder: [],
        hiddenProviderIds: [],
        pinnedProviderIds: ['idle-pinned'],
      },
    );

    expect(visible.map(({ providerId }) => providerId)).toEqual(['idle-pinned', 'active']);
  });

  it('applies hidden state without disconnecting the provider', () => {
    const codex = snapshot('codex');
    const visible = selectVisibleProviderSnapshots([codex, snapshot('openai')], {
      providerOrder: ['codex', 'openai'],
      hiddenProviderIds: ['codex'],
      pinnedProviderIds: [],
    });

    expect(codex.connected).toBe(true);
    expect(visible.map(({ providerId }) => providerId)).toEqual(['openai']);
  });

  it('fails closed over malformed persisted preferences', () => {
    expect(
      normalizeTaskbarUsagePreferences({
        enabled: 'yes',
        launchWithVibeSpace: false,
        providerOrder: ['openai', 'openai', '', 7],
        hiddenProviderIds: ['codex', '../secret'],
        placement: { monitorName: 'Primary', edge: 'diagonal', offset: -4 },
      }),
    ).toEqual({
      enabled: true,
      launchWithVibeSpace: false,
      providerOrder: ['openai'],
      hiddenProviderIds: ['codex'],
      pinnedProviderIds: [],
      registrySort: 'active',
      detailsOpen: false,
      placement: null,
      collapsed: false,
    });
  });

  it('labels stale and offline snapshots without inventing quota values', () => {
    expect(snapshotFreshnessLabel(snapshot('openai', { updatedAt: 1_000 }), 121_000)).toBe(
      'Updated 2m ago',
    );
    expect(snapshotFreshnessLabel(snapshot('codex', { freshness: 'offline' }), 121_000)).toBe(
      'Offline',
    );
    expect(snapshot('codex').usagePercent).toBeNull();
  });

  it('aggregates spend only when currency and scope are safely compatible', () => {
    expect(
      safeAggregateUsdSpend([
        snapshot('one', { usageValue: 2.5, usageUnit: 'usd', planScope: 'workspace' }),
        snapshot('two', { usageValue: 3, usageUnit: 'usd', planScope: 'workspace' }),
      ]),
    ).toBe(5.5);
    expect(
      safeAggregateUsdSpend([
        snapshot('one', { usageValue: 2.5, usageUnit: 'usd', planScope: 'personal' }),
        snapshot('two', { usageValue: 3, usageUnit: 'usd', planScope: 'workspace' }),
      ]),
    ).toBeNull();
    expect(
      safeAggregateUsdSpend([
        snapshot('one', { usageValue: 2.5, usageUnit: 'usd' }),
        snapshot('two', { usageValue: 3, usageUnit: 'usd' }),
      ]),
    ).toBeNull();
  });

  it('reconciles only comparable provider and local measurements', () => {
    expect(
      reconcileProviderAndLocalUsage({
        providerValue: 100,
        providerUnit: 'tokens',
        localValue: 100.5,
        localUnit: 'tokens',
      }),
    ).toBe('matched');
    expect(
      reconcileProviderAndLocalUsage({
        providerValue: 120,
        providerUnit: 'tokens',
        localValue: 100,
        localUnit: 'tokens',
      }),
    ).toBe('provider_ahead');
    expect(
      reconcileProviderAndLocalUsage({
        providerValue: 90,
        providerUnit: 'tokens',
        localValue: 100,
        localUnit: 'tokens',
      }),
    ).toBe('local_ahead');
    expect(
      reconcileProviderAndLocalUsage({
        providerValue: 10,
        providerUnit: 'usd',
        localValue: 10,
        localUnit: 'tokens',
      }),
    ).toBe('not_comparable');
  });
});
