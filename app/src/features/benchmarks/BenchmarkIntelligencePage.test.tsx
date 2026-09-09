import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchBenchmarkLeaderboard: vi.fn() }));
vi.mock('./benchmarkApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./benchmarkApi')>()),
  fetchBenchmarkLeaderboard: api.fetchBenchmarkLeaderboard,
}));

import { BenchmarkIntelligencePage } from './BenchmarkIntelligencePage';

const rows = [
  {
    id: 'a|max',
    rank: 1,
    provider: 'Anthropic',
    model: 'Claude Opus 5 (Max Effort)',
    effort: 'max',
    intelligenceIndex: 61,
    inputPricePer1MTokensUsd: 5,
    outputPricePer1MTokensUsd: 25,
    costPerTaskUsd: 0.5,
    outputTokensPerSecond: 80,
    timeToFirstTokenSeconds: 0.8,
    contextWindowTokens: 200000,
    openWeights: false,
    sourceName: 'Artificial Analysis' as const,
    sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
    sourceObservedAt: '2026-08-14T23:00:00.000Z',
    ingestedAt: '2026-08-14T23:07:00.000Z',
  },
  {
    id: 'b|max',
    rank: 2,
    provider: 'OpenAI',
    model: 'GPT-5.6 Sol (max)',
    effort: 'max',
    intelligenceIndex: 59,
    inputPricePer1MTokensUsd: 2,
    outputPricePer1MTokensUsd: 12,
    costPerTaskUsd: 0.3,
    outputTokensPerSecond: 100,
    timeToFirstTokenSeconds: 0.5,
    contextWindowTokens: 400000,
    openWeights: false,
    sourceName: 'Artificial Analysis' as const,
    sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
    sourceObservedAt: '2026-08-14T23:00:00.000Z',
    ingestedAt: '2026-08-14T23:07:00.000Z',
  },
];

