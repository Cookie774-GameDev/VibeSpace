import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';

const fixtures = vi.hoisted(() => {
  const fetchedAt = Date.parse('2026-07-11T12:00:00Z');
  const rows = Array.from({ length: 12 }, (_, index) => ({
    model: `Schema Model ${index + 1}`,
    provider: index < 8 ? 'Provider A' : 'Provider B',
    arena_score: 68 - index,
    ci_low: 68 - index,
    ci_high: 68 - index,
    open_source: index >= 9,
    license: index >= 9 ? 'MIT' : 'proprietary',
    cost_per_1m_input_usd: index + 1,
    cost_per_1m_output_usd: index + 2,
    context_window: 128_000,
    supports_image: true,
    supports_video: false,
    source: 'snapshot' as const,
    fetched_at: fetchedAt,
  }));

  return { fetchedAt, rows };
});

vi.mock('./benchmarkData', () => ({
  fetchBenchmarks: vi.fn(async () => ({
    rows: fixtures.rows,
    fromSnapshot: true,
    dataset: {
      sourceName: 'Artificial Analysis',
      sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
      metricLabel: 'Artificial Analysis Intelligence Index',
      benchmarkDate: fixtures.fetchedAt,
      ingestedAt: fixtures.fetchedAt,
      confidence: 'high',
    },
  })),
  isSupportedProvider: () => false,
}));

vi.mock('@/stores/auth', () => {
  const setDefaultProvider = vi.fn();
  const useAuthStore = Object.assign(
    (selector: (state: { setDefaultProvider: typeof setDefaultProvider }) => unknown) =>
      selector({ setDefaultProvider }),
    { getState: () => ({ setDefaultProvider }) },
  );
  return { useAuthStore };
});

import { BenchmarksPage } from './BenchmarksPage';
import { fetchBenchmarks } from './benchmarkData';

describe('BenchmarksPage Warm Schema B', () => {
  beforeEach(() => {
    useUIStore.setState({ theme: 'warm' });
    document.documentElement.setAttribute('data-theme', 'warm');
  });

  afterEach(() => {
    cleanup();
    useUIStore.setState({ theme: 'default' });
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  it('uses the reference-composed Warm surface while keeping the complete table available', async () => {
    const { container } = render(<BenchmarksPage />);
    await screen.findByText('from snapshot');

    const route = container.querySelector<HTMLElement>('[data-warm-page="benchmarks"]');
    expect(route).not.toBeNull();
    expect(route?.querySelector('[data-warm-surface="benchmarks-header"]')).not.toBeNull();
    expect(route?.querySelector('[data-warm-surface="benchmarks-warning"]')).not.toBeNull();
    expect(route?.querySelector('[data-warm-surface="benchmarks-filters"]')).not.toBeNull();
    expect(route?.querySelector('[data-warm-surface="benchmarks-chart"]')).not.toBeNull();
    const scenicPlate = route?.querySelectorAll('[data-warm-decoration="benchmarks-scene"] > img');
    expect(scenicPlate).toHaveLength(1);
    expect(route?.querySelector('[data-warm-decoration="benchmarks-scene"]')?.className).toContain(
      'hidden',
    );
    expect(scenicPlate?.[0]?.getAttribute('src')).toBe(
      '/assets/themes/warm/benchmarks/continuation-v2/benchmark-scroll-composite-v2.webp',
    );
    expect(scenicPlate?.[0]?.getAttribute('alt')).toBe('');
    for (const asset of [
      'benchmark-scroll-01.webp',
      'benchmark-scroll-02.webp',
      'benchmark-scroll-03.webp',
      'benchmark-scroll-04-v2.webp',
      'benchmark-scroll-05.webp',
    ]) {
      expect(
        existsSync(
          resolve(
            __dirname,
            `../../../public/assets/themes/warm/benchmarks/continuation-v2/${asset}`,
          ),
        ),
      ).toBe(true);
    }

    const chart = within(route!).getByRole('img');
    expect(chart.getAttribute('aria-label')).toBe('Bar chart of top 12 models by arena score');
    expect(within(chart).getByText('Schema Model 12')).toBeTruthy();

    const table = route!.querySelector('[data-monochrome-surface="benchmarks-table"]');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('Schema Model 12');
  });

  it('keeps provider and open-source filters functional in the reference layout', async () => {
    const { container } = render(<BenchmarksPage />);
    await screen.findByText('from snapshot');

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'Provider B' } });
    expect(screen.getByText('4 of 12 models')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Open source only' }));
    expect(screen.getByText('3 of 12 models')).toBeTruthy();

    const chart = container.querySelector('[data-warm-surface="benchmarks-chart"]');
    expect(chart?.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Bar chart of top 3 models by arena score',
    );
  });

  it('contains all 50 leaderboard models in a compact independently scrollable Warm table', async () => {
    const fiftyRows = Array.from({ length: 50 }, (_, index) => ({
      ...fixtures.rows[index % fixtures.rows.length],
      model: `Full Leaderboard Model ${index + 1}`,
      arena_score: 100 - index,
    }));
    vi.mocked(fetchBenchmarks).mockResolvedValueOnce({
      rows: fiftyRows,
      fromSnapshot: true,
      dataset: {
        sourceName: 'Artificial Analysis',
        sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
        metricLabel: 'Artificial Analysis Intelligence Index',
        benchmarkDate: fixtures.fetchedAt,
        ingestedAt: fixtures.fetchedAt,
        confidence: 'high',
        normalizationNote: 'Deterministic test fixture.',
      },
    });

    const { container } = render(<BenchmarksPage />);
    await screen.findByText('Full Leaderboard Model 50');

    const tableSurface = container.querySelector('[data-monochrome-surface="benchmarks-table"]');
    const scrollRegion = tableSurface?.querySelector(
      '[data-warm-region="benchmarks-table-scroll"]',
    );
    expect(tableSurface?.getAttribute('data-warm-table-mode')).toBe('compact-scroll');
    expect(scrollRegion?.className).toContain('overflow-auto');
    expect(tableSurface?.querySelectorAll('tbody tr')).toHaveLength(50);

    const chart = within(container).getByRole('img');
    expect(chart.getAttribute('aria-label')).toBe('Bar chart of top 25 models by arena score');
    expect(chart.querySelectorAll(':scope > g:not([aria-hidden])')).toHaveLength(25);
  });

  it('keeps Refresh real, disabled while loading, and recoverable after completion', async () => {
    render(<BenchmarksPage />);
    await screen.findByText('from snapshot');

    let resolveRefresh: ((value: Awaited<ReturnType<typeof fetchBenchmarks>>) => void) | undefined;
    const pendingRefresh = new Promise<Awaited<ReturnType<typeof fetchBenchmarks>>>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.mocked(fetchBenchmarks).mockImplementationOnce(() => pendingRefresh);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const loadingButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Fetching…' });
    expect(loadingButton.disabled).toBe(true);

    resolveRefresh?.({
      rows: fixtures.rows,
      fromSnapshot: true,
      dataset: {
        sourceName: 'Artificial Analysis',
        sourceUrl: 'https://artificialanalysis.ai/leaderboards/models',
        metricLabel: 'Artificial Analysis Intelligence Index',
        benchmarkDate: fixtures.fetchedAt,
        ingestedAt: fixtures.fetchedAt,
        confidence: 'high',
        normalizationNote: 'Deterministic test fixture.',
      },
    });

    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(
        false,
      ),
    );
  });
});
