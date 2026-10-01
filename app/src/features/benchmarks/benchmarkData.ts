/**
 * Benchmark data layer for the Jarvis Live Benchmarks page.
 *
 * Strategy:
 *   1. Fetch live rows from the Wu Long Arena archive API (daily Arena AI
 *      snapshots, structured JSON, free, no auth).
 *   2. Fall back to direct LMArena endpoints via `nativeFetch` (bypasses
 *      Tauri WebView CORS when packaged).
 *   3. If all live sources fail, serve the embedded `SNAPSHOT_ROWS` fallback.
 *      Snapshot rows are never written to the 1-hour live cache.
 *
 * Cache: live results only, 1 hour TTL (`jarvis-benchmark-cache`).
 */
import type { ProviderId } from '@/types/common';
import { nativeFetch } from '@/lib/nativeFetch';
import { LEADERBOARD_SNAPSHOT_ROWS, LEADERBOARD_SNAPSHOT_TS } from './leaderboardSnapshot20260711';

export interface BenchmarkRow {
  model: string;
  provider: string;
  arena_score: number;
  ci_low: number;
  ci_high: number;
  open_source: boolean;
  license?: string;
  cost_per_1m_input_usd?: number;
  cost_per_1m_output_usd?: number;
  context_window?: number;
  votes?: number;
  /** Accepts image input (vision). Inferred from the model family. */
  supports_image?: boolean;
  /** Accepts video input. Inferred from the model family. */
  supports_video?: boolean;
  /** True when costs were filled from the list-price catalog, not the feed. */
  cost_estimated?: boolean;
  source: 'lmsys' | 'snapshot';
  fetched_at: number;
}

/**
 * Heuristic input-modality detection from the model name. The Arena feed
 * doesn't carry modality flags, so we map well-known families to their
 * publicly documented vision/video support.
 */
export function inferCapabilities(model: string): { image: boolean; video: boolean } {
  const m = model.toLowerCase();
  const video =
    /gemini/.test(m) ||
    /qwen.*vl/.test(m) ||
    /qwen2\.5|qwen3/.test(m) ||
    /reka/.test(m) ||
    /llama-?4|llama\s?4/.test(m);
  const image =
    video ||
    /gpt-?4o|gpt-?4\.1|gpt-?4-turbo|gpt-?4-vision|gpt-?5|chatgpt-?4o|\bo1\b|\bo3\b|\bo4\b/.test(
      m,
    ) ||
    /claude[-\s]?3|claude[-\s]?4|claude.*opus|claude.*sonnet|claude.*haiku/.test(m) ||
    /grok[-\s]?2|grok[-\s]?3|grok[-\s]?4|grok.*vision/.test(m) ||
    /llama[-\s]?3\.2|llama.*vision/.test(m) ||
    /pixtral|mistral.*medium|mistral.*small[-\s]?3/.test(m) ||
    /phi-?3\.5-vision|phi-?4/.test(m) ||
    /\bvl\b|vision|multimodal/.test(m) ||
    /yi-?vision|command[-\s]?a/.test(m);
  return { image, video };
}

/**
 * List-price fallbacks (USD / 1M tokens) when the Arena row has no price.
 * Prefer more specific patterns first. Values track public Arena $/M columns
 * and vendor list prices as of the Jul 2026 snapshot.
 */
