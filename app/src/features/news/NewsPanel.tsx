/**
 * NewsPanel — floating mini-panel (unrelated to Pixel Pets).
 *
 * Right-docked card with:
 *   - Section tabs: Today (default) · Last week · More
 *   - Kind chips: All · Models · News · YouTube
 *   - Cards: image, title, summary, source credit, open external link
 *
 * Uses the configured free-only hourly Worker when available and preserves the
 * credited offline catalog as a resilient fallback.
 */
import * as React from 'react';
import './sakura-news.css';
import {
  AlertTriangle,
  Bell,
  BellRing,
  ExternalLink,
  Newspaper,
  Play,
  Radar,
  RefreshCw,
  X,
  Cpu,
  Radio,
  Github,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openExternal } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth';
import {
  NEWS_KIND_META,
  NEWS_SECTION_META,
  type NewsItem,
  type NewsKind,
  type NewsSectionId,
} from './newsCatalog';
import {
  countNewsBySection,
  formatNewsDate,
  getNewsFeed,
  groupNewsBySection,
} from './newsSections';
import {
  configuredNewsApiUrl,
  fetchLiveNews,
  type LiveNewsItem,
  type LiveNewsResponse,
} from './newsApi';
import {
  acknowledgeCreatorNotifications,
  fetchCreatorNotifications,
  fetchCreatorSubscriptions,
  setCreatorSubscription,
} from './creatorSubscriptions';

export interface NewsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional clock override for tests / demos. */
  now?: Date;
  runtimeEffectsEnabled?: boolean;
}

type KindFilter = NewsKind | 'all';

const KIND_FILTERS: ReadonlyArray<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'model_drop', label: NEWS_KIND_META.model_drop.short },
  { id: 'ai_news', label: NEWS_KIND_META.ai_news.short },
  { id: 'youtube', label: NEWS_KIND_META.youtube.short },
  { id: 'github', label: NEWS_KIND_META.github.short },
];

const SECTIONS: readonly NewsSectionId[] = ['today', 'last_week', 'more'];
const NEWS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function mergeRetainedById<T extends { id: string }>(
  current: readonly T[],
  retained: readonly T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of current) merged.set(item.id, item);
  for (const item of retained) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

export function reconcileLiveNews(
  previous: LiveNewsResponse | null,
  incoming: LiveNewsResponse,
): LiveNewsResponse {
  if (!previous || incoming.freshness?.state === 'fresh') return incoming;
  if (!['degraded', 'stale', 'failed', 'never'].includes(incoming.freshness?.state ?? '')) {
    return incoming;
  }
  const repositories = mergeRetainedById(incoming.repositories ?? [], previous.repositories ?? []);
  return {
    ...incoming,
    items: mergeRetainedById(incoming.items, previous.items),
    ...(repositories.length ? { repositories } : {}),
  };
}

function liveFeedStatus(live: LiveNewsResponse | null, liveError: string | null): string {
  if (liveError) {
    return live
      ? 'Last verified feed while live news reconnects.'
      : 'Saved snapshot while live news reconnects.';
  }
  if (!live) return 'Saved snapshot with original-source credits.';
  if (live.freshness?.state === 'degraded') {
    return 'Partial-source feed with last verified items retained.';
  }
  if (['stale', 'failed', 'never'].includes(live.freshness?.state ?? '')) {
    return 'Last verified feed while live news reconnects.';
  }
  return 'Free hourly AI headlines from verified sources.';
}

function KindIcon({ kind, className }: { kind: NewsKind; className?: string }) {
  if (kind === 'github') return <Github className={className} />;
  if (kind === 'youtube') return <Play className={className} />;
  if (kind === 'model_drop') return <Cpu className={className} />;
  return <Radio className={className} />;
}

