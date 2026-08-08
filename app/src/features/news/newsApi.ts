import type { NewsItem, NewsKind } from './newsCatalog';

export interface LiveNewsItem extends NewsItem {
  platform: string;
  verification: 'official' | 'confirmed';
  company?: string;
  category?: string;
}

export interface LiveNewsResponse {
  freeOnly: true;
  generatedAt?: string;
  lastCompletedAt?: string;
  items: LiveNewsItem[];
}

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI news response is malformed.');
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('AI news response is malformed.');
  }
  return value;
}

function kindForCategory(category: string): NewsKind {
  return /model|release|launch/i.test(category) ? 'model_drop' : 'ai_news';
}

export function parseNewsResponse(payload: unknown): LiveNewsResponse {
  const root = asRecord(payload);
  if (root.freeOnly !== true) {
    throw new Error('AI news endpoint did not declare a free-only data path.');
  }
  if (!Array.isArray(root.items)) {
    throw new Error('AI news response is malformed.');
  }

  const items = root.items.map((raw): LiveNewsItem => {
    const item = asRecord(raw);
    const nestedSource =
      item.source && typeof item.source === 'object' && !Array.isArray(item.source)
        ? (item.source as Record<string, unknown>)
        : undefined;
    const source = nestedSource
      ? requiredString(nestedSource, 'name')
      : requiredString(item, 'sourceName');
    const platform = nestedSource
      ? requiredString(nestedSource, 'platform')
      : requiredString(item, 'sourcePlatform');
    const verification = requiredString(item, 'verification');
    if (verification !== 'official' && verification !== 'confirmed') {
      throw new Error('AI news response is malformed.');
    }
    const category = requiredString(item, 'category');
    return {
      id: requiredString(item, 'id'),
      title: requiredString(item, 'title'),
      summary: requiredString(item, 'summary'),
      url: requiredString(item, 'url'),
      publishedAt: requiredString(item, 'publishedAt').slice(0, 10),
      source,
      platform,
      verification,
      company: typeof item.company === 'string' ? item.company : undefined,
      category,
      kind: kindForCategory(category),
      imageUrl: '',
      imageCredit: '',
      credit: `${verification === 'official' ? 'Official source' : 'Confirmed source'} · ${source}`,
      tags: [platform, verification, category].filter(Boolean),
    };
  });

  return {
    freeOnly: true,
    generatedAt: typeof root.generatedAt === 'string' ? root.generatedAt : undefined,
    lastCompletedAt:
      typeof root.lastCompletedAt === 'string'
        ? root.lastCompletedAt
        : typeof (root.latestRun as Record<string, unknown> | undefined)?.completed_at === 'string'
          ? String((root.latestRun as Record<string, unknown>).completed_at)
          : undefined,
    items,
  };
}

export async function fetchLiveNews(
  origin: string,
  { fetcher = fetch, timeoutMs = 8_000 }: { fetcher?: FetchLike; timeoutMs?: number } = {},
): Promise<LiveNewsResponse> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('/api/news?limit=50', origin);
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`AI news request failed (${response.status}).`);
    return parseNewsResponse(await response.json());
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function configuredNewsApiUrl(): string | null {
  const value = import.meta.env.VITE_NEWS_API_URL;
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}
