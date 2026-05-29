import { motion, AnimatePresence } from 'motion/react';
import { Check, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn, formatRelative } from '@/lib/utils';
import type { DraftTask } from '@/types/task';
import { TaskService } from './TaskService';
import { useTaskStore } from './store';

/**
 * Suggested-tasks section. Renders pending DraftTasks from the action
 * extractor agent. Each draft has a one-tap accept (creates the real
 * task and removes the draft) and a one-tap reject (just removes it).
 */

export interface DraftTaskListProps {
  className?: string;
}

export function DraftTaskList({ className }: DraftTaskListProps) {
  const drafts = useTaskStore((s) => s.drafts);
  const removeDraft = useTaskStore((s) => s.removeDraft);
  const flashTask = useTaskStore((s) => s.flashTask);

  if (drafts.length === 0) return null;

  const accept = async (draft: DraftTask) => {
    const t = draft.task;
    const created = await TaskService.createTask({
      title: t.title ?? draft.trigger_phrase,
      priority: t.priority ?? 'normal',
      context_tags: t.context_tags ?? [],
      due_at: t.due_at,
      scheduled_for: t.scheduled_for,
      effort: t.effort ?? 3,
      energy_required: t.energy_required ?? 'medium',
      notes: t.notes,
      project_id: t.project_id,
      created_by: 'extracted_chat',
      source_refs: [draft.source_ref, ...(t.source_refs ?? [])],
    });
    flashTask(created.id);
    removeDraft(draft.id);
  };

  const reject = (draft: DraftTask) => removeDraft(draft.id);

  return (
    <div className={cn('space-y-1.5', className)}>
      <AnimatePresence initial={false}>
        {drafts.map((d) => (
          <motion.div
            key={d.id}
            layout
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="rounded-md border border-dashed border-accent-cyan/30 bg-panel/60 p-2.5"
          >
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-cyan" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-body text-foreground" title={d.task.title}>
                    {d.task.title || 'Suggested task'}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {Math.round(d.confidence * 100)}%
                  </Badge>
                </div>
                {d.trigger_phrase && (
                  <div className="mt-0.5 line-clamp-2 text-metadata italic text-muted-foreground">
                    "{d.trigger_phrase}"
                  </div>
                )}
                {d.task.due_at !== undefined && (
                  <div className="mt-1 text-metadata text-muted-foreground">
                    Suggested due: {formatRelative(d.task.due_at)}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="accent"
                  size="icon-sm"
                  className="h-6 w-6"
                  aria-label="Accept suggestion"
                  title="Accept"
                  onClick={() => void accept(d)}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  aria-label="Reject suggestion"
                  title="Dismiss"
                  onClick={() => reject(d)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
