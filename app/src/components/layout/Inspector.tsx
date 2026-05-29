import * as React from 'react';
import { motion } from 'motion/react';
import {
  Boxes,
  CalendarDays,
  CircleDot,
  ExternalLink,
  GitBranch,
  Link2,
  ListTodo,
  Sparkles,
  Sun,
  Wrench,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth';
// `useTodayEvents` exists on the V2 schedule hooks (added by the parallel
// agent) but isn't re-exported from `@/features/schedule` yet. Import the
// deep path until it surfaces in the barrel.
import { useTodayEvents } from '@/features/schedule/hooks';
import type { RecurrenceInstance } from '@/features/schedule/recurrence';
import { useQuickLinks, launchLink } from '@/features/launcher';
import { useTodayTasks } from '@/features/tasks';
import { cn, formatClock } from '@/lib/utils';
import type { QuickLink } from '@/types/quick-link';
import type { Task, TaskPriority } from '@/types/task';
import type { WorkspaceId } from '@/types/common';

/**
 * Inspector — 320px right pane, mounted/unmounted via AnimatePresence
 * inside AppShell. Cmd+\ toggles via useUIStore.toggleInspector.
 *
 * V2 surfaces a "Today" tab as the first thing the user sees: schedule
 * for today, open tasks, and the most recently used quick-links. Other
 * tabs (Context / Tools / Trace / Refs) remain placeholders owned by
 * downstream subagents.
 */
export function Inspector() {
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
        <Tabs defaultValue="today" className="flex h-full flex-col">
          {/* 5-tab strip — Today is the new home tab. The trigger override
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
