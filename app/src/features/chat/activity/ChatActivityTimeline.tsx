import * as React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  FileCode2,
  FileText,
  GitPullRequest,
  Image,
  Loader2,
  Pencil,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { cn, formatRelative } from '@/lib/utils';
import { formatUserDateTime, formatUserTime } from '@/lib/timeFormat';
import type { ChatId } from '@/types/common';
import type { ChatActivityEvent, ChatActivityKind, ChatActivityStatus } from './types';
import { chatActivityPreferences } from './chatActivityPreferences';
import { useUnifiedChatActivity } from './unifiedActivity';

const KIND_ICON: Record<ChatActivityKind, typeof Bot> = {
  agent: Bot,
  subagent: Bot,
  file: FileText,
  url: ExternalLink,
  diff: Pencil,
  tool: Wrench,
};

const STATUS_META: Record<
  ChatActivityStatus,
  { label: string; variant: 'secondary' | 'success' | 'destructive'; icon: React.ReactElement }
> = {
  pending: { label: 'Queued', variant: 'secondary', icon: <Loader2 className="h-3 w-3" /> },
  running: {
    label: 'Running',
    variant: 'secondary',
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  done: { label: 'Done', variant: 'success', icon: <CheckCircle2 className="h-3 w-3" /> },
  cancelled: { label: 'Cancelled', variant: 'secondary', icon: <XCircle className="h-3 w-3" /> },
  error: { label: 'Failed', variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
};

const COLLAPSE_KEY = 'jarvis.chatActivity.collapsed';

function loadCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    // Default collapsed: show the stats dashboard, not a long Done list.
    if (stored == null) return true;
    return stored === '1';
  } catch {
    return true;
  }
}

function saveCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function formatClock(ms: number | undefined): string {
  if (ms == null) return '—';
  try {
    return formatUserTime(ms, { seconds: true });
  } catch {
    return '—';
  }
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Parse "8730+26 tokens" style subtitles from older agent events
 * that predate structured inputTokens/outputTokens fields.
 */
export function parseTokensFromSubtitle(subtitle: string | undefined): {
  inputTokens: number;
  outputTokens: number;
} | null {
  if (!subtitle) return null;
  const match = subtitle.match(/(\d+)\s*\+\s*(\d+)\s*tokens?/i);
  if (!match) return null;
  return {
    inputTokens: Number(match[1]),
    outputTokens: Number(match[2]),
  };
}

/** Aggregate stats for the session header. */
export function summarizeChatActivity(events: readonly ChatActivityEvent[], nowMs = Date.now()) {
  let inputTokens = 0;
  let outputTokens = 0;
  let addedLines = 0;
  let removedLines = 0;
  let agentTurns = 0;
  const editedFiles = new Set<string>();
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let running: ChatActivityEvent | undefined;
  let lastAgent: ChatActivityEvent | undefined;

  for (const event of events) {
    if (typeof event.inputTokens === 'number' && typeof event.outputTokens === 'number') {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
    } else {
      const parsed = parseTokensFromSubtitle(event.subtitle);
      if (parsed) {
        inputTokens += parsed.inputTokens;
        outputTokens += parsed.outputTokens;
      } else {
        if (typeof event.inputTokens === 'number') inputTokens += event.inputTokens;
        if (typeof event.outputTokens === 'number') outputTokens += event.outputTokens;
      }
    }
    if (typeof event.addedLines === 'number') addedLines += event.addedLines;
    if (typeof event.removedLines === 'number') removedLines += event.removedLines;
    if (event.filePath && (event.kind === 'diff' || event.kind === 'file')) {
      editedFiles.add(event.filePath);
    }
    if (event.kind === 'agent' || event.kind === 'subagent') {
      agentTurns += 1;
      if (!lastAgent || event.ts >= lastAgent.ts) lastAgent = event;
    }
    const start = event.startedAt ?? event.ts;
    if (startedAt == null || start < startedAt) startedAt = start;
    if (event.endedAt != null && (endedAt == null || event.endedAt > endedAt)) {
      endedAt = event.endedAt;
    }
    // Fallback end time for finished agent rows without endedAt
    if (
      (event.kind === 'agent' || event.kind === 'subagent') &&
      event.status === 'done' &&
      event.endedAt == null
    ) {
      if (endedAt == null || event.ts > endedAt) endedAt = event.ts;
    }
    if (event.status === 'running' || event.status === 'pending') {
      if (!running || event.ts >= running.ts) running = event;
    }
  }

  const isLive = Boolean(running);
  const durationMs = isLive
    ? nowMs - (startedAt ?? nowMs)
    : endedAt != null && startedAt != null
      ? Math.max(0, endedAt - startedAt)
      : 0;

  const doingNow =
    running?.detail ||
    running?.title ||
    (lastAgent?.status === 'running' || lastAgent?.status === 'pending'
      ? lastAgent.title
      : lastAgent?.status === 'done'
        ? 'Idle — ready for the next message'
        : lastAgent?.detail) ||
    (events.length === 0 ? 'Ready — send a message to start this session' : '—');

  return {
    inputTokens,
    outputTokens,
    addedLines,
    removedLines,
    editedFileCount: editedFiles.size,
    editedFiles: [...editedFiles],
    agentTurns,
    startedAt,
    endedAt,
    durationMs,
    isLive,
    doingNow,
    running,
    eventCount: events.length,
  };
}

/**
 * Expandable feed prefers useful ops over a wall of "@jarvis finished".
 * Keeps: files, diffs, tools, urls, running work, and the latest agent only.
 */
export function selectActivityFeedEvents(
  events: readonly ChatActivityEvent[],
): ChatActivityEvent[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const lastAgent = [...sorted].reverse().find((e) => e.kind === 'agent' || e.kind === 'subagent');
  return sorted
    .filter((event) => {
      if (event.status === 'running' || event.status === 'pending') return true;
      if (
        event.kind === 'diff' ||
        event.kind === 'file' ||
        event.kind === 'tool' ||
        event.kind === 'url'
      ) {
        return true;
      }
      if (
        (event.kind === 'agent' || event.kind === 'subagent') &&
        lastAgent &&
        event.id === lastAgent.id
      ) {
        return true;
      }
      return false;
    })
    .slice(-16);
}

export function ChatActivityTimeline({
  chatId,
  compact = false,
}: {
  chatId: ChatId | string;
  compact?: boolean;
}) {
  const activityPreferences = React.useSyncExternalStore(
    chatActivityPreferences.subscribe,
    chatActivityPreferences.getSnapshot,
    chatActivityPreferences.getSnapshot,
  );
  const events = useUnifiedChatActivity(String(chatId));
  // Default collapsed so the panel is a stats dashboard, not a wall of Done rows.
  const [collapsed, setCollapsed] = React.useState(() => {
    const stored = loadCollapsed();
    // First visit: collapsed. Explicit expand is remembered.
    return stored;
  });
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  const hasRunning = events.some((e) => e.status === 'running' || e.status === 'pending');
  React.useEffect(() => {
    if (!hasRunning) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  // Auto-expand while Jarvis is actively working so "what now" is visible.
  React.useEffect(() => {
    if (hasRunning) setCollapsed(false);
  }, [hasRunning]);

  const feed = React.useMemo(() => selectActivityFeedEvents(events), [events]);
  const summary = React.useMemo(() => summarizeChatActivity(events, nowMs), [events, nowMs]);

  if (!activityPreferences.showSessionPanel) return null;

  // Always render — empty chats and chats with no activity still show the dashboard.
  const toggle = () => {
    setCollapsed((v) => {
      const next = !v;
      saveCollapsed(next);
      return next;
    });
  };

  return (
    <section
      data-testid="jarvis-session-panel"
      className={cn(
        'overflow-hidden rounded-xl border border-accent-copper/30 bg-panel/85 shadow-soft',
        '[html[data-theme=monochrome]_&]:shadow-none',
        compact ? 'mx-1' : 'mx-0',
      )}
      aria-label="Jarvis session"
    >
      {/* Always-visible session dashboard */}
      <div className="bg-elevated/45 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-strong text-foreground">Jarvis session</p>
              {summary.isLive ? (
                <Badge variant="secondary" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running
                </Badge>
              ) : (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Idle
                </Badge>
              )}
              {summary.agentTurns > 0 ? (
                <span className="text-[10px] text-muted-foreground">
                  {summary.agentTurns} turn{summary.agentTurns === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-metadata text-muted-foreground">
              <span className="font-medium text-accent-copper">Now:</span>{' '}
              <span className="text-foreground/90">{summary.doingNow}</span>
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand session details' : 'Collapse session details'}
          >
            {collapsed ? 'Expand' : 'Collapse'}
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-180')}
            />
          </Button>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
          <StatChip
            label="Edited files"
            value={String(summary.editedFileCount)}
            hint={
              summary.editedFiles.length
                ? summary.editedFiles.slice(0, 4).map(basename).join(', ')
                : 'No file edits yet'
            }
          />
          <StatChip
            label="Lines in/out"
            value={
              <span className="font-mono tabular-nums">
                <span className="text-emerald-400">+{summary.addedLines}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-rose-400">-{summary.removedLines}</span>
              </span>
            }
            hint="Total added / removed lines of code this chat"
          />
          <StatChip
            label="Tokens in"
            value={
              <span className="font-mono tabular-nums">{summary.inputTokens.toLocaleString()}</span>
            }
            hint="Total input tokens this chat"
          />
          <StatChip
            label="Tokens out"
            value={
              <span className="font-mono tabular-nums">
                {summary.outputTokens.toLocaleString()}
              </span>
            }
            hint="Total output tokens this chat"
          />
          <StatChip
            label="Started"
            value={
              <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
                <Clock className="h-3 w-3 text-accent-copper" />
                {formatClock(summary.startedAt)}
              </span>
            }
            hint={summary.startedAt ? formatUserDateTime(summary.startedAt) : undefined}
          />
          <StatChip
            label={summary.isLive ? 'Running for' : 'Duration'}
            value={
              <span className="font-mono tabular-nums">{formatDuration(summary.durationMs)}</span>
            }
            hint={summary.isLive ? 'Elapsed since first activity' : 'Start → last finish'}
          />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-border/70"
          >
            {feed.length === 0 ? (
              <p className="px-3 py-2 text-metadata text-muted-foreground">
                {events.length === 0
                  ? 'Session panel stays here for this chat. Stats fill in as Jarvis works.'
                  : 'No file or tool activity yet — totals above still update after each reply.'}
              </p>
            ) : (
              <div className="divide-y divide-border/70">
                {feed.map((event) => (
                  <ActivityRow key={event.id} event={event} nowMs={nowMs} />
                ))}
              </div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function StatChip({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/50 px-2 py-1.5" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[12px] font-medium text-foreground">{value}</div>
    </div>
  );
}

export function ActivityRow({
  event,
  nowMs = Date.now(),
}: {
  event: ChatActivityEvent;
  nowMs?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const Icon = KIND_ICON[event.kind] ?? Bot;
  const meta = STATUS_META[event.status];
  const hasBody = Boolean(event.detail || event.diff);
  const isFileOp = event.kind === 'diff' || (event.kind === 'file' && Boolean(event.filePath));
  const start = event.startedAt ?? event.ts;
  const end = event.endedAt ?? (event.status === 'running' ? nowMs : event.ts);
  const durationLabel = formatDuration(Math.max(0, end - start));

  if (isFileOp && event.filePath) {
    return (
      <article className="bg-elevated/35">
        <button
          type="button"
          onClick={() => hasBody && setOpen((v) => !v)}
          disabled={!hasBody}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left',
            hasBody ? 'hover:bg-muted/35' : 'cursor-default',
          )}
          aria-expanded={open}
        >
          <span
            className={cn(
              'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
              event.kind === 'diff'
                ? 'border-accent-copper/40 bg-accent-copper/15 text-accent-copper'
                : 'border-border bg-background text-muted-foreground',
            )}
          >
            {event.kind === 'diff' ? (
              <Pencil className="h-3.5 w-3.5" />
            ) : (
              <FileCode2 className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-accent-copper">
                {event.kind === 'diff' ? 'Edit' : 'Read'}
              </span>
              <span className="truncate font-mono text-secondary text-foreground">
                {basename(event.filePath)}
              </span>
              {event.kind === 'diff' ? (
                <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
                  <span className="text-emerald-400">+{event.addedLines ?? 0}</span>
                  <span className="text-rose-400">-{event.removedLines ?? 0}</span>
                </span>
              ) : null}
            </div>
            <p
              className="truncate font-mono text-[10px] text-muted-foreground"
              title={event.filePath}
            >
              {event.filePath}
            </p>
          </div>
          <Badge variant={meta.variant} className="gap-1">
            {meta.icon}
            {meta.label}
          </Badge>
          {hasBody ? (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          ) : null}
        </button>
        <AnimatePresence initial={false}>
          {open && hasBody ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-t border-border/70"
            >
              <div className="space-y-2 px-3 py-2.5">
                {event.detail && event.kind === 'file' ? (
                  <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background/90 p-2 font-mono text-[11px] leading-relaxed text-foreground/90">
                    {event.detail}
                  </pre>
                ) : null}
                {event.diff ? <DiffPreview diff={event.diff} /> : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </article>
    );
  }

  return (
    <article className="bg-elevated/45">
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          hasBody ? 'hover:bg-muted/35' : 'cursor-default',
        )}
        aria-expanded={open}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-secondary text-foreground">{event.title}</p>
            {event.kind === 'file' && event.filePath && (
              <ImageAwareFileBadge path={event.filePath} />
            )}
          </div>
          <p className="truncate text-metadata text-muted-foreground">
            {event.subtitle ??
              event.agentSlug ??
              event.filePath ??
              event.url ??
              formatRelative(event.ts)}
            {event.inputTokens != null || event.outputTokens != null
              ? ` · ${event.inputTokens ?? 0}+${event.outputTokens ?? 0} tok · ${durationLabel}`
              : ` · ${durationLabel}`}
          </p>
        </div>
        <Badge variant={meta.variant} className="gap-1">
          {meta.icon}
          {meta.label}
        </Badge>
        {hasBody ? (
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>
      <AnimatePresence initial={false}>
        {open && hasBody ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-border/70"
          >
            <div className="space-y-2 px-3 py-2.5">
              {event.detail ? (
                <p className="whitespace-pre-wrap text-secondary text-muted-foreground">
                  {event.detail}
                </p>
              ) : null}
              {event.diff ? <DiffPreview diff={event.diff} /> : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </article>
  );
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split('\n').slice(0, 200);
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        let cls = 'text-foreground/85';
        if (line.startsWith('+') && !line.startsWith('+++'))
          cls = 'bg-emerald-500/10 text-emerald-300';
        else if (line.startsWith('-') && !line.startsWith('---'))
          cls = 'bg-rose-500/10 text-rose-300';
        else if (line.startsWith('@@')) cls = 'text-accent-honey';
        else if (line.startsWith('---') || line.startsWith('+++')) cls = 'text-muted-foreground';
        return (
          <div
            key={`${i}-${line.slice(0, 24)}`}
            className={cn('whitespace-pre-wrap break-all', cls)}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function ImageAwareFileBadge({ path }: { path: string }) {
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(path);
  if (!isImage) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-pink-500/10 px-1.5 py-0.5 text-[10px] text-pink-300">
      <Image className="h-2.5 w-2.5" />
      image
    </span>
  );
}
