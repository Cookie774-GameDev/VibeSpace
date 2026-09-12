/** Pure local-calendar helpers for the offline and live news feeds. */
import {
  NEWS_CATALOG,
  type NewsItem,
  type NewsKind,
  type NewsSectionId,
} from './newsCatalog';

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse either a static YYYY-MM-DD day or a full timezone-aware ISO timestamp. */
export function parseNewsDay(value: string): Date {
  const day = ISO_DAY.exec(value.trim());
  if (day) {
    return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12, 0, 0, 0);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(NaN);
}

/** Format a Date as YYYY-MM-DD in the user's local calendar. */
export function toIsoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localDayOrdinal(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** Calendar-day delta (b - a) in the user's local timezone. */
export function daysBetween(isoA: string, isoB: string): number {
  const a = parseNewsDay(isoA);
  const b = parseNewsDay(isoB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Number.NaN;
  return localDayOrdinal(b) - localDayOrdinal(a);
}

function resolveReferenceDate(today: string | Date): Date {
  return typeof today === 'string' ? parseNewsDay(today) : today;
}

/**
 * - Today: same user-local calendar date.
 * - Last week: one through seven preceding local calendar dates.
 * - More: older, future, or invalid.
 */
export function sectionForItem(
  item: Pick<NewsItem, 'publishedAt'>,
  today: string | Date,
): NewsSectionId {
  const published = parseNewsDay(item.publishedAt);
  const reference = resolveReferenceDate(today);
  if (Number.isNaN(published.getTime()) || Number.isNaN(reference.getTime())) return 'more';
  const delta = localDayOrdinal(reference) - localDayOrdinal(published);
  if (delta === 0) return 'today';
  if (delta >= 1 && delta <= 7) return 'last_week';
  return 'more';
}

export interface NewsFeedOptions {
  /** Override "today" for tests. Defaults to current local calendar day. */
  now?: Date;
  /** Optional kind filter. */
  kind?: NewsKind | 'all';
  catalog?: readonly NewsItem[];
}

export function resolveTodayIso(now: Date = new Date()): string {
  return toIsoDay(now);
}

export function groupNewsBySection<T extends Pick<NewsItem, 'publishedAt'>>(
  items: readonly T[],
  now: Date = new Date(),
): Record<NewsSectionId, T[]> {
  return items.reduce<Record<NewsSectionId, T[]>>(
    (grouped, item) => {
      grouped[sectionForItem(item, now)].push(item);
      return grouped;
    },
    { today: [], last_week: [], more: [] },
  );
}

export function getNewsFeed(section: NewsSectionId, options: NewsFeedOptions = {}): NewsItem[] {
  const catalog = options.catalog ?? NEWS_CATALOG;
  const now = options.now ?? new Date();
  const kind = options.kind ?? 'all';

  return catalog
    .filter((item) => sectionForItem(item, now) === section)
    .filter((item) => kind === 'all' || item.kind === kind)
    .slice()
    .sort((a, b) => {
      const byDate = parseNewsDay(b.publishedAt).getTime() - parseNewsDay(a.publishedAt).getTime();
      if (Number.isFinite(byDate) && byDate !== 0) return byDate;
      return a.title.localeCompare(b.title);
    });
}

export function countNewsBySection(options: NewsFeedOptions = {}): Record<NewsSectionId, number> {
  return {
    today: getNewsFeed('today', options).length,
    last_week: getNewsFeed('last_week', options).length,
    more: getNewsFeed('more', options).length,
  };
}

/** Date-only snapshots stay date-only; live timestamps include local time. */
export function formatNewsDate(value: string, locale?: string): string {
  const date = parseNewsDay(value);
  if (Number.isNaN(date.getTime())) return value;
  if (ISO_DAY.test(value.trim())) {
    return date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
