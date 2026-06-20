import type { DragEvent, KeyboardEvent } from 'react';
import { Check, Clock, GripVertical } from 'lucide-react';
import { cn, formatRelative } from '@/lib/utils';
import type { MilestoneItem } from '@/features/inspector/types';

export interface KanbanCardProps {
  item: MilestoneItem;
  isDragging?: boolean;
  reducedMotion?: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onClick: () => void;
}

const STATUS_LABEL = {
  todo: 'Todo',
  working: 'In progress',
  done: 'Done',
} as const;

export function KanbanCard({
  item,
  isDragging,
  reducedMotion,
  onDragStart,
  onDragEnd,
  onClick,
}: KanbanCardProps) {
  const done = item.status === 'done';

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={onKey}
      aria-label={`Milestone: ${item.title}`}
      className={cn(
        'group cursor-grab select-none rounded-lg border border-border bg-paper p-3',
        'transition-shadow transition-colors',
        'hover:shadow-lift hover:border-accent-cream/50',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'active:cursor-grabbing',
        isDragging && !reducedMotion && 'opacity-40',
        isDragging && reducedMotion && 'ring-1 ring-accent-copper',
        done && 'opacity-90',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-metadata',
            item.status === 'working' && 'bg-accent-copper/15 text-accent-copper',
            item.status === 'todo' && 'bg-muted/60 text-muted-foreground',
            item.status === 'done' && 'bg-accent-copper/20 text-accent-copper',
          )}
        >
          {done ? <Check className="h-3 w-3" /> : null}
          {STATUS_LABEL[item.status]}
        </span>
        <span className="inline-flex items-center gap-1 text-metadata text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span title={new Date(item.updatedAt).toLocaleString()}>
            {formatRelative(item.updatedAt)}
          </span>
        </span>
      </div>

      <div className="flex items-start gap-1.5">
        <GripVertical
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground/70"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'font-medium text-body text-foreground line-clamp-2',
              done && 'line-through text-muted-foreground',
            )}
          >
            {item.title}
          </div>
          {item.description ? (
            <div className="mt-1 line-clamp-2 text-secondary text-muted-foreground">
              {item.description}
            </div>
          ) : null}
        </div>
      </div>

      {item.completedAt ? (
        <div className="mt-2 text-metadata text-muted-foreground">
          Completed {formatRelative(item.completedAt)}
        </div>
      ) : null}
    </div>
  );
}
