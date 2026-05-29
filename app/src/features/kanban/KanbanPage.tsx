import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { taskRepo } from '@/lib/db/repositories';
import { cn } from '@/lib/utils';
import type { Task, TaskPriority, TaskStatus } from '@/types/task';
import type { ProjectId, TaskId, WorkspaceId } from '@/types/common';
import type { Project } from '@/lib/db/schema';
import { KanbanColumn } from './KanbanColumn';
import { useKanbanProjects, useKanbanTasks } from './hooks';

/**
 * Kanban page.
 *
 * Status mapping (existing TaskStatus is `'open' | 'in_progress' | 'blocked'
 * | 'done' | 'cancelled'`):
 *
 *   "Todo"        column ↔ status 'open'
 *   "In progress" column ↔ status 'in_progress'
 *   "Done"        column ↔ status 'done'
 *
 * `'blocked'` and `'cancelled'` are stashed in a small "Other" pop-out at
 * the bottom of the page so the main grid stays focused on actionable work.
 *
 * HTML5 drag is used for moves (no extra dep). On drop we run an optimistic
 * status override so the card jumps columns the instant the user releases,
 * then call `taskRepo.update` and let the live query catch up.
 */

interface ColumnSpec {
  status: TaskStatus;
  title: string;
}

const MAIN_COLUMNS: ColumnSpec[] = [
  { status: 'open', title: 'Todo' },
  { status: 'in_progress', title: 'In progress' },
  { status: 'done', title: 'Done' },
];

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const STATUSES: TaskStatus[] = ['open', 'in_progress', 'done', 'blocked', 'cancelled'];
const STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const SELECT_CLASS =
  'h-8 w-full rounded-md border border-input bg-background px-2 text-secondary text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    if (typeof m.addEventListener === 'function') {
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    }
    // Older Safari fallback
    m.addListener(onChange);
    return () => m.removeListener(onChange);
  }, []);
  return reduced;
}

