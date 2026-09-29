import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const fetchedAt = Date.now();
  return {
    fetchedAt,
    setDefaultProvider: vi.fn(),
    setSelectedModel: vi.fn(),
    rows: [
      {
        model: 'GPT-5.6 Sol',
        provider: 'openai',
        arena_score: 70,
        ci_low: 69,
        ci_high: 71,
        open_source: false,
        source: 'lmsys' as const,
        fetched_at: fetchedAt,
      },
      {
        model: 'Grok 999',
        provider: 'xai',
        arena_score: 69,
        ci_low: 68,
        ci_high: 70,
        open_source: false,
        source: 'lmsys' as const,
        fetched_at: fetchedAt,
      },
      {
        model: 'GPT-5.6 Sol',
        provider: 'xai',
        arena_score: 68,
        ci_low: 67,
        ci_high: 69,
        open_source: false,
        source: 'lmsys' as const,
        fetched_at: fetchedAt,
      },
    ],
  };
});

vi.mock('./benchmarkData', () => ({
  fetchBenchmarks: vi.fn(async () => ({
    rows: fixtures.rows,
    stale: false,
    unavailable: false,
    dataset: {
      sourceName: 'Arena',
      sourceUrl: 'https://arena.ai/leaderboard/text',
      metricLabel: 'Arena rating',
      benchmarkDate: fixtures.fetchedAt,
      ingestedAt: fixtures.fetchedAt,
      confidence: 'medium',
    },
  })),
  isSupportedProvider: (provider: string) => provider === 'openai' || provider === 'xai',
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (
    selector: (state: {
      setDefaultProvider: typeof fixtures.setDefaultProvider;
      setSelectedModel: typeof fixtures.setSelectedModel;
    }) => unknown,
  ) => selector(fixtures),
}));

import { BenchmarksPage } from './BenchmarksPage';

function openRow(model: string, provider?: string) {
  const row = [...document.querySelectorAll('tbody tr')].find(
    (candidate) =>
      candidate.textContent?.includes(model) &&
      (provider === undefined || candidate.textContent?.includes(provider)),
  );
  expect(row).toBeTruthy();
  fireEvent.click(row!);
}

describe('Benchmarks model preference', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('maps an exact benchmark name to the provider model ID before changing the default', async () => {
    render(<BenchmarksPage />);
    await screen.findAllByText('GPT-5.6 Sol');
    openRow('GPT-5.6 Sol');

    const drawer = screen.getByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set as default model' }));

    expect(fixtures.setDefaultProvider).toHaveBeenCalledExactlyOnceWith('openai');
    expect(fixtures.setSelectedModel).toHaveBeenCalledExactlyOnceWith('openai', 'gpt-5.6-sol');
  });

  it('does not claim an unmapped leaderboard name can be routed as an exact model', async () => {
    render(<BenchmarksPage />);
    await screen.findAllByText('Grok 999');
    openRow('Grok 999');

    const drawer = screen.getByRole('dialog');
    expect(within(drawer).queryByRole('button', { name: 'Set as default model' })).toBeNull();
    expect(within(drawer).getByText(/Exact model unavailable/)).toBeTruthy();
    expect(fixtures.setDefaultProvider).not.toHaveBeenCalled();
    expect(fixtures.setSelectedModel).not.toHaveBeenCalled();
  });

  it('keeps the provider identity when two rows share one model name', async () => {
    render(<BenchmarksPage />);
    await screen.findAllByText('GPT-5.6 Sol');
    openRow('GPT-5.6 Sol', 'xai');

    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('xai')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Set as default model' })).toBeNull();
    expect(fixtures.setDefaultProvider).not.toHaveBeenCalled();
    expect(fixtures.setSelectedModel).not.toHaveBeenCalled();
  });
});