const PRICING_CATALOG: ReadonlyArray<{ pattern: RegExp; input: number; output: number }> = [
  { pattern: /claude.*fable/, input: 10, output: 50 },
  { pattern: /claude.*opus.*4\.[5-9]|claude.*opus.*4-[5-9]/, input: 5, output: 25 },
  { pattern: /claude.*opus/, input: 15, output: 75 },
  { pattern: /claude.*sonnet.*5/, input: 2, output: 10 },
  { pattern: /claude.*sonnet/, input: 3, output: 15 },
  { pattern: /claude.*haiku/, input: 1, output: 5 },
  { pattern: /gpt-?5\.6|gpt-?5\.5/, input: 5, output: 30 },
  { pattern: /gpt-?5\.4-?mini/, input: 0.75, output: 4.5 },
  { pattern: /gpt-?5\.4/, input: 2.5, output: 15 },
  { pattern: /gpt-?5\.2/, input: 1.75, output: 14 },
  { pattern: /gpt-?5\.1/, input: 1.25, output: 10 },
  { pattern: /gpt-?5/, input: 1.25, output: 10 },
  { pattern: /gpt-?4o-mini|gpt-?4\.1-mini/, input: 0.15, output: 0.6 },
  { pattern: /gpt-?4o|chatgpt-?4o|gpt-?4\.1/, input: 2.5, output: 10 },
  { pattern: /gpt-?4-turbo/, input: 10, output: 30 },
  { pattern: /o1-mini|o3-mini|o4-mini/, input: 1.1, output: 4.4 },
  { pattern: /\bo1\b|\bo3\b|\bo4\b/, input: 15, output: 60 },
  { pattern: /gemini.*3\.5.*flash|gemini.*3-?flash/, input: 0.5, output: 3 },
  { pattern: /gemini.*3.*pro|gemini.*3\.1.*pro/, input: 2, output: 12 },
  { pattern: /gemini.*flash/, input: 0.3, output: 2.5 },
  { pattern: /gemini.*pro/, input: 1.25, output: 10 },
  { pattern: /grok[-\s]?4\.20|grok[-\s]?4\.5|grok[-\s]?4\.1/, input: 2, output: 6 },
  { pattern: /grok[-\s]?4/, input: 3, output: 15 },
  { pattern: /grok/, input: 2, output: 10 },
  { pattern: /deepseek.*v4/, input: 0.43, output: 0.87 },
  { pattern: /deepseek/, input: 0.27, output: 1.1 },
  { pattern: /muse.?spark/, input: 1.25, output: 4.25 },
  { pattern: /glm-?5/, input: 1.4, output: 4.4 },
  { pattern: /qwen3\.7|qwen3\.6|qwen3\.5/, input: 1.25, output: 3.75 },
  { pattern: /qwen/, input: 0.5, output: 1.5 },
  { pattern: /kimi|moonshot/, input: 0.95, output: 4 },
  { pattern: /mimo/, input: 0.43, output: 0.87 },
  { pattern: /llama.*405b/, input: 3, output: 5 },
  { pattern: /llama.*70b/, input: 0.6, output: 0.8 },
  { pattern: /llama.*8b/, input: 0.05, output: 0.08 },
  { pattern: /mistral.*large/, input: 2, output: 6 },
  { pattern: /pixtral|mistral.*nemo/, input: 0.15, output: 0.15 },
  { pattern: /command/, input: 2.5, output: 10 },
  { pattern: /gemma.?4/, input: 0.14, output: 0.4 },
  { pattern: /gemma/, input: 0.08, output: 0.16 },
];

function inferPricing(model: string): { input: number; output: number } | null {
  const m = model.toLowerCase();
  for (const entry of PRICING_CATALOG) {
    if (entry.pattern.test(m)) return { input: entry.input, output: entry.output };
  }
  return null;
}

/** Fill in modality + pricing fields that the live feed doesn't provide. */
export function enrichRow(row: BenchmarkRow): BenchmarkRow {
  const caps = inferCapabilities(row.model);
  const next: BenchmarkRow = {
    ...row,
    supports_image: row.supports_image ?? caps.image,
    supports_video: row.supports_video ?? caps.video,
  };
  if (next.cost_per_1m_input_usd == null || next.cost_per_1m_output_usd == null) {
    const pricing = inferPricing(row.model);
    if (pricing) {
      next.cost_per_1m_input_usd = next.cost_per_1m_input_usd ?? pricing.input;
      next.cost_per_1m_output_usd = next.cost_per_1m_output_usd ?? pricing.output;
      // Honesty flag: the UI renders these as "~" list-price estimates.
      next.cost_estimated = true;
    }
  }
  return next;
}

function enrichRows(rows: BenchmarkRow[]): BenchmarkRow[] {
  return rows.map(enrichRow);
}

