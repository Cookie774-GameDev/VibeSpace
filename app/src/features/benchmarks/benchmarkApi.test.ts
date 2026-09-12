import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blendedTokenPrice,
  clearLegacyBenchmarkCaches,
  fetchBenchmarkLeaderboard,
  getCachedBenchmarkLeaderboard,
  intelligencePerDollar,
  parseBenchmarkResponse,
} from './benchmarkApi';

const row = {
  id: 'anthropic|claude-opus-5|max',
  rank: 1,
  provider: 'Anthropic',
  model: 'Claude Opus 5 (Adaptive Reasoning, Max Effort)',
  variantLabel: 'Adaptive Reasoning',
  effort: 'max',
  intelligenceIndex: 61,
  outputTokensPerSecond: 80,
  timeToFirstTokenSeconds: 0.8,
  inputPricePer1MTokensUsd: 5,
  outputPricePer1MTokensUsd: 25,
  costPerTaskUsd: 0.5,
  contextWindowTokens: 200000,
  openWeights: false,
  sourceName: 'Artificial Analysis' as const,
  sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
  methodologyVersion: '3.0',
  sourceObservedAt: '2026-08-14T23:00:00Z',
  ingestedAt: '2026-08-14T23:07:00Z',
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-08-14T23:08:00Z',
    freshness: { state: 'fresh', ageMs: 60000 },
    dataset: {
      source: 'Artificial Analysis',
      metric: 'Artificial Analysis Intelligence Index',
      sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
      methodologyVersion: '3.0',
      sourceObservedAt: '2026-08-14T23:00:00Z',
      ingestedAt: '2026-08-14T23:07:00Z',
      rowCount: 1,
    },
    rows: [row],
    ...overrides,
  };
}

describe('benchmark API contract', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('accepts exact Artificial Analysis variants and full timestamps', () => {
    const parsed = parseBenchmarkResponse(payload());
    expect(parsed.rows[0]).toMatchObject({
      model: 'Claude Opus 5 (Adaptive Reasoning, Max Effort)',
      effort: 'max',
      intelligenceIndex: 61,
      sourceObservedAt: '2026-08-14T23:00:00.000Z',
    });
  });

  it('downgrades an old backend response without a complete page receipt', () => {
    const parsed = parseBenchmarkResponse(payload());
    expect(parsed.dataset?.completeness).toMatchObject({ state: 'unverified' });
    expect(parsed.freshness).toMatchObject({ state: 'degraded' });
    expect(parsed.freshness.warning).toMatch(/did not provide a complete/i);
  });

  it('rejects Arena/Elo-scale values mapped into Intelligence Index', () => {
    expect(() =>
      parseBenchmarkResponse(payload({ rows: [{ ...row, intelligenceIndex: 1587 }] })),
    ).toThrow(/outside the supported source scale/i);
  });

  it('rejects duplicate exact row identities', () => {
    expect(() =>
      parseBenchmarkResponse(
        payload({
          dataset: { ...(payload().dataset as object), rowCount: 2 },
          rows: [row, { ...row, rank: 2, intelligenceIndex: 60 }],
        }),
      ),
    ).toThrow(/duplicate row identities/i);
  });

  it('rejects duplicate logical variants even when the backend gives them different ids', () => {
    expect(() =>
      parseBenchmarkResponse(
        payload({
          dataset: { ...(payload().dataset as object), rowCount: 2 },
          rows: [
            row,
            {
              ...row,
              id: 'backend-alias-for-the-same-row',
              rank: 2,
              intelligenceIndex: 60,
            },
          ],
        }),
      ),
    ).toThrow(/duplicate logical benchmark variants/i);
  });

  it('keeps reasoning-effort variants separate', () => {
    const xhigh = {
      ...row,
      id: 'anthropic|claude-opus-5|xhigh',
      rank: 2,
      effort: 'xhigh',
      model: 'Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)',
      intelligenceIndex: 60,
    };
    const parsed = parseBenchmarkResponse(
      payload({
        dataset: { ...(payload().dataset as object), rowCount: 2 },
        rows: [row, xhigh],
      }),
    );
    expect(parsed.rows.map((entry) => entry.effort)).toEqual(['max', 'xhigh']);
  });

  it('calculates only documented derived metrics', () => {
    expect(blendedTokenPrice(row)).toBe(10);
    expect(intelligencePerDollar(row)).toBe(122);
    expect(intelligencePerDollar({ ...row, costPerTaskUsd: undefined })).toBeNull();
  });

  it('invalidates every legacy Arena cache key', () => {
    const storage = { removeItem: vi.fn() };
    clearLegacyBenchmarkCaches(storage);
    expect(storage.removeItem).toHaveBeenCalledWith('jarvis-benchmark-cache-v5');
    expect(storage.removeItem).toHaveBeenCalledWith('jarvis-benchmark-cache');
  });

  it('keeps last-known-good D1 data when a later refetch fails', async () => {
    const success = vi.fn(
      async () =>
        new Response(JSON.stringify(payload()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const live = await fetchBenchmarkLeaderboard('https://bench.example', { fetcher: success });
    expect(live.fromCache).toBe(false);

    const failure = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const cached = await fetchBenchmarkLeaderboard('https://bench.example', {
      fetcher: failure,
      force: true,
    });
    expect(cached.fromCache).toBe(true);
    expect(cached.freshness.state).toBe('stale');
    expect(cached.rows[0]?.intelligenceIndex).toBe(61);
  });

  it('returns saved results synchronously and skips a fresh repeat request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload())));
    await fetchBenchmarkLeaderboard('https://fast.example', { fetcher });
    expect(getCachedBenchmarkLeaderboard('https://fast.example')?.rows[0]?.intelligenceIndex).toBe(
      61,
    );
    const repeat = await fetchBenchmarkLeaderboard('https://fast.example', { fetcher });
    expect(repeat.fromCache).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(getCachedBenchmarkLeaderboard('https://other.example')).toBeNull();
  });

  it('shares simultaneous requests and preserves saved rows on an empty refresh', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const first = fetchBenchmarkLeaderboard('https://shared.example', { fetcher });
    const second = fetchBenchmarkLeaderboard('https://shared.example', { fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    finish(new Response(JSON.stringify(payload())));
    await Promise.all([first, second]);
    const empty = vi.fn(
      async () =>
        new Response(
          JSON.stringify(payload({ dataset: null, rows: [], freshness: { state: 'failed' } })),
        ),
    );
    const saved = await fetchBenchmarkLeaderboard('https://shared.example', {
      fetcher: empty,
      force: true,
    });
    expect(saved.rows).toHaveLength(1);
    expect(saved.freshness.state).toBe('stale');
  });
});
