import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Check,
  CalendarClock,
  ListChecks,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMilestonesStore } from '@/features/inspector/milestonesStore';
import { useWorkspaceAnalyticsStore } from '@/features/inspector/workspaceAnalytics';
import { celebrate } from '@/features/celebrate';
import { cn, formatRelative } from '@/lib/utils';
import type { MilestoneItem } from '@/features/inspector/types';
import { isMilestoneKind } from '@/features/inspector/types';
import { useKanbanMilestones } from './hooks';
import {
  useThemeLayoutTransition,
  useThemeMotionLayout,
  useThemeMotionTransition,
} from '@/features/appearance/themeMotion';
import './sakura-kanban.css';

const LEGACY_KANBAN_PROGRESS_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 120,
  damping: 20,
} as const);
const LEGACY_KANBAN_ROW_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 420,
  damping: 32,
} as const);

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
  const reducedMotion = useReducedMotion();

  const items = useKanbanMilestones();
  const addMilestone = useMilestonesStore((s) => s.addMilestone);
  const updateMilestone = useMilestonesStore((s) => s.updateMilestone);
  const removeMilestone = useMilestonesStore((s) => s.removeMilestone);
  const toggleDone = useMilestonesStore((s) => s.toggleDone);
  const clearCompletedTodos = useMilestonesStore((s) => s.clearCompletedTodos);

  const completedMilestones = useWorkspaceAnalyticsStore((s) => s.completedMilestones);

  const todos = useMemo(
    () =>
      items
        .filter((i) => !isMilestoneKind(i))
        .sort((a, b) => {
          // Open items first, then by recency.
          const aDone = a.status === 'done' ? 1 : 0;
          const bDone = b.status === 'done' ? 1 : 0;
          if (aDone !== bDone) return aDone - bDone;
          return b.updatedAt - a.updatedAt;
        }),
    [items],
  );
  const milestones = useMemo(
    () => items.filter(isMilestoneKind).sort((a, b) => b.updatedAt - a.updatedAt),
    [items],
  );

  const todoDone = todos.filter((t) => t.status === 'done').length;
  const milestoneDone = milestones.filter((m) => m.status === 'done').length;
  const milestonePercent =
    milestones.length > 0 ? Math.round((milestoneDone / milestones.length) * 100) : 0;

  const [todoDraft, setTodoDraft] = useState('');
  const [milestoneDraft, setMilestoneDraft] = useState('');
  const [celebrateId, setCelebrateId] = useState<string | null>(null);

  const onCheck = (item: MilestoneItem) => {
    if (item.status !== 'done') {
      setCelebrateId(item.id);
      celebrate('kanban_done', item.title);
      window.setTimeout(() => setCelebrateId(null), 900);
    }
    toggleDone(item.id);
  };

  const addTodo = () => {
    const title = todoDraft.trim();
    if (!title) return;
    addMilestone(title, 'todo');
    setTodoDraft('');
  };

  const addMilestoneItem = () => {
    const title = milestoneDraft.trim();
    if (!title) return;
    addMilestone(title, 'milestone');
    setMilestoneDraft('');
  };

  return (
    <div
      data-monochrome-route="kanban"
      data-sakura-route="kanban"
      className="flex h-full flex-col gap-6 overflow-y-auto p-6 [html[data-theme=monochrome]_&]:gap-4 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:p-4 [html[data-theme=monochrome]_&_.cozy-card]:rounded-sm [html[data-theme=monochrome]_&_.cozy-card]:border [html[data-theme=monochrome]_&_.cozy-card]:border-border-mid [html[data-theme=monochrome]_&_.cozy-card]:bg-panel [html[data-theme=monochrome]_&_.cozy-card]:shadow-none"
    >
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Trace · daily focus & long-run goals</span>
          <h1 className="font-display text-hero text-foreground">Kanban</h1>
          <p className="text-secondary text-muted-foreground max-w-xl">
            Knock out today&apos;s to-dos and track milestones that run for weeks. Everything syncs
            live with the Inspector Trace panel.
          </p>
        </div>
        <AnalyticsSummary
          todoOpen={todos.length - todoDone}
          todoDone={todoDone}
          milestonePercent={milestonePercent}
          completedMilestones={completedMilestones}
        />
      </header>

      <div
        data-kanban-checklist-grid="expanded"
        className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 items-stretch gap-4 lg:grid-cols-2"
      >
        {/* ---- Today's To-do ---- */}
        <ChecklistCard
          icon={<ListChecks className="h-4 w-4 text-accent-copper" />}
          title="Today's to-do"
          subtitle={
            todos.length === 0
              ? 'Add what you want to get done today'
              : `${todoDone}/${todos.length} done`
          }
          accent="copper"
          action={
            todoDone > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clearCompletedTodos}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                title="Start a fresh day — clears completed to-dos"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                New day
              </Button>
            ) : null
          }
          draft={todoDraft}
          onDraftChange={setTodoDraft}
          onAdd={addTodo}
          placeholder="Add a to-do…"
          items={todos}
          emptyHint="No to-dos yet. Add your first one above — check it off when it's done."
          celebrateId={celebrateId}
          reducedMotion={reducedMotion}
          onCheck={onCheck}
          onUpdate={(id, patch) => updateMilestone(id, patch)}
          onRemove={removeMilestone}
        />

        {/* ---- Milestones ---- */}
        <ChecklistCard
          icon={<Target className="h-4 w-4 text-accent-sage" />}
          title="Milestones"
          subtitle={
            milestones.length === 0
              ? 'Goals that run for weeks or months'
              : `${milestonePercent}% complete`
          }
          accent="sage"
          progress={milestones.length > 0 ? milestonePercent : undefined}
          draft={milestoneDraft}
          onDraftChange={setMilestoneDraft}
          onAdd={addMilestoneItem}
          placeholder="Add a milestone…"
          items={milestones}
          emptyHint="No milestones yet. Track the big goals here — they persist across days."
          celebrateId={celebrateId}
          reducedMotion={reducedMotion}
          onCheck={onCheck}
          onUpdate={(id, patch) => updateMilestone(id, patch)}
          onRemove={removeMilestone}
        />
      </div>
    </div>
  );
}