function dedupeRows(rows: BenchmarkRow[]): BenchmarkRow[] {
  const unique: BenchmarkRow[] = [];
  const indexes = new Map<string, number>();

  for (const row of rows) {
    const key = `${row.provider.trim().toLocaleLowerCase()}:${row.model.trim().toLocaleLowerCase()}`;
    const existingIndex = indexes.get(key);
    if (existingIndex == null) {
      indexes.set(key, unique.length);
      unique.push(row);
      continue;
    }
    if (row.arena_score > unique[existingIndex]!.arena_score) {
      unique[existingIndex] = row;
    }
  }

  return unique;
}

/** Provider IDs Jarvis can route through today. Used to gate the
 * "Use this model" button in the detail drawer. */
const SUPPORTED_PROVIDERS: ReadonlyArray<ProviderId> = [
  'anthropic',
  'openai',
  'google',
  'local',
  'xai',
  'openrouter',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'ollama',
];

export function isSupportedProvider(p: string): p is ProviderId {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

const WULONG_TEXT_LEADERBOARD =
  'https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text';
const LMARENA_ENDPOINTS = [
  'https://lmarena.ai/api/leaderboard',
  'https://lmarena.ai/leaderboard/text/overall',
  'https://lmarena.ai/leaderboard',
] as const;
const CACHE_KEY = 'jarvis-benchmark-cache-v5';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour ΓÇö live rows only
const REQUIRED_MODEL_COUNT = 50;
/** Reject cached rows whose Arena snapshot is older than this. */
const MAX_ROW_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

interface LiveDataset {
  rows: BenchmarkRow[];
  sourceName: string;
  sourceUrl: string;
}

let liveRefreshInFlight: Promise<LiveDataset & { ingestedAt: number }> | null = null;

/**
 * Snapshot timestamp ΓÇö curated Top 50 UNIQUE models (AA Intelligence, 2026-07-11).
 * The live fetch path is authoritative on Refresh; this labels curated rows.
 */
export const SNAPSHOT_TS = LEADERBOARD_SNAPSHOT_TS;

/**
 * Curated Top 50 unique models (one base model per row).
 * Rank score = Artificial Analysis Intelligence Index; prices/context from OpenRouter.
 */
export const SNAPSHOT_ROWS: BenchmarkRow[] = LEADERBOARD_SNAPSHOT_ROWS.map((row) => ({
  ...row,
}));

interface CacheEntry {
  rows: BenchmarkRow[];
  fromSnapshot: boolean;
  cachedAt: number;
  sourceName?: string;
  sourceUrl?: string;
}

function isLiveCacheEntry(entry: CacheEntry, allowExpired = false): boolean {
  if (entry.fromSnapshot) return false;
  if (typeof entry.cachedAt !== 'number') return false;
  if (!Array.isArray(entry.rows) || entry.rows.length < REQUIRED_MODEL_COUNT) return false;
  if (!allowExpired && Date.now() - entry.cachedAt > CACHE_TTL_MS) return false;
  if (entry.rows.some((r) => r.source === 'snapshot')) return false;
  if (
    (entry.sourceName !== undefined || entry.sourceUrl !== undefined) &&
    !isKnownLiveSource(entry.sourceName, entry.sourceUrl)
  ) {
    return false;
  }
  const newestFetched = Math.max(...entry.rows.map((r) => r.fetched_at));
  if (!Number.isFinite(newestFetched)) return false;
  if (Date.now() - newestFetched > MAX_ROW_AGE_MS) return false;
  return true;
}

function isKnownLiveSource(sourceName: unknown, sourceUrl: unknown): boolean {
  if (sourceName === 'LMArena via Wu Long archive') return sourceUrl === WULONG_TEXT_LEADERBOARD;
  return (
    sourceName === 'LMArena' &&
    typeof sourceUrl === 'string' &&
    (LMARENA_ENDPOINTS as readonly string[]).includes(sourceUrl)
  );
}

function readCache(allowExpired = false): CacheEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!isLiveCacheEntry(parsed, allowExpired)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* quota exceeded ΓÇö silently ignore, the page still works without cache */
  }
}