export function KanbanPage() {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const activeProjectId = useAuthStore((s) => s.projectId);
  const reducedMotion = useReducedMotion();
  const agentsMap = useAgentStore((s) => s.agents);

  // Project filter: 'all' or a ProjectId. Defaults to active project, or
  // 'all' when no project is selected globally. Tracks the auth store
  // value so flipping the active project updates the filter.
  const [projectFilter, setProjectFilter] = useState<string>(activeProjectId ?? 'all');
  useEffect(() => {
    setProjectFilter(activeProjectId ?? 'all');
  }, [activeProjectId]);

  const tasks = useKanbanTasks(workspaceId, projectFilter);
  const projects = useKanbanProjects(workspaceId);

  // Optimistic status overrides keyed by task id. Set on drop so the card
  // jumps columns immediately, cleared once the live query reports the
  // same status (or the task has gone away).
  const [optimistic, setOptimistic] = useState<Record<string, TaskStatus>>({});
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  useEffect(() => {
    setOptimistic((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let dirty = false;
      const next: Record<string, TaskStatus> = {};
      for (const id of keys) {
        const t = tasks.find((x) => x.id === id);
        if (!t || t.status === prev[id]) {
          dirty = true;
          continue;
        }
        next[id] = prev[id];
      }
      return dirty ? next : prev;
    });
  }, [tasks]);

  // Apply optimistic overrides, then bucket by status with stable order
  // by `updated_at` desc.
  const buckets = useMemo<Record<TaskStatus, Task[]>>(() => {
    const out: Record<TaskStatus, Task[]> = {
      open: [],
      in_progress: [],
      blocked: [],
      done: [],
      cancelled: [],
    };
    for (const t of tasks) {
      const override = optimistic[t.id];
      const status = override ?? t.status;
      const row: Task = override ? { ...t, status: override } : t;
      out[status].push(row);
    }
    for (const key of Object.keys(out) as TaskStatus[]) {
      out[key].sort((a, b) => b.updated_at - a.updated_at);
    }
    return out;
  }, [tasks, optimistic]);

  const projectsMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const agentsLookup = useMemo(() => {
    const m = new Map<string, (typeof agentsMap)[keyof typeof agentsMap]>();
    for (const a of Object.values(agentsMap)) m.set(a.id, a);
    return m;
  }, [agentsMap]);

  // ---- handlers ----

  const onDropTask = async (taskId: string, target: TaskStatus) => {
    const current = tasks.find((t) => t.id === taskId);
    if (!current || current.status === target) return;
    setOptimistic((p) => ({ ...p, [taskId]: target }));
    try {
      await taskRepo.update(taskId as TaskId, {
        status: target,
        updated_at: Date.now(),
      });
    } catch (err) {
      console.error('[Kanban] drop failed', err);
      setOptimistic((p) => {
        const { [taskId]: _drop, ...rest } = p;
        return rest;
      });
    }
  };

  const onCreateTask = async (status: TaskStatus, title: string) => {
    if (!workspaceId) return;
    // Pin a project_id when the filter is scoped to one, otherwise fall
    // back to the workspace's active project (if any) so new cards land
    // somewhere sensible.
    const project_id =
      projectFilter !== 'all'
        ? (projectFilter as ProjectId)
        : (activeProjectId ?? undefined);
    try {
      await taskRepo.create({
        workspace_id: workspaceId as WorkspaceId,
        project_id,
        title,
        status,
        created_by: 'user_text',
      });
    } catch (err) {
      console.error('[Kanban] create failed', err);
    }
  };

  // ---- render ----

  const totalMain =
    buckets.open.length + buckets.in_progress.length + buckets.done.length;
  const otherTasks = useMemo(
    () =>
      [...buckets.blocked, ...buckets.cancelled].sort(
        (a, b) => b.updated_at - a.updated_at,
      ),
    [buckets.blocked, buckets.cancelled],
  );
  const isEmpty = !workspaceId || (totalMain === 0 && otherTasks.length === 0);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Tasks · drag between columns</span>
          <h1 className="font-display text-hero text-foreground">Kanban</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <SeverityLegend />
          <ProjectFilter
            value={projectFilter}
            onChange={setProjectFilter}
            projects={projects}
          />
        </div>
      </header>

      {isEmpty ? (
        <EmptyKanbanState />
      ) : (
        <>
          <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
            {MAIN_COLUMNS.map((col) => (
              <KanbanColumn
                key={col.status}
                status={col.status}
                title={col.title}
                tasks={buckets[col.status]}
                projects={projectsMap}
                agents={agentsLookup}
                draggingTaskId={draggingTaskId}
                reducedMotion={reducedMotion}
                onDragStartTask={setDraggingTaskId}
                onDragEndTask={() => setDraggingTaskId(null)}
                onDropTask={(id, target) => void onDropTask(id, target)}
                onCreateTask={onCreateTask}
                onOpenTask={setEditingTask}
              />
            ))}
          </div>

          {otherTasks.length > 0 && (
            <OtherSection
              blocked={buckets.blocked}
              cancelled={buckets.cancelled}
              onOpenTask={setEditingTask}
            />
          )}
        </>
      )}

      <EditTaskDialog task={editingTask} onClose={() => setEditingTask(null)} />
    </div>
  );
}

// ============================================================
// Page header bits
// ============================================================

interface ProjectFilterProps {
  value: string;
  onChange: (v: string) => void;
  projects: Project[];
}

function ProjectFilter({ value, onChange, projects }: ProjectFilterProps) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="kanban-project-filter" className="shrink-0">
        Project
      </Label>
      <select
        id="kanban-project-filter"
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        className={cn(SELECT_CLASS, 'min-w-[10rem]')}
      >
        <option value="all">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

const SEV_DOTS: Array<{
  key: 'crit' | 'high' | 'med' | 'low' | 'info';
  label: string;
}> = [
  { key: 'crit', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'med', label: 'Medium' },
  { key: 'low', label: 'Low' },
  { key: 'info', label: 'Info' },
];

