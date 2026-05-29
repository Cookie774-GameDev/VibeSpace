import { useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn, formatRelative } from '@/lib/utils';
import { TaskService } from './TaskService';
import { parseTaskInput } from './parseTaskInput';
import { useTaskStore } from './store';

/**
 * Inline "add a task" composer.
 *
 * Live-parses the input as the user types so they can see what Jarvis is
 * about to schedule (date, priority, tags). Hitting Enter (or clicking the
 * + button) creates the task and triggers the accent flash via the store.
 */

export interface TaskComposerProps {
  className?: string;
  /** Hint shown in the placeholder. */
  placeholder?: string;
  /** Source channel - lets the extractor identify provenance. */
  createdBy?: 'user_text' | 'user_voice';
}

export function TaskComposer({
  className,
  placeholder = 'Add a task...  e.g. review PR fri 4pm urgent #review',
  createdBy = 'user_text',
}: TaskComposerProps) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const flashTask = useTaskStore((s) => s.flashTask);

  const preview = value.trim().length > 1 ? parseTaskInput(value) : null;

  const submit = async () => {
    const v = value.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    try {
      const parsed = parseTaskInput(v);
      const task = await TaskService.createTask({
        ...parsed,
        created_by: createdBy,
      });
      flashTask(task.id);
      setValue('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            className="h-8 pr-8 text-body"
            disabled={submitting}
            aria-label="New task"
          />
          <Sparkles
            className={cn(
              'pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground transition-colors',
              preview && 'text-accent-cyan',
            )}
          />
        </div>
        <Button
          size="icon"
          variant={value.trim() ? 'accent' : 'secondary'}
          onClick={() => void submit()}
          disabled={!value.trim() || submitting}
          aria-label="Add task"
          title="Add task"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Live preview chips - tells the user what Jarvis parsed out */}
      {preview && (preview.due_at !== undefined || preview.priority !== 'normal' || (preview.context_tags?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-1 px-0.5 text-metadata text-muted-foreground">
          <span>I'll save:</span>
          <span className="text-foreground">"{preview.title || '...'}"</span>
          {preview.due_at !== undefined && (
            <span className="rounded bg-muted/60 px-1.5 py-0.5">
              {formatRelative(preview.due_at)}
            </span>
          )}
          {preview.priority && preview.priority !== 'normal' && (
            <span className="rounded bg-muted/60 px-1.5 py-0.5">
              {preview.priority}
            </span>
          )}
          {(preview.context_tags ?? []).map((t) => (
            <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
