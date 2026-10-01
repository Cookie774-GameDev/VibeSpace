import { nativeFetch } from '@/lib/nativeFetch';
import { DEFAULT_NEWS_API_URL } from '@/features/news/newsApi';
import type { BenchmarkRow } from './benchmarkData';

export type NewsVerification = 'official' | 'confirmed';

export interface NewsApiItem {
  id?: number | string;
  title: string;
  summary?: string;
  url: string;
  source?: {
    platform?: string;
    name?: string;
  };
  company?: string | null;
  modelNames?: unknown;
  category?: string;
  verification?: string;
  importance?: number;
  publishedAt?: string;
  collectedAt?: string;
}

interface NewsApiResponse {
  generatedAt?: string;
  items?: unknown;
  freshness?: {
    state?: unknown;
  };
}

export interface NewsModelRelease {
  modelName: string;
  title: string;
  summary: string;
  url: string;
  company?: string;
  sourceName: string;
  sourcePlatform: string;
  verification: NewsVerification;
  importance: number;
  publishedAt: number;
}

export interface NewsBenchmarkPosition {
  position: 1 | 2;
  modelName: string;
  row: BenchmarkRow | null;
  status: 'leaderboard-match' | 'benchmark-pending';
}

export interface NewsBenchmarkPair {
  release: NewsModelRelease;
  primary: NewsBenchmarkPosition & { position: 1 };
  secondary: (NewsBenchmarkPosition & { position: 2; row: BenchmarkRow }) | null;
  comparisonReason: 'same-family' | 'same-provider' | 'leaderboard-leader' | 'none';
  selectedAt: number;
}

export type NewsBenchmarkDiscovery =
  | { status: 'unconfigured' }
  | { status: 'empty' }
  | { status: 'ready'; pair: NewsBenchmarkPair; stale?: boolean }
  | { status: 'error'; message: string; stalePair?: NewsBenchmarkPair };

const CACHE_KEY = 'vibespace-news-benchmark-pair-v1';
const CACHE_TTL_MS = 60 * 60 * 1000;
const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

let memoryCache: { endpoint: string; pair: NewsBenchmarkPair; cachedAt: number } | null = null;
type NewsReleaseFetch =
  | { status: 'empty' }
  | { status: 'ready'; release: NewsModelRelease; stale: boolean };
const inFlightByEndpoint = new Map<string, Promise<NewsReleaseFetch>>();

export function resolveNewsApiUrl(explicitUrl?: string | null): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const value = explicitUrl ?? env?.VITE_NEWS_API_URL ?? DEFAULT_NEWS_API_URL;
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

export function pickLatestModelRelease(items: unknown): NewsModelRelease | null {
  if (!Array.isArray(items)) return null;

  const candidates = items.flatMap((entry): NewsModelRelease[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as NewsApiItem;
    if (typeof item.title !== 'string' || typeof item.url !== 'string') return [];
    if (item.category !== 'model-release') return [];
    if (item.verification !== 'official' && item.verification !== 'confirmed') return [];

    const modelNames = Array.isArray(item.modelNames)
      ? item.modelNames.filter((name): name is string => typeof name === 'string')
      : [];
    const modelName = selectBestModelName(modelNames);
    if (!modelName) return [];

    const publishedAt = Date.parse(item.publishedAt ?? '');
    if (!Number.isFinite(publishedAt)) return [];

    return [
      {
        modelName,
        title: item.title.trim(),
        summary: typeof item.summary === 'string' ? item.summary.trim() : '',
        url: item.url,
        company: typeof item.company === 'string' ? item.company.trim() || undefined : undefined,
        sourceName: item.source?.name?.trim() || 'AI News',
        sourcePlatform: item.source?.platform?.trim() || 'media',
        verification: item.verification,
        importance:
          typeof item.importance === 'number' && Number.isFinite(item.importance)
            ? item.importance
            : 0,
        publishedAt,
      },
    ];
  });

  candidates.sort((left, right) => {
    const publishedDelta = right.publishedAt - left.publishedAt;
    if (publishedDelta !== 0) return publishedDelta;
    const verificationDelta =
      verificationWeight(right.verification) - verificationWeight(left.verification);
    if (verificationDelta !== 0) return verificationDelta;
    const importanceDelta = right.importance - left.importance;
    if (importanceDelta !== 0) return importanceDelta;
    const modelDelta = normalizeModelName(left.modelName).localeCompare(
      normalizeModelName(right.modelName),
      'en',
    );
    if (modelDelta !== 0) return modelDelta;
    return left.url.localeCompare(right.url, 'en');
  });

  return candidates[0] ?? null;
}

export function selectNewsBenchmarkPair(
  release: NewsModelRelease,
  rows: readonly BenchmarkRow[],
  selectedAt = Date.now(),
): NewsBenchmarkPair {
  const primaryRow = findLeaderboardMatch(release.modelName, rows);
  const provider = companyToProvider(release.company);
  const family = modelFamily(release.modelName);

  const secondarySelection = selectSecondaryRow({
    releaseModelName: release.modelName,
    primaryRow,
    provider,
    family,
    rows,
  });

  return {
    release,
    primary: {
      position: 1,
      modelName: release.modelName,
      row: primaryRow,
      status: primaryRow ? 'leaderboard-match' : 'benchmark-pending',
    },
    secondary: secondarySelection.row
      ? {
          position: 2,
          modelName: secondarySelection.row.model,
          row: secondarySelection.row,
          status: 'leaderboard-match',
        }
      : null,
    comparisonReason: secondarySelection.reason,
    selectedAt,
  };
}

