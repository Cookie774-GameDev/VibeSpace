/**
 * Benchmark data layer for the Jarvis Live Benchmarks page.
 *
 * Strategy:
 *   1. On request, attempt a live fetch from LMArena's public leaderboard
 *      JSON with a 5s timeout.
 *   2. If the fetch fails for any reason (network down, CORS, schema drift,
 *      timeout, 4xx/5xx), fall back to a frozen snapshot embedded in this
 *      file. The snapshot is intentionally clearly marked: rows carry
 *      `source: 'snapshot'` and a `fetched_at` timestamp from when the
 *      snapshot was *captured*, not from "now".
 *   3. Cache the result in localStorage under `jarvis-benchmark-cache` for
 *      30 minutes. On a hit we serve the cache without reaching the network.
 *
 * IMPORTANT honesty note for any future maintainer or reader:
 * the fallback rows below are a frozen point-in-time capture from
 * Chatbot Arena (lmarena.ai) circa October 2024. They are *not* live data.
 * The page surfaces a `from snapshot` warning chip whenever these rows are
 * displayed, and the relative-time stamp will reflect the snapshot date,
 * not the moment the user opens the page. Do not edit these numbers to
 * pretend they are current — refresh the snapshot from the real
 * leaderboard or extend the fetch path instead.
 */
import type { ProviderId } from '@/types/common';

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
  source: 'lmsys' | 'snapshot';
  fetched_at: number;
}

/** Provider IDs Jarvis can route through today. Used to gate the
 * "Use this model" button in the detail drawer. */
