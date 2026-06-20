import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Target } from 'lucide-react';
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
import { useMilestonesStore } from '@/features/inspector/milestonesStore';
import { useWorkspaceOpenTasks } from '@/features/inspector/workspaceTasks';
import { useWorkspaceAnalyticsStore } from '@/features/inspector/workspaceAnalytics';
import { celebrate } from '@/features/celebrate';
import { cn, formatRelative } from '@/lib/utils';
import type { MilestoneItem, MilestoneStatus } from '@/features/inspector/types';
import { KanbanColumn } from './KanbanColumn';
import {
  useKanbanMilestoneBuckets,
  useKanbanMilestoneProgress,
  useKanbanMilestones,
} from './hooks';
import { MILESTONE_COLUMNS } from './milestoneKanban';

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  todo: 'Todo',
  working: 'In progress',
  done: 'Done',
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
    m.addListener(onChange);
    return () => m.removeListener(onChange);
  }, []);
  return reduced;
}

export function KanbanPage() {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const projectId = useAuthStore((s) => s.projectId);
  const reducedMotion = useReducedMotion();

  const items = useKanbanMilestones();
  const addMilestone = useMilestonesStore((s) => s.addMilestone);
  const updateMilestone = useMilestonesStore((s) => s.updateMilestone);
  const removeMilestone = useMilestonesStore((s) => s.removeMilestone);

  const workspaceTasks = useWorkspaceOpenTasks(workspaceId, projectId);
  const analytics = useWorkspaceAnalyticsStore((s) => s.snapshot());

  const progress = useKanbanMilestoneProgress(items);
  const buckets = useKanbanMilestoneBuckets(items);

  const [optimistic, setOptimistic] = useState<Record<string, MilestoneStatus>>({});
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<MilestoneItem | null>(null);
  const [celebrateId, setCelebrateId] = useState<string | null>(null);

  useEffect(() => {
    setOptimistic((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let dirty = false;
      const next: Record<string, MilestoneStatus> = {};
      for (const id of keys) {
        const item = items.find((x) => x.id === id);
        if (!item || item.status === prev[id]) {
          dirty = true;
          continue;
        }
        next[id] = prev[id];
      }
      return dirty ? next : prev;
    });
  }, [items]);

  const displayBuckets = useMemo(() => {
    const out: Record<MilestoneStatus, MilestoneItem[]> = {
      todo: [],
      working: [],
      done: [],
    };
    for (const col of MILESTONE_COLUMNS) {
      out[col.status] = buckets[col.status].map((item) => {
        const override = optimistic[item.id];
        if (!override || override === item.status) return item;
        return { ...item, status: override };
      });
      if (Object.keys(optimistic).length > 0) {
        for (const [id, status] of Object.entries(optimistic)) {
          if (status !== col.status) continue;
          const source = items.find((i) => i.id === id);
          if (!source || source.status === status) continue;
          if (!out[col.status].some((i) => i.id === id)) {
            out[col.status].push({ ...source, status });
          }
        }
        out[col.status] = out[col.status]
          .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      }
    }
    return out;
  }, [buckets, optimistic, items]);

  const onDropItem = (itemId: string, target: MilestoneStatus) => {
    const current = items.find((i) => i.id === itemId);
    if (!current || current.status === target) return;
    setOptimistic((p) => ({ ...p, [itemId]: target }));
    updateMilestone(itemId, { status: target });
    if (target === 'done' && current.status !== 'done') {
      setCelebrateId(itemId);
      celebrate('kanban_done', current.title);
      window.setTimeout(() => setCelebrateId(null), 900);
    }
  };

  const onCreateItem = (status: MilestoneStatus, title: string) => {
    const id = addMilestone(title);
    if (status !== 'todo') {
      updateMilestone(id, { status });
    }
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Trace · milestones & workspace progress</span>
          <h1 className="font-display text-hero text-foreground">Kanban</h1>
          <p className="text-secondary text-muted-foreground max-w-xl">
            Same milestone board as the Inspector Trace panel — create checkpoints, drag across
            columns, and track live workspace activity.
          </p>
        </div>
        <AnalyticsSummary
          progress={progress}
          liveOpen={workspaceTasks.length}
          analytics={analytics}
        />
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
        {MILESTONE_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            title={col.title}
            items={displayBuckets[col.status]}
            draggingItemId={draggingItemId}
            reducedMotion={reducedMotion}
            onDragStartItem={setDraggingItemId}
            onDragEndItem={() => setDraggingItemId(null)}
            onDropItem={onDropItem}
            onCreateItem={onCreateItem}
            onOpenItem={setEditingItem}
          />
        ))}
      </div>

      {workspaceTasks.length > 0 ? (
        <LiveActivitySection tasks={workspaceTasks} />
      ) : items.length === 0 ? (
        <EmptyHint />
      ) : null}

      <EditMilestoneDialog
        item={editingItem}
        celebrating={editingItem ? celebrateId === editingItem.id : false}
        onClose={() => setEditingItem(null)}
        onSave={(patch) => {
          if (!editingItem) return;
          updateMilestone(editingItem.id, patch);
          if (patch.status === 'done' && editingItem.status !== 'done') {
            celebrate('kanban_done', editingItem.title);
          }
        }}
        onRemove={() => {
          if (!editingItem) return;
          removeMilestone(editingItem.id);
          setEditingItem(null);
        }}
      />
    </div>
  );
}

