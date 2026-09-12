import * as React from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  blendedTokenPrice,
  fetchBenchmarkLeaderboard,
  getCachedBenchmarkLeaderboard,
  intelligencePerDollar,
  type BenchmarkFetchResult,
  type BenchmarkModelRow,
} from './benchmarkApi';
import './sakura-benchmarks.css';

type SortKey =
  | 'intelligence'
  | 'costPerTask'
  | 'inputPrice'
  | 'outputPrice'
  | 'blendedPrice'
  | 'intelligencePerDollar'
  | 'speed'
  | 'ttft'
  | 'context';

type OwnershipFilter = 'all' | 'open' | 'proprietary';

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string; direction: 'asc' | 'desc' }> = [
  { value: 'intelligence', label: 'Intelligence', direction: 'desc' },
  { value: 'costPerTask', label: 'Cost per task', direction: 'asc' },
  { value: 'inputPrice', label: 'Input price / 1M', direction: 'asc' },
  { value: 'outputPrice', label: 'Output price / 1M', direction: 'asc' },
  { value: 'blendedPrice', label: 'Blended token price (derived)', direction: 'asc' },
  {
    value: 'intelligencePerDollar',
    label: 'Intelligence per dollar (derived)',
    direction: 'desc',
  },
  { value: 'speed', label: 'Output speed', direction: 'desc' },
  { value: 'ttft', label: 'Time to first token', direction: 'asc' },
  { value: 'context', label: 'Context window', direction: 'desc' },
];

const WARM_BENCHMARK_SCENE_ASSET =
  '/assets/themes/warm/benchmarks/continuation-v2/benchmark-scroll-composite-v2.webp';

function numberForSort(row: BenchmarkModelRow, key: SortKey): number | null {
  switch (key) {
    case 'intelligence':
      return row.intelligenceIndex;
    case 'costPerTask':
      return row.costPerTaskUsd ?? null;
    case 'inputPrice':
      return row.inputPricePer1MTokensUsd ?? null;
    case 'outputPrice':
      return row.outputPricePer1MTokensUsd ?? null;
    case 'blendedPrice':
      return blendedTokenPrice(row);
    case 'intelligencePerDollar':
      return intelligencePerDollar(row);
    case 'speed':
      return row.outputTokensPerSecond ?? null;
    case 'ttft':
      return row.timeToFirstTokenSeconds ?? null;
    case 'context':
      return row.contextWindowTokens ?? null;
  }
}

export function sortBenchmarkRows(
  rows: readonly BenchmarkModelRow[],
  key: SortKey,
  direction: 'asc' | 'desc',
): BenchmarkModelRow[] {
  return rows.slice().sort((left, right) => {
    const leftValue = numberForSort(left, key);
    const rightValue = numberForSort(right, key);
    if (leftValue == null && rightValue == null) return left.rank - right.rank;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    const delta = leftValue - rightValue;
    if (delta === 0) return left.rank - right.rank;
    return direction === 'asc' ? delta : -delta;
  });
}

function normalizedDisplayIdentity(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function benchmarkDisplayNames(
  rows: readonly BenchmarkModelRow[],
): ReadonlyMap<string, string> {
  const groupCounts = new Map<string, number>();
  for (const row of rows) {
    const groupKey = `${normalizedDisplayIdentity(row.provider)}\u001f${normalizedDisplayIdentity(row.model)}`;
    groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1);
  }

  return new Map(
    rows.map((row) => {
      const groupKey = `${normalizedDisplayIdentity(row.provider)}\u001f${normalizedDisplayIdentity(row.model)}`;
      if ((groupCounts.get(groupKey) ?? 0) < 2) return [row.id, row.model] as const;
      const qualifiers = [
        row.variantLabel,
        row.effort ? `effort: ${row.effort}` : undefined,
      ].filter((value): value is string => Boolean(value));
      return [row.id, `${row.model} — ${qualifiers.join(' · ')}`] as const;
    }),
  );
}

