import * as React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CalendarClock,
  Check,
  GripVertical,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { ActivityRow } from '@/features/chat/activity';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import { useScopedMilestones, useScopedMilestoneDraft } from './useScopedMilestones';
import { isMilestoneKind } from './types';
import type { MilestoneItem } from './types';

type TraceView = 'milestones' | 'timeline';

interface InspectorMilestonesPanelProps {
  view: TraceView;
  onViewChange: (view: TraceView) => void;
}

export function InspectorMilestonesPanel({ view, onViewChange }: InspectorMilestonesPanelProps) {
  const { items: allItems, ready, scopeKey, addMilestone, updateMilestone,
    removeMilestone, toggleDone } = useScopedMilestones();
  const items = React.useMemo(() => allItems.filter(isMilestoneKind), [allItems]);
  const eventsByChat = useJarvisTaskRunStore((s) => s.activityByChat);
  const activityEvents = React.useMemo(() => {
    const chatKeys = Object.keys(eventsByChat);
    if (chatKeys.length === 0) return [];
    return chatKeys
      .flatMap((chatKey) => eventsByChat[chatKey] ?? [])
      .sort((a, b) => a.ts - b.ts)
      .slice(-16);
  }, [eventsByChat]);

  const [draft, setDraft] = useScopedMilestoneDraft(scopeKey);
  const [celebrateId, setCelebrateId] = React.useState<string | null>(null);

  const doneCount = items.filter((i) => i.status === 'done').length;
  const progress = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  const onAdd = () => {
    const title = draft.trim();
    if (!title) return;
    if (addMilestone(title, 'milestone')) setDraft('');
  };

  const onCheck = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item || !toggleDone(id)) return;
    if (item.status !== 'done') {
      setCelebrateId(id);
      window.setTimeout(() => setCelebrateId(null), 900);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <div>
          <p className="text-ui-strong text-foreground">Trace</p>
          <p className="text-metadata text-muted-foreground">
            {view === 'milestones' ? 'Milestone list' : 'Workflow timeline'} · {progress}% complete
          </p>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Trace view options">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            <button
              type="button"
              className={cn(
                'w-full rounded px-2 py-1.5 text-left text-secondary hover:bg-muted',
                view === 'milestones' && 'text-accent-copper font-medium',
              )}
              onClick={() => onViewChange('milestones')}
            >
              Milestone List
            </button>
            <button
              type="button"
              className={cn(
                'w-full rounded px-2 py-1.5 text-left text-secondary hover:bg-muted',
                view === 'timeline' && 'text-accent-copper font-medium',
              )}
              onClick={() => onViewChange('timeline')}
            >
              Workflow timeline
            </button>
          </PopoverContent>
        </Popover>
      </header>

      {view === 'timeline' ? (
        activityEvents.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border bg-elevated">
            {activityEvents.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-elevated px-3 py-3 text-secondary text-muted-foreground">
            Jarvis agent, file, URL, and diff activity will appear here as chat workflows run. Use{' '}
            <span className="text-foreground">Milestone List</span> for manual checkpoints.
          </div>
        )
      ) : (
        <>
          <div className="flex gap-1.5">
            <Input
              value={draft}
              disabled={!ready}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAdd();
              }}
              placeholder="Add milestone…"
              className="h-8 text-secondary"
            />
            <Button
              type="button"
              size="sm"
              variant="accent"
              onClick={onAdd}
              disabled={!ready || !draft.trim()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          {items.length === 0 ? (
            <p className="text-secondary text-muted-foreground italic px-0.5">
              No milestones assigned to this project. Older unassigned items are retained.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <MilestoneRow
                    key={item.id}
                    item={item}
                    celebrating={celebrateId === item.id}
                    onCheck={() => onCheck(item.id)}
                    onUpdate={(patch) => updateMilestone(item.id, patch)}
                    onRemove={() => removeMilestone(item.id)}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function MilestoneRow({
  item,
  celebrating,
  onCheck,
  onUpdate,
  onRemove,
}: {
  item: MilestoneItem;
  celebrating: boolean;
  onCheck: () => void;
  onUpdate: (
    patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status' | 'deadlineAt'>>,
  ) => void;
  onRemove: () => void;
}) {
  const done = item.status === 'done';
  return (
    <li
      className={cn(
        'relative rounded-md border border-border bg-elevated px-2 py-2',
        celebrating && 'ring-2 ring-accent-copper/60 shadow-[0_0_24px_rgba(255,152,0,0.25)]',
        done && 'opacity-80',
      )}
    >
      {celebrating ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md bg-accent-copper/10"
          initial={{ opacity: 0.8, scale: 0.95 }}
          animate={{ opacity: 0, scale: 1.05 }}
          transition={{ duration: 0.85 }}
        />
      ) : null}
      <div className="flex items-start gap-2">
        <GripVertical className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
        <button
          type="button"
          onClick={onCheck}
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
            done
              ? 'border-accent-copper bg-accent-copper/20 text-accent-copper'
              : 'border-border hover:border-accent-copper/50',
          )}
          aria-label={done ? 'Mark milestone todo' : 'Complete milestone'}
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
          <input
            value={item.description ?? ''}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder="Description"
            className="mt-0.5 w-full bg-transparent text-metadata text-muted-foreground outline-none"
          />
          <label className="mt-1 flex items-center gap-1.5 text-metadata text-muted-foreground">
            <CalendarClock className="h-3 w-3 text-accent-copper/80" />
            <span className="sr-only">Target date for {item.title}</span>
            <input
              type="date"
              value={toDateInput(item.deadlineAt)}
              onChange={(e) => onUpdate({ deadlineAt: fromDateInput(e.target.value) })}
              className="min-w-0 bg-transparent outline-none [color-scheme:dark]"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive"
          aria-label="Delete milestone"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {celebrating ? (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-accent-copper">
          <Sparkles className="h-3 w-3" /> Nice — milestone complete!
        </p>
      ) : null}
    </li>
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