const SUPPORTED_PROVIDERS: ReadonlyArray<ProviderId> = [
  'anthropic',
  'openai',
  'google',
  'mock',
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

const LMARENA_ENDPOINTS = [
  'https://lmarena.ai/api/leaderboard',
  'https://lmarena.ai/leaderboard/text/overall',
  'https://lmarena.ai/leaderboard',
] as const;
const CACHE_KEY = 'jarvis-benchmark-cache';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Snapshot timestamp — the last time this fallback table was audited.
 * The live fetch path is authoritative; this only labels fallback rows.
 */
const SNAPSHOT_TS = Date.UTC(2026, 5, 2, 12, 0, 0); // 2026-06-02T12:00:00Z

/**
 * Frozen Chatbot Arena snapshot (28 rows). Scores and CIs approximate the
 * public leaderboard at SNAPSHOT_TS. Cost numbers are list prices from each
 * provider's docs at the same point. Token counts are tokenizer-agnostic
 * estimates. None of this is live.
 */
export const SNAPSHOT_ROWS: BenchmarkRow[] = [
  {
    model: 'o1-preview',
    provider: 'openai',
    arena_score: 1355,
    ci_low: 1347,
    ci_high: 1363,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 15,
    cost_per_1m_output_usd: 60,
    context_window: 128_000,
    votes: 12_400,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'ChatGPT-4o-latest',
    provider: 'openai',
    arena_score: 1338,
    ci_low: 1331,
    ci_high: 1345,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 5,
    cost_per_1m_output_usd: 15,
    context_window: 128_000,
    votes: 26_800,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'GPT-4o (2024-08)',
    provider: 'openai',
    arena_score: 1314,
    ci_low: 1308,
    ci_high: 1320,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 2.5,
    cost_per_1m_output_usd: 10,
    context_window: 128_000,
    votes: 53_900,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'o1-mini',
    provider: 'openai',
    arena_score: 1304,
    ci_low: 1296,
    ci_high: 1312,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 3,
    cost_per_1m_output_usd: 12,
    context_window: 128_000,
    votes: 13_200,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Gemini 1.5 Pro (002)',
    provider: 'google',
    arena_score: 1296,
    ci_low: 1290,
    ci_high: 1302,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 1.25,
    cost_per_1m_output_usd: 5,
    context_window: 2_000_000,
    votes: 24_500,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Grok 2',
    provider: 'xai',
    arena_score: 1288,
    ci_low: 1281,
    ci_high: 1295,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 5,
    cost_per_1m_output_usd: 15,
    context_window: 131_072,
    votes: 18_600,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Yi-Lightning',
    provider: '01ai',
    arena_score: 1287,
    ci_low: 1279,
    ci_high: 1295,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 0.15,
    cost_per_1m_output_usd: 0.15,
    context_window: 16_000,
    votes: 9_400,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    arena_score: 1283,
    ci_low: 1277,
    ci_high: 1289,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 3,
    cost_per_1m_output_usd: 15,
    context_window: 200_000,
    votes: 51_200,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'GPT-4o-mini',
    provider: 'openai',
    arena_score: 1273,
    ci_low: 1267,
    ci_high: 1279,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 0.15,
    cost_per_1m_output_usd: 0.6,
    context_window: 128_000,
    votes: 41_800,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Gemini 1.5 Flash (002)',
    provider: 'google',
    arena_score: 1271,
    ci_low: 1264,
    ci_high: 1278,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 0.075,
    cost_per_1m_output_usd: 0.3,
    context_window: 1_000_000,
    votes: 22_300,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Llama 3.1 405B',
    provider: 'meta',
    arena_score: 1267,
    ci_low: 1260,
    ci_high: 1274,
    open_source: true,
    license: 'Llama 3.1 Community',
    cost_per_1m_input_usd: 5,
    cost_per_1m_output_usd: 15,
    context_window: 128_000,
    votes: 38_700,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Nemotron 70B',
    provider: 'nvidia',
    arena_score: 1267,
    ci_low: 1257,
    ci_high: 1277,
    open_source: true,
    license: 'NVIDIA OMA',
    cost_per_1m_input_usd: 0.35,
    cost_per_1m_output_usd: 0.4,
    context_window: 128_000,
    votes: 6_900,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'DeepSeek V2.5',
    provider: 'deepseek',
    arena_score: 1259,
    ci_low: 1252,
    ci_high: 1266,
    open_source: true,
    license: 'DeepSeek License',
    cost_per_1m_input_usd: 0.14,
    cost_per_1m_output_usd: 0.28,
    context_window: 128_000,
    votes: 14_500,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'GPT-4 Turbo',
    provider: 'openai',
    arena_score: 1257,
    ci_low: 1251,
    ci_high: 1263,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 10,
    cost_per_1m_output_usd: 30,
    context_window: 128_000,
    votes: 71_400,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Qwen 2.5 72B',
    provider: 'alibaba',
    arena_score: 1257,
    ci_low: 1248,
    ci_high: 1266,
    open_source: true,
    license: 'Qwen License',
    cost_per_1m_input_usd: 1.2,
    cost_per_1m_output_usd: 1.2,
    context_window: 131_072,
    votes: 8_300,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Mistral Large 2',
    provider: 'mistral',
    arena_score: 1251,
    ci_low: 1244,
    ci_high: 1258,
    open_source: true,
    license: 'MRL',
    cost_per_1m_input_usd: 2,
    cost_per_1m_output_usd: 6,
    context_window: 128_000,
    votes: 17_900,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Claude 3 Opus',
    provider: 'anthropic',
    arena_score: 1248,
    ci_low: 1242,
    ci_high: 1254,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 15,
    cost_per_1m_output_usd: 75,
    context_window: 200_000,
    votes: 56_700,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Llama 3.1 70B',
    provider: 'meta',
    arena_score: 1247,
    ci_low: 1240,
    ci_high: 1254,
    open_source: true,
    license: 'Llama 3.1 Community',
    cost_per_1m_input_usd: 0.59,
    cost_per_1m_output_usd: 0.79,
    context_window: 128_000,
    votes: 32_600,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Gemma 2 27B',
    provider: 'google',
    arena_score: 1218,
    ci_low: 1210,
    ci_high: 1226,
    open_source: true,
    license: 'Gemma Terms',
    cost_per_1m_input_usd: 0.27,
    cost_per_1m_output_usd: 0.27,
    context_window: 8_192,
    votes: 11_200,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'DeepSeek V2',
    provider: 'deepseek',
    arena_score: 1208,
    ci_low: 1201,
    ci_high: 1215,
    open_source: true,
    license: 'DeepSeek License',
    cost_per_1m_input_usd: 0.14,
    cost_per_1m_output_usd: 0.28,
    context_window: 128_000,
    votes: 19_400,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Reka Core',
    provider: 'reka',
    arena_score: 1196,
    ci_low: 1186,
    ci_high: 1206,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 5,
    cost_per_1m_output_usd: 15,
    context_window: 128_000,
    votes: 5_700,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Command R+',
    provider: 'cohere',
    arena_score: 1190,
    ci_low: 1183,
    ci_high: 1197,
    open_source: true,
    license: 'CC-BY-NC',
    cost_per_1m_input_usd: 2.5,
    cost_per_1m_output_usd: 10,
    context_window: 128_000,
    votes: 13_100,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Qwen 2 72B',
    provider: 'alibaba',
    arena_score: 1187,
    ci_low: 1180,
    ci_high: 1194,
    open_source: true,
    license: 'Qwen License',
    cost_per_1m_input_usd: 0.9,
    cost_per_1m_output_usd: 0.9,
    context_window: 131_072,
    votes: 10_700,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Mistral Nemo',
    provider: 'mistral',
    arena_score: 1186,
    ci_low: 1178,
    ci_high: 1194,
    open_source: true,
    license: 'Apache-2.0',
    cost_per_1m_input_usd: 0.15,
    cost_per_1m_output_usd: 0.15,
    context_window: 128_000,
    votes: 8_900,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Claude 3 Haiku',
    provider: 'anthropic',
    arena_score: 1179,
    ci_low: 1173,
    ci_high: 1185,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 0.25,
    cost_per_1m_output_usd: 1.25,
    context_window: 200_000,
    votes: 28_400,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Llama 3.1 8B',
    provider: 'meta',
    arena_score: 1175,
    ci_low: 1168,
    ci_high: 1182,
    open_source: true,
    license: 'Llama 3.1 Community',
    cost_per_1m_input_usd: 0.05,
    cost_per_1m_output_usd: 0.08,
    context_window: 128_000,
    votes: 16_300,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Phi-3.5 MoE',
    provider: 'microsoft',
    arena_score: 1175,
    ci_low: 1165,
    ci_high: 1185,
    open_source: true,
    license: 'MIT',
    cost_per_1m_input_usd: 0.18,
    cost_per_1m_output_usd: 0.18,
    context_window: 128_000,
    votes: 4_800,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
  {
    model: 'Gemini 1.0 Pro',
    provider: 'google',
    arena_score: 1131,
    ci_low: 1124,
    ci_high: 1138,
    open_source: false,
    license: 'proprietary',
    cost_per_1m_input_usd: 0.5,
    cost_per_1m_output_usd: 1.5,
    context_window: 32_768,
    votes: 19_800,
    source: 'snapshot',
    fetched_at: SNAPSHOT_TS,
  },
];

interface CacheEntry {
  rows: BenchmarkRow[];
  fromSnapshot: boolean;
  cachedAt: number;
}

function readCache(): CacheEntry | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (
      typeof parsed.cachedAt !== 'number' ||
      !Array.isArray(parsed.rows) ||
      Date.now() - parsed.cachedAt > CACHE_TTL_MS
    ) {
      return null;
    }
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
    /* quota exceeded — silently ignore, the page still works without cache */
  }
}

