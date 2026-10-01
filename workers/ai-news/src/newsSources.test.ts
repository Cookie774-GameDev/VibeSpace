import { describe, expect, it } from 'vitest';
import { NEWS_SOURCES, selectNewsSourcesForRun, validateNewsSourceRegistry } from './newsSources';

describe('AI news source registry', () => {
  it('contains 50-100 reviewable high-value sources with unique official identities', () => {
    const result = validateNewsSourceRegistry();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.sourceCount).toBeGreaterThanOrEqual(50);
    expect(result.sourceCount).toBeLessThanOrEqual(100);
    expect(result.enabledCount).toBeGreaterThanOrEqual(40);
  });

  it('keeps unsupported official sites explicit rather than silently scraping them', () => {
    const disabled = NEWS_SOURCES.filter((source) => !source.enabled);
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.every((source) => source.sourceType === 'official_site')).toBe(true);
    expect(disabled.every((source) => Boolean(source.disabledReason))).toBe(true);
  });

  it('selects a bounded deterministic hourly set with no more than two X sources', () => {
    const first = selectNewsSourcesForRun('2026-08-14T23:07:00Z');
    const repeated = selectNewsSourcesForRun('2026-08-14T23:07:00Z');
    expect(first).toEqual(repeated);
    expect(first.length).toBeLessThanOrEqual(24);
    expect(first.filter((source) => source.sourceType === 'x').length).toBeLessThanOrEqual(2);
    expect(new Set(first.map((source) => source.id)).size).toBe(first.length);
  });

  it('rotates long-tail sources across clock hours while retaining core feeds', () => {
    const first = selectNewsSourcesForRun('2026-08-14T22:07:00Z');
    const next = selectNewsSourcesForRun('2026-08-14T23:07:00Z');
    const firstIds = new Set(first.map((source) => source.id));
    const nextIds = new Set(next.map((source) => source.id));
    expect(firstIds.has('openai-news')).toBe(true);
    expect(nextIds.has('openai-news')).toBe(true);
    expect([...firstIds].some((id) => !nextIds.has(id))).toBe(true);
  });
});
