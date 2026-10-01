import { describe, expect, it } from 'vitest';
import {
  evaluateFreshness,
  formatFreshnessFooter,
  hoursForBudgetUsd,
  parseIsoDateUtc,
  tokensPerMillionCostUsd,
  usdPerHourFromPerMinute,
  type DynamicDataMeta,
} from './freshness';
import {
  COST_RATES_META,
  DEEPGRAM_PRICING_META,
  DYNAMIC_DATA_SURFACES,
  evaluateAllSurfaces,
  getDynamicDataSurface,
  listStaleOrUnverifiedSurfaces,
} from './registry';

const sample: DynamicDataMeta = {
  id: 'sample',
  lastUpdated: '2026-08-01',
  sourceUrl: 'https://example.com/pricing',
  sourceKind: 'official_docs',
  staleAfterDays: 30,
};

describe('dynamic data freshness', () => {
  it('parses ISO calendar dates as UTC midnight', () => {
    expect(parseIsoDateUtc('2026-08-01')).toBe(Date.UTC(2026, 7, 1));
    expect(parseIsoDateUtc('not-a-date')).toBeNull();
  });

  it('labels data current only inside the stale window', () => {
    const current = evaluateFreshness(sample, new Date('2026-08-15T12:00:00Z'));
    expect(current.status).toBe('current');
    expect(current.isCurrent).toBe(true);

    const stale = evaluateFreshness(sample, new Date('2026-09-05T00:00:00Z'));
    expect(stale.status).toBe('stale');
    expect(stale.isCurrent).toBe(false);
  });

  it('never labels a failed refresh as current even when age is fresh', () => {
    const failed = evaluateFreshness(sample, new Date('2026-08-02T00:00:00Z'), {
      refreshFailed: true,
    });
    expect(failed.status).toBe('refresh_failed');
    expect(failed.isCurrent).toBe(false);
    expect(formatFreshnessFooter(failed)).toMatch(/not confirmed current/i);
  });

  it('marks snapshot fallback distinctly from live current data', () => {
    const fallback = evaluateFreshness(sample, new Date('2026-08-02T00:00:00Z'), {
      usingSnapshotFallback: true,
    });
    expect(fallback.status).toBe('snapshot_fallback');
    expect(fallback.isCurrent).toBe(false);
  });

  it('converts minute pricing to hours-for-budget without inventing rates', () => {
    expect(usdPerHourFromPerMinute(0.0048)).toBeCloseTo(0.288, 6);
    expect(hoursForBudgetUsd(0.0048, 10)).toBeCloseTo(34.7222, 3);
    expect(hoursForBudgetUsd(0, 10)).toBe(0);
    expect(hoursForBudgetUsd(0.0048, -1)).toBe(0);
  });

  it('computes token cost with unit conversion to per-million rates', () => {
    // 1M in + 1M out at $3 / $15 → $18
    expect(tokensPerMillionCostUsd(1_000_000, 1_000_000, 3, 15)).toBe(18);
    expect(tokensPerMillionCostUsd(500_000, 0, 2, 10)).toBe(1);
    // Non-finite input tokens are treated as 0; valid output still counts.
    expect(tokensPerMillionCostUsd(Number.NaN, 100, 1, 1)).toBeCloseTo(0.0001, 8);
    expect(tokensPerMillionCostUsd(Number.NaN, Number.NaN, 1, 1)).toBe(0);
  });
});

describe('dynamic data registry', () => {
  it('inventories required launch-critical surfaces', () => {
    const ids = DYNAMIC_DATA_SURFACES.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'deepgram-stt-pricing',
        'llm-cost-rates',
        'chat-model-catalog',
        'provider-model-dynamic-listing',
        'local-model-catalog',
        'benchmark-leaderboard',
        'benchmark-list-price-catalog',
        'hive-frontier-model-ids',
        'ai-news-catalog',
        'subscription-plan-pricing',
        'provider-connectivity-metadata',
        'provider-usage-limits',
        'composer-stt-catalog',
      ]),
    );
    expect(getDynamicDataSurface('deepgram-stt-pricing')?.module).toContain('deepgram/catalog');
  });

  it('exposes last-updated metadata for cost rates and deepgram', () => {
    expect(COST_RATES_META.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEEPGRAM_PRICING_META.sourceUrl).toContain('deepgram.com/pricing');
  });

  it('flags stale embedded catalogs relative to a far-future now', () => {
    const farFuture = new Date('2030-01-01T00:00:00Z');
    const stale = listStaleOrUnverifiedSurfaces(farFuture);
    expect(stale.some((s) => s.id === 'llm-cost-rates')).toBe(true);
    expect(stale.some((s) => s.id === 'deepgram-stt-pricing')).toBe(true);
  });

  it('keeps realtime surfaces out of the stale list when age is zero-threshold', () => {
    const results = evaluateAllSurfaces(new Date('2026-08-02T00:00:00Z'));
    const realtime = results.find((r) => r.surface.id === 'provider-connectivity-metadata');
    expect(realtime?.surface.staleAfterDays).toBe(0);
  });
});
