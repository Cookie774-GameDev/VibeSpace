import * as React from 'react';
import {
  Activity,
  Braces,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  ListTree,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  buildEvidenceLanes,
  calculateVirtualWindow,
  exportDevLog,
  formatDevLogTimestamp,
  humanizeEntry,
  type DevLogEvidenceLane,
} from './fullDevLog';
import {
  filterEntries,
  safeStringify,
  useDevConsoleStore,
  type DevLogChannel,
  type DevLogEntry,
  type DevLogLevel,
  type DevLogViewMode,
} from './store';

const ROW_HEIGHT = 62;
const EMPTY_ENTRIES: DevLogEntry[] = [];
const OVERSCAN = 8;

const CHANNELS: { id: DevLogChannel; label: string }[] = [
  { id: 'app', label: 'App' },
  { id: 'console', label: 'Console' },
  { id: 'fetch', label: 'Network' },
  { id: 'invoke', label: 'Native' },
  { id: 'event', label: 'Events' },
  { id: 'route', label: 'Routes' },
  { id: 'ai', label: 'AI' },
  { id: 'action', label: 'Actions' },
  { id: 'react', label: 'React' },
  { id: 'window', label: 'Errors' },
];

const LEVELS: DevLogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_STYLES: Record<DevLogLevel, string> = {
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-amber-600',
  error: 'text-rose-600',
};

const CHANNEL_STYLES: Record<DevLogChannel, string> = {
  action: 'bg-orange-500/10 text-orange-700',
  ai: 'bg-amber-500/10 text-amber-700',
  app: 'bg-muted/50 text-foreground',
  console: 'bg-muted/50 text-foreground',
  event: 'bg-emerald-500/10 text-emerald-700',
  fetch: 'bg-sky-500/10 text-sky-700',
  invoke: 'bg-violet-500/10 text-violet-700',
  react: 'bg-rose-500/10 text-rose-700',
  route: 'bg-cyan-500/10 text-cyan-700',
  window: 'bg-rose-500/10 text-rose-700',
};

const LANE_STYLES: Record<DevLogEvidenceLane['kind'], string> = {
  model: 'border-amber-500/30 bg-amber-500/10 text-amber-800',
  request: 'border-sky-500/30 bg-sky-500/10 text-sky-800',
  rlm: 'border-violet-500/30 bg-violet-500/10 text-violet-800',
  siyuan: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800',
  tool: 'border-orange-500/30 bg-orange-500/10 text-orange-800',
};

function downloadArtifact(entries: readonly DevLogEntry[], format: 'json' | 'html'): void {
  const artifact = exportDevLog(entries, format);
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function TimelineRow({
  entry,
  mode,
  selected,
  onSelect,
}: {
  entry: DevLogEntry;
  mode: DevLogViewMode;
  selected: boolean;
  onSelect: () => void;
}) {
  const human = humanizeEntry(entry);
  return (
    <button
      type="button"
      data-dev-log-row="true"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group flex h-[58px] w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors',
        selected
          ? 'border-accent-copper/50 bg-paper shadow-soft'
          : 'border-transparent bg-paper-soft/60 hover:border-border hover:bg-paper',
      )}
    >
      <span className="w-[78px] shrink-0 font-mono text-metadata tabular-nums text-muted-foreground">
        {formatDevLogTimestamp(entry.ts)}
      </span>
      {mode === 'human' ? (
        <>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {human.eyebrow}
            </span>
            <span className={cn('block truncate text-secondary', LEVEL_STYLES[entry.level])}>
              {human.title}
            </span>
          </span>
          <span
            className={cn(
              'hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium sm:inline-flex',
              CHANNEL_STYLES[entry.channel],
            )}
          >
            {entry.channel}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 font-mono text-[11px] leading-4">
          <span className="block truncate text-muted-foreground">
            #{entry.id} [{entry.channel}/{entry.level}]
          </span>
          <span className={cn('block truncate', LEVEL_STYLES[entry.level])}>{entry.message}</span>
        </span>
      )}
      {human.duration ? (
        <span className="shrink-0 font-mono text-metadata tabular-nums text-muted-foreground">
          {human.duration}
        </span>
      ) : null}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-aria-pressed:translate-x-0.5" />
    </button>
  );
}