function money(value: number | undefined | null, maximumFractionDigits = 3): string {
  if (value == null) return '—';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits })}`;
}

function compactNumber(value: number | undefined | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

function decimal(value: number | undefined | null, suffix = ''): string {
  if (value == null) return '—';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function fullTime(value: string | undefined): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusLabel(result: BenchmarkFetchResult | null): string {
  if (!result) return 'Loading';
  if (result.dataset?.completeness?.state === 'unverified' && result.freshness.state === 'fresh') {
    return 'Saved results';
  }
  if (result.fromCache || result.freshness.state === 'stale') return 'Saved results';
  if (result.freshness.state === 'degraded') return 'Saved results';
  if (['failed', 'never'].includes(result.freshness.state)) return 'Unavailable';
  return 'Fresh';
}

export function BenchmarkIntelligencePage() {
  const [result, setResult] = React.useState<BenchmarkFetchResult | null>(() =>
    getCachedBenchmarkLeaderboard(),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(!result);
  const [refreshing, setRefreshing] = React.useState(false);
  const [provider, setProvider] = React.useState('all');
  const [ownership, setOwnership] = React.useState<OwnershipFilter>('all');
  const [effort, setEffort] = React.useState('all');
  const [sortKey, setSortKey] = React.useState<SortKey>('intelligence');
  const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>('desc');
  const lastFetchRef = React.useRef(0);
  const mountedRef = React.useRef(false);
  const pendingRef = React.useRef(false);
  const [visibleCount, setVisibleCount] = React.useState(50);

  const load = React.useCallback(async (manual = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    if (manual) setRefreshing(true);
    try {
      const next = await fetchBenchmarkLeaderboard(undefined, { force: manual });
      if (!mountedRef.current) return;
      setResult(next);
      setError(null);
      lastFetchRef.current = Date.now();
    } catch {
      if (mountedRef.current)
        setError('Benchmarks are temporarily unavailable. Please try again shortly.');
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  React.useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastFetchRef.current >= 10 * 60 * 1000) void load();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void load(), 60 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [load]);

  const providers = React.useMemo(
    () => [...new Set(result?.rows.map((row) => row.provider) ?? [])].sort(),
    [result],
  );
  const efforts = React.useMemo(
    () =>
      [
        ...new Set((result?.rows ?? []).map((row) => row.effort).filter(Boolean) as string[]),
      ].sort(),
    [result],
  );
  const displayNames = React.useMemo(
    () => benchmarkDisplayNames(result?.rows ?? []),
    [result?.rows],
  );

  const filteredRows = React.useMemo(() => {
    const rows = (result?.rows ?? []).filter((row) => {
      if (provider !== 'all' && row.provider !== provider) return false;
      if (ownership === 'open' && row.openWeights !== true) return false;
      if (ownership === 'proprietary' && row.openWeights !== false) return false;
      if (effort !== 'all' && row.effort !== effort) return false;
      return true;
    });
    return sortBenchmarkRows(rows, sortKey, sortDirection);
  }, [effort, ownership, provider, result, sortDirection, sortKey]);

  React.useEffect(() => {
    setVisibleCount(50);
  }, [effort, ownership, provider, sortDirection, sortKey]);

  const chartRows = React.useMemo(
    () =>
      filteredRows
        .slice()
        .sort((left, right) => left.rank - right.rank)
        .slice(0, 12),
    [filteredRows],
  );
  const chartMax = Math.max(1, ...chartRows.map((row) => row.intelligenceIndex));

  const changeSort = (value: string) => {
    const option = SORT_OPTIONS.find((entry) => entry.value === value);
    if (!option) return;
    setSortKey(option.value);
    setSortDirection(option.direction);
  };

  return (
    <div
      data-monochrome-route="benchmarks"
      data-sakura-route="benchmarks"
      data-warm-page="benchmarks"
      className="bg-paper-soft min-h-full w-full [html[data-theme=monochrome]_&]:bg-background"
    >
      <div
        aria-hidden="true"
        className="hidden [html[data-theme=warm]_&]:block"
        data-warm-decoration="benchmarks-scene"
      >
        <img
          alt=""
          decoding="async"
          draggable={false}
          loading="eager"
          role="presentation"
          src={WARM_BENCHMARK_SCENE_ASSET}
        />
      </div>

      <main
        className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8"
        data-warm-surface="benchmarks-content"
      >
        <header
          className="flex flex-wrap items-start justify-between gap-4"
          data-warm-surface="benchmarks-header"
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-metadata uppercase tracking-wider text-muted-foreground">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  statusLabel(result) === 'Fresh' ? 'bg-success' : 'bg-warning',
                )}
              />
              <span>{statusLabel(result)}</span>
              <Badge variant="outline">Artificial Analysis</Badge>
            </div>
            <h1 className="font-display text-4xl font-semibold leading-tight text-foreground">
              Benchmarks
            </h1>
            <p className="max-w-3xl text-secondary text-muted-foreground">
              Artificial Analysis Intelligence Index rankings with exact evaluated variants, price,
              speed, latency, context, and clearly labeled VibeSpace-derived comparisons.
            </p>
            {result?.dataset ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-metadata text-muted-foreground">
                <span>{result.dataset.metric}</span>
                <span>Updated: {fullTime(result.dataset.sourceObservedAt)}</span>
                {result.dataset.methodologyVersion ? (
                  <span>Methodology: {result.dataset.methodologyVersion}</span>
                ) : null}
                <a
                  href={result.dataset.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  Source <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ) : null}
          </div>
          <Button
            variant="outline"
            onClick={() => void load(true)}
            disabled={refreshing || loading}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </header>

        {error && !result?.rows.length ? (
          <div
            role="status"
            className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground"
            data-warm-surface="benchmarks-warning"
          >
            <span>{error}</span>
          </div>
        ) : null}

        <section
          className="cozy-card rounded-2xl border border-border bg-paper p-5 shadow-soft"
          data-warm-surface="benchmarks-chart"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-semibold text-foreground">
                Top intelligence
              </h2>
              <p className="text-metadata text-muted-foreground">
                Independent evaluations · higher scores indicate stronger performance.
              </p>
            </div>
            <span className="text-metadata text-muted-foreground">
              {filteredRows.length} of {result?.rows.length ?? 0} rows
            </span>
          </div>
          {chartRows.length ? (
            <div className="space-y-2" aria-label="Artificial Analysis Intelligence Index chart">
              {chartRows.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[minmax(130px,240px)_1fr_3rem] items-center gap-3"
                >
                  <div className="min-w-0">
                    <div
                      title={displayNames.get(row.id) ?? row.model}
                      className="text-sm font-medium leading-snug text-foreground"
                    >
                      {displayNames.get(row.id) ?? row.model}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{row.provider}</div>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-accent-copper transition-[width]"
                      style={{ width: `${Math.max(2, (row.intelligenceIndex / chartMax) * 100)}%` }}
                    />
                  </div>
                  <div className="text-right font-mono text-sm font-semibold text-foreground">
                    {row.intelligenceIndex}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {loading
                ? 'Loading benchmarks…'
                : result?.rows.length
                  ? 'No models match these filters.'
                  : 'Results will appear here when available.'}
            </p>
          )}
        </section>

        <section
          className="cozy-card rounded-2xl border border-border bg-paper p-5 shadow-soft"
          data-warm-surface="benchmarks-filters"
        >
          <div className="grid min-w-0 gap-3 md:grid-cols-4">
            <label className="min-w-0 space-y-1 text-metadata text-muted-foreground">
              <span>Provider</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="box-border h-9 w-full !min-w-0 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="all">All providers</option>
                {providers.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 space-y-1 text-metadata text-muted-foreground">
              <span>Weights</span>
              <select
                value={ownership}
                onChange={(event) => setOwnership(event.target.value as OwnershipFilter)}
                className="box-border h-9 w-full !min-w-0 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="all">Open + proprietary</option>
                <option value="open">Open weights</option>
                <option value="proprietary">Proprietary</option>
              </select>
            </label>
            <label className="min-w-0 space-y-1 text-metadata text-muted-foreground">
              <span>Reasoning effort</span>
              <select
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
                className="box-border h-9 w-full !min-w-0 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="all">All effort variants</option>
                {efforts.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 space-y-1 text-metadata text-muted-foreground">
              <span>Sort</span>
              <select
                value={sortKey}
                onChange={(event) => changeSort(event.target.value)}
                className="box-border h-9 w-full !min-w-0 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            Blended token price is a VibeSpace-derived 3:1 input/output average: (3 × input +
            output) ÷ 4. Intelligence per dollar is derived only when Artificial Analysis supplies
            cost per task for the exact row.
          </p>
        </section>

        <section
          className="cozy-card rounded-2xl border border-border bg-paper p-5 shadow-soft"
          data-monochrome-surface="benchmarks-table"
          data-sakura-surface="benchmarks-table"
          data-warm-table-mode="compact-scroll"
        >
          <div
            className="overflow-x-auto"
            data-warm-region="benchmarks-table-scroll"
            tabIndex={0}
            aria-label="Scrollable Artificial Analysis benchmark table"
          >
            <table className="w-full min-w-[1280px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-3">Rank</th>
                  <th className="px-2 py-3">Model / exact variant</th>
                  <th className="px-2 py-3 text-right">Intelligence</th>
                  <th className="px-2 py-3 text-right">Cost / task</th>
                  <th className="px-2 py-3 text-right">Input / 1M</th>
                  <th className="px-2 py-3 text-right">Output / 1M</th>
                  <th className="px-2 py-3 text-right">Blended*</th>
                  <th className="px-2 py-3 text-right">Intel / $*</th>
                  <th className="px-2 py-3 text-right">Output speed</th>
                  <th className="px-2 py-3 text-right">TTFT</th>
                  <th className="px-2 py-3 text-right">Context</th>
                  <th className="px-2 py-3">Weights</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, visibleCount).map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/60 align-top hover:bg-muted/30"
                  >
                    <td className="px-2 py-3 font-mono text-muted-foreground">#{row.rank}</td>
                    <td className="px-2 py-3">
                      <div className="font-medium text-foreground">
                        {displayNames.get(row.id) ?? row.model}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                        <span>{row.provider}</span>
                        {row.variantLabel ? <span>{row.variantLabel}</span> : null}
                        {row.effort ? <span>Effort: {row.effort}</span> : null}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-right font-mono text-base font-semibold text-foreground">
                      {row.intelligenceIndex}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {money(row.costPerTaskUsd, 4)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {money(row.inputPricePer1MTokensUsd)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {money(row.outputPricePer1MTokensUsd)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {money(blendedTokenPrice(row))}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {decimal(intelligencePerDollar(row))}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {decimal(row.outputTokensPerSecond, ' t/s')}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {decimal(row.timeToFirstTokenSeconds, ' s')}
                    </td>
                    <td className="px-2 py-3 text-right font-mono">
                      {compactNumber(row.contextWindowTokens)}
                    </td>
                    <td className="px-2 py-3">
                      {row.openWeights == null ? '—' : row.openWeights ? 'Open' : 'Proprietary'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visibleCount < filteredRows.length ? (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setVisibleCount((count) => count + 50)}
            >
              Show more models ({Math.min(visibleCount, filteredRows.length)} of{' '}
              {filteredRows.length})
            </Button>
          ) : null}
        </section>
      </main>
    </div>
  );
}
