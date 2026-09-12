import { DEFAULT_NEWS_API_URL } from '@/features/news/newsApi';

export type BenchmarkFreshnessState = 'fresh' | 'degraded' | 'stale' | 'failed' | 'never';

export interface BenchmarkFreshness {
  state: BenchmarkFreshnessState;
  ageMs?: number;
  warning?: string;
}

export interface BenchmarkDatasetMetadata {
  source: 'Artificial Analysis';
  metric: 'Artificial Analysis Intelligence Index';
  sourceUrl: string;
  methodologyVersion?: string;
  sourceObservedAt: string;
  ingestedAt: string;
  rowCount: number;
  checksum?: string;
}

export interface BenchmarkModelRow {
  id: string;
  rank: number;
  provider: string;
  model: string;
  variantLabel?: string;
  effort?: string;
  intelligenceIndex: number;
  outputTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  endToEndSeconds?: number;
  inputPricePer1MTokensUsd?: number;
  outputPricePer1MTokensUsd?: number;
  cacheWritePricePer1MUsd?: number;
  cacheHitPricePer1MUsd?: number;
  costPerTaskUsd?: number;
  contextWindowTokens?: number;
  openWeights?: boolean;
  releaseDate?: string;
  sourceName: 'Artificial Analysis';
  sourceUrl: string;
  methodologyVersion?: string;
  sourceObservedAt: string;
  ingestedAt: string;
}

export interface BenchmarkApiResponse {
  generatedAt: string;
  freshness: BenchmarkFreshness;
  dataset: BenchmarkDatasetMetadata | null;
  rows: BenchmarkModelRow[];
}

export interface BenchmarkFetchResult extends BenchmarkApiResponse {
  fromCache: boolean;
}

type FetchLike = typeof fetch;

const CACHE_KEY = 'vibespace-benchmark-aa-v1';
const CACHE_VERSION = 1;
const LEGACY_CACHE_KEYS = [
  'jarvis-benchmark-cache',
  'jarvis-benchmark-cache-v3',
  'jarvis-benchmark-cache-v4',
  'jarvis-benchmark-cache-v5',
] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_INTELLIGENCE_INDEX = 199;

interface CacheEnvelope {
  version: number;
  cachedAt: string;
  payload: BenchmarkApiResponse;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Benchmark response is malformed.');
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Benchmark response is malformed.');
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Benchmark response is malformed.');
  }
  return value;
}

function optionalNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Benchmark response is malformed.');
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error('Benchmark response is malformed.');
  return value;
}

function isoTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Benchmark response is malformed.');
  return new Date(timestamp).toISOString();
}

function parseFreshness(value: unknown): BenchmarkFreshness {
  const record = asRecord(value);
  const state = requiredString(record, 'state');
  if (!['fresh', 'degraded', 'stale', 'failed', 'never'].includes(state)) {
    throw new Error('Benchmark response is malformed.');
  }
  const warning = optionalString(record, 'warning');
  return {
    state: state as BenchmarkFreshnessState,
    ...(record.ageMs !== undefined
      ? { ageMs: optionalNonNegativeNumber(record, 'ageMs') }
      : {}),
    ...(warning ? { warning } : {}),
  };
}

function parseDataset(value: unknown): BenchmarkDatasetMetadata | null {
  if (value === null) return null;
  const record = asRecord(value);
  if (requiredString(record, 'source') !== 'Artificial Analysis') {
    throw new Error('Benchmark source is not Artificial Analysis.');
  }
  if (requiredString(record, 'metric') !== 'Artificial Analysis Intelligence Index') {
    throw new Error('Benchmark metric is not the Artificial Analysis Intelligence Index.');
  }
  const rowCount = requiredNumber(record, 'rowCount');
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error('Benchmark response is malformed.');
  }
  return {
    source: 'Artificial Analysis',
    metric: 'Artificial Analysis Intelligence Index',
    sourceUrl: requiredString(record, 'sourceUrl'),
    sourceObservedAt: isoTimestamp(requiredString(record, 'sourceObservedAt')),
    ingestedAt: isoTimestamp(requiredString(record, 'ingestedAt')),
    rowCount,
    methodologyVersion: optionalString(record, 'methodologyVersion'),
    checksum: optionalString(record, 'checksum'),
  };
}