function DetailInspector({
  entry,
  mode,
}: {
  entry: DevLogEntry | undefined;
  mode: DevLogViewMode;
}) {
  return (
    <aside className="hidden min-w-0 border-l border-border/70 bg-panel/45 lg:flex lg:w-[38%] lg:flex-col">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          {mode === 'human' ? (
            <Activity className="h-4 w-4 text-accent-copper" />
          ) : (
            <Braces className="h-4 w-4 text-accent-copper" />
          )}
          <h3 className="font-serif text-ui-strong text-foreground">
            {mode === 'human' ? 'Event evidence' : 'Sanitized trace'}
          </h3>
        </div>
        <p className="mt-1 text-metadata text-muted-foreground">
          Prompt, source, tool input/output, credentials, and private user-path segments are
          omitted.
        </p>
      </div>
      {entry ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="rounded-xl border border-border/70 bg-paper/70 p-3 shadow-soft">
            <div className="flex flex-wrap items-center gap-2 text-metadata text-muted-foreground">
              <span className="font-mono tabular-nums">{formatDevLogTimestamp(entry.ts)}</span>
              <span className={cn('rounded-full px-2 py-0.5', CHANNEL_STYLES[entry.channel])}>
                {entry.channel}
              </span>
              <span className={LEVEL_STYLES[entry.level]}>{entry.level}</span>
              {entry.durationMs !== undefined ? <span>{entry.durationMs} ms</span> : null}
            </div>
            <p className="mt-2 text-secondary text-foreground">{entry.message}</p>
          </div>
          <pre className="mt-3 min-h-[120px] whitespace-pre-wrap break-words rounded-xl border border-border/70 bg-paper-soft/80 p-3 font-mono text-[11px] leading-5 text-foreground">
            {entry.detail === undefined
              ? 'No structured detail recorded.'
              : safeStringify(entry.detail)}
          </pre>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-secondary text-muted-foreground">
          Select an event to inspect the real sanitized evidence recorded with it.
        </div>
      )}
    </aside>
  );
}

