import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    render(<BenchmarkIntelligencePage />);
    expect((await screen.findAllByText('Claude Opus 5 (Max Effort)')).length).toBe(2);
    expect(screen.getAllByText('Artificial Analysis').length).toBeGreaterThan(0);
    expect(screen.queryByText(/New model comparison/i)).toBeNull();
    expect(screen.queryByText(/Official provider valuations/i)).toBeNull();
  });

  it('sorts by exact-row input price and output speed', async () => {
    render(<BenchmarkIntelligencePage />);
    await screen.findAllByText('Claude Opus 5 (Max Effort)');
    const sort = screen.getByLabelText('Sort');
    fireEvent.change(sort, { target: { value: 'inputPrice' } });
    const modelCells = screen.getAllByRole('cell').filter((cell) =>
      /Claude Opus 5|GPT-5.6 Sol/.test(cell.textContent ?? ''),
    );
    expect(modelCells[0]?.textContent).toContain('GPT-5.6 Sol');

    fireEvent.change(sort, { target: { value: 'speed' } });
    await waitFor(() => {
      const cells = screen.getAllByRole('cell').filter((cell) =>
        /Claude Opus 5|GPT-5.6 Sol/.test(cell.textContent ?? ''),
      );
      expect(cells[0]?.textContent).toContain('GPT-5.6 Sol');
    });
  });
});
