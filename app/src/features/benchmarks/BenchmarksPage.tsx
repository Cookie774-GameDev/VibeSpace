/**
 * BenchmarksPage — live AI model benchmark page for Jarvis.
 *
 * Shows a sortable, filterable table + horizontal bar chart of public
 * leaderboard scores. Data comes from `benchmarkData.fetchBenchmarks()`.
 * Only structured Arena rows are ranked; provider-published evaluations are
 * displayed separately with their exact benchmark and setup.
 *
 * The page is fully self-contained: no parent route wiring, no provider,
 * no shared state beyond reading `useAuthStore` to allow the detail
 * drawer to switch the user's default provider.
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  X as XIcon,
  ArrowDown,
  ArrowUp,
  Image as ImageIcon,
  Video as VideoIcon,
  Lock,
  Unlock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { cn, formatCost, formatRelative, formatTokenCount } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { fetchBenchmarks, isSupportedProvider, type BenchmarkRow } from './benchmarkData';
import { OFFICIAL_BENCHMARK_EVIDENCE } from './officialBenchmarkData';
import {
  BENCHMARK_REFRESH_COMPLETE_EVENT,
  type BenchmarkRefreshCompleteEvent,
} from './BenchmarkRefreshHost';
import { BarChart } from './BarChart';
import './sakura-benchmarks.css';

type SortKey = 'arena_score' | 'cost' | 'context';

const PROVIDER_FILTER_ALL = '__all__';
const TOP_N_FOR_CHART = 25;
const WARM_BENCHMARK_SCENE_ASSET =
  '/assets/themes/warm/benchmarks/continuation-v2/benchmark-scroll-composite-v2.webp';
/** Show at least this many rows before collapsing the rest behind a button. */
const MIN_VISIBLE_ROWS = 50;
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/models';

/** One-line capability summary used for the row hover tooltip. */
function rowTooltip(r: BenchmarkRow): string {
  const parts: string[] = [];
  parts.push(`${r.model} · ${r.provider}`);
  parts.push(
    r.open_source ? `Open source${r.license ? ` (${r.license})` : ''}` : 'Closed / proprietary',
  );
  if (r.cost_per_1m_input_usd != null || r.cost_per_1m_output_usd != null) {
    const i = r.cost_per_1m_input_usd != null ? `$${r.cost_per_1m_input_usd}` : '—';
    const o = r.cost_per_1m_output_usd != null ? `$${r.cost_per_1m_output_usd}` : '—';
    parts.push(`Price: ${i} in / ${o} out per 1M`);
  } else {
    parts.push('Price: not published');
  }
  const modalities = ['Text'];
  if (r.supports_image) modalities.push('Image');
  if (r.supports_video) modalities.push('Video');
  parts.push(`Inputs: ${modalities.join(', ')}`);
  const ciHalf = (r.ci_high - r.ci_low) / 2;
  parts.push(
    ciHalf > 0
      ? `Arena rating ${r.arena_score} (±${Math.round(ciHalf)})`
      : `Arena rating ${r.arena_score}`,
  );
  return parts.join('\n');
}

/** Heuristic: cost = average of input + output if both, else whichever is set,
 * else +Infinity so it sorts last. */
function costFor(r: BenchmarkRow): number {
  const i = r.cost_per_1m_input_usd;
  const o = r.cost_per_1m_output_usd;
  if (i != null && o != null) return (i + o) / 2;
  if (i != null) return i;
  if (o != null) return o;
  return Number.POSITIVE_INFINITY;
}

/** Approximate license severity bucket for the pill colour. */
function licenseSeverity(row: BenchmarkRow): 'low' | 'med' | 'high' | 'info' {
  const lic = (row.license || '').toLowerCase();
  if (!row.open_source) return 'high';
  if (lic.includes('mit') || lic.includes('apache')) return 'low';
  if (lic.includes('cc-by-nc') || lic.includes('community')) return 'med';
  return 'info';
}