export interface FetchResult {
  rows: BenchmarkRow[];
  fromSnapshot: boolean;
  reason?: string;
  cached?: boolean;
  stale?: boolean;
  /** True only when no verified structured benchmark rows are available. */
  unavailable?: boolean;
  dataset: {
    metricLabel: 'Arena score' | 'Arena rating' | 'Artificial Analysis Intelligence Index';
    sourceName: string;
    sourceUrl: string;
    benchmarkDate: number;
    ingestedAt: number;
    confidence: 'high' | 'medium';
    normalizationNote: string;
  };
}

/**
 * Best-effort normalizer. The real LMArena API shape is undocumented, so
 * we accept a few plausible shapes and short-circuit to snapshot if we
 * can't recognize what we got back.
 */
function normalize(raw: unknown, ts: number): BenchmarkRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const candidates: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { models?: unknown }).models)
      ? (raw as { models: unknown[] }).models
      : Array.isArray((raw as { leaderboard?: unknown }).leaderboard)
        ? (raw as { leaderboard: unknown[] }).leaderboard
        : [];

  const rows: BenchmarkRow[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const model = pickString(o, ['model', 'name', 'model_name']);
    const provider = pickString(o, ['provider', 'organization', 'org']);
    // A generic `score` can represent a completely different benchmark.
    // Accept only fields that identify an Arena/Elo-style metric here.
    const score = pickNumber(o, ['arena_score', 'elo', 'rating']);
    if (!model || !provider || score == null) continue;
    const ciLow = pickNumber(o, ['ci_low', 'lower', 'lower_bound']) ?? score;
    const ciHigh = pickNumber(o, ['ci_high', 'upper', 'upper_bound']) ?? score;
    rows.push({
      model,
      provider: provider.toLowerCase(),
      arena_score: Math.round(score),
      ci_low: Math.round(ciLow),
      ci_high: Math.round(ciHigh),
      open_source: pickBoolean(o, ['open_source', 'is_open']) ?? false,
      license: pickString(o, ['license']) ?? undefined,
      cost_per_1m_input_usd: pickNumber(o, ['cost_per_1m_input_usd', 'input_cost']) ?? undefined,
      cost_per_1m_output_usd: pickNumber(o, ['cost_per_1m_output_usd', 'output_cost']) ?? undefined,
      context_window: pickNumber(o, ['context_window', 'context']) ?? undefined,
      votes: pickNumber(o, ['votes', 'sample_size']) ?? undefined,
      source: 'lmsys',
      fetched_at: ts,
    });
  }
  return dedupeRows(rows);
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function pickBoolean(o: Record<string, unknown>, keys: string[]): boolean | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'boolean') return v;
  }
  return null;
}

/** Map Arena vendor labels to Jarvis provider slugs. */
export function vendorToProvider(vendor: string): string {
  const v = vendor.trim().toLowerCase();
  if (v.includes('anthropic')) return 'anthropic';
  if (v.includes('openai')) return 'openai';
  if (v.includes('google')) return 'google';
  if (v.includes('meta')) return 'meta';
  if (v.includes('x.ai') || v.includes('spacexai') || v === 'xai') return 'xai';
  if (v.includes('deepseek')) return 'deepseek';
  if (v.includes('mistral')) return 'mistral';
  if (v.includes('nvidia')) return 'nvidia';
  if (v.includes('microsoft')) return 'microsoft';
  if (v.includes('alibaba') || v.includes('qwen')) return 'alibaba';
  if (v.includes('cohere')) return 'cohere';
  if (v.includes('01.ai') || v.includes('01ai')) return '01ai';
  if (v.includes('z.ai') || v === 'zai' || v === 'z.ai') return 'zai';
  if (v.includes('baidu')) return 'baidu';
  if (v.includes('moonshot')) return 'moonshot';
  if (v.includes('xiaomi')) return 'xiaomi';
  if (v.includes('bytedance')) return 'bytedance';
  if (v.includes('minimax')) return 'minimax';
  if (v.includes('meta')) return 'meta';
  return v.replace(/\s+/g, '');
}

