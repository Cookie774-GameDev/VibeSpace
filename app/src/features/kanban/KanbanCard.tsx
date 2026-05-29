import type { DragEvent, KeyboardEvent } from 'react';
import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { cn, formatRelative } from '@/lib/utils';
import type { Task, TaskPriority } from '@/types/task';
import type { Project } from '@/lib/db/schema';
import type { Agent } from '@/types/agent';

/**
 * One draggable task card in the kanban grid. Renders a severity pill
 * derived from the task's priority, an optional due-date badge, the title
 * (clamped at 2 lines), one line of notes, and a footer with the project
 * chip + agent avatar + time-since-updated.
 *
 * `isDragging` — controlled by the parent so the visual hint tracks
 * `draggingTaskId` even after the source row reorders during drop.
 *
 * `reducedMotion` — when the user prefers reduced motion we keep the card
 * fully visible while dragging (the column ring still indicates the drop
 * target) so we don't mute it via opacity transitions.
 */

const PRIORITY_TO_SEVERITY: Record<TaskPriority, 'crit' | 'high' | 'med' | 'low'> = {
  urgent: 'crit',
  high: 'high',
  normal: 'med',
  low: 'low',
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Med',
  low: 'Low',
};

export interface KanbanCardProps {
  task: Task;
  project?: Project;
  agent?: Agent;
  isDragging?: boolean;
  reducedMotion?: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onClick: () => void;
}

export function KanbanCard({
  task,
  project,
  agent,
  isDragging,
  reducedMotion,
  onDragStart,
  onDragEnd,
  onClick,
}: KanbanCardProps) {
  const sev = PRIORITY_TO_SEVERITY[task.priority];
  const sevLabel = PRIORITY_LABEL[task.priority];

  const dueLabel = useMemo(
    () => (task.due_at !== undefined ? formatRelative(task.due_at) : null),
    [task.due_at],
  );

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
      aria-label={`Task: ${task.title}`}
      className={cn(
        'group cursor-grab select-none rounded-lg border border-border bg-paper p-3',
        'transition-shadow transition-colors',
        'hover:shadow-lift hover:border-accent-cream/50',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'active:cursor-grabbing',
        isDragging && !reducedMotion && 'opacity-40',
        isDragging && reducedMotion && 'ring-1 ring-accent-copper',
      )}
    >
      {/* Top row — severity pill + optional due date */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={cn('sev-pill', sev)}>{sevLabel}</span>
        {dueLabel && (
          <span className="inline-flex items-center gap-1 text-metadata text-muted-foreground">
            <Clock className="h-3 w-3" />
            {dueLabel}
          </span>
        )}
      </div>

      {/* Title (2-line clamp) */}
      <div className="font-medium text-body text-foreground line-clamp-2">{task.title}</div>

      {/* Description (1-line clamp) */}
      {task.notes && (
        <div className="mt-1 line-clamp-1 text-secondary text-muted-foreground">{task.notes}</div>
      )}

      {/* Footer — project chip · agent avatar · time-since-updated */}
      <div className="mt-3 flex items-center gap-2 text-metadata text-muted-foreground">
        {project && <ProjectChip project={project} />}
        <span className="ml-auto inline-flex items-center gap-1.5">
          {agent && (
            <Avatar
              seed={agent.slug}
              initials={agent.name.charAt(0)}
              size={16}
              title={agent.name}
            />
          )}
          <span title={new Date(task.updated_at).toLocaleString()}>
            {formatRelative(task.updated_at)}
          </span>
        </span>
      </div>
    </div>
  );
}

function ProjectChip({ project }: { project: Project }) {
  const hue = project.color_hue;
  if (hue === undefined) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-metadata text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
        {project.name}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-metadata"
      style={{
        backgroundColor: `hsl(${hue} 40% 30% / 0.45)`,
        color: `hsl(${hue} 60% 80%)`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: `hsl(${hue} 60% 60%)` }}
      />
      {project.name}
    </span>
  );
}