function SeverityLegend() {
  return (
    <div
      className="flex items-center gap-2 text-metadata text-muted-foreground"
      aria-label="Severity legend"
    >
      <span className="eyebrow">Severity</span>
      <div className="flex items-center gap-1.5">
        {SEV_DOTS.map((d) => (
          <span
            key={d.key}
            className={cn('sev-pill', d.key)}
            style={{
              padding: 0,
              width: 10,
              height: 10,
              borderRadius: 9999,
              display: 'inline-block',
            }}
            title={d.label}
            aria-label={d.label}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyKanbanState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="cozy-card max-w-md text-center">
        <div className="font-display text-page-title text-foreground">
          No tasks yet.
        </div>
        <div className="mt-2 text-secondary text-muted-foreground">
          Try the assistant:{' '}
          <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-metadata text-foreground">
            make a todo: ship the launcher tomorrow
          </code>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Other (blocked + cancelled) pop-out
// ============================================================

interface OtherSectionProps {
  blocked: Task[];
  cancelled: Task[];
  onOpenTask: (t: Task) => void;
}

function OtherSection({ blocked, cancelled, onOpenTask }: OtherSectionProps) {
  const [open, setOpen] = useState(false);
  const total = blocked.length + cancelled.length;
  const all = [...blocked, ...cancelled];

  return (
    <section className="rounded-xl bg-paper-soft p-4 shadow-soft">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-ui-strong text-foreground">Other</h3>
          <span className="eyebrow">{total}</span>
        </div>
        <span className="text-metadata text-muted-foreground">
          Blocked {blocked.length} · Cancelled {cancelled.length} ·{' '}
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {all.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpenTask(t)}
              className="flex items-center gap-2 rounded-lg border border-border bg-paper p-2.5 text-left transition-shadow hover:shadow-soft"
            >
              <span
                className={cn(
                  'sev-pill',
                  t.status === 'cancelled' ? 'info' : 'med',
                )}
              >
                {t.status === 'cancelled' ? 'Cancelled' : 'Blocked'}
              </span>
              <span className="line-clamp-1 font-medium text-body text-foreground">
                {t.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================
// Edit task dialog
// ============================================================

interface EditTaskDialogProps {
  task: Task | null;
  onClose: () => void;
}

function EditTaskDialog({ task, onClose }: EditTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueLocal, setDueLocal] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [status, setStatus] = useState<TaskStatus>('open');

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setNotes(task.notes ?? '');
    setDueLocal(task.due_at ? msToLocalInput(task.due_at) : '');
    setPriority(task.priority);
    setStatus(task.status);
  }, [task]);

  const onSave = async () => {
    if (!task) return;
    const trimmed = title.trim() || task.title;
    const due_at = dueLocal ? localInputToMs(dueLocal) : undefined;
    try {
      await taskRepo.update(task.id, {
        title: trimmed,
        notes: notes.trim() ? notes : undefined,
        due_at,
        priority,
        status,
        updated_at: Date.now(),
      });
    } catch (err) {
      console.error('[Kanban] save failed', err);
    }
    onClose();
  };

  return (
    <Dialog
      open={task !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="kanban-edit-title">Title</Label>
            <Input
              id="kanban-edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="kanban-edit-notes">Description</Label>
            <Textarea
              id="kanban-edit-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-edit-due">Due date</Label>
              <Input
                id="kanban-edit-due"
                type="datetime-local"
                value={dueLocal}
                onChange={(e) => setDueLocal(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kanban-edit-priority">Priority</Label>
              <select
                id="kanban-edit-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className={SELECT_CLASS}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="kanban-edit-status">Status</Label>
            <select
              id="kanban-edit-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className={SELECT_CLASS}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" onClick={() => void onSave()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Helpers
// ============================================================

/** Convert unix ms to a value usable in `<input type="datetime-local">`. */
function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Inverse of `msToLocalInput`: parses the picker's local-time string. */
function localInputToMs(s: string): number {
  return new Date(s).getTime();
}
