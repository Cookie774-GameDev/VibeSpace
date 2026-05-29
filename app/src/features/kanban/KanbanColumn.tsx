import type { DragEvent, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Task, TaskStatus } from '@/types/task';
import type { Project } from '@/lib/db/schema';
import type { Agent } from '@/types/agent';
import { KanbanCard } from './KanbanCard';

/**
 * One kanban column. Owns the column header, the inline-create input, the
 * drop-zone visual + handlers, and the stack of cards.
 *
 * Drag math: the column is the drop target. We `preventDefault()` on
 * `dragover` so the browser allows a `drop`, and toggle a copper ring while
 * the drag is hovering. The column doesn't read `dataTransfer` itself; the
 * page hands us the active drag id via `draggingTaskId` so we can mute the
 * source card during the gesture.
 */

export interface KanbanColumnProps {
  status: TaskStatus;
  title: string;
  tasks: Task[];
  projects: Map<string, Project>;
  agents: Map<string, Agent>;
  draggingTaskId: string | null;
  reducedMotion: boolean;
  onDragStartTask: (taskId: string) => void;
  onDragEndTask: () => void;
  onDropTask: (taskId: string, target: TaskStatus) => void;
  onCreateTask: (status: TaskStatus, title: string) => Promise<void> | void;
  onOpenTask: (task: Task) => void;
}

export function KanbanColumn({
  status,
  title,
  tasks,
  projects,
  agents,
  draggingTaskId,
  reducedMotion,
  onDragStartTask,
  onDragEndTask,
  onDropTask,
  onCreateTask,
  onOpenTask,
}: KanbanColumnProps) {
  const [isOver, setIsOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset hover state if the active drag ends elsewhere (e.g. dropped on
  // another column). We can't rely on dragleave alone because nested
  // children can fire enter/leave pairs that confuse the boolean.
  useEffect(() => {
    if (!draggingTaskId) {
      dragDepth.current = 0;
      setIsOver(false);
    }
  }, [draggingTaskId]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!draggingTaskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!draggingTaskId) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsOver(true);
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsOver(false);
    const taskId = e.dataTransfer.getData('text/jarvis-task') || draggingTaskId;
    if (!taskId) return;
    onDropTask(taskId, status);
  };

  const submitDraft = async () => {
    const title = draft.trim();
    if (!title) {
      setCreating(false);
      setDraft('');
      return;
    }
    await onCreateTask(status, title);
    setDraft('');
    setCreating(false);
  };

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCreating(false);
      setDraft('');
    }
  };

  return (
    <section
      aria-label={`${title} column`}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex h-full min-h-[320px] flex-col gap-4 rounded-xl bg-paper-soft p-6 shadow-soft',
        'transition-[box-shadow] duration-150',
        isOver && 'ring-1 ring-accent-copper',
      )}
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-page-title text-foreground">{title}</h2>
          <span className="eyebrow" aria-label={`${tasks.length} tasks`}>
            {tasks.length}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Add task to ${title}`}
          title={`Add task to ${title}`}
          onClick={() => setCreating((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </header>

      {/* Inline create form */}
      {creating && (
        <div className="rounded-lg border border-border bg-paper p-2">
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            onBlur={() => void submitDraft()}
            placeholder={`New task in ${title.toLowerCase()}`}
            className="h-7"
          />
        </div>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {tasks.length === 0 ? (
          <div
            className={cn(
              'flex flex-1 items-center justify-center rounded-lg border border-dashed border-border-mid/60 px-3 py-6 text-center text-secondary text-muted-foreground',
              isOver && 'border-accent-copper/60 text-foreground',
            )}
          >
            Drop a task here, or hit + to add one.
          </div>
        ) : (
          tasks.map((t) => (
            <KanbanCard
              key={t.id}
              task={t}
              project={t.project_id ? projects.get(t.project_id) : undefined}
              agent={t.agent_owner ? agents.get(t.agent_owner) : undefined}
              isDragging={draggingTaskId === t.id}
              reducedMotion={reducedMotion}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/jarvis-task', t.id);
                onDragStartTask(t.id);
              }}
              onDragEnd={onDragEndTask}
              onClick={() => onOpenTask(t)}
            />
          ))
        )}
      </div>
    </section>
  );
}
