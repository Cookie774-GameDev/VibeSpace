import type { DragEvent, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { MilestoneItem, MilestoneStatus } from '@/features/inspector/types';
import { KanbanCard } from './KanbanCard';

export interface KanbanColumnProps {
  status: MilestoneStatus;
  title: string;
  items: MilestoneItem[];
  draggingItemId: string | null;
  reducedMotion: boolean;
  onDragStartItem: (itemId: string) => void;
  onDragEndItem: () => void;
  onDropItem: (itemId: string, target: MilestoneStatus) => void;
  onCreateItem: (status: MilestoneStatus, title: string) => void;
  onOpenItem: (item: MilestoneItem) => void;
}

export function KanbanColumn({
  status,
  title,
  items,
  draggingItemId,
  reducedMotion,
  onDragStartItem,
  onDragEndItem,
  onDropItem,
  onCreateItem,
  onOpenItem,
}: KanbanColumnProps) {
  const [isOver, setIsOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draggingItemId) {
      dragDepth.current = 0;
      setIsOver(false);
    }
  }, [draggingItemId]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!draggingItemId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!draggingItemId) return;
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
    const itemId = e.dataTransfer.getData('text/jarvis-milestone') || draggingItemId;
    if (!itemId) return;
    onDropItem(itemId, status);
  };

  const submitDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setCreating(false);
      setDraft('');
      return;
    }
    onCreateItem(status, trimmed);
    setDraft('');
    setCreating(false);
  };

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitDraft();
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
        'flex h-full min-h-[360px] flex-col gap-4 rounded-xl bg-paper-soft p-6 shadow-soft',
        'transition-[box-shadow] duration-150',
        isOver && 'ring-1 ring-accent-copper',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-page-title text-foreground">{title}</h2>
          <span className="eyebrow" aria-label={`${items.length} milestones`}>
            {items.length}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Add milestone to ${title}`}
          title={`Add milestone to ${title}`}
          onClick={() => setCreating((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </header>

      {creating ? (
        <div className="rounded-lg border border-border bg-paper p-2">
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            onBlur={submitDraft}
            placeholder={`New milestone in ${title.toLowerCase()}`}
            className="h-7"
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {items.length === 0 ? (
          <div
            className={cn(
              'flex flex-1 items-center justify-center rounded-lg border border-dashed border-border-mid/60 px-3 py-6 text-center text-secondary text-muted-foreground',
              isOver && 'border-accent-copper/60 text-foreground',
            )}
          >
            Drop a milestone here, or hit + to add one.
          </div>
        ) : (
          items.map((item) => (
            <KanbanCard
              key={item.id}
              item={item}
              isDragging={draggingItemId === item.id}
              reducedMotion={reducedMotion}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/jarvis-milestone', item.id);
                onDragStartItem(item.id);
              }}
              onDragEnd={onDragEndItem}
              onClick={() => onOpenItem(item)}
            />
          ))
        )}
      </div>
    </section>
  );
}
