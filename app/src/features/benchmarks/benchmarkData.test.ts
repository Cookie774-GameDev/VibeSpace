import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativeFetch', () => ({
  nativeFetch: vi.fn(),
}));

import { nativeFetch } from '@/lib/nativeFetch';
import {
  clearBenchmarkCache,
  fetchBenchmarks,
  normalizeWulong,
  vendorToProvider,
} from './benchmarkData';

const mockedFetch = vi.mocked(nativeFetch);

beforeEach(() => {
  clearBenchmarkCache();
  mockedFetch.mockReset();
});

describe('benchmarkData live sources', () => {
  it('maps Arena vendors to Jarvis provider slugs', () => {
    expect(vendorToProvider('Anthropic')).toBe('anthropic');
    expect(vendorToProvider('OpenAI')).toBe('openai');
    expect(vendorToProvider('Google')).toBe('google');
    expect(vendorToProvider('Z.ai')).toBe('zai');
    expect(vendorToProvider('ByteDance')).toBe('bytedance');
    expect(vendorToProvider('MiniMax')).toBe('minimax');
  });

  it('normalizes Wu Long Arena JSON into benchmark rows', () => {
    const rows = normalizeWulong(
      {
        meta: { fetched_at: '2026-06-22T07:01:02.283089+00:00' },
        models: [
          {
            rank: 1,
            model: 'claude-opus-4-6',
            vendor: 'Anthropic',
            license: 'proprietary',
            score: 1499,
            ci: 4,
            votes: 49596,
          },
          {
            rank: 2,
            model: 'llama-3.1-405b',
            vendor: 'Meta',
            license: 'open',
            score: 1267,
            ci: 7,
            votes: 1000,
          },
        ],
      },
      Date.UTC(2026, 5, 1),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe('claude-opus-4-6');
    expect(rows[0]?.provider).toBe('anthropic');
    expect(rows[0]?.arena_score).toBe(1499);
    expect(rows[0]?.ci_low).toBe(1495);
    expect(rows[0]?.ci_high).toBe(1503);
    expect(rows[0]?.source).toBe('lmsys');
    expect(rows[0]?.fetched_at).toBe(Date.parse('2026-06-22T07:01:02.283089+00:00'));
    expect(rows[1]?.open_source).toBe(true);
  });

  it('deduplicates repeated live model rows and keeps the strongest score', () => {
    const rows = normalizeWulong(
      {
        models: [
          { model: 'gemini-3.5-flash-high', vendor: 'Google', score: 1400, ci: 5 },
          { model: 'gemini-3.5-flash-high', vendor: 'Google', score: 1412, ci: 4 },
          { model: 'claude-opus', vendor: 'Anthropic', score: 1390, ci: 3 },
        ],
      },
      Date.UTC(2026, 6, 11),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe('gemini-3.5-flash-high');
    expect(rows[0]?.arena_score).toBe(1412);
    expect(rows[1]?.model).toBe('claude-opus');
  });

  it('returns live Wu Long rows when the API succeeds', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meta: { fetched_at: new Date().toISOString() },
        models: Array.from({ length: 50 }, (_, index) => ({
          model: index === 0 ? 'claude-opus-4-6' : `live-model-${index + 1}`,
          vendor: index === 0 ? 'Anthropic' : 'OpenAI',
          score: 1499 - index,
          ci: 4,
          votes: 1,
        })),
      }),
      headers: { get: () => 'application/json' },
    } as unknown as Response);

    const result = await fetchBenchmarks({ force: true });
    expect(result.fromSnapshot).toBe(false);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]?.model).toBe('claude-opus-4-6');
  });

  it('shares one live refresh across concurrent callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedFetch.mockImplementationOnce(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          meta: { fetched_at: new Date().toISOString() },
          models: Array.from({ length: 50 }, (_, index) => ({
            model: `single-flight-${index + 1}`,
            vendor: 'OpenAI',
            score: 1500 - index,
          })),
        }),
        headers: { get: () => 'application/json' },
      } as unknown as Response;
    });

    const first = fetchBenchmarks({ force: true });
    const second = fetchBenchmarks({ force: true });
    release?.();
    const [left, right] = await Promise.all([first, second]);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(left.rows).toEqual(right.rows);
    expect(left.dataset.ingestedAt).toBe(right.dataset.ingestedAt);
  });

  it('preserves the exact direct LMArena source when Wu Long fails, including cache reads', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('Wu Long unavailable')).mockResolvedValueOnce({
      ok: true,
      json: async () =>
        Array.from({ length: 50 }, (_, index) => ({
          model: `direct-model-${index + 1}`,
          provider: 'OpenAI',
          arena_score: 1500 - index,
        })),
      headers: { get: () => 'application/json' },
    } as unknown as Response);

    const live = await fetchBenchmarks({ force: true });
    const cached = await fetchBenchmarks();

    const cache = JSON.parse(localStorage.getItem('jarvis-benchmark-cache-v5') ?? '{}') as {
      cachedAt?: number;
    };
    localStorage.setItem(
      'jarvis-benchmark-cache-v5',
      JSON.stringify({ ...cache, cachedAt: Date.now() - 2 * 60 * 60 * 1000 }),
    );
    mockedFetch.mockRejectedValue(new Error('all live sources unavailable'));
    const fallback = await fetchBenchmarks({ force: true });

    expect(live.dataset).toMatchObject({
      sourceName: 'LMArena',
      sourceUrl: 'https://lmarena.ai/api/leaderboard',
    });
    expect(cached.cached).toBe(true);
    expect(cached.dataset).toMatchObject({
      sourceName: 'LMArena',
      sourceUrl: 'https://lmarena.ai/api/leaderboard',
    });
    expect(fallback).toMatchObject({ cached: true, stale: true });
    expect(fallback.dataset).toMatchObject({
      sourceName: 'LMArena',
      sourceUrl: 'https://lmarena.ai/api/leaderboard',
    });
    expect(mockedFetch).toHaveBeenCalledTimes(6);
  });

  it('keeps the complete Top 50 when a live source returns a partial leaderboard', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: Array.from({ length: 20 }, (_, index) => ({
          model: `partial-model-${index + 1}`,
          vendor: 'OpenAI',
          score: 1400 - index,
        })),
      }),
      headers: { get: () => 'application/json' },
    } as unknown as Response);

    const result = await fetchBenchmarks({ force: true });
    expect(result.fromSnapshot).toBe(true);
    expect(result.rows).toHaveLength(50);
    expect(result.reason).toContain('incomplete leaderboard (20/50 models)');
  });

  it('falls back to snapshot when every live source fails', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));
    const result = await fetchBenchmarks({ force: true });
    expect(result.fromSnapshot).toBe(true);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]?.model).toBe('Claude Fable 5');
    expect(result.rows[0]?.arena_score).toBe(68);
    expect(result.rows[0]?.cost_per_1m_input_usd).toBe(10);
    expect(result.rows[0]?.source).toBe('snapshot');
  });

  it('attempts a structured refresh before using the embedded cold-start fallback', async () => {
    mockedFetch.mockRejectedValue(new Error('offline'));
    const result = await fetchBenchmarks();
    expect(result.fromSnapshot).toBe(true);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]?.model).toBe('Claude Fable 5');
    expect(result.rows[1]?.model).toBe('GPT-5.6 Sol');
    expect(result.rows[5]?.model).toBe('Grok 4.5');
    expect(result.rows[9]?.model).toBe('Gemini 2.5 Pro');
    expect(result.rows[9]?.arena_score).toBe(49.6);
    expect(result.rows[49]?.model).toBe('GPT-OSS 20B');
    // One unique model per row ΓÇö no reasoning-variant duplicates.
    const names = result.rows.map((r) => r.model);
    expect(new Set(names).size).toBe(50);
    expect(mockedFetch).toHaveBeenCalled();
  });

  it('keeps a stale last-known-good live dataset when the hourly refresh fails', async () => {
    const fetchedAt = Date.now() - 2 * 60 * 60 * 1000;
    localStorage.setItem(
      'jarvis-benchmark-cache-v5',
      JSON.stringify({
        fromSnapshot: false,
        cachedAt: fetchedAt,
        rows: Array.from({ length: 50 }, (_, index) => ({
          model: `known-good-${index + 1}`,
          provider: 'openai',
          arena_score: 1500 - index,
          ci_low: 1495 - index,
          ci_high: 1505 - index,
          open_source: false,
          source: 'lmsys',
          fetched_at: fetchedAt,
        })),
      }),
    );
    const privateDetail = 'upstream unavailable: token=private';
    mockedFetch.mockRejectedValue(new Error(privateDetail));

    const result = await fetchBenchmarks();

    expect(result.fromSnapshot).toBe(false);
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.rows[0]?.model).toBe('known-good-1');
    expect(result.reason).toContain('request failed');
    expect(result.reason).not.toContain(privateDetail);
  });

  it('keeps OpenRouter list prices and modalities on snapshot rows', async () => {
    const result = await fetchBenchmarks();
    const withPrice = result.rows.filter(
      (r) => r.cost_per_1m_input_usd != null && r.cost_per_1m_output_usd != null,
    );
    expect(withPrice.length).toBe(50);
    const sol = result.rows.find((r) => r.model === 'GPT-5.6 Sol');
    expect(sol?.cost_per_1m_input_usd).toBe(5);
    expect(sol?.cost_per_1m_output_usd).toBe(30);
    expect(sol?.context_window).toBe(1_050_000);
    expect(sol?.supports_image).toBe(true);
    const gemini = result.rows.find((r) => r.model === 'Gemini 3.5 Flash');
    expect(gemini?.cost_per_1m_input_usd).toBe(1.5);
    expect(gemini?.cost_per_1m_output_usd).toBe(9);
    expect(gemini?.supports_video).toBe(true);
    const oss = result.rows.find((r) => r.model === 'GPT-OSS 20B');
    expect(oss?.arena_score).toBe(14.9);
    expect(oss?.open_source).toBe(true);
  });
});
