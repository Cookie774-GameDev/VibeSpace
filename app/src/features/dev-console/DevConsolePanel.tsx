/**
 * DevConsolePanel — floating bottom-attached panel that shows the
 * live DevConsole feed.
 *
 * Layout (from top to bottom):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  [search box]   channels  levels   [Clear] [Copy] [×]   │  toolbar
 *   ├──────────────────────────────────────────────────────────┤
 *   │  09:41:02.123  [fetch]  POST /v1/chat/completions → 200 │  feed
 *   │     ▸ details (lazy, expandable)                         │
 *   │  09:41:01.987  [invoke] terminal_spawn → ok (412 ms)     │
 *   │  …                                                        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Behavior:
 *   - Auto-scrolls to the bottom when new entries arrive UNLESS
 *     the user has scrolled up (we treat that as "they're inspecting
 *     a specific row" and stop following).
 *   - Filters are stateful (sticky during the session).
 *   - "Copy" copies the visible (filtered) entries as JSON to the
 *     clipboard so the user can paste a full repro into a chat.
 *   - Mounted at the page level via `<DevConsoleHost />` so it sits
 *     above every other UI layer.
 *   - Closed by default; open via Mod+Shift+D, the Help/Tools menu,
 *     or programmatically via `devConsole.setOpen(true)`.
 */

import * as React from 'react';
import {
  X,
  Trash2,
  Copy,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  filterEntries,
  safeStringify,
  useDevConsoleStore,
  type DevLogChannel,
  type DevLogEntry,
  type DevLogLevel,
} from './store';

const CHANNELS: { id: DevLogChannel; label: string }[] = [
  { id: 'app', label: 'app' },
  { id: 'console', label: 'console' },
  { id: 'fetch', label: 'fetch' },
  { id: 'invoke', label: 'invoke' },
  { id: 'event', label: 'event' },
  { id: 'route', label: 'route' },
  { id: 'ai', label: 'ai' },
  { id: 'action', label: 'action' },
  { id: 'react', label: 'react' },
  { id: 'window', label: 'window' },
];

const LEVELS: DevLogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_STYLES: Record<DevLogLevel, string> = {
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-amber-500',
  error: 'text-rose-500',
};

const CHANNEL_STYLES: Record<DevLogChannel, string> = {
  app: 'bg-muted/40 text-foreground',
  console: 'bg-muted/40 text-foreground',
  fetch: 'bg-sky-500/10 text-sky-500',
  invoke: 'bg-violet-500/10 text-violet-500',
  event: 'bg-emerald-500/10 text-emerald-500',
  route: 'bg-cyan-500/10 text-cyan-500',
  ai: 'bg-amber-500/10 text-amber-500',
  action: 'bg-orange-500/10 text-orange-500',
  react: 'bg-rose-500/10 text-rose-500',
  window: 'bg-rose-500/10 text-rose-500',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function Row({ entry }: { entry: DevLogEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const hasDetail = entry.detail !== undefined;

  return (
    <div className="border-b border-border/40">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/40',
          hasDetail ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span className="shrink-0 w-3 mt-0.5 text-muted-foreground">
          {hasDetail ? (
            expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-metadata text-muted-foreground tabular-nums">
          {formatTime(entry.ts)}
        </span>
        <span
          className={cn(
            'shrink-0 inline-flex items-center rounded px-1.5 text-metadata font-mono',
            CHANNEL_STYLES[entry.channel],
          )}
        >
          {entry.channel}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 font-mono text-secondary truncate',
            LEVEL_STYLES[entry.level],
          )}
        >
          {entry.message}
        </span>
        {entry.durationMs !== undefined && (
          <span className="shrink-0 font-mono text-metadata text-muted-foreground tabular-nums">
            {entry.durationMs}ms
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <pre className="mx-3 mb-2 mt-0 max-h-[200px] overflow-auto rounded border border-border bg-paper-soft px-2 py-1.5 font-mono text-metadata text-foreground">
          {safeStringify(entry.detail)}
        </pre>
      )}
    </div>
  );
}

export function DevConsolePanel() {
  const open = useDevConsoleStore((s) => s.open);
  const setOpen = useDevConsoleStore((s) => s.setOpen);
  const entries = useDevConsoleStore((s) => s.entries);
  const channels = useDevConsoleStore((s) => s.channels);
  const levels = useDevConsoleStore((s) => s.levels);
  const query = useDevConsoleStore((s) => s.query);
  const setQuery = useDevConsoleStore((s) => s.setQuery);
  const toggleChannel = useDevConsoleStore((s) => s.toggleChannel);
  const toggleLevel = useDevConsoleStore((s) => s.toggleLevel);
  const resetFilters = useDevConsoleStore((s) => s.resetFilters);
  const clear = useDevConsoleStore((s) => s.clear);

  const filtered = React.useMemo(
    () => filterEntries(entries, { channels, levels, query }),
    [entries, channels, levels, query],
  );

  // Auto-follow: scroll to bottom on new entries unless the user has
  // scrolled up. We track "stuck to bottom" with a ref that flips
  // false the moment the user scrolls away from the tail.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Treat anything within ~24px of the bottom as "still at the tail"
    // so a small scroll wobble (trackpad inertia) doesn't unstick.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickRef.current = atBottom;
  };

  React.useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filtered, open]);

  const copyVisible = async () => {
    const text = safeStringify(filtered);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied */
    }
  };

  if (!open) return null;

  return (
    <div
      role="region"
      aria-label="Dev console"
      className="fixed inset-x-0 bottom-0 z-[90] h-[42vh] min-h-[260px] border-t border-border bg-panel/95 backdrop-blur-sm shadow-soft flex flex-col"
    >
      {/* Toolbar */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter (matches message + JSON detail)"
            className="pl-7 h-7 text-secondary"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {CHANNELS.map((c) => {
            const active = channels.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleChannel(c.id)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-metadata font-mono transition-colors',
                  active
                    ? CHANNEL_STYLES[c.id]
                    : 'text-muted-foreground hover:bg-muted/40',
                )}
                aria-pressed={active}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          {LEVELS.map((l) => {
            const active = levels.has(l);
            return (
              <button
                key={l}
                type="button"
                onClick={() => toggleLevel(l)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-metadata font-mono transition-colors',
                  active ? LEVEL_STYLES[l] : 'text-muted-foreground hover:bg-muted/40',
                  active && 'bg-muted/40',
                )}
                aria-pressed={active}
              >
                {l}
              </button>
            );
          })}
        </div>

        {(channels.size > 0 || levels.size > 0 || query) && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset
          </Button>
        )}

        <span className="text-metadata text-muted-foreground ml-auto tabular-nums">
          {filtered.length} / {entries.length}
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={copyVisible}
          aria-label="Copy visible entries"
          title="Copy visible"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={clear}
          aria-label="Clear feed"
          title="Clear feed"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(false)}
          aria-label="Close dev console"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Feed */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-secondary px-4 text-center">
            {entries.length === 0
              ? 'No events captured yet. Trigger anything (open settings, send a message, switch routes) to see logs flow in.'
              : 'No entries match the current filters.'}
          </div>
        ) : (
          filtered.map((e) => <Row key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}