function parseRow(value: unknown): BenchmarkModelRow {
  const record = asRecord(value);
  const intelligenceIndex = requiredNumber(record, 'intelligenceIndex');
  if (intelligenceIndex < 0 || intelligenceIndex > MAX_INTELLIGENCE_INDEX) {
    throw new Error('Benchmark Intelligence Index is outside the supported source scale.');
  }
  const rank = requiredNumber(record, 'rank');
  if (!Number.isInteger(rank) || rank < 1) throw new Error('Benchmark response is malformed.');
  if (requiredString(record, 'sourceName') !== 'Artificial Analysis') {
    throw new Error('Benchmark row source is not Artificial Analysis.');
  }

  return {
    id: requiredString(record, 'id'),
    rank,
    provider: requiredString(record, 'provider'),
    model: requiredString(record, 'model'),
    variantLabel: optionalString(record, 'variantLabel'),
    effort: optionalString(record, 'effort'),
    intelligenceIndex,
    outputTokensPerSecond: optionalNonNegativeNumber(record, 'outputTokensPerSecond'),
    timeToFirstTokenSeconds: optionalNonNegativeNumber(record, 'timeToFirstTokenSeconds'),
    endToEndSeconds: optionalNonNegativeNumber(record, 'endToEndSeconds'),
    inputPricePer1MTokensUsd: optionalNonNegativeNumber(record, 'inputPricePer1MTokensUsd'),
    outputPricePer1MTokensUsd: optionalNonNegativeNumber(record, 'outputPricePer1MTokensUsd'),
    cacheWritePricePer1MUsd: optionalNonNegativeNumber(record, 'cacheWritePricePer1MUsd'),
    cacheHitPricePer1MUsd: optionalNonNegativeNumber(record, 'cacheHitPricePer1MUsd'),
    costPerTaskUsd: optionalNonNegativeNumber(record, 'costPerTaskUsd'),
    contextWindowTokens: optionalNonNegativeNumber(record, 'contextWindowTokens'),
    openWeights: optionalBoolean(record, 'openWeights'),
    releaseDate: optionalString(record, 'releaseDate'),
    sourceName: 'Artificial Analysis',
    sourceUrl: requiredString(record, 'sourceUrl'),
    methodologyVersion: optionalString(record, 'methodologyVersion'),
    sourceObservedAt: isoTimestamp(requiredString(record, 'sourceObservedAt')),
    ingestedAt: isoTimestamp(requiredString(record, 'ingestedAt')),
  };
}

export function parseBenchmarkResponse(payload: unknown): BenchmarkApiResponse {
  const root = asRecord(payload);
  const rowsValue = root.rows;
  if (!Array.isArray(rowsValue)) throw new Error('Benchmark response is malformed.');
  const rows = rowsValue.map(parseRow).sort((left, right) => left.rank - right.rank);
  const ids = new Set<string>();
  let priorScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (ids.has(row.id)) throw new Error('Benchmark response contains duplicate row identities.');
    ids.add(row.id);
    if (row.rank !== index + 1) throw new Error('Benchmark response ranks are not contiguous.');
    if (row.intelligenceIndex > priorScore) {
      throw new Error('Benchmark response is not monotonic by rank.');
    }
    priorScore = row.intelligenceIndex;
  }

  const dataset = parseDataset(root.dataset);
  if (dataset && dataset.rowCount !== rows.length) {
    throw new Error('Benchmark response row count does not match its dataset metadata.');
  }
  if (!dataset && rows.length > 0) throw new Error('Benchmark response is malformed.');

  return {
    generatedAt: isoTimestamp(requiredString(root, 'generatedAt')),
    freshness: parseFreshness(root.freshness),
    dataset,
    rows,
  };
}

export function blendedTokenPrice(row: BenchmarkModelRow): number | null {
  const input = row.inputPricePer1MTokensUsd;
  const output = row.outputPricePer1MTokensUsd;
  if (input == null || output == null) return null;
  return (input * 3 + output) / 4;
}

export function intelligencePerDollar(row: BenchmarkModelRow): number | null {
  const cost = row.costPerTaskUsd;
  if (cost == null || cost <= 0) return null;
  return row.intelligenceIndex / cost;
}

export function clearLegacyBenchmarkCaches(storage: Pick<Storage, 'removeItem'> | null = null): void {
  const target = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!target) return;
  for (const key of LEGACY_CACHE_KEYS) target.removeItem(key);
}

function readCache(): BenchmarkApiResponse | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as CacheEnvelope;
    if (envelope.version !== CACHE_VERSION) return null;
    return parseBenchmarkResponse(envelope.payload);
  } catch {
    return null;
  }
}

function writeCache(payload: BenchmarkApiResponse): void {
  if (typeof localStorage === 'undefined' || !payload.dataset || payload.rows.length === 0) return;
  try {
    const envelope: CacheEnvelope = {
      version: CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      payload,
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Cache is a startup optimization only; D1 remains authoritative.
  }
}

export function configuredBenchmarkApiUrl(): string {
  const explicit = import.meta.env.VITE_BENCHMARK_API_URL;
  if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) return explicit;
  const newsOrigin = import.meta.env.VITE_NEWS_API_URL;
  if (typeof newsOrigin === 'string' && /^https?:\/\//i.test(newsOrigin)) return newsOrigin;
  return DEFAULT_NEWS_API_URL;
}

export async function fetchBenchmarkLeaderboard(
  origin = configuredBenchmarkApiUrl(),
  {
    fetcher = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { fetcher?: FetchLike; timeoutMs?: number } = {},
): Promise<BenchmarkFetchResult> {
  clearLegacyBenchmarkCaches();
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('/api/benchmarks', origin);
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Benchmark request failed (${response.status}).`);
    const parsed = parseBenchmarkResponse(await response.json());
    writeCache(parsed);
    return { ...parsed, fromCache: false };
  } catch (error) {
    const cached = readCache();
    if (!cached) throw error;
    return {
      ...cached,
      fromCache: true,
      freshness: {
        state: 'stale',
        ageMs: cached.freshness.ageMs,
        warning: 'The benchmark backend is unavailable. Showing the last cached D1 dataset.',
      },
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