function AnalyticsSummary({
  progress,
  liveOpen,
  analytics,
}: {
  progress: { done: number; total: number; open: number; percent: number };
  liveOpen: number;
  analytics: {
    completedMilestones: number;
  };
}) {
  return (
    <div className="cozy-card flex flex-wrap items-stretch gap-4 p-4 min-w-[280px]">
      <StatBlock label="Milestones" value={`${progress.done}/${progress.total}`} hint="complete" />
      <StatBlock label="Progress" value={`${progress.percent}%`} hint="of board" />
      <StatBlock label="Live work" value={String(liveOpen)} hint="open items" />
      <StatBlock
        label="Session"
        value={analytics.completedMilestones > 0 ? String(analytics.completedMilestones) : '—'}
        hint="done (rollup)"
      />
    </div>
  );
}

function StatBlock({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex min-w-[5.5rem] flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span className="font-display text-page-title text-foreground tabular-nums">{value}</span>
      <span className="text-metadata text-muted-foreground">{hint}</span>
    </div>
  );
}

function LiveActivitySection({
  tasks,
}: {
  tasks: ReturnType<typeof useWorkspaceOpenTasks>;
}) {
  return (
    <section className="rounded-xl bg-paper-soft p-4 shadow-soft">
      <header className="mb-3 flex items-center gap-2">
        <Target className="h-4 w-4 text-accent-copper" />
        <h3 className="font-display text-ui-strong text-foreground">Live workspace activity</h3>
        <span className="eyebrow">{tasks.length}</span>
      </header>
      <p className="mb-3 text-secondary text-muted-foreground">
        Read-only feed from terminals, chats, tools, and open Dexie tasks — same source as
        Inspector → Today.
      </p>
      <ul className="grid gap-2 md:grid-cols-2">
        {tasks.slice(0, 8).map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-paper px-3 py-2"
          >
            <span className="eyebrow shrink-0">{t.source}</span>
            <span className="line-clamp-1 text-secondary text-foreground">{t.title}</span>
            <span className="ml-auto text-metadata text-muted-foreground shrink-0">
              {formatRelative(t.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyHint() {
  return (
    <div className="cozy-card max-w-lg p-4">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 text-accent-copper shrink-0" />
        <div>
          <p className="font-display text-ui-strong text-foreground">Start your first milestone</p>
          <p className="mt-1 text-secondary text-muted-foreground">
            Hit <strong className="text-foreground font-medium">+</strong> in any column above, or
            add milestones from Inspector → Trace. Changes sync instantly across both views.
          </p>
        </div>
      </div>
    </div>
  );
}

interface EditMilestoneDialogProps {
  item: MilestoneItem | null;
  celebrating: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status'>>) => void;
  onRemove: () => void;
}

function EditMilestoneDialog({
  item,
  celebrating,
  onClose,
  onSave,
  onRemove,
}: EditMilestoneDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<MilestoneStatus>('todo');

  useEffect(() => {
    if (!item) return;
    setTitle(item.title);
    setDescription(item.description ?? '');
    setStatus(item.status);
  }, [item]);

  const handleSave = () => {
    if (!item) return;
    onSave({
      title: title.trim() || item.title,
      description: description.trim() || undefined,
      status,
    });
    onClose();
  };

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit milestone</DialogTitle>
        </DialogHeader>
        <div
          className={cn(
            'grid gap-3',
            celebrating && 'ring-2 ring-accent-copper/50 rounded-lg p-1',
          )}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="kanban-milestone-title">Title</Label>
            <Input
              id="kanban-milestone-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="kanban-milestone-description">Description</Label>
            <Textarea
              id="kanban-milestone-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notes, acceptance criteria, links…"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="kanban-milestone-status">Status</Label>
            <select
              id="kanban-milestone-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as MilestoneStatus)}
              className={SELECT_CLASS}
            >
              {(['todo', 'working', 'done'] as MilestoneStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          {item ? (
            <div className="text-metadata text-muted-foreground">
              Created {formatRelative(item.createdAt)} · Updated {formatRelative(item.updatedAt)}
              {item.completedAt ? ` · Completed ${formatRelative(item.completedAt)}` : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" className="text-destructive" onClick={onRemove}>
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="accent" onClick={handleSave}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
