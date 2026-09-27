import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchBenchmarkLeaderboard: vi.fn(),
  getCachedBenchmarkLeaderboard: vi.fn(() => null),
}));
vi.mock('./benchmarkApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./benchmarkApi')>()),
  fetchBenchmarkLeaderboard: api.fetchBenchmarkLeaderboard,
  getCachedBenchmarkLeaderboard: api.getCachedBenchmarkLeaderboard,
}));

import { BenchmarkIntelligencePage, contextForBenchmarkRow } from './BenchmarkIntelligencePage';

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
  it('shows only Overall, Speed, and Cost and allows returning to Overall', async () => {
    render(<BenchmarkIntelligencePage />);
    await screen.findAllByText('Claude Opus 5 (Max Effort)');
    const categories = screen.getByRole('navigation', { name: 'Benchmark categories' });
    expect([...categories.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Overall',
      'Speed',
      'Cost',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Speed' }));
    expect(screen.getByRole('heading', { name: 'Speed ranking' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cost' }));
    expect(screen.getByRole('heading', { name: 'Cost ranking' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Overall' }));
    expect(screen.getByRole('heading', { name: 'Overall ranking' })).toBeTruthy();
  });

  it('shows the SpaceXAI logo and marks a failed image as unavailable', async () => {
    const saved = await api.fetchBenchmarkLeaderboard();
    api.fetchBenchmarkLeaderboard.mockResolvedValueOnce({
      ...saved,
      rows: [{ ...rows[0], id: 'grok', provider: 'SpaceXAI', model: 'Grok 4.7' }],
    });
    render(<BenchmarkIntelligencePage />);
    const mark = await screen.findByLabelText('SpaceXAI logo');
    const image = mark.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/benchmark-provider-logos/spacexai.svg');
    expect(mark.textContent).toBe('');
    fireEvent.error(image!);
    expect(screen.getByLabelText('SpaceXAI logo unavailable').querySelector('img')).toBeNull();
  });

  it('uses feed context first and exact provider docs only when the feed omits it', () => {
    expect(contextForBenchmarkRow(rows[1]!)).toMatchObject({
      tokens: 400000,
      sourceName: 'Artificial Analysis feed',
    });
    expect(contextForBenchmarkRow({ ...rows[1]!, contextWindowTokens: undefined })).toMatchObject({
      tokens: 1050000,
      sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
    });
    expect(
      contextForBenchmarkRow({
        ...rows[0]!,
        model: 'Claude Unknown 5',
        contextWindowTokens: undefined,
      }),
    ).toBeNull();
    expect(
      contextForBenchmarkRow({
        ...rows[0]!,
        model: 'Claude Opus 5.5 (max)',
        contextWindowTokens: undefined,
      })?.tokens,
    ).toBe(1_000_000);
    expect(
      contextForBenchmarkRow({
        ...rows[0]!,
        provider: 'Meta',
        model: 'Muse Spark 1.3 (max)',
        contextWindowTokens: undefined,
      })?.tokens,
    ).toBe(1_048_576);
  });
  it('refreshes an open page hourly and removes its timer on unmount', async () => {
    vi.useFakeTimers();
    try {
      const view = render(<BenchmarkIntelligencePage />);
      await act(async () => {
        await Promise.resolve();
      });
      const initial = api.fetchBenchmarkLeaderboard.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      });
      expect(api.fetchBenchmarkLeaderboard.mock.calls.length).toBe(initial + 1);
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      });
      expect(api.fetchBenchmarkLeaderboard.mock.calls.length).toBe(initial + 1);
    } finally {
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    api.getCachedBenchmarkLeaderboard.mockReturnValue(null);
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

  it('renders saved models immediately while a refresh is pending', async () => {
    const saved = await api.fetchBenchmarkLeaderboard();
    api.getCachedBenchmarkLeaderboard.mockReturnValueOnce(saved);
    api.fetchBenchmarkLeaderboard.mockReturnValueOnce(new Promise(() => {}));
    render(<BenchmarkIntelligencePage />);
    expect(screen.getAllByText('Claude Opus 5 (Max Effort)')).toHaveLength(1);
    expect(screen.queryByText('Loading benchmarks…')).toBeNull();
  });

  it('renders a bounded table while keeping every model reachable', async () => {
    const saved = await api.fetchBenchmarkLeaderboard();
    api.fetchBenchmarkLeaderboard.mockResolvedValueOnce({
      ...saved,
      rows: Array.from({ length: 120 }, (_, index) => ({
        ...rows[0],
        id: `model-${index}`,
        model: `Model ${index}`,
        rank: index + 1,
      })),
    });
    render(<BenchmarkIntelligencePage />);
    fireEvent.click(screen.getByRole('button', { name: /^table$/i }));
    await screen.findByText('Show more models (50 of 120)');
    expect(screen.getAllByRole('row')).toHaveLength(51);
    fireEvent.click(screen.getByRole('button', { name: 'Show more models (50 of 120)' }));
    expect(screen.getAllByRole('row')).toHaveLength(101);
    fireEvent.click(screen.getByRole('button', { name: 'Show more models (100 of 120)' }));
    expect(screen.getAllByRole('row')).toHaveLength(121);
  });

  it('renders Artificial Analysis and excludes the removed comparison/valuation UI', async () => {
    const { container } = render(<BenchmarkIntelligencePage />);
    expect((await screen.findAllByText('Claude Opus 5 (Max Effort)')).length).toBe(1);
    expect(screen.getAllByText('Artificial Analysis').length).toBeGreaterThan(0);
    expect(screen.queryByText(/New model comparison/i)).toBeNull();
    expect(screen.queryByText(/Official provider valuations/i)).toBeNull();
    expect(container.querySelector('[data-warm-surface="benchmarks-chart"]')).toBeTruthy();
    expect(container.querySelector('[data-warm-surface="benchmarks-filters"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^table$/i }));
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
    expect(await screen.findByText('Saved results')).toBeTruthy();
    expect(screen.queryByText(/^Fresh$/u)).toBeNull();
    expect(screen.queryByText('Dataset completeness: unverified')).toBeNull();
  });

  it('sorts by exact-row input price and output speed', async () => {
    render(<BenchmarkIntelligencePage />);
    fireEvent.click(screen.getByRole('button', { name: /^table$/i }));
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

  it('keeps backend diagnostics out of the customer page', async () => {
    const value = await api.fetchBenchmarkLeaderboard();
    api.fetchBenchmarkLeaderboard.mockResolvedValueOnce({
      ...value,
      freshness: { state: 'degraded', warning: 'Internal D1 error AA_DUPLICATE_VARIANT' },
      latestRun: { status: 'failed', errorCodes: ['AA_DUPLICATE_VARIANT'] },
    });
    render(<BenchmarkIntelligencePage />);
    await screen.findAllByText('Claude Opus 5 (Max Effort)');
    expect(screen.queryByText(/AA_DUPLICATE_VARIANT|D1|backend|Ingested:/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh benchmarks' })).toBeTruthy();
    expect(screen.getByText('Saved results')).toBeTruthy();
  });

  it('uses a neutral retry message for an unavailable first load', async () => {
    api.fetchBenchmarkLeaderboard.mockRejectedValueOnce(new Error('private backend /sql/query'));
    render(<BenchmarkIntelligencePage />);
    expect(
      await screen.findByText('Benchmarks are temporarily unavailable. Please try again shortly.'),
    ).toBeTruthy();
    expect(screen.queryByText(/private backend|sql\/query|Arena\/Elo/)).toBeNull();
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
    ).toHaveLength(1);
    expect(screen.getAllByText('Claude Opus 5 — Adaptive Reasoning · effort: xhigh')).toHaveLength(
      1,
    );
    expect(screen.queryByText(/^Claude Opus 5$/u)).toBeNull();
  });

  it('contains every filter control inside its responsive grid track', async () => {
    const { container } = render(<BenchmarkIntelligencePage />);
    await screen.findAllByText('Claude Opus 5 (Max Effort)');

    const filters = container.querySelector('[data-warm-surface="benchmarks-filters"]');
    const grid = filters?.firstElementChild;
    expect(grid?.classList.contains('min-w-0')).toBe(true);

    expect(screen.getByLabelText('Models')).toBeTruthy();
    for (const label of ['Weights', 'Reasoning effort', 'Sort']) {
      const control = screen.getByLabelText<HTMLSelectElement>(label);
      expect(control.parentElement?.classList.contains('min-w-0')).toBe(true);
      expect(control.classList.contains('box-border')).toBe(true);
      expect(control.classList.contains('!min-w-0')).toBe(true);
      expect(control.classList.contains('max-w-full')).toBe(true);
    }
  });

  it('filters providers across the available categories', async () => {
    render(<BenchmarkIntelligencePage />);
    await screen.findByText('Claude Opus 5 (Max Effort)');
    fireEvent.change(screen.getByLabelText('Models'), { target: { value: 'OpenAI' } });
    expect(screen.queryByText('Claude Opus 5 (Max Effort)')).toBeNull();
    expect(screen.getByText('GPT-5.6 Sol (max)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Speed' }));
    expect(screen.getByText('GPT-5.6 Sol (max)')).toBeTruthy();
    expect(screen.getAllByText(/output tokens\/s/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cost' }));
    expect(screen.getByText('GPT-5.6 Sol (max)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cost ranking' })).toBeTruthy();
  });

  it('copies a source-dated leaderboard summary and confirms success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<BenchmarkIntelligencePage />);
    await screen.findByText('Claude Opus 5 (Max Effort)');
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('2026-08-14')),
    );
    expect(screen.getByRole('button', { name: /Copied/ })).toBeTruthy();
  });
});
