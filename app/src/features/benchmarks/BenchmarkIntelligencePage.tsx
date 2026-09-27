import * as React from 'react';
import { Check, ExternalLink, ImageOff, RefreshCw, Search, Share2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  blendedTokenPrice,
  fetchBenchmarkLeaderboard,
  getCachedBenchmarkLeaderboard,
  intelligencePerDollar,
  type BenchmarkFetchResult,
  type BenchmarkModelRow,
} from './benchmarkApi';
import { PROVIDER_LOGOS } from './providerLogos';
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
type Category = 'Overall' | 'Speed' | 'Cost';
const CATEGORIES: readonly Category[] = ['Overall', 'Speed', 'Cost'];

function ProviderMark({ provider }: { provider: string }) {
  const logo = PROVIDER_LOGOS[provider];
  const [imageFailed, setImageFailed] = React.useState(false);
  React.useEffect(() => setImageFailed(false), [provider]);
  const available = Boolean(logo && !imageFailed);
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-background text-xs font-bold text-accent-copper"
      aria-label={available ? `${provider} logo` : `${provider} logo unavailable`}
      title={available ? `${provider} logo` : `${provider} logo unavailable`}
    >
      {logo && !imageFailed ? (
        <img
          src={logo.src}
          alt=""
          className="h-6 w-6 object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <ImageOff className="h-4 w-4" aria-hidden="true" />
      )}
    </span>
  );
}

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
const CONTEXT_DOCS_CHECKED_AT = '2026-09-27';