export async function discoverNewsBenchmarkPair(
  rows: readonly BenchmarkRow[],
  options?: { force?: boolean; newsApiUrl?: string | null },
): Promise<NewsBenchmarkDiscovery> {
  const endpoint = resolveNewsApiUrl(options?.newsApiUrl);
  if (!endpoint) return { status: 'unconfigured' };

  if (!options?.force) {
    const cached = readCache(endpoint);
    if (cached && Date.now() - cached.cachedAt <= CACHE_TTL_MS) {
      return { status: 'ready', pair: remapCachedPair(cached.pair, rows) };
    }
  }
  try {
    const fetched = await fetchNewsRelease(endpoint);
    if (fetched.status === 'empty') return fetched;
    const pair = selectNewsBenchmarkPair(fetched.release, rows);
    writeCache(endpoint, pair);
    return { status: 'ready', pair, stale: fetched.stale };
  } catch (error) {
    const cached = readCache(endpoint);
    const stalePair =
      cached && Date.now() - cached.cachedAt <= STALE_CACHE_MAX_AGE_MS
        ? remapCachedPair(cached.pair, rows)
        : undefined;
    return { status: 'error', message: boundedNewsDiscoveryError(error), stalePair };
  }
}

async function fetchNewsRelease(endpoint: string): Promise<NewsReleaseFetch> {
  const existing = inFlightByEndpoint.get(endpoint);
  if (existing) return existing;
  const task = (async (): Promise<NewsReleaseFetch> => {
    const response = await nativeFetch(`${endpoint}/api/news?category=model-release&limit=40`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`News API returned HTTP ${response.status}`);
    const payload = (await response.json()) as NewsApiResponse;
    const release = pickLatestModelRelease(payload.items);
    return release
      ? { status: 'ready', release, stale: isRetainedNewsPayload(payload) }
      : { status: 'empty' };
  })();
  inFlightByEndpoint.set(endpoint, task);
  try {
    return await task;
  } finally {
    if (inFlightByEndpoint.get(endpoint) === task) inFlightByEndpoint.delete(endpoint);
  }
}

export function clearNewsBenchmarkCache(): void {
  memoryCache = null;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // The feature remains usable without persistent cache access.
  }
}

function selectBestModelName(names: readonly string[]): string | null {
  const candidates = names
    .map(cleanModelName)
    .filter((name): name is string => Boolean(name))
    .sort((left, right) => {
      const specificityDelta = modelNameSpecificity(right) - modelNameSpecificity(left);
      return (
        specificityDelta || normalizeModelName(left).localeCompare(normalizeModelName(right), 'en')
      );
    });
  return candidates[0] ?? null;
}

