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
    const disabledSites = disabled.filter((source) => source.sourceType === 'official_site');
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabledSites.length).toBeGreaterThan(0);
    expect(disabled.every((source) => Boolean(source.disabledReason))).toBe(true);
  });

  it('selects a bounded deterministic hourly set with free model-release sources and no X by default', () => {
    const first = selectNewsSourcesForRun('2026-08-14T23:07:00Z');
    const repeated = selectNewsSourcesForRun('2026-08-14T23:07:00Z');
    expect(first).toEqual(repeated);
    expect(first.length).toBeLessThanOrEqual(24);
    expect(first.filter((source) => source.sourceType === 'x')).toEqual([]);
    expect(first.some((source) => source.sourceType === 'github_releases')).toBe(true);
    expect(first.some((source) => source.id === 'anthropic-news')).toBe(true);
    expect(new Set(first.map((source) => source.id)).size).toBe(first.length);
    expect(selectNewsSourcesForRun('2026-08-14T23:07:00Z', { maxSources: 20 })).toHaveLength(20);
  });

  it('reserves the requested optional X slots without displacing hourly model releases', () => {
    const selected = selectNewsSourcesForRun('2026-08-14T23:07:00Z', { maxX: 2 });
    expect(selected).toHaveLength(24);
    expect(selected.filter((source) => source.sourceType === 'x')).toHaveLength(2);
    expect(
      selected.filter((source) => source.sourceType === 'github_releases').length,
    ).toBeGreaterThan(0);
  });

  it('uses five to ten approved YouTube feeds with stable channel IDs', () => {
    const channels = NEWS_SOURCES.filter((source) => source.sourceType === 'youtube_feed');
    expect(channels.length).toBeGreaterThanOrEqual(5);
    expect(channels.length).toBeLessThanOrEqual(10);
    for (const channel of channels) {
      expect(channel.endpoint).toMatch(
        /^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=UC[A-Za-z0-9_-]{22}$/u,
      );
      expect(channel.officialSite).toMatch(/^https:\/\/www\.youtube\.com\/@/u);
    }
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