export function BenchmarksPage() {
  const warmActive = useUIStore((state) => state.theme === 'warm');
  const [rows, setRows] = React.useState<BenchmarkRow[]>([]);
  const [refreshStale, setRefreshStale] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [dataset, setDataset] = React.useState<
    Awaited<ReturnType<typeof fetchBenchmarks>>['dataset'] | null
  >(null);

  const [providerFilter, setProviderFilter] = React.useState<string>(PROVIDER_FILTER_ALL);
  const [openOnly, setOpenOnly] = React.useState(false);
  const [sortKey, setSortKey] = React.useState<SortKey>('arena_score');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');

  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);

  // Apply a fetch result to all the relevant state slots in one shot.
  // Used by initial load, manual refresh, focus refresh, and polling so
  // the four code paths can't drift apart.
  const applyResult = React.useCallback((result: Awaited<ReturnType<typeof fetchBenchmarks>>) => {
    setRows(result.rows);
    setRefreshStale(result.stale === true);
    setUnavailable(result.unavailable === true);
    setFetchedAt(result.dataset?.benchmarkDate ?? Date.now());
    setDataset(result.dataset ?? null);
  }, []);

  // Initial load.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const result = await fetchBenchmarks();
      if (cancelled) return;
      applyResult(result);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyResult]);

  React.useEffect(() => {
    const onScheduledRefresh = (event: Event) => {
      const outcome = (event as BenchmarkRefreshCompleteEvent).detail;
      if (outcome?.result) applyResult(outcome.result);
    };
    window.addEventListener(BENCHMARK_REFRESH_COMPLETE_EVENT, onScheduledRefresh);
    return () => window.removeEventListener(BENCHMARK_REFRESH_COMPLETE_EVENT, onScheduledRefresh);
  }, [applyResult]);

  // Tick once a minute so the header relative-time stays fresh.
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const id = setInterval(force, 60_000);
    return () => clearInterval(id);
  }, []);

  // Auto-refresh when the user comes back to the window. Soft-refresh
  // (cache-respecting) so we don't blast the upstream every alt-tab.
  // `visibilitychange` covers blur->restore on Windows where `focus`
  // alone can miss; we listen to both.
  React.useEffect(() => {
    let cancelled = false;
    const onFocus = () => {
      if (cancelled) return;
      if (refreshing || loading) return;
      void fetchBenchmarks().then((result) => {
        if (!cancelled) applyResult(result);
      });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [applyResult, refreshing, loading]);

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await fetchBenchmarks({ force: true });
      applyResult(result);
      if (result.stale || result.unavailable) {
        toast.warning(
          result.unavailable ? 'Verified benchmark data unavailable' : 'Using last-known-good data',
          result.reason
            ? `Live fetch failed: ${result.reason}`
            : 'The last verified structured leaderboard remains available.',
        );
      } else {
        toast.success('Benchmarks refreshed', `${result.rows.length} models loaded`);
      }
    } catch (error) {
      toast.error(
        'Benchmark refresh failed',
        error instanceof Error ? error.message : 'The previous dataset remains available.',
      );
    } finally {
      setRefreshing(false);
    }
  }, [applyResult]);

  const stale =
    refreshStale || (fetchedAt != null && Date.now() - fetchedAt > 7 * 24 * 60 * 60 * 1000);

  // Distinct providers, sorted alphabetically.
  const providers = React.useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.provider));
    return Array.from(set).sort();
  }, [rows]);

  const filtered = React.useMemo(() => {
    return rows.filter((r) => {
      if (providerFilter !== PROVIDER_FILTER_ALL && r.provider !== providerFilter) {
        return false;
      }
      if (openOnly && !r.open_source) return false;
      return true;
    });
  }, [rows, providerFilter, openOnly]);

  const sorted = React.useMemo(() => {
    const arr = filtered.slice();
    arr.sort((a, b) => {
      let av: number;
      let bv: number;
      if (sortKey === 'arena_score') {
        av = a.arena_score;
        bv = b.arena_score;
      } else if (sortKey === 'cost') {
        av = costFor(a);
        bv = costFor(b);
      } else {
        av = a.context_window ?? 0;
        bv = b.context_window ?? 0;
      }
      const cmp = av - bv;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const topForChart = React.useMemo(() => {
    return filtered
      .slice()
      .sort((a, b) => b.arena_score - a.arena_score)
      .slice(0, TOP_N_FOR_CHART);
  }, [filtered]);
  const chartRows = topForChart;

  const visibleRows = React.useMemo(
    () => (showAll ? sorted : sorted.slice(0, MIN_VISIBLE_ROWS)),
    [sorted, showAll],
  );
  const hiddenCount = Math.max(0, sorted.length - visibleRows.length);

  // Collapse the table again whenever the filter set changes.
  React.useEffect(() => {
    setShowAll(false);
  }, [providerFilter, openOnly]);

  const selectedRow = React.useMemo(
    () => (selectedModel ? (rows.find((r) => r.model === selectedModel) ?? null) : null),
    [rows, selectedModel],
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Sensible defaults: scores high-first, cost low-first, context high-first.
      setSortDir(key === 'cost' ? 'asc' : 'desc');
    }
  };

  return (
    <div
      data-monochrome-route="benchmarks"
      data-sakura-route="benchmarks"
      data-warm-page="benchmarks"
      className="bg-paper-soft min-h-full w-full [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&_.cozy-card]:rounded-sm [html[data-theme=monochrome]_&_.cozy-card]:border [html[data-theme=monochrome]_&_.cozy-card]:border-border-mid [html[data-theme=monochrome]_&_.cozy-card]:bg-panel [html[data-theme=monochrome]_&_.cozy-card]:shadow-none"
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
      <div
        data-warm-surface="benchmarks-content"
        className="max-w-7xl mx-auto px-6 py-8 flex flex-col gap-6"
      >
        {/* Header */}
        <header
          data-warm-surface="benchmarks-header"
          className="flex items-start justify-between gap-4 flex-wrap"
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-metadata text-muted-foreground uppercase tracking-wider">
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  unavailable || stale ? 'bg-warning' : 'bg-success',
                )}
              />
              <span>
                {loading ? 'Loading' : unavailable ? 'Unavailable' : stale ? 'Stale' : 'Live'}
                {fetchedAt && ' · last fetched '}
                {fetchedAt && formatRelative(fetchedAt)}
              </span>
            </div>
            <h1 className="font-display text-foreground text-4xl font-semibold leading-tight">
              Benchmarks
            </h1>
            <p className="text-secondary text-muted-foreground max-w-xl">
              Hourly structured Arena rankings with source-linked official evaluations kept
              separate.
            </p>
            {dataset && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-metadata text-muted-foreground">
                <a
                  href={dataset.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  {dataset.sourceName}
                </a>
                <span>Metric: {dataset.metricLabel}</span>
                <span>Benchmark: {formatRelative(dataset.benchmarkDate)}</span>
                <span>Ingested: {formatRelative(dataset.ingestedAt)}</span>
                <span>Confidence: {dataset.confidence}</span>
              </div>
            )}
          </div>
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className={cn(
              'shrink-0',
              refreshing &&
                'border-accent-copper text-accent-copper shadow-[0_0_0_1px_hsl(var(--accent-copper)/0.4)]',
            )}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            {refreshing ? 'Fetching…' : 'Refresh'}
          </Button>
        </header>

        {stale && !loading && (
          <div
            data-warm-surface="benchmarks-warning"
            className="cozy-card !px-4 !py-3 flex items-center gap-2 border-warning/40 text-secondary"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            Benchmark data is stale. The last known dataset remains visible; use Refresh to retry
            verified structured sources.
          </div>
        )}

        {/* Filters row */}
        <section
          data-monochrome-surface="benchmarks-filters"
          data-sakura-surface="benchmarks-filters"
          data-warm-surface="benchmarks-filters"
          className="flex flex-wrap items-end gap-4 [html[data-theme=monochrome]_&]:border-y [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:py-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bench-provider">Provider</Label>
            <select
              id="bench-provider"
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className={cn(
                'flex h-8 rounded-md border border-input bg-background px-2 pr-7 text-body text-foreground min-w-[160px]',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors',
              )}
            >
              <option value={PROVIDER_FILTER_ALL}>All providers</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bench-sort">Sort by</Label>
            <select
              id="bench-sort"
              value={sortKey}
              onChange={(e) => {
                const k = e.target.value as SortKey;
                setSortKey(k);
                setSortDir(k === 'cost' ? 'asc' : 'desc');
              }}
              className={cn(
                'flex h-8 rounded-md border border-input bg-background px-2 pr-7 text-body text-foreground min-w-[160px]',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors',
              )}
            >
              <option value="arena_score">Arena rating</option>
              <option value="cost">Cost</option>
              <option value="context">Context window</option>
            </select>
          </div>

          <div className="flex items-center gap-2 h-8 self-end pb-1">
            <Switch
              id="bench-open"
              aria-labelledby="bench-open-label"
              checked={openOnly}
              onCheckedChange={setOpenOnly}
              className="[html[data-theme=monochrome]_&_span]:shadow-none"
            />
            <Label id="bench-open-label" htmlFor="bench-open" className="cursor-pointer">
              Open source only
            </Label>
          </div>

          <div className="flex-1" />

          <div className="text-metadata text-muted-foreground self-end pb-1">
            {filtered.length} of {rows.length} models
          </div>
        </section>

        {/* Bar chart */}
        <section
          data-monochrome-surface="benchmarks-chart"
          data-sakura-surface="benchmarks-chart"
          data-warm-surface="benchmarks-chart"
          className="cozy-card !p-5"
        >
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-page-title text-foreground">
              Top {Math.min(TOP_N_FOR_CHART, topForChart.length)} by Arena rating
            </h2>
            <div className="flex items-center gap-3 text-metadata text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-4 rounded-sm bg-accent-terracotta" />
                Closed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-4 rounded-sm bg-accent-sage" />
                Open
              </span>
            </div>
          </div>
          {loading ? (
            <div className="py-16 text-center text-secondary text-muted-foreground">
              Loading leaderboard…
            </div>
          ) : (
            <BarChart rows={chartRows} height={warmActive ? 420 : undefined} />
          )}
        </section>

        {/* Table */}
        <section
          data-monochrome-surface="benchmarks-table"
          data-sakura-surface="benchmarks-table"
          data-warm-table-mode={warmActive ? 'compact-scroll' : undefined}
          className="cozy-card !p-0 overflow-hidden"
        >
          <div
            className="overflow-auto"
            data-warm-region={warmActive ? 'benchmarks-table-scroll' : undefined}
            tabIndex={warmActive ? 0 : undefined}
            aria-label={warmActive ? `Leaderboard table, ${visibleRows.length} models` : undefined}
          >
            <table className="w-full text-secondary [html[data-theme=monochrome]_&]:font-mono">
              <thead>
                <tr className="border-b border-border bg-paper-soft text-metadata text-muted-foreground uppercase tracking-wider [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background">
                  <th className="text-left font-semibold px-4 py-3">Model</th>
                  <th className="text-left font-semibold px-4 py-3">Provider</th>
                  <th className="text-left font-semibold px-4 py-3">Type</th>
                  <SortableTh
                    label="Arena"
                    active={sortKey === 'arena_score'}
                    dir={sortDir}
                    onClick={() => toggleSort('arena_score')}
                  />
                  <SortableTh
                    label="Cost / 1M"
                    active={sortKey === 'cost'}
                    dir={sortDir}
                    onClick={() => toggleSort('cost')}
                    align="right"
                  />
                  <SortableTh
                    label="Context"
                    active={sortKey === 'context'}
                    dir={sortDir}
                    onClick={() => toggleSort('context')}
                    align="right"
                  />
                  <th className="text-left font-semibold px-4 py-3">License</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr
                    key={`${row.model}:${row.provider}:${index}`}
                    onClick={() => setSelectedModel(row.model)}
                    title={rowTooltip(row)}
                    className="border-b border-border/60 last:border-b-0 hover:bg-paper-soft cursor-pointer transition-colors [html[data-theme=monochrome]_&]:transition-none [html[data-theme=monochrome]_&]:hover:bg-muted"
                  >
                    <td className="px-4 py-3 text-foreground font-medium">{row.model}</td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-metadata">
                      {row.provider}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-metadata',
                            row.open_source
                              ? 'border-accent-sage/40 bg-accent-sage/10 text-accent-sage'
                              : 'border-accent-terracotta/40 bg-accent-terracotta/10 text-accent-terracotta',
                          )}
                          title={row.open_source ? 'Open source' : 'Closed / proprietary'}
                        >
                          {row.open_source ? (
                            <Unlock className="h-3 w-3" />
                          ) : (
                            <Lock className="h-3 w-3" />
                          )}
                          {row.open_source ? 'Open' : 'Closed'}
                        </span>
                        {row.supports_image && (
                          <span
                            className="inline-flex items-center text-muted-foreground"
                            title="Accepts image input"
                          >
                            <ImageIcon className="h-3.5 w-3.5" />
                          </span>
                        )}
                        {row.supports_video && (
                          <span
                            className="inline-flex items-center text-muted-foreground"
                            title="Accepts video input"
                          >
                            <VideoIcon className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-foreground">
                      {row.arena_score}
                      {row.ci_high - row.ci_low > 0 && (
                        <span className="text-muted-foreground text-metadata ml-1">
                          ±{Math.round((row.ci_high - row.ci_low) / 2)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-right">
                      {row.cost_per_1m_input_usd != null || row.cost_per_1m_output_usd != null ? (
                        <span
                          className="text-foreground"
                          title={
                            row.cost_estimated
                              ? 'List-price estimate — not reported by the leaderboard feed'
                              : undefined
                          }
                        >
                          {row.cost_estimated ? (
                            <span className="text-muted-foreground">~</span>
                          ) : null}
                          {row.cost_per_1m_input_usd != null
                            ? formatCost(row.cost_per_1m_input_usd)
                            : '—'}
                          <span className="text-muted-foreground"> / </span>
                          {row.cost_per_1m_output_usd != null
                            ? formatCost(row.cost_per_1m_output_usd)
                            : '—'}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-right text-foreground">
                      {row.context_window != null ? formatTokenCount(row.context_window) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'sev-pill',
                          licenseSeverity(row),
                          '[html[data-theme=monochrome]_&]:bg-none [html[data-theme=monochrome]_&]:bg-border-mid',
                        )}
                      >
                        {row.license ?? (row.open_source ? 'open' : 'proprietary')}
                      </span>
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-secondary text-muted-foreground"
                    >
                      {unavailable
                        ? 'Verified Arena data is unavailable. No fallback scores were invented.'
                        : 'No models match the current filters.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {hiddenCount > 0 && (
            <div className="border-t border-border bg-paper-soft px-4 py-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                Show all {sorted.length} models
                <span className="text-muted-foreground ml-1">(+{hiddenCount})</span>
              </Button>
            </div>
          )}
          {showAll && sorted.length > MIN_VISIBLE_ROWS && (
            <div className="border-t border-border bg-paper-soft px-4 py-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => setShowAll(false)}>
                Show top {MIN_VISIBLE_ROWS} only
              </Button>
            </div>
          )}
        </section>

        <section
          aria-labelledby="official-evaluations-title"
          className="cozy-card !p-5 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <h2 id="official-evaluations-title" className="text-page-title text-foreground">
              Official provider evaluations
            </h2>
            <p className="text-secondary text-muted-foreground max-w-3xl">
              Source-linked results reported by model providers. Scores are shown with their exact
              benchmark and setup and are never merged into the Arena ranking.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {OFFICIAL_BENCHMARK_EVIDENCE.map((entry) => (
              <article
                key={`${entry.provider}:${entry.model}:${entry.benchmark}:${entry.evaluationSetup}`}
                className="rounded-lg border border-border p-4 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-foreground font-medium">{entry.model}</div>
                    <div className="text-metadata text-muted-foreground">{entry.provider}</div>
                  </div>
                  <div className="font-mono text-foreground">
                    {entry.value}
                    {entry.unit}
                  </div>
                </div>
                <div className="text-secondary text-foreground">{entry.benchmark}</div>
                <div className="text-metadata text-muted-foreground">
                  {entry.metric} · {entry.evaluationSetup}
                </div>
                <a
                  href={entry.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-auto inline-flex items-center gap-1 text-metadata text-accent-copper hover:underline"
                >
                  Source: {entry.reportedBy} <ExternalLink className="h-3 w-3" />
                </a>
              </article>
            ))}
          </div>
        </section>
      </div>

      <DetailDrawer row={selectedRow} dataset={dataset} onClose={() => setSelectedModel(null)} />
    </div>
  );
}

interface SortableThProps {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
}

function SortableTh({ label, active, dir, onClick, align = 'left' }: SortableThProps) {
  return (
    <th
      className={cn(
        'font-semibold px-4 py-3 cursor-pointer select-none',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      onClick={onClick}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 transition-colors',
          active ? 'text-foreground' : 'hover:text-foreground',
        )}
      >
        {label}
        {active &&
          (dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </span>
    </th>
  );
}

interface DetailDrawerProps {
  row: BenchmarkRow | null;
  dataset: Awaited<ReturnType<typeof fetchBenchmarks>>['dataset'] | null;
  onClose: () => void;
}

function DetailDrawer({ row, dataset, onClose }: DetailDrawerProps) {
  const setDefaultProvider = useAuthStore((s) => s.setDefaultProvider);
  const open = !!row;

  const providerSupported = row != null && isSupportedProvider(row.provider);

  const handleUseModel = () => {
    if (!row || !isSupportedProvider(row.provider)) return;
    setDefaultProvider(row.provider);
    toast.success(
      'Default provider updated',
      `${row.model} (${row.provider}) is now the default. Add a key in Settings to actually route through it.`,
    );
    onClose();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
            'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
          )}
        />
        <DialogPrimitive.Content
          data-monochrome-surface="benchmark-detail"
          data-sakura-surface="benchmark-detail"
          className={cn(
            'fixed right-0 top-0 z-50 h-full w-full sm:max-w-md bg-elevated border-l border-border shadow-2xl',
            'flex flex-col',
            'data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-out',
            '[html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:data-[state=open]:animate-none [html[data-theme=monochrome]_&]:data-[state=closed]:animate-none',
          )}
        >
          {row && (
            <>
              <div className="flex items-start justify-between gap-3 p-5 border-b border-border">
                <div className="min-w-0">
                  <DialogPrimitive.Title className="text-page-title text-foreground truncate">
                    {row.model}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="text-metadata text-muted-foreground font-mono mt-1">
                    {row.provider}
                  </DialogPrimitive.Description>
                </div>
                <DialogPrimitive.Close
                  className="text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors"
                  aria-label="Close"
                >
                  <XIcon className="h-4 w-4" />
                </DialogPrimitive.Close>
              </div>

              <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
                {/* Score block */}
                <div>
                  <div className="text-metadata text-muted-foreground uppercase tracking-wider mb-1">
                    Arena rating
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-hero font-mono text-foreground">{row.arena_score}</span>
                    {row.ci_high - row.ci_low > 0 && (
                      <span className="text-secondary text-muted-foreground font-mono">
                        ({row.ci_low} – {row.ci_high})
                      </span>
                    )}
                  </div>
                  {row.votes != null && (
                    <div className="text-metadata text-muted-foreground mt-1">
                      {row.votes.toLocaleString()} pairwise votes
                    </div>
                  )}
                </div>

                <Separator />

                {/* Stats grid */}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-secondary">
                  <div>
                    <dt className="text-metadata text-muted-foreground uppercase tracking-wider">
                      Input{row.cost_estimated ? ' (est.)' : ''}
                    </dt>
                    <dd className="text-foreground font-mono mt-0.5">
                      {row.cost_per_1m_input_usd != null
                        ? `${row.cost_estimated ? '~' : ''}${formatCost(row.cost_per_1m_input_usd)} / 1M`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-metadata text-muted-foreground uppercase tracking-wider">
                      Output{row.cost_estimated ? ' (est.)' : ''}
                    </dt>
                    <dd className="text-foreground font-mono mt-0.5">
                      {row.cost_per_1m_output_usd != null
                        ? `${row.cost_estimated ? '~' : ''}${formatCost(row.cost_per_1m_output_usd)} / 1M`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-metadata text-muted-foreground uppercase tracking-wider">
                      Context
                    </dt>
                    <dd className="text-foreground font-mono mt-0.5">
                      {row.context_window != null
                        ? `${formatTokenCount(row.context_window)} tokens`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-metadata text-muted-foreground uppercase tracking-wider">
                      License
                    </dt>
                    <dd className="mt-0.5">
                      <span
                        className={cn(
                          'sev-pill',
                          licenseSeverity(row),
                          '[html[data-theme=monochrome]_&]:bg-none [html[data-theme=monochrome]_&]:bg-border-mid',
                        )}
                      >
                        {row.license ?? (row.open_source ? 'open' : 'proprietary')}
                      </span>
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-metadata text-muted-foreground uppercase tracking-wider">
                      Inputs
                    </dt>
                    <dd className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">Text</Badge>
                      {row.supports_image && (
                        <Badge variant="secondary" className="gap-1">
                          <ImageIcon className="h-3 w-3" /> Image
                        </Badge>
                      )}
                      {row.supports_video && (
                        <Badge variant="secondary" className="gap-1">
                          <VideoIcon className="h-3 w-3" /> Video
                        </Badge>
                      )}
                    </dd>
                  </div>
                </dl>

                <Separator />

                <div>
                  <div className="text-metadata text-muted-foreground uppercase tracking-wider mb-2">
                    Source
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {dataset && (
                      <a
                        href={dataset.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1.5 text-secondary text-accent-copper hover:underline"
                      >
                        {dataset.sourceName}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <a
                      href={OPENROUTER_MODELS_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 text-secondary text-accent-copper hover:underline"
                    >
                      OpenRouter models (pricing)
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="text-metadata text-muted-foreground mt-2">
                    Data source: <span className="font-mono">Structured Arena feed</span>
                    {' · '}
                    fetched {formatRelative(row.fetched_at)}
                  </div>
                </div>
              </div>

              <div className="border-t border-border p-5 flex items-center justify-between gap-3">
                {providerSupported ? (
                  <Button variant="accent" onClick={handleUseModel}>
                    Use this model
                  </Button>
                ) : (
                  <div className="text-metadata text-muted-foreground">
                    <Badge variant="outline">Provider not wired</Badge>
                    <span className="ml-2">
                      Jarvis can't route to <span className="font-mono">{row.provider}</span> yet.
                    </span>
                  </div>
                )}
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