function parseFetchedAt(meta: unknown, fallback: number): number {
  if (!meta || typeof meta !== 'object') return fallback;
  const raw = (meta as { fetched_at?: unknown }).fetched_at;
  if (typeof raw === 'string') {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return fallback;
}

/** Normalize Wu Long Arena archive JSON into benchmark rows. */
export function normalizeWulong(raw: unknown, fallbackTs: number): BenchmarkRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const payload = raw as {
    meta?: { fetched_at?: string };
    models?: Array<{
      model?: string;
      vendor?: string | null;
      license?: string | null;
      score?: number | null;
      ci?: number | null;
      votes?: number | null;
    }>;
  };
  if (!Array.isArray(payload.models)) return [];

  const fetchedAt = parseFetchedAt(payload.meta, fallbackTs);
  const rows: BenchmarkRow[] = [];

  for (const entry of payload.models) {
    if (!entry?.model || entry.score == null || !Number.isFinite(entry.score)) continue;
    const ci = entry.ci != null && Number.isFinite(entry.ci) ? Math.max(0, entry.ci) : 0;
    const score = Math.round(entry.score);
    const vendor = entry.vendor?.trim() || 'unknown';
    rows.push({
      model: entry.model,
      provider: vendorToProvider(vendor),
      arena_score: score,
      ci_low: Math.round(score - ci),
      ci_high: Math.round(score + ci),
      open_source: entry.license === 'open',
      license: entry.license ?? undefined,
      votes: entry.votes ?? undefined,
      source: 'lmsys',
      fetched_at: fetchedAt,
    });
  }

  return dedupeRows(rows);
}