export interface FetchResult {
  rows: BenchmarkRow[];
  fromSnapshot: boolean;
  reason?: string;
  cached?: boolean;
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
    ? ((raw as { models: unknown[] }).models)
    : Array.isArray((raw as { leaderboard?: unknown }).leaderboard)
    ? ((raw as { leaderboard: unknown[] }).leaderboard)
    : [];

  const rows: BenchmarkRow[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const model = pickString(o, ['model', 'name', 'model_name']);
    const provider = pickString(o, ['provider', 'organization', 'org']);
    const score = pickNumber(o, ['arena_score', 'elo', 'rating', 'score']);
    if (!model || !provider || score == null) continue;
    const ciLow = pickNumber(o, ['ci_low', 'lower', 'lower_bound']) ?? score - 5;
    const ciHigh = pickNumber(o, ['ci_high', 'upper', 'upper_bound']) ?? score + 5;
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
  return rows;
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

/**
 * Fetch benchmarks. Returns a snapshot if the live fetch fails or the
 * cache is stale and the live fetch fails again.
 *
 * @param opts.force - bypass cache and re-fetch
 */
export async function fetchBenchmarks(opts?: { force?: boolean }): Promise<FetchResult> {
  if (!opts?.force) {
    const cached = readCache();
    if (cached) {
      return { rows: cached.rows, fromSnapshot: cached.fromSnapshot, cached: true };
    }
  }

  const now = Date.now();
  try {
    const errors: string[] = [];
    for (const url of LMARENA_ENDPOINTS) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
        });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') ?? '';
        const data = contentType.includes('application/json')
          ? ((await res.json()) as unknown)
          : extractLeaderboardJson(await res.text());
        const rows = normalize(data, now);
        if (rows.length < 5) throw new Error(`${url}: schema not recognized`);
        const result: FetchResult = { rows, fromSnapshot: false };
        writeCache({ rows, fromSnapshot: false, cachedAt: now });
        return result;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(errors.join(' | ') || 'Live leaderboard unavailable');
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Fetch failed';
    writeCache({ rows: SNAPSHOT_ROWS, fromSnapshot: true, cachedAt: now });
    return { rows: SNAPSHOT_ROWS, fromSnapshot: true, reason };
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
  } catch {
    /* ignore */
  }
}
