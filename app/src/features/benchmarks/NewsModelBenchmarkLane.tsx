import * as React from 'react';
import { ArrowRight, ExternalLink, Newspaper, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatRelative } from '@/lib/utils';
import { fetchBenchmarks } from './benchmarkData';
import {
  discoverNewsBenchmarkPair,
  resolveNewsApiUrl,
  type NewsBenchmarkDiscovery,
  type NewsBenchmarkPair,
  type NewsBenchmarkPosition,
} from './newsModelDiscovery';

const FOREGROUND_REFRESH_MS = 15 * 60 * 1000;

type LaneState = { status: 'loading' } | NewsBenchmarkDiscovery;

export function NewsModelBenchmarkLane() {
  const configured = Boolean(resolveNewsApiUrl());
  const [state, setState] = React.useState<LaneState>(
    configured ? { status: 'loading' } : { status: 'unconfigured' },
  );
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async (force = false) => {
    if (!resolveNewsApiUrl()) {
      setState({ status: 'unconfigured' });
      return;
    }

    if (force) setRefreshing(true);
    try {
      const benchmarks = await fetchBenchmarks();
      const discovery = await discoverNewsBenchmarkPair(benchmarks.rows, { force });
      setState(discovery);
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Benchmark Scout could not load.',
      });
    } finally {
      if (force) setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    void (async () => {
      try {
        const benchmarks = await fetchBenchmarks();
        const discovery = await discoverNewsBenchmarkPair(benchmarks.rows);
        if (!cancelled) setState(discovery);
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Benchmark Scout could not load.',
          });
        }
      }
    })();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, FOREGROUND_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [configured, load]);

  if (state.status === 'unconfigured') return null;

  const pair =
    state.status === 'ready'
      ? state.pair
      : state.status === 'error'
        ? state.stalePair
        : undefined;

  return (
    <section
      aria-label="AI news model benchmark comparison"
      data-news-benchmark-lane
      className="border-b border-border bg-paper-soft px-6 py-4 [html[data-theme=monochrome]_&]:bg-background"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-metadata uppercase tracking-wider text-muted-foreground">
              <Newspaper className="h-3.5 w-3.5" />
              Benchmark Scout · AI News
            </div>
            <h2 className="mt-1 text-page-title text-foreground">New model comparison</h2>
            <p className="mt-1 max-w-2xl text-secondary text-muted-foreground">
              Verified model-release news is placed first. A real leaderboard model is selected
              second for comparison; missing scores stay marked as pending.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing || state.status === 'loading'}
            onClick={() => void load(true)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            {refreshing ? 'Checking…' : 'Check news'}
          </Button>
        </div>

        {state.status === 'loading' ? (
          <div className="cozy-card !px-4 !py-3 text-secondary text-muted-foreground">
            Checking verified model-release news…
          </div>
        ) : pair ? (
          <ComparisonPair pair={pair} stale={state.status === 'error'} />
        ) : state.status === 'empty' ? (
          <div className="cozy-card !px-4 !py-3 text-secondary text-muted-foreground">
            No verified model release with a recognizable model name is available yet.
          </div>
        ) : (
          <div className="cozy-card !px-4 !py-3 text-secondary text-muted-foreground">
            News could not be checked right now. The benchmark leaderboard remains unchanged.
            {state.status === 'error' ? ` ${state.message}` : ''}
          </div>
        )}
      </div>
    </section>
  );
}

function ComparisonPair({ pair, stale }: { pair: NewsBenchmarkPair; stale: boolean }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
      <PositionCard position={pair.primary} pair={pair} primary />
      <div className="hidden items-center justify-center text-muted-foreground lg:flex">
        <ArrowRight className="h-5 w-5" />
      </div>
      {pair.secondary ? (
        <PositionCard position={pair.secondary} pair={pair} />
      ) : (
        <div className="cozy-card !p-4 text-secondary text-muted-foreground">
          No secondary leaderboard model is available.
        </div>
      )}
      <div className="lg:col-span-3 flex flex-wrap items-center justify-between gap-2 text-metadata text-muted-foreground">
        <span>
          {stale ? 'Showing the last successful news match · ' : ''}
          Published {formatRelative(pair.release.publishedAt)} · {pair.release.sourceName}
          {' · '}
          {pair.release.verification}
        </span>
        <a
          href={pair.release.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-accent-copper hover:underline"
        >
          Read announcement <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function PositionCard({
  position,
  pair,
  primary = false,
}: {
  position: NewsBenchmarkPosition;
  pair: NewsBenchmarkPair;
  primary?: boolean;
}) {
  const row = position.row;
  return (
    <article
      className={cn(
        'cozy-card !p-4',
        primary &&
          'border-accent-copper/50 shadow-[0_0_0_1px_hsl(var(--accent-copper)/0.15)]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-metadata uppercase tracking-wider text-muted-foreground">
          Position {position.position} · {primary ? 'News model' : 'Secondary model'}
        </span>
        {primary && (
          <span className="inline-flex items-center gap-1 text-metadata text-success">
            <ShieldCheck className="h-3.5 w-3.5" />
            {pair.release.verification}
          </span>
        )}
      </div>
      <div className="mt-2 font-display text-xl font-semibold text-foreground">
        {position.modelName}
      </div>
      <div className="mt-1 text-metadata font-mono text-muted-foreground">
        {row?.provider ?? pair.release.company ?? 'Provider not mapped'}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {row ? (
          <>
            <span className="rounded-full border border-border px-2 py-1 text-metadata text-foreground">
              Leaderboard score {row.arena_score}
            </span>
            <span className="rounded-full border border-border px-2 py-1 text-metadata text-muted-foreground">
              {row.source === 'snapshot' ? 'Curated snapshot' : 'Live Arena'}
            </span>
          </>
        ) : (
          <span className="rounded-full border border-warning/50 bg-warning/10 px-2 py-1 text-metadata text-warning">
            Benchmark pending — no score invented
          </span>
        )}
      </div>
      {primary && (
        <p className="mt-3 line-clamp-2 text-secondary text-muted-foreground">
          {pair.release.title}
        </p>
      )}
    </article>
  );
}