export function DevConsolePanel() {
  const open = useDevConsoleStore((state) => state.open);
  const setOpen = useDevConsoleStore((state) => state.setOpen);
  // Recording stays live in the store; a closed inspector must not rebuild
  // its entire evidence index on every streamed event.
  const entries = useDevConsoleStore((state) => (state.open ? state.entries : EMPTY_ENTRIES));
  const channels = useDevConsoleStore((state) => state.channels);
  const levels = useDevConsoleStore((state) => state.levels);
  const query = useDevConsoleStore((state) => state.query);
  const viewMode = useDevConsoleStore((state) => state.viewMode);
  const setQuery = useDevConsoleStore((state) => state.setQuery);
  const setViewMode = useDevConsoleStore((state) => state.setViewMode);
  const toggleChannel = useDevConsoleStore((state) => state.toggleChannel);
  const toggleLevel = useDevConsoleStore((state) => state.toggleLevel);
  const resetFilters = useDevConsoleStore((state) => state.resetFilters);
  const clear = useDevConsoleStore((state) => state.clear);

  const [selectedId, setSelectedId] = React.useState<number>();
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(420);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickToTail = React.useRef(true);

  const filtered = React.useMemo(
    () => filterEntries(entries, { channels, levels, query }),
    [entries, channels, levels, query],
  );
  const lanes = React.useMemo(() => buildEvidenceLanes(filtered), [filtered]);
  const tailId = entries.at(-1)?.id;
  const selected = React.useMemo(
    () => filtered.find((entry) => entry.id === selectedId),
    [filtered, selectedId],
  );
  const virtual = React.useMemo(
    () =>
      calculateVirtualWindow({
        count: filtered.length,
        scrollTop,
        viewportHeight,
        rowHeight: ROW_HEIGHT,
        overscan: OVERSCAN,
      }),
    [filtered.length, scrollTop, viewportHeight],
  );
  const visibleEntries = filtered.slice(virtual.start, virtual.end);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight || 420);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [open]);

  React.useLayoutEffect(() => {
    if (!open || !stickToTail.current) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = Math.max(0, virtual.totalHeight - element.clientHeight);
    setScrollTop(element.scrollTop);
  }, [tailId, open, virtual.totalHeight]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    stickToTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(exportDevLog(filtered, 'json').content);
    } catch {
      // Clipboard permission can be denied; export remains available.
    }
  };

  if (!open) return null;

  return (
    <section
      role="region"
      aria-label="Full Dev Log"
      data-warm-surface="full-dev-log"
      className="fixed inset-x-2 bottom-2 z-[90] flex h-[58vh] min-h-[360px] flex-col overflow-hidden rounded-2xl border border-border/80 bg-panel/90 shadow-soft backdrop-blur-md [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:backdrop-blur-none"
    >
      <header className="shrink-0 border-b border-border/70 bg-paper/55 px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[190px]">
            <div className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-accent-copper" />
              <h2 className="font-serif text-section-title text-foreground">Full Dev Log</h2>
              <span className="rounded-full border border-border/70 bg-paper-soft px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {entries.length.toLocaleString()} / 10,000
              </span>
            </div>
            <p className="mt-0.5 text-metadata text-muted-foreground">
              Real app, request, model, Context, and tool evidence—sanitized before storage.
            </p>
          </div>

          <div
            className="flex rounded-lg border border-border/70 bg-paper-soft/80 p-0.5"
            aria-label="Log view"
          >
            <button
              type="button"
              onClick={() => setViewMode('human')}
              aria-pressed={viewMode === 'human'}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-metadata transition-colors',
                viewMode === 'human'
                  ? 'bg-paper text-foreground shadow-soft'
                  : 'text-muted-foreground',
              )}
            >
              <ListTree className="h-3.5 w-3.5" /> Human timeline
            </button>
            <button
              type="button"
              onClick={() => setViewMode('deep')}
              aria-pressed={viewMode === 'deep'}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-metadata transition-colors',
                viewMode === 'deep'
                  ? 'bg-paper text-foreground shadow-soft'
                  : 'text-muted-foreground',
              )}
            >
              <Braces className="h-3.5 w-3.5" /> Deep trace
            </button>
          </div>

          <div className="relative min-w-[210px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sanitized events and evidence"
              className="h-8 bg-paper/70 pl-8 text-secondary"
            />
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={copyJson}
              aria-label="Copy sanitized JSON"
              title="Copy sanitized JSON"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => downloadArtifact(filtered, 'json')}
              aria-label="Export sanitized JSON"
              title="Export JSON"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => downloadArtifact(filtered, 'html')}
              aria-label="Export safe HTML"
              title="Export safe HTML"
            >
              <FileCode2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setSelectedId(undefined);
                clear();
              }}
              aria-label="Clear Full Dev Log"
              title="Clear log"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              aria-label="Close Full Dev Log"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="mt-2 flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Evidence
          </span>
          {lanes.length === 0 ? (
            <span className="text-metadata text-muted-foreground">
              No request/model/RLM/SiYuan/tool identity recorded in this view.
            </span>
          ) : (
            lanes.slice(0, 20).map((lane) => (
              <span
                key={lane.id}
                className={cn(
                  'shrink-0 rounded-full border px-2 py-0.5 text-[10px]',
                  LANE_STYLES[lane.kind],
                )}
              >
                {lane.label} · {lane.count}
              </span>
            ))
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-border/60 bg-panel/35 px-3 py-1.5">
            {CHANNELS.map((channel) => (
              <button
                key={channel.id}
                type="button"
                onClick={() => toggleChannel(channel.id)}
                aria-pressed={channels.has(channel.id)}
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
                  channels.has(channel.id)
                    ? CHANNEL_STYLES[channel.id]
                    : 'text-muted-foreground hover:bg-paper-soft',
                )}
              >
                {channel.label}
              </button>
            ))}
            <span className="mx-1 h-3 w-px bg-border" />
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                aria-pressed={levels.has(level)}
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
                  levels.has(level)
                    ? `bg-paper-soft ${LEVEL_STYLES[level]}`
                    : 'text-muted-foreground hover:bg-paper-soft',
                )}
              >
                {level}
              </button>
            ))}
            {channels.size > 0 || levels.size > 0 || query ? (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-1 text-[10px] text-accent-copper hover:underline"
              >
                Reset filters
              </button>
            ) : null}
            <span className="ml-auto text-metadata tabular-nums text-muted-foreground">
              {filtered.length.toLocaleString()} visible
            </span>
          </div>

          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto bg-panel/20 px-2"
          >
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-secondary text-muted-foreground">
                {entries.length === 0
                  ? 'No events yet. Use VibeSpace normally and the real timeline will appear here.'
                  : 'No sanitized events match these filters.'}
              </div>
            ) : (
              <div style={{ height: virtual.totalHeight, position: 'relative' }}>
                <div style={{ position: 'absolute', left: 0, right: 0, top: virtual.offsetTop }}>
                  {visibleEntries.map((entry) => (
                    <div key={entry.id} style={{ height: ROW_HEIGHT }} className="py-0.5">
                      <TimelineRow
                        entry={entry}
                        mode={viewMode}
                        selected={entry.id === selectedId}
                        onSelect={() => setSelectedId(entry.id)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <DetailInspector entry={selected} mode={viewMode} />
      </div>
    </section>
  );
}
