import * as React from 'react';
import { motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Boxes,
  CalendarDays,
  CircleDot,
  ExternalLink,
  GitBranch,
  Link2,
  ListTodo,
  MessageSquare,
  Sparkles,
  Sun,
  Tag,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
// `useTodayEvents` exists on the V2 schedule hooks (added by the parallel
// agent) but isn't re-exported from `@/features/schedule` yet. Import the
// deep path until it surfaces in the barrel.
import { useTodayEvents } from '@/features/schedule/hooks';
import type { RecurrenceInstance } from '@/features/schedule/recurrence';
import { useQuickLinks, launchLink } from '@/features/launcher';
import { useTodayTasks } from '@/features/tasks';
import { chatRepo, taskRepo, terminalSessionRepo } from '@/lib/db';
import { isTauri } from '@/lib/tauri';
import { cn, formatClock, formatRelative } from '@/lib/utils';
import type { QuickLink } from '@/types/quick-link';
import type { Task, TaskPriority, TaskStatus } from '@/types/task';
import type { Chat } from '@/types/chat';
import type { TerminalSession } from '@/types/terminal';
import type { WorkspaceId } from '@/types/common';

/** V3 top-level routes. Mirrors the contract in `@/stores/ui` (Slice 4). */
type Route =
  | 'chat'
  | 'terminal'
  | 'kanban'
  | 'agents'
  | 'skills'
  | 'benchmarks'
  | 'history';

/**
 * Inspector — 320px right pane, mounted/unmounted via AnimatePresence
 * inside AppShell. Cmd+\ toggles via useUIStore.toggleInspector.
 *
 * V3 makes the Inspector route-aware. Above the existing Today tab we
 * insert a route-context strip whose panel switches with the active
 * top-level route (terminal / kanban / skills / benchmarks / history).
 * Chat (the default) keeps the strip empty and lets the Today tab below
 * be the primary surface — preserving V2 behavior.
 *
 * The Today / Context / Tools / Trace / Refs tabs are intentionally
 * untouched. Strip panels are wrapped in defensive try/catch + lazy
 * imports so a sibling slice that hasn't landed yet renders a friendly
 * "Coming soon" card instead of crashing the inspector.
 */
export function Inspector() {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;

  return (
    <motion.aside
      aria-label="Inspector"
      className="shrink-0 overflow-hidden bg-panel border-l border-border"
      initial={{ width: 0 }}
      animate={{ width: 320 }}
      exit={{ width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <div className="flex h-full w-[320px] flex-col">
        <Tabs defaultValue="today" className="flex h-full min-h-0 flex-col">
          {/* NEW — route-context strip. Renders nothing for chat/agents. */}
          <RouteContextStrip workspaceId={workspaceId} />

          {/* 5-tab strip — Today is the home tab. The trigger override
              tightens padding so labels still fit the 320px pane. */}
          <div className="px-3 pt-3">
            <TabsList className="grid w-full grid-cols-5">
              <InspectorTab value="today" icon={Sun} label="Today" />
              <InspectorTab value="context" icon={Boxes} label="Context" />
              <InspectorTab value="tools" icon={Wrench} label="Tools" />
              <InspectorTab value="trace" icon={GitBranch} label="Trace" />
              <InspectorTab value="refs" icon={Link2} label="Refs" />
            </TabsList>
          </div>
          <TabsContent
            value="today"
            className="m-0 flex-1 overflow-auto scrollbar-hidden"
          >
            <TodayPanel />
          </TabsContent>
          <TabsContent
            value="context"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Context"
              body="Memory items, files, and runtime state the active agent is using."
            />
          </TabsContent>
          <TabsContent
            value="tools"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Tools"
              body="Tool-call history with arguments and results, expandable inline."
            />
          </TabsContent>
          <TabsContent
            value="trace"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Trace"
              body="Workflow timeline with agent rows, tool spans, and token costs."
            />
          </TabsContent>
          <TabsContent
            value="refs"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="References"
              body="Source references for the current message. Click any item to open it."
            />
          </TabsContent>
        </Tabs>
      </div>
    </motion.aside>
  );
}

interface InspectorTabProps {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

/**
 * Tighter trigger so 5 labels fit at 320px pane width. Tooltip surfaces
 * the full label if the visible text feels cramped on smaller scales.
 */
function InspectorTab({ value, icon: Icon, label }: InspectorTabProps) {
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <TabsTrigger value={value} className="gap-1 px-1 text-metadata">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-ui-strong text-foreground">{title}</p>
      <p className="text-secondary text-muted-foreground">{body}</p>
    </div>
  );
}

// ============================================================
// Today panel
// ============================================================

/**
 * Today's schedule, open tasks, and recent quick-links. Each section is
 * a warm card with a small caps section label and a generous body. Empty
 * states stay friendly — the inspector is meant to feel like a calm
 * morning brief, not a dashboard.
 */
function TodayPanel() {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;

  // Today's schedule comes from the recurrence-aware feed so daily/weekly
  // anchors light up correctly. Returns `RecurrenceInstance[]` (anchor +
  // materialised repeats), not raw `EventRow[]`.
  const todayEvents = useTodayEvents(workspaceId);

  const todayTasks = useTodayTasks();
  const quickLinks = useQuickLinks(workspaceId);

  const recentLinks = React.useMemo(() => {
    return [...quickLinks]
      .sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0))
      .slice(0, 4);
  }, [quickLinks]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <ScheduleSection events={todayEvents.slice(0, 5)} />
      <TasksSection tasks={todayTasks.slice(0, 5)} />
      <QuickLinksSection links={recentLinks} />
    </div>
  );
}

// ----- Section: schedule for today -----

function ScheduleSection({ events }: { events: RecurrenceInstance[] }) {
  return (
    <Section
      label="Schedule"
      icon={<CalendarDays className="h-3 w-3" />}
      hint={events.length > 0 ? `${events.length} today` : undefined}
    >
      {events.length === 0 ? (
        <EmptyState text="Cleared for focus." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {events.map((inst) => (
            <li
              key={`${inst.event.id}-${inst.instanceStartMs}`}
              className="rounded-md border border-border bg-elevated px-2.5 py-2 flex items-center gap-2.5"
            >
              <span className="text-metadata font-mono text-accent-copper tabular-nums shrink-0 w-14">
                {inst.event.all_day ? 'All day' : formatClock(inst.instanceStartMs)}
              </span>
              <span
                className="text-secondary text-foreground truncate"
                title={inst.event.title}
              >
                {inst.event.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ----- Section: open tasks -----

function TasksSection({ tasks }: { tasks: Task[] }) {
  return (
    <Section
      label="Open tasks"
      icon={<ListTodo className="h-3 w-3" />}
      hint={tasks.length > 0 ? `${tasks.length} due` : undefined}
    >
      {tasks.length === 0 ? (
        <EmptyState text="No open tasks." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="rounded-md border border-border bg-elevated px-2.5 py-2 flex items-center gap-2"
            >
              <PriorityDot priority={t.priority} />
              <span className="text-secondary text-foreground truncate flex-1" title={t.title}>
                {t.title}
              </span>
              {(t.due_at || t.scheduled_for) && (
                <span className="text-metadata text-muted-foreground tabular-nums shrink-0">
                  {formatClock((t.due_at ?? t.scheduled_for) as number)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PriorityDot({ priority }: { priority: TaskPriority }) {
  const cls =
    priority === 'urgent'
      ? 'text-destructive'
      : priority === 'high'
        ? 'text-warning'
        : priority === 'low'
          ? 'text-muted-foreground'
          : 'text-accent-copper';
  return <CircleDot className={cn('h-3 w-3 shrink-0', cls)} aria-hidden="true" />;
}

// ----- Section: recent quick-links -----

function QuickLinksSection({ links }: { links: QuickLink[] }) {
  return (
    <Section
      label="Recent"
      icon={<Sparkles className="h-3 w-3" />}
    >
      {links.length === 0 ? (
        <EmptyState text="No pinned links yet." />
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {links.map((link) => (
            <QuickLinkButton key={link.id} link={link} />
          ))}
        </div>
      )}
    </Section>
  );
}

function QuickLinkButton({ link }: { link: QuickLink }) {
  // Match LauncherDialog: emoji-or-letter fallback, hue tint from the link.
  const initial = (link.icon ?? link.label.charAt(0) ?? '?').toString();
  const hue = link.color_hue ?? 22; // copper-ish default

  const onClick = React.useCallback(async () => {
    try {
      await launchLink(link);
    } catch {
      /* launchLink toasts on failure */
    }
  }, [link]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-2 rounded-md border border-border bg-elevated',
        'px-2 py-2 text-left transition-colors',
        'hover:bg-panel hover:border-accent-copper/40',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      title={link.url}
    >
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-metadata font-medium"
        style={{
          backgroundColor: `hsl(${hue}, 50%, 24%)`,
          color: `hsl(${hue}, 70%, 78%)`,
        }}
        aria-hidden="true"
      >
        {initial.slice(0, 1)}
      </span>
      <span className="text-secondary text-foreground truncate flex-1">{link.label}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

// ----- Section primitives -----

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}

function Section({ label, icon, hint, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 px-0.5">
        <span className="inline-flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
          <span className="text-accent-copper">{icon}</span>
          {label}
        </span>
        {hint && (
          <span className="text-metadata text-muted-foreground tabular-nums">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="text-secondary text-muted-foreground italic px-0.5">{text}</p>
  );
}

// ============================================================
// V3 — Route-context strip (renders above the tab strip)
// ============================================================

/**
 * Read the active V3 route. Falls back to `'chat'` when Slice 4 hasn't
 * landed yet — the cast keeps tsc green even if the field is missing
 * from `useUIStore`'s current type.
 */
function useRoute(): Route {
  return useUIStore((s) => (s as unknown as { route?: Route }).route ?? 'chat');
}

/**
 * Route-aware quick-info strip. Inserts above the existing tabs.
 *
 * Chat / Agents routes render nothing — the Today tab below is the
 * primary surface for those. Every other route gets its own cozy
 * paper-card. Panels that depend on sibling slices use lazy imports
 * with `.catch` so a missing module gracefully falls back to a
 * `PlaceholderCard` instead of crashing the inspector.
 */
function RouteContextStrip({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const route = useRoute();
  if (route === 'chat' || route === 'agents') return null;

  let panel: React.ReactNode = null;
  try {
    switch (route) {
      case 'terminal':
        panel = <TerminalsContextPanel workspaceId={workspaceId} />;
        break;
      case 'kanban':
        panel = <KanbanContextPanel workspaceId={workspaceId} />;
        break;
      case 'skills':
        panel = <SkillsContextPanel />;
        break;
      case 'benchmarks':
        panel = <BenchmarksContextPanel />;
        break;
      case 'history':
        panel = <HistoryContextPanel workspaceId={workspaceId} />;
        break;
    }
  } catch {
    panel = (
      <PlaceholderCard
        title="Coming soon"
        body="This panel will light up once its slice ships."
      />
    );
  }

  return <div className="shrink-0 border-b border-border px-3 py-3">{panel}</div>;
}

// ----- Cozy strip primitives -----

/**
 * Warm paper-card used by every route panel. Eyebrow uppercase,
 * optional copper hint on the right for numeric counts.
 */
function StripCard({
  eyebrow,
  hint,
  children,
}: {
  eyebrow: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-paper p-3 shadow-soft">
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="text-metadata uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </span>
        {hint && (
          <span className="text-metadata text-accent-copper tabular-nums">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function PlaceholderCard({ title, body }: { title: string; body: string }) {
  return (
    <StripCard eyebrow={title}>
      <p className="text-secondary text-muted-foreground italic">{body}</p>
    </StripCard>
  );
}

// ----- Terminal — active sessions -----

function TerminalsContextPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const sessions =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as TerminalSession[];
        const rows = await terminalSessionRepo.listByWorkspace(workspaceId);
        return rows
          .filter((s) => s.status === 'running' || s.status === 'detached')
          .sort((a, b) => b.last_active_at - a.last_active_at);
      },
      [workspaceId],
      [] as TerminalSession[],
    ) ?? [];

  if (!isTauri) {
    return (
      <PlaceholderCard
        title="Active terminals"
        body="Run the desktop build to manage terminals."
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <PlaceholderCard
        title="Active terminals"
        body="No PTY sessions running. Spawn one to see it here."
      />
    );
  }

  return (
    <StripCard eyebrow="Active terminals" hint={String(sessions.length)}>
      <ul className="flex flex-col gap-1.5">
        {sessions.slice(0, 6).map((s) => (
          <TerminalRow key={s.id} session={s} />
        ))}
      </ul>
    </StripCard>
  );
}

function TerminalRow({ session }: { session: TerminalSession }) {
  const onKill = React.useCallback(async () => {
    // Try the Tauri command first; fall back to marking the row exited so
    // the strip clears even when Slice 1's Rust handler hasn't shipped.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('terminal_kill', { sessionId: session.id });
    } catch {
      try {
        await terminalSessionRepo.markExited(session.id, -1);
      } catch {
        /* swallow — row will refresh on next live-query tick */
      }
    }
  }, [session.id]);

  return (
    <li className="flex items-start gap-2 rounded-md bg-paper-soft px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-secondary text-foreground truncate">{session.title}</div>
        <div
          className="text-metadata text-muted-foreground truncate"
          title={session.cwd}
        >
          {session.cwd ?? '~'} · {formatRelative(session.created_at)}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onKill}
        aria-label={`Kill ${session.title}`}
        title="Kill"
      >
        <XCircle className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </li>
  );
}

// ----- Kanban — recent task transitions -----

function KanbanContextPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  // Slice 8 may eventually expose a `useRecentKanbanTransitions` hook; until
  // then we read the workspace task list and sort by `updated_at desc`.
  const tasks =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as Task[];
        const rows = await taskRepo.listByWorkspace(workspaceId);
        return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, 10);
      },
      [workspaceId],
      [] as Task[],
    ) ?? [];

  if (tasks.length === 0) {
    return (
      <PlaceholderCard
        title="Recent updates"
        body="Move a card to see it here."
      />
    );
  }

  return (
    <StripCard eyebrow="Recent updates" hint={String(tasks.length)}>
      <ul className="flex flex-col gap-1.5">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-2 rounded-md bg-paper-soft px-2 py-1.5"
          >
            <StatusDot status={t.status} />
            <span
              className="text-secondary text-foreground truncate flex-1"
              title={t.title}
            >
              {t.title}
            </span>
            <span className="text-metadata text-muted-foreground tabular-nums shrink-0">
              {formatRelative(t.updated_at)}
            </span>
          </li>
        ))}
      </ul>
    </StripCard>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const cls =
    status === 'done'
      ? 'text-accent-sage'
      : status === 'in_progress'
        ? 'text-accent-copper'
        : status === 'blocked'
          ? 'text-destructive'
          : 'text-muted-foreground';
  return <CircleDot className={cn('h-3 w-3 shrink-0', cls)} aria-hidden="true" />;
}

// ----- Skills — count + tag breakdown (lazy-loaded from Slice 5) -----

interface SkillSummary {
  total: number;
  tags: Array<{ tag: string; count: number }>;
}

function SkillsContextPanel() {
  const [summary, setSummary] = React.useState<SkillSummary | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Slice 5 owns this loader. Until it ships an `index.ts` exporting
        // `loadAllSkills` the import resolves to undefined and we render
        // a placeholder — see WAVE4_CONTRACTS.md "Skills loader".
        const path = '@/features/skills';
        const mod = await import(/* @vite-ignore */ path).catch(() => null);
        if (cancelled || !mod) return;
        const loader = (mod as { loadAllSkills?: () => Promise<unknown> })
          .loadAllSkills;
        if (typeof loader !== 'function') return;
        const result = (await loader()) as Array<{
          enabled?: boolean;
          tags?: string[];
        }>;
        if (cancelled || !Array.isArray(result)) return;
        const enabled = result.filter((s) => s.enabled !== false);
        const counts = new Map<string, number>();
        for (const s of enabled) {
          for (const t of s.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const tags = [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 4);
        setSummary({ total: enabled.length, tags });
      } catch {
        /* silent — placeholder remains */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!summary) {
    return (
      <PlaceholderCard
        title="Enabled skills"
        body="Skills loader is wiring up — check back after the next build."
      />
    );
  }

  return (
    <StripCard eyebrow="Enabled skills" hint={String(summary.total)}>
      {summary.tags.length === 0 ? (
        <p className="text-secondary text-muted-foreground italic">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {summary.tags.map((t) => (
            <li
              key={t.tag}
              className="inline-flex items-center gap-1 rounded-sm bg-paper-soft px-1.5 py-0.5 text-metadata text-foreground"
            >
              <Tag className="h-3 w-3 text-accent-copper" aria-hidden="true" />
              <span>{t.tag}</span>
              <span className="text-muted-foreground tabular-nums">{t.count}</span>
            </li>
          ))}
        </ul>
      )}
    </StripCard>
  );
}

// ----- Benchmarks — top 5 by Arena score (snapshot fallback) -----

interface BenchmarkLite {
  model: string;
  provider: string;
  arena_score: number;
}

function BenchmarksContextPanel() {
  const [rows, setRows] = React.useState<BenchmarkLite[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const path = '@/features/benchmarks';
        const mod = await import(/* @vite-ignore */ path).catch(() => null);
        if (cancelled || !mod) return;
        const snap = (mod as { SNAPSHOT_ROWS?: BenchmarkLite[] }).SNAPSHOT_ROWS;
        if (!Array.isArray(snap)) return;
        const top = [...snap]
          .sort((a, b) => b.arena_score - a.arena_score)
          .slice(0, 5);
        if (!cancelled) setRows(top);
      } catch {
        /* silent — placeholder remains */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!rows) {
    return (
      <PlaceholderCard
        title="Top by Arena score"
        body="Loading the latest snapshot…"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <PlaceholderCard
        title="Top by Arena score"
        body="No benchmark rows available yet."
      />
    );
  }

  return (
    <StripCard eyebrow="Top by Arena score" hint="snapshot">
      <ol className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <li
            key={`${r.provider}-${r.model}`}
            className="flex items-center gap-2 rounded-md bg-paper-soft px-2 py-1.5"
          >
            <span className="text-metadata text-muted-foreground tabular-nums shrink-0 w-4">
              {i + 1}
            </span>
            <span
              className="text-secondary text-foreground truncate flex-1"
              title={r.model}
            >
              {r.model}
            </span>
            <span className="text-metadata text-accent-copper tabular-nums shrink-0">
              {r.arena_score}
            </span>
          </li>
        ))}
      </ol>
    </StripCard>
  );
}

// ----- History — last 5 chats with quick-jump -----

function HistoryContextPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  // `setRoute` lands with Slice 4. Optional cast keeps tsc green meanwhile.
  const setRouteFn = useUIStore(
    (s) => (s as unknown as { setRoute?: (r: Route) => void }).setRoute,
  );

  const chats =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as Chat[];
        const rows = await chatRepo.listByWorkspace(workspaceId);
        return rows.slice(0, 5);
      },
      [workspaceId],
      [] as Chat[],
    ) ?? [];

  if (chats.length === 0) {
    return (
      <PlaceholderCard
        title="Last 5 chats"
        body="Start a chat to see it here."
      />
    );
  }

  const onJump = (chat: Chat) => {
    setActiveChat(chat.id);
    setRouteFn?.('chat');
  };

  return (
    <StripCard eyebrow="Last 5 chats" hint={String(chats.length)}>
      <ul className="flex flex-col gap-1.5">
        {chats.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onJump(c)}
              className={cn(
                'group flex w-full items-center gap-2 rounded-md bg-paper-soft px-2 py-1.5 text-left transition-colors',
                'hover:bg-paper hover:ring-1 hover:ring-accent-copper/40',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <MessageSquare
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span
                className="text-secondary text-foreground truncate flex-1"
                title={c.title}
              >
                {c.title || 'Untitled chat'}
              </span>
              <span className="text-metadata text-muted-foreground tabular-nums shrink-0">
                {formatRelative(c.updated_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </StripCard>
  );
}