async function fetchLiveRows(now: number): Promise<LiveDataset> {
  const errors: string[] = [];

  try {
    const res = await nativeFetch(WULONG_TEXT_LEADERBOARD, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    const rows = normalizeWulong(data, now);
    if (rows.length < REQUIRED_MODEL_COUNT) {
      throw new Error(`incomplete leaderboard (${rows.length}/${REQUIRED_MODEL_COUNT} models)`);
    }
    return {
      rows,
      sourceName: 'LMArena via Wu Long archive',
      sourceUrl: WULONG_TEXT_LEADERBOARD,
    };
  } catch (err) {
    errors.push(boundedLeaderboardError('wulong', err));
  }

  for (const url of LMARENA_ENDPOINTS) {
    try {
      const res = await nativeFetch(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json')
        ? ((await res.json()) as unknown)
        : extractLeaderboardJson(await res.text());
      const rows = normalize(data, now);
      if (rows.length < REQUIRED_MODEL_COUNT) {
        throw new Error(`incomplete leaderboard (${rows.length}/${REQUIRED_MODEL_COUNT} models)`);
      }
      return { rows, sourceName: 'LMArena', sourceUrl: url };
    } catch (err) {
      errors.push(boundedLeaderboardError('lmarena', err));
    }
  }

  throw new Error(errors.join(' | ') || 'Live leaderboard unavailable');
}

function boundedLeaderboardError(source: 'wulong' | 'lmarena', error: unknown): string {
  if (error instanceof Error) {
    const http = /^HTTP (\d{3})$/u.exec(error.message);
    if (http) return `${source}: HTTP ${http[1]}`;
    const incomplete = /incomplete leaderboard \((\d+)\/(\d+) models\)/u.exec(error.message);
    if (incomplete) {
      return `${source}: incomplete leaderboard (${incomplete[1]}/${incomplete[2]} models)`;
    }
  }
  return `${source}: request failed`;
}

async function refreshLiveDataset(): Promise<LiveDataset & { ingestedAt: number }> {
  if (liveRefreshInFlight) return liveRefreshInFlight;
  const task = (async () => {
    const ingestedAt = Date.now();
    const dataset = await fetchLiveRows(ingestedAt);
    writeCache({
      rows: dataset.rows,
      fromSnapshot: false,
      cachedAt: ingestedAt,
      sourceName: dataset.sourceName,
      sourceUrl: dataset.sourceUrl,
    });
    return { ...dataset, ingestedAt };
  })();
  liveRefreshInFlight = task;
  try {
    return await task;
  } finally {
    if (liveRefreshInFlight === task) liveRefreshInFlight = null;
  }
}

/**
 * Fetch benchmarks. A normal load uses a fresh live cache when possible and
 * otherwise refreshes the structured sources. The embedded snapshot is the
 * final cold-start fallback only.
 */
export async function fetchBenchmarks(opts?: { force?: boolean }): Promise<FetchResult> {
  const curated: FetchResult = {
    rows: enrichRows(SNAPSHOT_ROWS),
    fromSnapshot: true,
    dataset: {
      metricLabel: 'Artificial Analysis Intelligence Index',
      sourceName: 'Artificial Analysis',
      sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
      benchmarkDate: SNAPSHOT_TS,
      ingestedAt: SNAPSHOT_TS,
      confidence: 'high',
      normalizationNote:
        'This snapshot is displayed as its own Intelligence Index dataset and is never numerically merged with Arena scores.',
    },
  };

  if (!opts?.force) {
    const cached = readCache();
    if (cached) {
      const benchmarkDate = Math.max(...cached.rows.map((row) => row.fetched_at));
      return {
        rows: enrichRows(cached.rows),
        fromSnapshot: cached.fromSnapshot,
        cached: true,
        dataset: {
          metricLabel: 'Arena score',
          sourceName: cached.sourceName ?? 'LMArena via Wu Long archive',
          sourceUrl: cached.sourceUrl ?? WULONG_TEXT_LEADERBOARD,
          benchmarkDate,
          ingestedAt: cached.cachedAt,
          confidence: 'medium',
          normalizationNote:
            'Arena rows are ranked only against the same Arena feed and are not merged with Intelligence Index scores.',
        },
      };
    }
  }

  try {
    const { rows, ingestedAt, sourceName, sourceUrl } = await refreshLiveDataset();
    return {
      rows: enrichRows(rows),
      fromSnapshot: false,
      dataset: {
        metricLabel: 'Arena score',
        sourceName,
        sourceUrl,
        benchmarkDate: Math.max(...rows.map((row) => row.fetched_at)),
        ingestedAt,
        confidence: 'medium',
        normalizationNote:
          'Arena rows are ranked only against the same Arena feed and are not merged with Intelligence Index scores.',
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Fetch failed';
    const staleCache = readCache(true);
    if (staleCache) {
      return {
        rows: enrichRows(staleCache.rows),
        fromSnapshot: false,
        cached: true,
        stale: true,
        reason,
        dataset: {
          metricLabel: 'Arena score',
          sourceName: staleCache.sourceName ?? 'LMArena via Wu Long archive',
          sourceUrl: staleCache.sourceUrl ?? WULONG_TEXT_LEADERBOARD,
          benchmarkDate: Math.max(...staleCache.rows.map((row) => row.fetched_at)),
          ingestedAt: staleCache.cachedAt,
          confidence: 'medium',
          normalizationNote:
            'Last-known-good Arena rows are retained when the hourly refresh is unavailable; no scores are synthesized.',
        },
      };
    }
    return { ...curated, reason, stale: Date.now() - SNAPSHOT_TS > CACHE_TTL_MS };
  }
}

function extractLeaderboardJson(html: string): unknown {
  const nextData = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!nextData?.[1]) return null;
  try {
    return JSON.parse(nextData[1]);
  } catch {
    return null;
  }
}

/** Clears the localStorage cache. Useful for tests and a "force live"
 * UX in the future. */
export function clearBenchmarkCache(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(CACHE_KEY);
    // Drop legacy keys that may still hold frozen snapshot rows.
    localStorage.removeItem('jarvis-benchmark-cache');
    localStorage.removeItem('jarvis-benchmark-cache-v3');
    localStorage.removeItem('jarvis-benchmark-cache-v4');
  } catch {
    /* ignore */
  }
}
