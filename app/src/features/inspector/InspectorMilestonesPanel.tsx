import * as React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, GripVertical, MoreHorizontal, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useMilestonesStore } from './milestonesStore';
import type { MilestoneItem } from './types';

type TraceView = 'milestones' | 'timeline';

interface InspectorMilestonesPanelProps {
  view: TraceView;
  onViewChange: (view: TraceView) => void;
}

export function InspectorMilestonesPanel({ view, onViewChange }: InspectorMilestonesPanelProps) {
  const items = useMilestonesStore((s) => s.items);
  const addMilestone = useMilestonesStore((s) => s.addMilestone);
  const updateMilestone = useMilestonesStore((s) => s.updateMilestone);
  const removeMilestone = useMilestonesStore((s) => s.removeMilestone);
  const toggleDone = useMilestonesStore((s) => s.toggleDone);

  const [draft, setDraft] = React.useState('');
  const [celebrateId, setCelebrateId] = React.useState<string | null>(null);

  const doneCount = items.filter((i) => i.status === 'done').length;
  const progress = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  const onAdd = () => {
    const title = draft.trim();
    if (!title) return;
    addMilestone(title);
    setDraft('');
  };

  const onCheck = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (item.status !== 'done') {
      setCelebrateId(id);
      window.setTimeout(() => setCelebrateId(null), 900);
    }
    toggleDone(id);
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
        <div className="rounded-md border border-border bg-elevated px-3 py-3 text-secondary text-muted-foreground">
          Agent rows, tool spans, and token costs will appear here as workflow events are recorded.
          Use <span className="text-foreground">Milestone List</span> for actionable progress tracking today.
        </div>
      ) : (
        <>
          <div className="flex gap-1.5">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAdd();
              }}
              placeholder="Add milestone…"
              className="h-8 text-secondary"
            />
            <Button type="button" size="sm" variant="accent" onClick={onAdd} disabled={!draft.trim()}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          {items.length === 0 ? (
            <p className="text-secondary text-muted-foreground italic px-0.5">
              No milestones yet. Add your first checkpoint above.
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
  onUpdate: (patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status'>>) => void;
  onRemove: () => void;
}) {
  const done = item.status === 'done';
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
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
            placeholder="Notes (optional)"
            className="mt-0.5 w-full bg-transparent text-metadata text-muted-foreground outline-none"
          />
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
    </motion.li>
  );
}