function NewsCard({
  item,
  runtimeEffectsEnabled,
  followed,
  followPending,
  canFollow,
  onToggleFollow,
}: {
  item: NewsItem | LiveNewsItem;
  runtimeEffectsEnabled: boolean;
  followed: boolean;
  followPending: boolean;
  canFollow: boolean;
  onToggleFollow: () => void;
}) {
  const [imgFailed, setImgFailed] = React.useState(false);

  const open = () => {
    if (!runtimeEffectsEnabled) return;
    void openExternal(item.url);
  };

  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-xl border border-border bg-paper',
        'shadow-soft transition-colors hover:border-accent-copper/40',
      )}
    >
      {'sourceId' in item && item.sourceId && item.kind !== 'github' ? (
        <button
          type="button"
          className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-panel/95 text-foreground shadow-soft disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`${followed ? 'Unfollow' : 'Follow'} ${item.source}`}
          aria-pressed={followed}
          disabled={!canFollow || followPending}
          title={
            canFollow
              ? 'Alert me to new items while VibeSpace is open'
              : 'Sign in with cloud sync to follow creators'
          }
          onClick={onToggleFollow}
        >
          {followed ? (
            <BellRing className="h-4 w-4 text-accent-copper" />
          ) : (
            <Bell className="h-4 w-4" />
          )}
        </button>
      ) : null}
      <button
        type="button"
        onClick={open}
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-copper/50"
        aria-label={`Open: ${item.title}`}
      >
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
          {runtimeEffectsEnabled && item.imageUrl && !imgFailed ? (
            <img
              src={item.imageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center bg-gradient-to-br from-paper-soft to-muted [html[data-theme=monochrome]_&]:bg-none"
              data-news-media-fallback="true"
            >
              <Newspaper className="h-8 w-8 text-muted-foreground/50 [html[data-theme=monochrome]_&]:text-muted-foreground" />
            </div>
          )}
          <span
            className={cn(
              'absolute left-2 top-2 inline-flex items-center gap-1 rounded-full',
              'border border-border/60 bg-panel/90 px-2 py-0.5',
              'text-metadata font-medium text-foreground backdrop-blur-sm [html[data-theme=monochrome]_&]:backdrop-blur-none',
            )}
          >
            <KindIcon kind={item.kind} className="h-3 w-3 text-accent-copper" />
            {NEWS_KIND_META[item.kind].label}
          </span>
          {(item.kind === 'youtube' || ('mediaType' in item && item.mediaType === 'video')) && (
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center"
              data-news-video-badge="true"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm [html[data-theme=monochrome]_&]:backdrop-blur-none">
                <Play className="h-5 w-5 fill-current" />
              </span>
            </span>
          )}
        </div>

        <div className="space-y-1.5 p-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display text-secondary leading-snug text-foreground">
              {item.title}
            </h3>
            <ExternalLink
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden
            />
          </div>
          <p className="text-metadata leading-relaxed text-muted-foreground line-clamp-3">
            {item.summary}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-metadata text-muted-foreground">
            <span className="font-medium text-foreground/80">{item.source}</span>
            <span aria-hidden>·</span>
            <time dateTime={item.publishedAt}>{formatNewsDate(item.publishedAt)}</time>
          </div>
          {'verification' in item ? (
            <div className="flex flex-wrap gap-1 pt-1">
              <span className="rounded-full border border-accent-cyan/30 bg-accent-cyan/10 px-1.5 py-0.5 text-[10px] text-accent-cyan">
                {item.verification}
              </span>
              <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {item.platform}
              </span>
              {item.company ? (
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {item.company}
                </span>
              ) : null}
            </div>
          ) : null}
          {'repository' in item && item.repository ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <Star className="h-3 w-3" /> {item.repository.stars.toLocaleString()}
              </span>
              <span>{item.repository.trendSignal}</span>
              <span>{item.repository.forks.toLocaleString()} forks</span>
              {item.repository.language ? <span>{item.repository.language}</span> : null}
            </div>
          ) : null}
          <p className="text-[10px] leading-snug text-muted-foreground/80 [html[data-theme=monochrome]_&]:text-muted-foreground">
            Credit: {item.credit}
            {item.imageCredit ? ` · Image: ${item.imageCredit}` : null}
          </p>
        </div>
      </button>
    </article>
  );
}