function cleanModelName(value: string): string | null {
  const trimmed = value
    .replace(/[|,:;!?()[\]{}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed || trimmed.length > 100) return null;

  const stopWords = new Set([
    'is',
    'are',
    'has',
    'have',
    'brings',
    'launches',
    'launched',
    'released',
    'available',
    'arrives',
    'for',
    'with',
    'now',
    'and',
    'the',
    'a',
    'an',
  ]);
  const words = trimmed.split(' ');
  const cutoff = words.findIndex((word, index) => index > 0 && stopWords.has(word.toLowerCase()));
  const compact = (cutoff > 0 ? words.slice(0, cutoff) : words).join(' ').trim();
  return compact || null;
}

function modelNameSpecificity(value: string): number {
  let score = value.length;
  if (/\d/.test(value)) score += 40;
  if (/\b(opus|sonnet|haiku|pro|flash|mini|max|coder|reasoner|vision|vl)\b/i.test(value)) {
    score += 15;
  }
  return score;
}

function verificationWeight(value: NewsVerification): number {
  return value === 'official' ? 2 : 1;
}

function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function modelFamily(value: string): string | null {
  const normalized = normalizeModelName(value);
  const families = [
    'gpt',
    'claude',
    'gemini',
    'grok',
    'deepseek',
    'qwen',
    'mistral',
    'llama',
    'kimi',
    'minimax',
    'gemma',
    'phi',
    'command',
    'glm',
    'ollama',
  ];
  return families.find((family) => normalized.includes(family)) ?? normalized.split(' ')[0] ?? null;
}

function numericTokens(value: string): string[] {
  return normalizeModelName(value).match(/\d+/g) ?? [];
}

function findLeaderboardMatch(
  modelName: string,
  rows: readonly BenchmarkRow[],
): BenchmarkRow | null {
  const target = normalizeModelName(modelName);
  const targetFamily = modelFamily(modelName);
  const targetNumbers = numericTokens(modelName);
  let best: { row: BenchmarkRow; score: number } | null = null;

  for (const row of rows) {
    const candidate = normalizeModelName(row.model);
    if (!candidate || modelFamily(row.model) !== targetFamily) continue;

    let score = 0;
    if (candidate === target) score = 100;
    else if (candidate.includes(target) || target.includes(candidate)) score = 82;
    else {
      const targetTokens = new Set(target.split(' '));
      const candidateTokens = new Set(candidate.split(' '));
      const overlap = [...targetTokens].filter((token) => candidateTokens.has(token)).length;
      const union = new Set([...targetTokens, ...candidateTokens]).size;
      score = union > 0 ? (overlap / union) * 70 : 0;
    }

    const candidateNumbers = numericTokens(row.model);
    if (targetNumbers.length && candidateNumbers.length) {
      const numberOverlap = targetNumbers.filter((token) =>
        candidateNumbers.includes(token),
      ).length;
      if (numberOverlap === 0) score -= 50;
      else score += numberOverlap * 6;
    }

    if (
      score >= 78 &&
      (!best ||
        score > best.score ||
        (score === best.score && row.arena_score > best.row.arena_score) ||
        (score === best.score &&
          row.arena_score === best.row.arena_score &&
          normalizeModelName(row.model).localeCompare(normalizeModelName(best.row.model), 'en') <
            0))
    ) {
      best = { row, score };
    }
  }

  return best?.row ?? null;
}

function selectSecondaryRow(input: {
  releaseModelName: string;
  primaryRow: BenchmarkRow | null;
  provider: string | null;
  family: string | null;
  rows: readonly BenchmarkRow[];
}): { row: BenchmarkRow | null; reason: NewsBenchmarkPair['comparisonReason'] } {
  const primaryKey = normalizeModelName(input.primaryRow?.model ?? input.releaseModelName);
  const candidates = input.rows.filter((row) => normalizeModelName(row.model) !== primaryKey);
  if (!candidates.length) return { row: null, reason: 'none' };

  const ranked = candidates
    .map((row) => {
      const sameFamily = Boolean(input.family && modelFamily(row.model) === input.family);
      const sameProvider = Boolean(input.provider && row.provider === input.provider);
      const priority = (sameFamily ? 2_000 : 0) + (sameProvider ? 1_000 : 0) + row.arena_score;
      return { row, sameFamily, sameProvider, priority };
    })
    .sort((left, right) => {
      const priorityDelta = right.priority - left.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return normalizeModelName(left.row.model).localeCompare(
        normalizeModelName(right.row.model),
        'en',
      );
    });

  const winner = ranked[0];
  if (!winner) return { row: null, reason: 'none' };
  return {
    row: winner.row,
    reason: winner.sameFamily
      ? 'same-family'
      : winner.sameProvider
        ? 'same-provider'
        : 'leaderboard-leader',
  };
}

function companyToProvider(company?: string): string | null {
  const value = company?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('openai')) return 'openai';
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('google') || value.includes('deepmind')) return 'google';
  if (value.includes('xai')) return 'xai';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('mistral')) return 'mistral';
  if (value.includes('alibaba') || value.includes('qwen')) return 'alibaba';
  if (value.includes('meta')) return 'meta';
  if (value.includes('moonshot') || value.includes('kimi')) return 'moonshot';
  if (value.includes('minimax')) return 'minimax';
  if (value.includes('nvidia')) return 'nvidia';
  if (value.includes('hugging face')) return 'huggingface';
  if (value.includes('ollama')) return 'ollama';
  return value.replace(/[^a-z0-9]+/g, '');
}

function remapCachedPair(
  pair: NewsBenchmarkPair,
  rows: readonly BenchmarkRow[],
): NewsBenchmarkPair {
  return selectNewsBenchmarkPair(pair.release, rows, pair.selectedAt);
}

function readCache(
  endpoint: string,
): { endpoint: string; pair: NewsBenchmarkPair; cachedAt: number } | null {
  if (memoryCache?.endpoint === endpoint) return memoryCache;
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      endpoint?: unknown;
      pair?: unknown;
      cachedAt?: unknown;
    };
    if (parsed.endpoint !== endpoint || typeof parsed.cachedAt !== 'number' || !parsed.pair) {
      return null;
    }
    const value = parsed as {
      endpoint: string;
      pair: NewsBenchmarkPair;
      cachedAt: number;
    };
    memoryCache = value;
    return value;
  } catch {
    return null;
  }
}

function writeCache(endpoint: string, pair: NewsBenchmarkPair): void {
  const value = { endpoint, pair, cachedAt: Date.now() };
  memoryCache = value;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // The feature remains usable without persistent cache access.
  }
}

function isRetainedNewsPayload(payload: NewsApiResponse): boolean {
  const state = payload.freshness?.state;
  return state === 'stale' || state === 'degraded' || state === 'failed' || state === 'never';
}

function boundedNewsDiscoveryError(error: unknown): string {
  if (error instanceof Error) {
    const status = /^News API returned HTTP (\d{3})$/u.exec(error.message);
    if (status) return `News API returned HTTP ${status[1]}`;
  }
  return 'Benchmark Scout could not refresh the news feed.';
}