describe('BenchmarkIntelligencePage', () => {
  it('refreshes an open page hourly and removes its timer on unmount', async () => {
    vi.useFakeTimers();
    try {
      const view = render(<BenchmarkIntelligencePage />);
      await act(async () => { await Promise.resolve(); });
      const initial = api.fetchBenchmarkLeaderboard.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
      expect(api.fetchBenchmarkLeaderboard.mock.calls.length).toBe(initial + 1);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
      expect(api.fetchBenchmarkLeaderboard.mock.calls.length).toBe(initial + 1);
    } finally { vi.useRealTimers(); }
  });
  beforeEach(() => {
    api.fetchBenchmarkLeaderboard.mockResolvedValue({
      generatedAt: '2026-08-14T23:08:00.000Z',
      freshness: { state: 'fresh', ageMs: 60000 },
      dataset: {
        source: 'Artificial Analysis',
        metric: 'Artificial Analysis Intelligence Index',
        sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
        sourceObservedAt: '2026-08-14T23:00:00.000Z',
        ingestedAt: '2026-08-14T23:07:00.000Z',
        rowCount: 2,
      },
      rows,
      fromCache: false,
    });
  });

  it('renders Artificial Analysis and excludes the removed comparison/valuation UI', async () => {
    const { container } = render(<BenchmarkIntelligencePage />);
    expect((await screen.findAllByText('Claude Opus 5 (Max Effort)')).length).toBe(2);
    expect(screen.getAllByText('Artificial Analysis').length).toBeGreaterThan(0);
    expect(screen.queryByText(/New model comparison/i)).toBeNull();
    expect(screen.queryByText(/Official provider valuations/i)).toBeNull();
    expect(container.querySelector('[data-warm-surface="benchmarks-chart"]')).toBeTruthy();
    expect(container.querySelector('[data-warm-surface="benchmarks-filters"]')).toBeTruthy();
    expect(container.querySelector('[data-monochrome-surface="benchmarks-table"]')).toBeTruthy();
    expect(container.querySelector('[data-warm-region="benchmarks-table-scroll"]')).toBeTruthy();
  });

  it('never presents cached or failed data as fresh', async () => {
    api.fetchBenchmarkLeaderboard.mockResolvedValueOnce({
      generatedAt: '2026-08-14T23:08:00.000Z',
      freshness: { state: 'failed' },
      dataset: null,
      rows: [],
      fromCache: false,
    });
    render(<BenchmarkIntelligencePage />);
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(/^Fresh$/u)).toBeNull();
  });

  it('shows unverified pagination as degraded instead of a green fresh badge', async () => {
    api.fetchBenchmarkLeaderboard.mockResolvedValueOnce({
      generatedAt: '2026-08-14T23:08:00.000Z',
      freshness: { state: 'fresh' },
      dataset: {
        source: 'Artificial Analysis',
        metric: 'Artificial Analysis Intelligence Index',
        sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
        sourceObservedAt: '2026-08-14T23:00:00.000Z',
        ingestedAt: '2026-08-14T23:07:00.000Z',
        rowCount: 2,
        completeness: {
          state: 'unverified',
          reason: 'The backend did not provide a complete Artificial Analysis page-set receipt.',
        },
      },
      latestRun: { status: 'success', completedAt: '2026-08-14T23:07:00.000Z', errorCodes: [] },
      rows,
      fromCache: false,
    });
    render(<BenchmarkIntelligencePage />);
    expect(await screen.findByText('Degraded')).toBeTruthy();
    expect(screen.queryByText(/^Fresh$/u)).toBeNull();
    expect(screen.getByText('Dataset completeness: unverified')).toBeTruthy();
  });

  it('sorts by exact-row input price and output speed', async () => {
    render(<BenchmarkIntelligencePage />);
    await screen.findAllByText('Claude Opus 5 (Max Effort)');
    const sort = screen.getByLabelText('Sort');
    fireEvent.change(sort, { target: { value: 'inputPrice' } });
    const modelCells = screen
      .getAllByRole('cell')
      .filter((cell) => /Claude Opus 5|GPT-5.6 Sol/.test(cell.textContent ?? ''));
    expect(modelCells[0]?.textContent).toContain('GPT-5.6 Sol');

    fireEvent.change(sort, { target: { value: 'speed' } });
    await waitFor(() => {
      const cells = screen
        .getAllByRole('cell')
        .filter((cell) => /Claude Opus 5|GPT-5.6 Sol/.test(cell.textContent ?? ''));
      expect(cells[0]?.textContent).toContain('GPT-5.6 Sol');
    });
  });

  it('disambiguates genuine upstream variants with the same provider and model label', async () => {
    const sameLabelVariants = [
      {
        ...rows[0]!,
        id: 'anthropic|claude-opus-5|max',
        model: 'Claude Opus 5',
        variantLabel: 'Adaptive Reasoning',
        effort: 'max',
      },
      {
        ...rows[0]!,
        id: 'anthropic|claude-opus-5|xhigh',
        rank: 2,
        model: 'Claude Opus 5',
        variantLabel: 'Adaptive Reasoning',
        effort: 'xhigh',
        intelligenceIndex: 60,
      },
    ];
    api.fetchBenchmarkLeaderboard.mockResolvedValueOnce({
      generatedAt: '2026-08-14T23:08:00.000Z',
      freshness: { state: 'fresh', ageMs: 60000 },
      dataset: {
        source: 'Artificial Analysis',
        metric: 'Artificial Analysis Intelligence Index',
        sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
        sourceObservedAt: '2026-08-14T23:00:00.000Z',
        ingestedAt: '2026-08-14T23:07:00.000Z',
        rowCount: 2,
      },
      rows: sameLabelVariants,
      fromCache: false,
    });

    render(<BenchmarkIntelligencePage />);

    expect(
      await screen.findAllByText('Claude Opus 5 — Adaptive Reasoning · effort: max'),
    ).toHaveLength(2);
    expect(screen.getAllByText('Claude Opus 5 — Adaptive Reasoning · effort: xhigh')).toHaveLength(
      2,
    );
    expect(screen.queryByText(/^Claude Opus 5$/u)).toBeNull();
  });

  it('contains every filter control inside its responsive grid track', async () => {
    const { container } = render(<BenchmarkIntelligencePage />);
    await screen.findAllByText('Claude Opus 5 (Max Effort)');

    const filters = container.querySelector('[data-warm-surface="benchmarks-filters"]');
    const grid = filters?.firstElementChild;
    expect(grid?.classList.contains('min-w-0')).toBe(true);

    for (const label of ['Provider', 'Weights', 'Reasoning effort', 'Sort']) {
      const control = screen.getByLabelText<HTMLSelectElement>(label);
      expect(control.parentElement?.classList.contains('min-w-0')).toBe(true);
      expect(control.classList.contains('box-border')).toBe(true);
      expect(control.classList.contains('!min-w-0')).toBe(true);
      expect(control.classList.contains('max-w-full')).toBe(true);
    }
  });
});