interface ChecklistCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: 'copper' | 'sage';
  action?: React.ReactNode;
  progress?: number;
  draft: string;
  onDraftChange: (v: string) => void;
  onAdd: () => void;
  placeholder: string;
  items: MilestoneItem[];
  emptyHint: string;
  celebrateId: string | null;
  reducedMotion: boolean;
  onCheck: (item: MilestoneItem) => void;
  onUpdate: (
    id: string,
    patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status' | 'deadlineAt'>>,
  ) => void;
  onRemove: (id: string) => void;
}

function ChecklistCard({
  icon,
  title,
  subtitle,
  accent,
  action,
  progress,
  draft,
  onDraftChange,
  onAdd,
  placeholder,
  items,
  emptyHint,
  celebrateId,
  reducedMotion,
  onCheck,
  onUpdate,
  onRemove,
}: ChecklistCardProps) {
  const progressTransition = useThemeLayoutTransition(LEGACY_KANBAN_PROGRESS_TRANSITION);
  const accentRing = accent === 'copper' ? 'ring-accent-copper/60' : 'ring-accent-sage/60';
  const accentText = accent === 'copper' ? 'text-accent-copper' : 'text-accent-sage';
  const accentBar = accent === 'copper' ? 'bg-accent-copper' : 'bg-accent-sage';
  const inputRef = useRef<HTMLInputElement>(null);
  const handleAddRequest = () => {
    if (!draft.trim()) {
      inputRef.current?.focus();
      return;
    }
    onAdd();
  };

  return (
    <section
      data-monochrome-surface="kanban-column"
      data-sakura-surface="kanban-column"
      data-warm-state={items.length === 0 ? 'empty' : 'populated'}
      className="relative flex min-h-[360px] flex-col gap-3 overflow-hidden rounded-xl bg-paper-soft p-5 shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
    >
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-px opacity-60 [html[data-theme=monochrome]_&]:bg-none [html[data-theme=monochrome]_&]:bg-border-mid [html[data-theme=monochrome]_&]:opacity-100',
          accent === 'copper'
            ? 'bg-gradient-to-r from-transparent via-accent-copper/60 to-transparent'
            : 'bg-gradient-to-r from-transparent via-accent-sage/60 to-transparent',
        )}
      />
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-paper shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none">
            {icon}
          </span>
          <div>
            <h2 className="font-display text-page-title text-foreground">{title}</h2>
            <p className="text-metadata text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {action}
      </header>

      {progress !== undefined ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60 [html[data-theme=monochrome]_&]:h-px [html[data-theme=monochrome]_&]:rounded-none">
          <motion.div
            className={cn('h-full rounded-full', accentBar)}
            initial={false}
            animate={{ width: `${progress}%` }}
            transition={progressTransition}
          />
        </div>
      ) : null}

      <div className="flex gap-1.5">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddRequest();
            }
          }}
          aria-label={`New item for ${title}`}
          placeholder={placeholder}
          className="h-8 text-secondary"
        />
        <Button
          type="button"
          size="sm"
          variant="accent"
          onClick={handleAddRequest}
          aria-label={`Add item to ${title}`}
          data-warm-action="kanban-add"
          data-warm-accent={accent}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        {items.length === 0 ? (
          <div
            data-warm-surface="kanban-empty-copy"
            className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border-mid/60 px-3 py-6 text-center text-secondary text-muted-foreground [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-solid"
          >
            {emptyHint}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  celebrating={celebrateId === item.id}
                  reducedMotion={reducedMotion}
                  accentRing={accentRing}
                  accentText={accentText}
                  onCheck={() => onCheck(item)}
                  onUpdate={(patch) => onUpdate(item.id, patch)}
                  onRemove={() => onRemove(item.id)}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </section>
  );
}

function ChecklistRow({
  item,
  celebrating,
  reducedMotion,
  accentRing,
  accentText,
  onCheck,
  onUpdate,
  onRemove,
}: {
  item: MilestoneItem;
  celebrating: boolean;
  reducedMotion: boolean;
  accentRing: string;
  accentText: string;
  onCheck: () => void;
  onUpdate: (
    patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status' | 'deadlineAt'>>,
  ) => void;
  onRemove: () => void;
}) {
  const rowTransition = useThemeMotionTransition(LEGACY_KANBAN_ROW_TRANSITION);
  const rowLayout = useThemeMotionLayout(true);
  const done = item.status === 'done';
  return (
    <motion.li
      data-sakura-surface="kanban-card"
      data-sakura-state={done ? 'complete' : 'open'}
      layout={rowLayout}
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? undefined : { opacity: 0, scale: 0.97, transition: { duration: 0.2 } }}
      transition={rowTransition}
      className={cn(
        'group relative flex items-start gap-2 rounded-lg border border-border bg-paper px-2.5 py-2 transition-colors',
        celebrating &&
          `ring-2 ${accentRing} shadow-[0_0_24px_rgba(217,119,87,0.22)] [html[data-theme=monochrome]_&]:border-foreground [html[data-theme=monochrome]_&]:ring-0 [html[data-theme=monochrome]_&]:shadow-none`,
        done && 'opacity-75',
      )}
    >
      {celebrating ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg bg-accent-copper/10"
          initial={reducedMotion ? false : { opacity: 0.7, scale: 0.96 }}
          animate={reducedMotion ? undefined : { opacity: 0, scale: 1.04 }}
          transition={reducedMotion ? undefined : { duration: 0.85 }}
        />
      ) : null}
      <button
        type="button"
        onClick={onCheck}
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
          done
            ? `border-accent-copper bg-accent-copper/20 ${accentText}`
            : 'border-border hover:border-accent-copper/50',
        )}
        aria-label={done ? `Mark ${item.title} not done` : `Complete ${item.title}`}
      >
        {done ? <Check className="h-3 w-3" /> : null}
      </button>
      <div className="min-w-0 flex-1">
        <input
          value={item.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className={cn(
            'w-full bg-transparent text-secondary text-foreground outline-none',
            done && 'line-through text-muted-foreground',
          )}
        />
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-metadata text-muted-foreground">
            {formatRelative(item.updatedAt)}
          </span>
          {item.deadlineAt ? (
            <span className="inline-flex items-center gap-1 text-metadata text-muted-foreground">
              <CalendarClock className="h-3 w-3" /> Target {formatDeadlineLabel(item.deadlineAt)}
            </span>
          ) : null}
          {celebrating ? (
            <span className={cn('inline-flex items-center gap-1 text-[10px]', accentText)}>
              <Sparkles className="h-3 w-3" /> Done!
            </span>
          ) : null}
        </div>
        <input
          value={item.description ?? ''}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Description"
          className="mt-1 w-full bg-transparent text-metadata text-muted-foreground outline-none placeholder:text-muted-foreground/45"
        />
        <div className="mt-1 flex items-center gap-1.5 text-metadata text-muted-foreground">
          <CalendarClock className="h-3 w-3 text-accent-copper/80" />
          <input
            type="date"
            value={toDateInput(item.deadlineAt)}
            onChange={(e) => onUpdate({ deadlineAt: fromDateInput(e.target.value) })}
            aria-label={`Target date for ${item.title}`}
            className="min-w-0 bg-transparent outline-none [color-scheme:dark]"
          />
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="mt-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
        aria-label={`Delete ${item.title}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </motion.li>
  );
}

function toDateInput(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '';
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fromDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(`${value}T17:00:00`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function formatDeadlineLabel(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function AnalyticsSummary({
  todoOpen,
  todoDone,
  milestonePercent,
  completedMilestones,
}: {
  todoOpen: number;
  todoDone: number;
  milestonePercent: number;
  completedMilestones: number;
}) {
  return (
    <div
      data-sakura-surface="kanban-summary"
      className="cozy-card flex flex-wrap items-stretch gap-4 p-4 min-w-[280px]"
    >
      <StatBlock label="To-do" value={String(todoOpen)} hint="open today" />
      <StatBlock label="Done" value={todoDone > 0 ? String(todoDone) : '—'} hint="today" />
      <StatBlock label="Milestones" value={`${milestonePercent}%`} hint="complete" />
      <StatBlock
        label="Session"
        value={completedMilestones > 0 ? String(completedMilestones) : '—'}
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

export default KanbanPage;