// The live Cloudflare AA feed currently omits context. Supplement only exact
// model families documented by their providers, and link every supplemented value.
const VERIFIED_CONTEXT: ReadonlyArray<{
  provider: string;
  model: RegExp;
  tokens: number;
  sourceUrl: string;
}> = [
  {
    provider: 'Anthropic',
    model: /^Claude Opus 5\.5(?:\s*\(|$)/u,
    tokens: 1_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/models/opus-5-5/overview',
  },
  {
    provider: 'Anthropic',
    model: /^Claude Fable 5\.1(?:\s*\(|$)/u,
    tokens: 1_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/models/fable-5-1/overview',
  },
  {
    provider: 'Anthropic',
    model: /^Claude (?:Opus 5|Fable 5)(?:\s*\(|$)/u,
    tokens: 1_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/build-with-claude/context-windows',
  },
  {
    provider: 'OpenAI',
    model: /^GPT-6 Astra(?:\s*\(|$)/u,
    tokens: 1_050_000,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
  },
  {
    provider: 'OpenAI',
    model: /^GPT-6 Sol(?:\s*\(|$)/u,
    tokens: 1_050_000,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6-sol',
  },
  {
    provider: 'OpenAI',
    model: /^GPT-5\.6 Sol(?:\s*\(|$)/u,
    tokens: 1_050_000,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
  },
  {
    provider: 'Meta',
    model: /^Muse Spark 1\.3(?:\s*\(|$)/u,
    tokens: 1_048_576,
    sourceUrl: 'https://dev.meta.ai/docs/models',
  },
  {
    provider: 'SpaceXAI',
    model: /^Grok 4\.7(?:\s*\(|$)/u,
    tokens: 500_000,
    sourceUrl: 'https://docs.x.ai/developers/models/grok-4.7',
  },
  {
    provider: 'Xiaomi',
    model: /^MiMo-V2\.6-Pro(?:\s*\(|$)/u,
    tokens: 1_000_000,
    sourceUrl: 'https://mimo.mi.com/models/en-US/mimo-v2.6-pro',
  },
  {
    provider: 'Alibaba',
    model: /^Qwen3\.8 Max \(0902\)$/u,
    tokens: 1_000_000,
    sourceUrl: 'https://www.alibabacloud.com/help/en/model-studio/text-generation-model',
  },
];

export function contextForBenchmarkRow(row: BenchmarkModelRow): {
  tokens: number;
  sourceUrl: string;
  sourceName: string;
} | null {
  if (row.contextWindowTokens && row.contextWindowTokens > 0) {
    return {
      tokens: row.contextWindowTokens,
      sourceUrl: row.sourceUrl,
      sourceName: 'Artificial Analysis feed',
    };
  }
  const verified = VERIFIED_CONTEXT.find(
    (entry) => entry.provider === row.provider && entry.model.test(row.model),
  );
  return verified
    ? {
        tokens: verified.tokens,
        sourceUrl: verified.sourceUrl,
        sourceName: `${row.provider} model documentation`,
      }
    : null;
}

function contextLabel(tokens: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(
    tokens,
  );
}

function ContextValue({ row }: { row: BenchmarkModelRow }) {
  const context = contextForBenchmarkRow(row);
  if (!context)
    return <span title="Context unavailable from the feed or a verified model source">—</span>;
  return (
    <a
      href={context.sourceUrl}
      target="_blank"
      rel="noreferrer"
      title={`${context.tokens.toLocaleString()} tokens · ${context.sourceName}${context.sourceName.includes('documentation') ? ` · checked ${CONTEXT_DOCS_CHECKED_AT}` : ''}`}
      className="underline decoration-border underline-offset-2 hover:text-accent-copper"
    >
      {contextLabel(context.tokens)}
    </a>
  );
}

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
      return contextForBenchmarkRow(row)?.tokens ?? null;
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
  const [modelSearch, setModelSearch] = React.useState('');
  const [ownership, setOwnership] = React.useState<OwnershipFilter>('all');
  const [effort, setEffort] = React.useState('all');
  const [sortKey, setSortKey] = React.useState<SortKey>('intelligence');
  const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>('desc');
  const [category, setCategory] = React.useState<Category>('Overall');
  const [view, setView] = React.useState<'chart' | 'table'>('chart');
  const [shared, setShared] = React.useState(false);
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
    const query = modelSearch.trim().toLocaleLowerCase();
    const rows = (result?.rows ?? []).filter((row) => {
      if (provider !== 'all' && row.provider !== provider) return false;
      if (query && !`${row.model} ${row.provider}`.toLocaleLowerCase().includes(query))
        return false;
      if (ownership === 'open' && row.openWeights !== true) return false;
      if (ownership === 'proprietary' && row.openWeights !== false) return false;
      if (effort !== 'all' && row.effort !== effort) return false;
      return true;
    });
    return sortBenchmarkRows(rows, sortKey, sortDirection);
  }, [effort, modelSearch, ownership, provider, result, sortDirection, sortKey]);

  React.useEffect(() => {
    setVisibleCount(50);
  }, [effort, modelSearch, ownership, provider, sortDirection, sortKey]);

  const categoryMetric: SortKey =
    category === 'Speed' ? 'speed' : category === 'Cost' ? 'costPerTask' : 'intelligence';
  const categoryUnit =
    category === 'Speed'
      ? 'output tokens/s'
      : category === 'Cost'
        ? 'USD per task'
        : 'index points';
  const lowerIsBetter = category === 'Cost';
  const rankedRows = React.useMemo(
    () =>
      sortBenchmarkRows(
        filteredRows.filter((row) => numberForSort(row, categoryMetric) != null),
        categoryMetric,
        lowerIsBetter ? 'asc' : 'desc',
      ),
    [filteredRows, categoryMetric, lowerIsBetter],
  );
  const chartRows = React.useMemo(() => rankedRows.slice(0, 25), [rankedRows]);
  const chartMax = Math.max(1, ...chartRows.map((row) => numberForSort(row, categoryMetric) ?? 0));
  const chartMin = Math.min(
    ...chartRows.map((row) => numberForSort(row, categoryMetric) ?? Infinity),
  );

  const share = async () => {
    const sourceDate = result?.dataset?.sourceObservedAt
      ? new Date(result.dataset.sourceObservedAt).toISOString().slice(0, 10)
      : 'date unavailable';
    const summary = `VibeSpace benchmarks · ${category} · Artificial Analysis · ${sourceDate}\n${window.location.href}`;
    try {
      await navigator.clipboard.writeText(summary);
      setShared(true);
      window.setTimeout(() => setShared(false), 3000);
    } catch {
      setShared(false);
      toast.error('Could not copy leaderboard', 'Clipboard access is unavailable.');
    }
  };

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
        className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6"
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
            <h1 className="font-display text-3xl font-semibold leading-tight text-foreground">
              Leaderboard
            </h1>
            <p className="max-w-3xl text-secondary text-muted-foreground">
              Independently evaluated models, ranked with source-linked scores and API prices.
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
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                role="searchbox"
                inputMode="search"
                aria-label="Search models"
                placeholder="Search models"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setModelSearch('');
                }}
                className="h-10 w-full rounded-lg border border-border bg-paper py-2 pl-9 pr-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-accent-copper/60"
              />
              {modelSearch ? (
                <button
                  type="button"
                  aria-label="Clear model search"
                  onClick={() => setModelSearch('')}
                  className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-accent-copper/10 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-copper"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-border bg-paper px-2 text-sm">
              <span>Models</span>
              <select
                aria-label="Models"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="h-9 min-w-24 bg-transparent text-foreground"
              >
                <option value="all">All</option>
                {providers.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="outline" onClick={() => void share()}>
              <Share2 className="mr-2 h-4 w-4" />
              {shared ? (
                <>
                  <Check className="mr-1 h-4 w-4" />
                  Copied
                </>
              ) : (
                'Share'
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => void load(true)}
              disabled={refreshing || loading}
              aria-label="Refresh benchmarks"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
          </div>
        </header>

        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border"
          data-testid="benchmark-navigation"
        >
          <nav className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Benchmark categories">
            {CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setCategory(item);
                  setSortKey(
                    item === 'Speed' ? 'speed' : item === 'Cost' ? 'costPerTask' : 'intelligence',
                  );
                  setSortDirection(item === 'Cost' ? 'asc' : 'desc');
                }}
                aria-current={category === item ? 'page' : undefined}
                className={cn(
                  'border-b-2 px-0.5 py-2 text-sm font-medium transition-colors',
                  category === item
                    ? 'border-accent-copper text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {item}
              </button>
            ))}
          </nav>
          <div
            className="mb-1 flex rounded-lg border border-border bg-paper p-0.5"
            role="group"
            aria-label="Leaderboard view"
          >
            {(['chart', 'table'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm capitalize',
                  view === mode
                    ? 'bg-accent-copper/15 font-semibold text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {`Artificial Analysis · ${category === 'Overall' ? 'Intelligence Index' : category} · ${categoryUnit} · ${lowerIsBetter ? 'lower' : 'higher'} is better · observed ${result?.dataset?.sourceObservedAt ? fullTime(result.dataset.sourceObservedAt) : 'date unavailable'}`}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Context in tokens: Cloudflare feed when supplied; linked provider documentation fills
          exact model matches (checked {CONTEXT_DOCS_CHECKED_AT}).
        </p>

        {error && !result?.rows.length ? (
          <div
            role="status"
            className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground"
            data-warm-surface="benchmarks-warning"
          >
            <span>{error}</span>
          </div>
        ) : null}

        {view === 'chart' ? (
          <section
            className="cozy-card rounded-2xl border border-border bg-paper p-4 shadow-soft"
            data-warm-surface="benchmarks-chart"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-xl font-semibold text-foreground">
                  {category} ranking
                </h2>
                <p className="text-metadata text-muted-foreground">
                  Artificial Analysis · {categoryUnit} · {lowerIsBetter ? 'lower' : 'higher'} is
                  better. Bars are relative to the best displayed value.
                </p>
              </div>
              <span className="text-metadata text-muted-foreground">
                {chartRows.length} of {rankedRows.length} models shown
              </span>
            </div>
            {chartRows.length ? (
              <div className="space-y-1" aria-label={`Artificial Analysis ${category} chart`}>
                <div className="hidden grid-cols-[minmax(240px,2fr)_minmax(140px,2fr)_auto_135px_70px] gap-3 border-b border-border pb-2 text-[11px] uppercase tracking-wide text-muted-foreground xl:grid">
                  <span>Model / provider</span>
                  <span>
                    {category} · {categoryUnit}
                  </span>
                  <span></span>
                  <span className="text-right">API in / out · $/1M</span>
                  <span
                    className="text-right"
                    title="Cloudflare feed where supplied; otherwise linked provider model documentation"
                  >
                    Context
                  </span>
                </div>
                {chartRows.map((row, index) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(145px,260px)_1fr_auto] items-center gap-3 border-b border-border/50 py-1.5 xl:grid-cols-[minmax(240px,2fr)_minmax(140px,2fr)_auto_135px_70px]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <ProviderMark provider={row.provider} />
                      <div className="min-w-0">
                        <div
                          title={displayNames.get(row.id) ?? row.model}
                          className="text-sm font-medium leading-snug text-foreground"
                        >
                          {displayNames.get(row.id) ?? row.model}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {row.provider}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground xl:hidden">
                          {money(row.inputPricePer1MTokensUsd)} /{' '}
                          {money(row.outputPricePer1MTokensUsd)} per 1M · <ContextValue row={row} />{' '}
                          context
                        </div>
                      </div>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-accent-copper transition-[width]"
                        style={{
                          width: `${Math.max(2, (lowerIsBetter ? chartMin / Math.max(numberForSort(row, categoryMetric) ?? 1, 0.0001) : (numberForSort(row, categoryMetric) ?? 0) / chartMax) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="text-right font-mono text-sm font-semibold text-foreground">
                      {category === 'Cost'
                        ? money(row.costPerTaskUsd, 4)
                        : category === 'Speed'
                          ? decimal(row.outputTokensPerSecond)
                          : row.intelligenceIndex}
                    </div>
                    <div className="hidden text-right font-mono text-xs text-muted-foreground xl:block">
                      {money(row.inputPricePer1MTokensUsd)} / {money(row.outputPricePer1MTokensUsd)}
                    </div>
                    <div className="hidden text-right font-mono text-xs text-muted-foreground xl:block">
                      <ContextValue row={row} />
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
        ) : null}

        <section
          className="cozy-card rounded-2xl border border-border bg-paper p-5 shadow-soft"
          data-warm-surface="benchmarks-filters"
        >
          <div className="grid min-w-0 gap-3 md:grid-cols-3">
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

        {view === 'table' ? (
          <section
            className="cozy-card rounded-2xl border border-border bg-paper p-4 shadow-soft"
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
                    <th
                      className="px-2 py-3 text-right"
                      title="Cloudflare feed where supplied; otherwise linked provider model documentation"
                    >
                      Context
                    </th>
                    <th className="px-2 py-3">Weights</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.slice(0, visibleCount).map((row, index) => (
                    <tr
                      key={row.id}
                      className="border-b border-border/60 align-top hover:bg-muted/30"
                    >
                      <td className="px-2 py-3 font-mono text-muted-foreground">#{index + 1}</td>
                      <td className="px-2 py-3">
                        <div className="flex items-center gap-2 font-medium text-foreground">
                          <ProviderMark provider={row.provider} />
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
                        <ContextValue row={row} />
                      </td>
                      <td className="px-2 py-3">
                        {row.openWeights == null ? '—' : row.openWeights ? 'Open' : 'Proprietary'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filteredRows.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {loading
                  ? 'Loading benchmarks…'
                  : result?.rows.length
                    ? 'No models match these filters.'
                    : 'Results will appear here when available.'}
              </p>
            ) : null}
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
        ) : null}
      </main>
    </div>
  );
}
