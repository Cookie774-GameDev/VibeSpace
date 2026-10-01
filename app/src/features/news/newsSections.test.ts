import { describe, expect, it } from 'vitest';
import { NEWS_CATALOG, type NewsItem } from './newsCatalog';
import {
  countNewsBySection,
  daysBetween,
  formatNewsDate,
  getNewsFeed,
  sectionForItem,
  toIsoDay,
} from './newsSections';

const SAMPLE: NewsItem[] = [
  {
    id: 't',
    title: 'Today story',
    summary: 's',
    kind: 'ai_news',
    publishedAt: '2026-07-11',
    url: 'https://example.com/t',
    imageUrl: 'https://example.com/t.jpg',
    imageCredit: 'ex',
    source: 'Example',
    credit: 'Example',
  },
  {
    id: 'w',
    title: 'Week story',
    summary: 's',
    kind: 'model_drop',
    publishedAt: '2026-07-08',
    url: 'https://example.com/w',
    imageUrl: 'https://example.com/w.jpg',
    imageCredit: 'ex',
    source: 'Example',
    credit: 'Example',
  },
  {
    id: 'm',
    title: 'More story',
    summary: 's',
    kind: 'youtube',
    publishedAt: '2026-06-01',
    url: 'https://example.com/m',
    imageUrl: 'https://example.com/m.jpg',
    imageCredit: 'ex',
    source: 'Example',
    credit: 'Example',
    youtubeId: 'abc',
  },
];

describe('newsSections', () => {
  it('computes calendar day deltas', () => {
    expect(daysBetween('2026-07-08', '2026-07-11')).toBe(3);
    expect(daysBetween('2026-07-11', '2026-07-11')).toBe(0);
  });

  it('assigns sections relative to today', () => {
    expect(sectionForItem({ publishedAt: '2026-07-11' }, '2026-07-11')).toBe('today');
    expect(sectionForItem({ publishedAt: '2026-07-04' }, '2026-07-11')).toBe('last_week');
    expect(sectionForItem({ publishedAt: '2026-07-01' }, '2026-07-11')).toBe('more');
  });

  it('filters feed by section and kind', () => {
    const now = new Date(Date.UTC(2026, 6, 11, 12));
    const today = getNewsFeed('today', { now, catalog: SAMPLE });
    expect(today.map((i) => i.id)).toEqual(['t']);

    const week = getNewsFeed('last_week', { now, catalog: SAMPLE });
    expect(week.map((i) => i.id)).toEqual(['w']);

    const models = getNewsFeed('last_week', {
      now,
      catalog: SAMPLE,
      kind: 'model_drop',
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe('w');

    const counts = countNewsBySection({ now, catalog: SAMPLE });
    expect(counts).toEqual({ today: 1, last_week: 1, more: 1 });
  });

  it('formats dates in the user-local calendar', () => {
    expect(toIsoDay(new Date(2026, 6, 11, 12))).toBe('2026-07-11');
    expect(formatNewsDate('2026-07-09', 'en-US')).toMatch(/Jul/);
  });

  it('ships a real preloaded catalog with links, images, and credits', () => {
    expect(NEWS_CATALOG.length).toBeGreaterThanOrEqual(10);
    for (const item of NEWS_CATALOG) {
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.title.length).toBeGreaterThan(8);
      expect(item.summary.length).toBeGreaterThan(20);
      expect(item.url).toMatch(/^https:\/\//);
      expect(item.imageUrl).toMatch(/^https:\/\//);
      expect(item.imageCredit.length).toBeGreaterThan(2);
      expect(item.source.length).toBeGreaterThan(1);
      expect(item.credit.length).toBeGreaterThan(2);
      expect(item.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (item.kind === 'youtube') {
        expect(item.youtubeId?.length).toBeGreaterThan(5);
        expect(item.url).toMatch(/youtube\.com|youtu\.be/);
      }
    }

    // Relative to the curated week (2026-07-11), all three buckets have content.
    const now = new Date(Date.UTC(2026, 6, 11, 15));
    const counts = countNewsBySection({ now });
    expect(counts.today).toBeGreaterThan(0);
    expect(counts.last_week).toBeGreaterThan(0);
    expect(counts.more).toBeGreaterThan(0);
  });
});
