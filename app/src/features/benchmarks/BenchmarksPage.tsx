/**
 * BenchmarksPage — live AI model benchmark page for Jarvis.
 *
 * Shows a sortable, filterable table + horizontal bar chart of public
 * leaderboard scores. Data comes from `benchmarkData.fetchBenchmarks()`,
 * which falls back to a frozen snapshot when the live LMArena endpoint
 * fails. The header chip makes that fallback state explicit.
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import {
  cn,
  formatCost,
  formatRelative,
  formatTokenCount,
} from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import {
  fetchBenchmarks,
  isSupportedProvider,
  type BenchmarkRow,
} from './benchmarkData';
import { BarChart } from './BarChart';

type SortKey = 'arena_score' | 'cost' | 'context';

const PROVIDER_FILTER_ALL = '__all__';
const TOP_N_FOR_CHART = 12;
const LMSYS_PUBLIC_URL = 'https://lmarena.ai/leaderboard';

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
  const [rows, setRows] = React.useState<BenchmarkRow[]>([]);
  const [fromSnapshot, setFromSnapshot] = React.useState(false);
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [errorReason, setErrorReason] = React.useState<string | null>(null);

  const [providerFilter, setProviderFilter] =
    React.useState<string>(PROVIDER_FILTER_ALL);
  const [openOnly, setOpenOnly] = React.useState(false);
  const [sortKey, setSortKey] = React.useState<SortKey>('arena_score');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');

  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);

  // Apply a fetch result to all the relevant state slots in one shot.
  // Used by initial load, manual refresh, focus refresh, and polling so
  // the four code paths can't drift apart.
  const applyResult = React.useCallback(
    (result: Awaited<ReturnType<typeof fetchBenchmarks>>) => {
      setRows(result.rows);
      setFromSnapshot(result.fromSnapshot);
      setErrorReason(result.fromSnapshot ? result.reason ?? null : null);
      setFetchedAt(
        result.rows.length > 0 ? result.rows[0].fetched_at : Date.now(),
      );
    },
    [],
  );

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

  // Background polling. Arena ELO publishes weekly-ish, so 24h is the
  // right cadence; faster just shows the same snapshot fallback toast on
  // a loop. Forced fetch (skips cache) so we actually re-hit the upstream.
  React.useEffect(() => {
    const POLL_MS = 24 * 60 * 60 * 1000;
    let cancelled = false;
    const id = setInterval(() => {
      if (cancelled || refreshing || loading) return;
      void fetchBenchmarks({ force: true }).then((result) => {
        if (!cancelled) applyResult(result);
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [applyResult, refreshing, loading]);

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true);
    const result = await fetchBenchmarks({ force: true });
    applyResult(result);
    setRefreshing(false);
    if (result.fromSnapshot) {
      toast.warning(
        'Using snapshot data',
        result.reason
          ? `Live fetch failed: ${result.reason}`
          : 'Live fetch failed; showing frozen leaderboard.',
      );
    } else {
      toast.success('Benchmarks refreshed', `${result.rows.length} models loaded`);
    }
  }, [applyResult]);

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

  const selectedRow = React.useMemo(
    () => (selectedModel ? rows.find((r) => r.model === selectedModel) ?? null : null),
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
    <div className="bg-paper-soft min-h-full w-full">
      <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col gap-6">
        {/* Header */}
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-metadata text-muted-foreground uppercase tracking-wider">
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  fromSnapshot ? 'bg-warning' : 'bg-success',
                )}
              />
              <span>
                {loading
                  ? 'Loading'
                  : fromSnapshot
                  ? 'Snapshot'
                  : 'Live'}
                {fetchedAt && ' · last fetched '}
                {fetchedAt && formatRelative(fetchedAt)}
              </span>
              {fromSnapshot && (
                <span
                  className="sev-pill med ml-2"
                  title={errorReason ?? 'Live endpoint unavailable; using frozen data.'}
                >
                  from snapshot
                </span>
              )}
            </div>
            <h1 className="font-display text-foreground text-4xl font-semibold leading-tight">
              Benchmarks
            </h1>
            <p className="text-secondary text-muted-foreground max-w-xl">
              Free public leaderboards. BYOK to run any of them.
            </p>
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
            <RefreshCw
              className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')}
            />
            {refreshing ? 'Fetching…' : 'Refresh'}
          </Button>
        </header>

        {/* Snapshot warning panel — full width, only when we're on fallback */}
        {fromSnapshot && !loading && (
          <div className="cozy-card !py-3 !px-4 flex items-start gap-3 border-warning/40">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <div className="text-secondary text-foreground">
              Showing a frozen snapshot from {fetchedAt && formatRelative(fetchedAt)}.{' '}
              <span className="text-muted-foreground">
                The live leaderboard endpoint is unreachable
                {errorReason ? ` (${errorReason})` : ''}; numbers below are not
                live. Hit refresh to retry.
              </span>
            </div>
          </div>
        )}

        {/* Filters row */}
        <section className="flex flex-wrap items-end gap-4">
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
              <option value="arena_score">Arena score</option>
              <option value="cost">Cost</option>
              <option value="context">Context window</option>
            </select>
          </div>

          <div className="flex items-center gap-2 h-8 self-end pb-1">
            <Switch
              id="bench-open"
              checked={openOnly}
              onCheckedChange={setOpenOnly}
            />
            <Label htmlFor="bench-open" className="cursor-pointer">
              Open source only
            </Label>
          </div>

          <div className="flex-1" />

          <div className="text-metadata text-muted-foreground self-end pb-1">
            {filtered.length} of {rows.length} models
          </div>
        </section>

        {/* Bar chart */}
        <section className="cozy-card !p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-page-title text-foreground">
              Top {Math.min(TOP_N_FOR_CHART, topForChart.length)} by Arena score
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
            <BarChart rows={topForChart} />
          )}
        </section>

        {/* Table */}
        <section className="cozy-card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-secondary">
              <thead>
                <tr className="border-b border-border bg-paper-soft text-metadata text-muted-foreground uppercase tracking-wider">
                  <th className="text-left font-semibold px-4 py-3">Model</th>
                  <th className="text-left font-semibold px-4 py-3">Provider</th>
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
                {sorted.map((row) => (
                  <tr
                    key={row.model}
                    onClick={() => setSelectedModel(row.model)}
                    className="border-b border-border/60 last:border-b-0 hover:bg-paper-soft cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-foreground font-medium">
                      {row.model}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-metadata">
                      {row.provider}
                    </td>
                    <td className="px-4 py-3 font-mono text-foreground">
                      {row.arena_score}
                      <span className="text-muted-foreground text-metadata ml-1">
                        ±{Math.round((row.ci_high - row.ci_low) / 2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-right">
                      {row.cost_per_1m_input_usd != null ||
                      row.cost_per_1m_output_usd != null ? (
                        <span className="text-foreground">
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
                      {row.context_window != null
                        ? formatTokenCount(row.context_window)
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('sev-pill', licenseSeverity(row))}>
                        {row.license ?? (row.open_source ? 'open' : 'proprietary')}
                      </span>
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-secondary text-muted-foreground"
                    >
                      No models match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <DetailDrawer
        row={selectedRow}
        onClose={() => setSelectedModel(null)}
      />
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
          (dir === 'desc' ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          ))}
      </span>
    </th>
  );
}

interface DetailDrawerProps {
  row: BenchmarkRow | null;
  onClose: () => void;
}

function DetailDrawer({ row, onClose }: DetailDrawerProps) {
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
          className={cn(
            'fixed right-0 top-0 z-50 h-full w-full sm:max-w-md bg-elevated border-l border-border shadow-2xl',
            'flex flex-col',
            'data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-out',
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
                    Arena score
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-hero font-mono text-foreground">
                      {row.arena_score}
                    </span>
                    <span className="text-secondary text-muted-foreground font-mono">
                      ({row.ci_low} – {row.ci_high})
                    </span>
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
                      Input
                    </dt>
                    <dd className="text-foreground font-mono mt-0.5">
                      {row.cost_per_1m_input_usd != null
                        ? `${formatCost(row.cost_per_1m_input_usd)} / 1M`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-metadata text-muted-foreground uppercase tracking-wider">
                      Output
                    </dt>
                    <dd className="text-foreground font-mono mt-0.5">
                      {row.cost_per_1m_output_usd != null
                        ? `${formatCost(row.cost_per_1m_output_usd)} / 1M`
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
                      <span className={cn('sev-pill', licenseSeverity(row))}>
                        {row.license ?? (row.open_source ? 'open' : 'proprietary')}
                      </span>
                    </dd>
                  </div>
                </dl>

                <Separator />

                <div>
                  <div className="text-metadata text-muted-foreground uppercase tracking-wider mb-2">
                    Source
                  </div>
                  <a
                    href={LMSYS_PUBLIC_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 text-secondary text-accent-copper hover:underline"
                  >
                    Chatbot Arena leaderboard
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <div className="text-metadata text-muted-foreground mt-2">
                    Data source:{' '}
                    <span className="font-mono">
                      {row.source === 'snapshot' ? 'frozen snapshot' : 'lmsys live'}
                    </span>
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