export function NewsPanel({
  open,
  onOpenChange,
  now,
  runtimeEffectsEnabled = true,
}: NewsPanelProps) {
  const [section, setSection] = React.useState<NewsSectionId>('today');
  const [kind, setKind] = React.useState<KindFilter>('all');
  const [live, setLive] = React.useState<LiveNewsResponse | null>(null);
  const [liveError, setLiveError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [following, setFollowing] = React.useState<Set<string>>(() => new Set());
  const [followPending, setFollowPending] = React.useState<Set<string>>(() => new Set());
  const [subscriptionError, setSubscriptionError] = React.useState<string | null>(null);
  const cloudAccountId = useAuthStore((state) => state.cloudSession?.user_id.trim() ?? '');
  const endpoint = React.useMemo(configuredNewsApiUrl, []);

  const refresh = React.useCallback(async () => {
    if (!endpoint || !runtimeEffectsEnabled) return;
    setRefreshing(true);
    try {
      const response = await fetchLiveNews(endpoint);
      setLive((current) => reconcileLiveNews(current, response));
      setLiveError(null);
      if (cloudAccountId) {
        try {
          const notifications = await fetchCreatorNotifications(endpoint);
          const seenKey = `vibespace-news-notifications:v1:${cloudAccountId}`;
          const seen = new Set<string>(
            JSON.parse(window.localStorage.getItem(seenKey) ?? '[]') as string[],
          );
          for (const notification of notifications) {
            const key = String(notification.id);
            if (!seen.has(key)) {
              seen.add(key);
              toast.info(`New from ${notification.company}`, notification.title);
            }
          }
          window.localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-500)));
          await acknowledgeCreatorNotifications(
            endpoint,
            notifications.map((notification) => notification.id),
          );
        } catch {
          // Headline refresh remains independent from authenticated creator alerts.
        }
      }
    } catch (error) {
      setLiveError(
        error instanceof Error ? error.message : 'Live news is temporarily unavailable.',
      );
    } finally {
      setRefreshing(false);
    }
  }, [cloudAccountId, endpoint, runtimeEffectsEnabled]);

  React.useEffect(() => {
    if (!open || !endpoint || !cloudAccountId || !runtimeEffectsEnabled) {
      setFollowing(new Set());
      return;
    }
    setSubscriptionError(null);
    let cancelled = false;
    void fetchCreatorSubscriptions(endpoint)
      .then((sourceIds) => {
        if (!cancelled) {
          setFollowing(new Set(sourceIds));
        }
      })
      .catch((error) => {
        if (!cancelled)
          setSubscriptionError(
            error instanceof Error ? error.message : 'Creator alerts are unavailable.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [cloudAccountId, endpoint, open, runtimeEffectsEnabled]);

  const toggleFollow = React.useCallback(
    async (sourceId: string) => {
      if (!endpoint || !cloudAccountId || followPending.has(sourceId)) return;
      const wasFollowing = following.has(sourceId);
      const nextFollowing = !wasFollowing;
      setFollowing((current) => {
        const next = new Set(current);
        if (nextFollowing) next.add(sourceId);
        else next.delete(sourceId);
        return next;
      });
      setFollowPending((current) => new Set(current).add(sourceId));
      try {
        await setCreatorSubscription(endpoint, sourceId, nextFollowing);
        setSubscriptionError(null);
      } catch (error) {
        setFollowing((current) => {
          const next = new Set(current);
          if (wasFollowing) next.add(sourceId);
          else next.delete(sourceId);
          return next;
        });
        setSubscriptionError(
          error instanceof Error ? error.message : 'Creator alert change was not saved.',
        );
      } finally {
        setFollowPending((current) => {
          const next = new Set(current);
          next.delete(sourceId);
          return next;
        });
      }
    },
    [cloudAccountId, endpoint, followPending, following],
  );

  // Reset to Today whenever the panel opens.
  React.useEffect(() => {
    if (open) {
      setSection('today');
      setKind('all');
    }
  }, [open]);

  React.useEffect(() => {
    if (!open || !endpoint || !runtimeEffectsEnabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), NEWS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [endpoint, open, refresh, runtimeEffectsEnabled]);

  // Escape closes the panel.
  React.useEffect(() => {
    if (!open || !runtimeEffectsEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange, runtimeEffectsEnabled]);

  const feedOptions = React.useMemo(() => ({ now, kind }), [now, kind]);
  const offlineCounts = React.useMemo(() => countNewsBySection({ now }), [now]);
  const liveBySection = React.useMemo(() => {
    if (!live) return null;
    return groupNewsBySection(live.items, now ?? new Date());
  }, [live, now]);
  const counts = liveBySection
    ? {
        today: liveBySection.today.length,
        last_week: liveBySection.last_week.length,
        more: liveBySection.more.length,
      }
    : offlineCounts;
  const items = React.useMemo(
    () =>
      kind === 'github'
        ? (live?.repositories ?? [])
        : liveBySection
          ? liveBySection[section].filter((item) => kind === 'all' || item.kind === kind)
          : getNewsFeed(section, feedOptions),
    [feedOptions, kind, live?.repositories, liveBySection, section],
  );

  if (!open) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[70] flex justify-end" role="presentation">
      {/* Soft click-catcher (does not dim the whole app heavily). */}
      <button
        type="button"
        aria-label="Close news panel"
        className="pointer-events-auto absolute inset-0 bg-black/20 backdrop-blur-[1px] [html[data-theme=monochrome]_&]:backdrop-blur-none"
        onClick={() => onOpenChange(false)}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="news-panel-title"
        className={cn(
          'pointer-events-auto relative flex h-full w-[min(420px,100vw)] flex-col',
          'sakura-news-panel',
          'border-l border-border bg-elevated shadow-2xl',
          'animate-in slide-in-from-right duration-200',
        )}
      >
        {/* Header */}
        <header className="shrink-0 border-b border-border bg-paper-soft px-4 pb-3 pt-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="eyebrow flex items-center gap-1.5">
                <Radar className="h-3 w-3 text-accent-copper" />
                AI feed
              </span>
              <h2
                id="news-panel-title"
                className="font-display mt-0.5 text-title leading-tight text-foreground"
              >
                News
              </h2>
              <p className="mt-0.5 text-metadata text-muted-foreground">
                {liveFeedStatus(live, liveError)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void refresh()}
              disabled={!endpoint || refreshing}
              aria-label="Refresh AI news"
              title={endpoint ? 'Refresh AI news' : 'Set VITE_NEWS_API_URL to enable live news'}
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              aria-label="Close news"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Section tabs */}
          {kind !== 'github' ? (
            <div
              role="tablist"
              aria-label="News time range"
              className="mt-3 flex gap-1 rounded-lg border border-border bg-paper p-0.5"
            >
              {SECTIONS.map((id) => {
                const active = section === id;
                const meta = NEWS_SECTION_META[id];
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={`${meta.label} ${counts[id]}`}
                    onClick={() => setSection(id)}
                    className={cn(
                      'flex-1 rounded-md px-2 py-1.5 text-metadata font-medium transition-colors',
                      active
                        ? 'bg-accent-copper/15 text-accent-copper'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {meta.label}
                    <span
                      className={cn(
                        'ml-1 tabular-nums',
                        active
                          ? 'text-accent-copper/80 [html[data-theme=monochrome]_&]:text-accent-copper'
                          : 'text-muted-foreground/70 [html[data-theme=monochrome]_&]:text-muted-foreground',
                      )}
                    >
                      {counts[id]}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-metadata font-medium text-foreground">
              Trending GitHub repositories
            </p>
          )}

          {/* Kind chips */}
          <div className="mt-2 flex flex-wrap gap-1">
            {KIND_FILTERS.map((f) => {
              const active = kind === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setKind(f.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-metadata transition-colors',
                    active
                      ? 'border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan'
                      : 'border-border bg-paper text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* Feed */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {liveError || subscriptionError ? (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-metadata text-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {liveError ?? subscriptionError}{' '}
                {liveError && live
                  ? 'Keeping the last live results.'
                  : 'Showing the credited offline feed.'}
              </span>
            </div>
          ) : null}
          <p className="mb-2 px-1 text-metadata text-muted-foreground">
            {kind === 'github'
              ? 'Approved AI repositories ranked by measured star change, then total stars.'
              : NEWS_SECTION_META[section].description}
          </p>
          {items.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-paper/50 px-4 py-12 text-center"
              data-sakura-state="empty"
            >
              <Newspaper className="h-7 w-7 text-muted-foreground/50 [html[data-theme=monochrome]_&]:text-muted-foreground" />
              <p className="text-secondary text-muted-foreground">
                {kind === 'github'
                  ? 'No repository trend snapshot is available yet.'
                  : `Nothing in ${NEWS_SECTION_META[section].label.toLowerCase()} yet.`}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  kind === 'github'
                    ? setKind('all')
                    : setSection(section === 'today' ? 'last_week' : 'more')
                }
              >
                {kind === 'github' ? 'Back to headlines' : 'Browse other sections'}
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => {
                const sourceId =
                  'sourceId' in item && typeof item.sourceId === 'string' ? item.sourceId : '';
                return (
                  <li key={item.id}>
                    <NewsCard
                      item={item}
                      runtimeEffectsEnabled={runtimeEffectsEnabled}
                      followed={Boolean(sourceId && following.has(sourceId))}
                      followPending={Boolean(sourceId && followPending.has(sourceId))}
                      canFollow={Boolean(cloudAccountId)}
                      onToggleFollow={() => {
                        if (sourceId) void toggleFollow(sourceId);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="shrink-0 border-t border-border bg-paper-soft px-4 py-2">
          {live?.freshness?.warning && (
            <p className="mb-1 text-[10px] leading-snug text-warning" role="status">
              {live.freshness.warning}
            </p>
          )}
          <p className="text-[10px] leading-snug text-muted-foreground">
            {live
              ? `Free-only feed · Last ingestion ${formatNewsDate(live.lastCompletedAt ?? live.generatedAt ?? new Date().toISOString())}.`
              : 'Curated offline snapshot. Stories open in your browser and retain original-publisher credits.'}
            {cloudAccountId
              ? ' Creator alerts are checked while VibeSpace is open; they are not OS push notifications.'
              : ''}
          </p>
        </footer>
      </aside>
    </div>
  );
}
