import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./benchmarkData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./benchmarkData')>();
  return { ...actual, fetchBenchmarks: vi.fn() };
});

import type { BenchmarkRow } from './benchmarkData';
import { fetchBenchmarks } from './benchmarkData';
import {
  deduplicateBenchmarkRows,
  nextBenchmarkRefreshAt,
  readBenchmarkRefreshConfig,
  refreshBenchmarkDataset,
  shouldRunMissedBenchmarkRefresh,
  writeBenchmarkRefreshConfig,
} from './benchmarkRefresh';

const mockedFetchBenchmarks = vi.mocked(fetchBenchmarks);

function row(model: string, votes: number, fetchedAt: number): BenchmarkRow {
  return {
    model,
    provider: 'openai',
    arena_score: 100,
    ci_low: 95,
    ci_high: 105,
    open_source: false,
    votes,
    source: 'lmsys',
    fetched_at: fetchedAt,
  };
}

describe('benchmark refresh policy', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockedFetchBenchmarks.mockReset();
  });

  it('defaults to an hourly cadence and schedules from the last successful run', () => {
    expect(readBenchmarkRefreshConfig()).toEqual({ enabled: true, intervalMinutes: 60 });
    const now = new Date(2026, 7, 2, 11, 30);
    const lastRunAt = new Date(2026, 7, 2, 11, 5).getTime();
    const next = nextBenchmarkRefreshAt(now, readBenchmarkRefreshConfig(), lastRunAt);
    expect(next?.getHours()).toBe(12);
    expect(next?.getMinutes()).toBe(5);
    expect(next?.getDate()).toBe(2);
  });

  it('runs immediately when the hourly refresh is missing or overdue', () => {
    writeBenchmarkRefreshConfig({ enabled: true, intervalMinutes: 60 });
    const now = new Date(2026, 7, 2, 10, 0);
    expect(shouldRunMissedBenchmarkRefresh(now, readBenchmarkRefreshConfig(), null)).toBe(true);
    expect(
      shouldRunMissedBenchmarkRefresh(
        now,
        readBenchmarkRefreshConfig(),
        new Date(2026, 7, 2, 8, 59).getTime(),
      ),
    ).toBe(true);
    expect(
      shouldRunMissedBenchmarkRefresh(
        now,
        readBenchmarkRefreshConfig(),
        new Date(2026, 7, 2, 9, 30).getTime(),
      ),
    ).toBe(false);
  });

  it('deduplicates provider/model identities using the strongest evidence', () => {
    const result = deduplicateBenchmarkRows([
      row('GPT-X', 10, 100),
      row(' gpt-x ', 20, 90),
      row('Other', 5, 100),
    ]);
    expect(result.duplicateCount).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(
      result.rows.find((candidate) => candidate.model.trim().toLowerCase() === 'gpt-x')?.votes,
    ).toBe(20);
  });

  it('records one audit for concurrent refresh requests', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedFetchBenchmarks.mockImplementationOnce(async () => {
      await gate;
      return {
        rows: [row('GPT-X', 10, 100)],
        fromSnapshot: false,
        dataset: {
          metricLabel: 'Arena score',
          sourceName: 'LMArena',
          sourceUrl: 'https://lmarena.ai/leaderboard',
          benchmarkDate: 100,
          ingestedAt: 100,
          confidence: 'high',
          normalizationNote: 'Arena only.',
        },
      };
    });

    const first = refreshBenchmarkDataset('scheduled');
    const second = refreshBenchmarkDataset('manual');
    release?.();
    const [left, right] = await Promise.all([first, second]);

    expect(mockedFetchBenchmarks).toHaveBeenCalledTimes(1);
    expect(left.audit.id).toBe(right.audit.id);
    expect(left.audit.trigger).toBe('scheduled');
  });
});
