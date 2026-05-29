import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  CalendarRange,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Inbox,
  Sparkles,
  Sunrise,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import type { Task, TaskInput } from '@/types/task';
import { TaskCard } from './TaskCard';
import { TaskComposer } from './TaskComposer';
import { DraftTaskList } from './DraftTaskList';
import { TaskService } from './TaskService';
import { startNotificationLoop } from './NotificationEngine';
import { useTasks, useRecentlyCompletedTasks } from './hooks';
import { useTaskStore } from './store';

/**
 * The right-rail to-do panel.
 *
 * Layout: portals into `<aside id="todo-drawer-root" />` (rendered by the
 * shell layout). If that anchor isn't present we fall back to document.body
 * so the panel still renders during dev.
 *
 * Sections (top to bottom):
 *   - Now         (in_progress + open with due_at within 1h)
 *   - Today       (rest of today)
 *   - This Week   (within 7 days)
 *   - Later       (beyond 7 days, or no time set)
 *   - Suggested   (DraftTaskList)
 *   - Done        (last 24h, collapsed by default)
 */

declare global {
  interface WindowEventMap {
    'jarvis:create-task': CustomEvent<{ input: TaskInput }>;
    'jarvis:plan-day': CustomEvent<{ ts: number }>;
  }
}

export function TodoPanel() {
  const open = useUIStore((s) => s.todoDrawerOpen);
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const flashTask = useTaskStore((s) => s.flashTask);
  const flashedTaskIds = useTaskStore((s) => s.flashedTaskIds);

  const tasks = useTasks(workspaceId);
  const doneTasks = useRecentlyCompletedTasks();

  // ---- portal target ----
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.getElementById('todo-drawer-root'));
  }, []);

  // ---- notification engine lifecycle ----
  // Starts on first mount, runs as long as the panel is mounted.
  useEffect(() => {
    const stop = startNotificationLoop();
    return stop;
  }, []);

  // ---- voice-driven task creation listener ----
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ input: TaskInput }>;
      const input = ce.detail?.input;
      if (!input) return;
      void (async () => {
        try {
          const created = await TaskService.createTask({
            ...input,
            created_by: input.created_by ?? 'user_voice',
          });
          flashTask(created.id);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[TodoPanel] jarvis:create-task failed', err);
        }
      })();
    };
    window.addEventListener('jarvis:create-task', handler);
    return () => window.removeEventListener('jarvis:create-task', handler);
  }, [flashTask]);

  // ---- bucket tasks ----
  const buckets = useMemo(() => bucketTasks(tasks, Date.now()), [tasks]);
  const nowCount = buckets.now.length;
  const todayCount = buckets.today.length;

  const onPlanDay = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('jarvis:plan-day', { detail: { ts: Date.now() } }));
  };

  const content = (
    <motion.div
      initial={false}
      animate={{ width: open ? 340 : 0, opacity: open ? 1 : 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className={cn(
        'h-full shrink-0 overflow-hidden border-l border-border bg-panel/80 backdrop-blur-sm',
        'flex flex-col',
      )}
      aria-hidden={!open}
    >
      {/* Inner is fixed-width so content doesn't squish when collapsing */}
      <div className="flex h-full w-[340px] flex-col" data-testid="todo-panel-inner">
        {/* Header */}
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <CheckCheck className="h-4 w-4 text-accent-cyan" />
              <span className="text-ui-strong text-foreground">To-do</span>
              {nowCount > 0 && (
                <Badge variant="accent" className="ml-1">
                  {nowCount} now
                </Badge>
              )}
              {todayCount > 0 && (
                <Badge variant="secondary">
                  {todayCount} today
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-metadata"
              onClick={onPlanDay}
              title="Have Jarvis plan your day"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Plan my day
            </Button>
          </div>
          <TaskComposer />
        </div>

        {/* Scroll body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
          <Section
            id="now"
            title="Now"
            icon={<Sparkles className="h-3.5 w-3.5 text-accent-cyan" />}
            count={buckets.now.length}
            tasks={buckets.now}
            flashedTaskIds={flashedTaskIds}
            empty="Nothing burning. Take a breath."
          />
          <Section
            id="today"
            title="Today"
            icon={<Sunrise className="h-3.5 w-3.5 text-warning" />}
            count={buckets.today.length}
            tasks={buckets.today}
            flashedTaskIds={flashedTaskIds}
            empty="No tasks for today."
          />
          <Section
            id="this-week"
            title="This Week"
            icon={<CalendarRange className="h-3.5 w-3.5 text-info" />}
            count={buckets.thisWeek.length}
            tasks={buckets.thisWeek}
            flashedTaskIds={flashedTaskIds}
            empty="Nothing scheduled this week."
          />
          <Section
            id="later"
            title="Later"
            icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" />}
            count={buckets.later.length}
            tasks={buckets.later}
            flashedTaskIds={flashedTaskIds}
            empty="No future tasks."
          />

          {/* Suggested */}
          <CollapsibleHeader
            id="suggested"
            title="Suggested"
            icon={<Sparkles className="h-3.5 w-3.5 text-accent-violet" />}
            count={undefined}
            defaultOpen
          >
            <DraftTaskList />
            <DraftTaskListEmpty />
          </CollapsibleHeader>

          {/* Done */}
          {doneTasks.length > 0 && (
            <CollapsibleHeader
              id="done"
              title="Done"
              icon={<CheckCheck className="h-3.5 w-3.5 text-success" />}
              count={doneTasks.length}
              defaultOpen={false}
            >
              <div className="space-y-1.5">
                {doneTasks.map((t) => (
                  <TaskCard key={t.id} task={t} flash={flashedTaskIds.has(t.id)} />
                ))}
              </div>
            </CollapsibleHeader>
          )}
        </div>
      </div>
    </motion.div>
  );

  // Portal target: explicit aside root, or document.body fallback.
  const target = portalTarget ?? (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;
  return createPortal(content, target);
}

// ============================================================
// Section helpers
// ============================================================

interface SectionProps {
  id: string;
  title: string;
  icon: ReactNode;
  count: number;
  tasks: Task[];
  flashedTaskIds: Set<string>;
  empty?: string;
}

function Section({ id, title, icon, count, tasks, flashedTaskIds, empty }: SectionProps) {
  // Hide empty sections except "Now" and "Today" (which we always show).
  const alwaysShow = id === 'now' || id === 'today';
  if (count === 0 && !alwaysShow) return null;

  return (
    <CollapsibleHeader id={id} title={title} icon={icon} count={count} defaultOpen>
      {tasks.length > 0 ? (
        <div className="space-y-1.5">
          <AnimatePresence initial={false}>
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} flash={flashedTaskIds.has(t.id)} />
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <EmptySection text={empty ?? 'Nothing here.'} />
      )}
    </CollapsibleHeader>
  );
}

function EmptySection({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border-mid/60 bg-background/40 px-3 py-3 text-metadata text-muted-foreground">
      <Inbox className="h-3.5 w-3.5" />
      {text}
    </div>
  );
}

interface CollapsibleHeaderProps {
  id: string;
  title: string;
  icon: ReactNode;
  count?: number;
  defaultOpen: boolean;
  children: ReactNode;
}

function CollapsibleHeader({ id, title, icon, count, defaultOpen, children }: CollapsibleHeaderProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-section={id}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-0.5 py-1 text-ui-strong text-foreground hover:text-accent-cyan transition-colors"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {icon}
        <span>{title}</span>
        {count !== undefined && count > 0 && (
          <span className="ml-1 rounded bg-muted/60 px-1.5 py-0.5 text-metadata text-muted-foreground">
            {count}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            className="overflow-hidden"
          >
            <div className="pt-1.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Renders a soft empty state when no draft tasks exist.
 * Lives outside DraftTaskList because the list returns null when empty
 * (so it doesn't take vertical space inside chat panels), and the
 * `Suggested` section in the to-do panel still wants to acknowledge it.
 */
function DraftTaskListEmpty() {
  const drafts = useTaskStore((s) => s.drafts);
  if (drafts.length > 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border-mid/60 bg-background/40 px-3 py-3 text-metadata text-muted-foreground">
      <Sparkles className="h-3.5 w-3.5" />
      No suggestions yet. They appear after meetings or chats.
    </div>
  );
}

// ============================================================
// Task bucketing
// ============================================================

interface Buckets {
  now: Task[];
  today: Task[];
  thisWeek: Task[];
  later: Task[];
}

function bucketTasks(tasks: Task[], now: number): Buckets {
  const oneHour = 60 * 60 * 1000;
  const todayEnd = endOfTodayMs(now);
  const weekEnd = now + 7 * 24 * 60 * 60 * 1000;

  const now_: Task[] = [];
  const today: Task[] = [];
  const thisWeek: Task[] = [];
  const later: Task[] = [];

  // Sort by (priority desc, time asc) for stable readability.
  const sorted = [...tasks].sort(compareTasks);

  for (const t of sorted) {
    if (t.status === 'done' || t.status === 'cancelled') continue;
    const ts = t.due_at ?? t.scheduled_for;

    if (t.status === 'in_progress') {
      now_.push(t);
      continue;
    }
    if (ts !== undefined && ts <= now + oneHour) {
      now_.push(t);
      continue;
    }
    if (ts !== undefined && ts <= todayEnd) {
      today.push(t);
      continue;
    }
    if (ts !== undefined && ts <= weekEnd) {
      thisWeek.push(t);
      continue;
    }
    later.push(t);
  }

  return { now: now_, today, thisWeek, later };
}

const PRIO_RANK: Record<Task['priority'], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function compareTasks(a: Task, b: Task): number {
  const pa = PRIO_RANK[a.priority];
  const pb = PRIO_RANK[b.priority];
  if (pa !== pb) return pa - pb;
  const ta = a.due_at ?? a.scheduled_for ?? Number.POSITIVE_INFINITY;
  const tb = b.due_at ?? b.scheduled_for ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.created_at - b.created_at;
}

function endOfTodayMs(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
