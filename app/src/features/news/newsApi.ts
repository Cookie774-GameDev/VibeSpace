import type { NewsItem, NewsKind } from './newsCatalog';

export type LiveMediaType = 'image' | 'video' | 'none';

export interface LiveNewsItem extends NewsItem {
  platform: string;
  verification: 'official' | 'confirmed';
  company?: string;
  category?: string;
  videoUrl?: string;
  mediaType: LiveMediaType;
  mediaSource?: string;
  sourceReferences?: Array<{ name: string; url: string; platform?: string }>;
}

export interface LiveNewsResponse {
  freeOnly: true;
  generatedAt?: string;
  lastCompletedAt?: string;
  freshness?: {
    state: 'fresh' | 'stale' | 'degraded' | 'failed' | 'never';
    ageMs?: number;
    warning?: string;
  };
  items: LiveNewsItem[];
}

type FetchLike = typeof fetch;
export const DEFAULT_NEWS_API_URL = 'https://vibespace-ai-news.vibespace-viper.workers.dev';

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
  return value.trim();
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function requiredId(record: Record<string, unknown>): string {
  const value = record.id;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new Error('AI news response is malformed.');
  }
  return String(value);
}

function requiredIsoTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!/^\d{4}-\d{2}-\d{2}T/i.test(value) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw new Error('AI news response discarded publication time precision.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('AI news response is malformed.');
  return new Date(timestamp).toISOString();
}

function optionalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, 12);
}

function parseSourceReferences(value: unknown): LiveNewsItem['sourceReferences'] {
  if (!Array.isArray(value)) return undefined;
  const references = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const name = optionalString(record, 'name', 'sourceName');
    const url = safeHttpsUrl(record.url ?? record.sourceUrl);
    if (!name || !url) return [];
    return [
      {
        name,
        url,
        ...(typeof record.platform === 'string' ? { platform: record.platform } : {}),
      },
    ];
  });
  return references.length ? references : undefined;
}

function youtubeIdForUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0];
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') ?? undefined;
      const match = /^\/(?:shorts|embed)\/([^/?#]+)/.exec(url.pathname);
      return match?.[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function kindForItem(category: string, mediaType: LiveMediaType, youtubeId?: string): NewsKind {
  if (mediaType === 'video' || youtubeId) return 'youtube';
  return /model|release|launch/i.test(category) ? 'model_drop' : 'ai_news';
}

function plainText(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, '$1')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&([a-z]+);/giu, (entity, name: string) => namedEntities[name.toLowerCase()] ?? entity)
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseFreshness(value: unknown): LiveNewsResponse['freshness'] {
  if (value === undefined) return undefined;
  const freshness = asRecord(value);
  const state = freshness.state;
  if (!['fresh', 'stale', 'degraded', 'failed', 'never'].includes(String(state))) {
    throw new Error('AI news response is malformed.');
  }
  if (
    freshness.ageMs !== undefined &&
    (typeof freshness.ageMs !== 'number' ||
      !Number.isFinite(freshness.ageMs) ||
      freshness.ageMs < 0)
  ) {
    throw new Error('AI news response is malformed.');
  }
  if (freshness.warning !== undefined && typeof freshness.warning !== 'string') {
    throw new Error('AI news response is malformed.');
  }
  return {
    state: state as NonNullable<LiveNewsResponse['freshness']>['state'],
    ...(typeof freshness.ageMs === 'number' ? { ageMs: freshness.ageMs } : {}),
    ...(typeof freshness.warning === 'string' ? { warning: freshness.warning } : {}),
  };
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
    const sourceUrl = safeHttpsUrl(item.url ?? item.sourceUrl);
    if (!sourceUrl) throw new Error('AI news response is malformed.');

    const videoUrl = safeHttpsUrl(item.videoUrl ?? item.video_url);
    let imageUrl = safeHttpsUrl(item.imageUrl ?? item.image_url);
    const explicitMediaType = optionalString(item, 'mediaType', 'media_type');
    const youtubeId = youtubeIdForUrl(videoUrl ?? sourceUrl);
    if (!imageUrl && youtubeId) imageUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
    const mediaType: LiveMediaType =
      explicitMediaType === 'video' || videoUrl || youtubeId
        ? 'video'
        : explicitMediaType === 'image' || imageUrl
          ? 'image'
          : 'none';
    const imageCredit =
      optionalString(item, 'imageCredit', 'image_credit') ??
      (youtubeId && imageUrl ? `Official YouTube thumbnail · ${source}` : '');
    const mediaSource = optionalString(item, 'mediaSource', 'media_source');
    const company = optionalString(item, 'company');
    const modelNames = readStringArray(item.modelNames ?? item.model_names);
    const tags = [...new Set([platform, verification, category, company, ...modelNames].filter(Boolean))] as string[];
    const sourceReferences = parseSourceReferences(item.sourceReferences ?? item.source_references);

    return {
      id: requiredId(item),
      title: requiredString(item, 'title'),
      summary: plainText(requiredString(item, 'summary')),
      url: sourceUrl,
      publishedAt: requiredIsoTimestamp(item, 'publishedAt'),
      source,
      platform,
      verification,
      ...(company ? { company } : {}),
      category,
      kind: kindForItem(category, mediaType, youtubeId),
      imageUrl: imageUrl ?? '',
      imageCredit,
      credit: `${verification === 'official' ? 'Official source' : 'Confirmed source'} · ${source}`,
      ...(youtubeId ? { youtubeId } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      mediaType,
      ...(mediaSource ? { mediaSource } : {}),
      ...(sourceReferences ? { sourceReferences } : {}),
      tags,
    };
  });

  const generatedAt = optionalIsoTimestamp(root.generatedAt);
  const latestRun =
    root.latestRun && typeof root.latestRun === 'object' && !Array.isArray(root.latestRun)
      ? (root.latestRun as Record<string, unknown>)
      : undefined;
  const lastCompletedAt = optionalIsoTimestamp(root.lastCompletedAt ?? latestRun?.completed_at);

  return {
    freeOnly: true,
    ...(generatedAt ? { generatedAt } : {}),
    ...(lastCompletedAt ? { lastCompletedAt } : {}),
    freshness: parseFreshness(root.freshness),
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
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : DEFAULT_NEWS_API_URL;
}
