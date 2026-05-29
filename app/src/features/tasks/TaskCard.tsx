import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlarmClock,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Clock,
  MoreHorizontal,
  Pencil,
  Quote,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn, formatClock, formatRelative } from '@/lib/utils';
import type { Reminder, Task, TaskPriority } from '@/types/task';
import type { ReminderId, TaskId } from '@/types/common';
import { TaskService } from './TaskService';
import { SnoozePopover } from './SnoozePopover';
import { useTaskStore } from './store';

/**
 * One task card. Compact by default, expands the source ref / full notes
 * on click. Hover reveals snooze, done, edit, delete actions. Right-click
 * also opens the action menu.
 */

export interface TaskCardProps {
  task: Task;
  /** When true, the card briefly accent-flashes (used for newly created cards). */
  flash?: boolean;
  className?: string;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

function priorityVariant(p: TaskPriority): 'accent' | 'destructive' | 'warning' | 'secondary' | 'outline' {
  switch (p) {
    case 'urgent':
      return 'destructive';
    case 'high':
      return 'warning';
    case 'normal':
      return 'secondary';
    case 'low':
      return 'outline';
  }
}

export function TaskCard({ task, flash, className }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [menuOpen, setMenuOpen] = useState(false);

  const snoozeOpenForReminderId = useTaskStore((s) => s.snoozeOpenForReminderId);
  const openSnoozeFor = useTaskStore((s) => s.openSnoozeFor);

  const nextReminder = useMemo(() => pickNextReminder(task.reminders), [task.reminders]);
  const isDone = task.status === 'done';
  const isInProgress = task.status === 'in_progress';

  const onToggleDone = async () => {
    if (isDone) {
      await TaskService.reopenTask(task.id as TaskId);
    } else {
      await TaskService.completeTask(task.id as TaskId);
    }
  };

  const commitTitle = async () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === task.title) {
      setTitleDraft(task.title);
      return;
    }
    await TaskService.updateTask(task.id as TaskId, { title: next });
  };

  const onDelete = async () => {
    setMenuOpen(false);
    await TaskService.deleteTask(task.id as TaskId);
  };

  const onSnooze = async (until: number) => {
    if (!nextReminder) return;
    await TaskService.snoozeReminder(nextReminder.id as ReminderId, until);
    openSnoozeFor(null);
  };

  const sourceRef = task.source_refs?.[0];
  const triggerExcerpt = sourceRef?.excerpt;

  return (
    <motion.div
      layout
      initial={flash ? { opacity: 0, y: -4 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className={cn(
        'group relative rounded-md border border-border bg-panel p-2.5 transition-colors',
        'hover:border-border-mid focus-within:border-accent-cyan/40',
        isDone && 'opacity-60',
        className,
      )}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {/* Accent flash strip on the left edge for newly created tasks */}
      {flash && (
        <motion.span
          aria-hidden
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-y-0 left-0 w-[2px] rounded-l bg-accent-gradient shadow-[0_0_10px_-2px_hsl(var(--accent-cyan)/0.6)]"
        />
      )}

      <div className="flex items-start gap-2">
        <div className="pt-0.5">
          <Checkbox
            checked={isDone}
            onCheckedChange={() => void onToggleDone()}
            aria-label={isDone ? 'Reopen task' : 'Mark task done'}
          />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-start justify-between gap-2">
            {editingTitle ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitTitle();
                  if (e.key === 'Escape') {
                    setEditingTitle(false);
                    setTitleDraft(task.title);
                  }
                }}
                className="h-6 -my-0.5 flex-1 px-1.5"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className={cn(
                  'flex-1 truncate text-left text-body text-foreground hover:text-accent-cyan transition-colors',
                  isDone && 'line-through',
                )}
                title={task.title}
              >
                {task.title}
              </button>
            )}

            <Badge variant={priorityVariant(task.priority)} className="shrink-0">
              {PRIORITY_LABEL[task.priority]}
            </Badge>
          </div>

          {/* Tag row */}
          {task.context_tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.context_tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-muted/60 px-1.5 py-0.5 text-metadata text-muted-foreground"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Time row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-metadata text-muted-foreground">
            {task.due_at !== undefined && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Due {formatRelative(task.due_at)}
                <span className="text-muted-foreground/70">· {formatClock(task.due_at)}</span>
              </span>
            )}
            {task.scheduled_for !== undefined && task.due_at === undefined && (
              <span className="inline-flex items-center gap-1">
                <CircleDashed className="h-3 w-3" />
                Plan {formatRelative(task.scheduled_for)}
              </span>
            )}
            {nextReminder && (
              <span className="inline-flex items-center gap-1">
                <Bell className="h-3 w-3" />
                Reminds {formatRelative(nextReminder.fires_at)}
              </span>
            )}
            {isInProgress && (
              <span className="inline-flex items-center gap-1 text-accent-cyan">
                <Circle className="h-2.5 w-2.5 fill-current" />
                In progress
              </span>
            )}
          </div>

          {/* Smart reason / source ref - collapsed unless expanded */}
          {(nextReminder?.smart_reason || triggerExcerpt) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 flex items-center gap-1 text-metadata text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {expanded ? 'Hide details' : 'Why this time'}
            </button>
          )}
          {expanded && (
            <div className="mt-1.5 rounded border border-border-mid/40 bg-background/40 p-2 text-metadata text-muted-foreground space-y-1.5">
              {nextReminder?.smart_reason && (
                <div className="flex items-start gap-1.5">
                  <AlarmClock className="mt-0.5 h-3 w-3 shrink-0 text-accent-cyan" />
                  <span>{nextReminder.smart_reason}</span>
                </div>
              )}
              {triggerExcerpt && (
                <div className="flex items-start gap-1.5">
                  <Quote className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="italic">{triggerExcerpt}</span>
                </div>
              )}
              {sourceRef && !triggerExcerpt && (
                <div className="text-metadata">
                  Source: {sourceRef.kind} · {sourceRef.id}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hover actions - top right cluster */}
      <div
        className={cn(
          'pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity',
          'group-hover:opacity-100 focus-within:opacity-100',
          (snoozeOpenForReminderId === nextReminder?.id || menuOpen) && 'opacity-100',
        )}
      >
        {nextReminder && (
          <SnoozePopover
            open={snoozeOpenForReminderId === nextReminder.id}
            onOpenChange={(o) => openSnoozeFor(o ? nextReminder.id : null)}
            onSnooze={(ts) => void onSnooze(ts)}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="pointer-events-auto h-6 w-6 hover:bg-muted"
              aria-label="Snooze"
              title="Snooze"
            >
              <AlarmClock className="h-3.5 w-3.5" />
            </Button>
          </SnoozePopover>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-events-auto h-6 w-6 hover:bg-muted"
          aria-label={isDone ? 'Reopen' : 'Done'}
          title={isDone ? 'Reopen' : 'Done'}
          onClick={(e) => {
            e.stopPropagation();
            void onToggleDone();
          }}
        >
          {isDone ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="pointer-events-auto h-6 w-6 hover:bg-muted"
          aria-label="Edit"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            setEditingTitle(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>

        {/* Right-click / "more" menu using a popover, since native context menu can't host actions */}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="pointer-events-auto h-6 w-6 hover:bg-muted"
              aria-label="More"
              title="More"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            <button
              type="button"
              onClick={() => void onDelete()}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-body text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete task
            </button>
            {!isDone && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void TaskService.updateTask(task.id as TaskId, {
                    status: isInProgress ? 'open' : 'in_progress',
                  });
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-body text-foreground hover:bg-muted transition-colors"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {isInProgress ? 'Mark not started' : 'Mark in progress'}
              </button>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </motion.div>
  );
}

/** Pick the soonest scheduled reminder. */
function pickNextReminder(rs: Reminder[]): Reminder | null {
  let best: Reminder | null = null;
  for (const r of rs) {
    if (r.status !== 'scheduled') continue;
    if (!best || r.fires_at < best.fires_at) best = r;
  }
  return best;
}
