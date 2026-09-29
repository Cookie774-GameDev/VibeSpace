import * as React from 'react';
import { pageOrderedBlocks, type CanvasBlock, type CanvasDocument } from './contracts';

// ---------------------------------------------------------------------------
// Label derivation
// ---------------------------------------------------------------------------

const MAX_LABEL_TEXT_LENGTH = 80;

function truncateText(text: string): string {
  if (text.length <= MAX_LABEL_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_LABEL_TEXT_LENGTH - 1)}…`;
}

/** Derives a meaningful, screen-reader-friendly label from a canvas block. */
export function blockOutlineLabel(block: CanvasBlock): string {
  const { content } = block;
  switch (content.kind) {
    case 'heading':
      return `Heading ${content.level}: ${truncateText(content.text)}`;
    case 'text':
      return `Text: ${truncateText(content.text)}`;
    case 'note':
      return `Note: ${truncateText(content.text)}`;
    case 'code':
      return `Code (${content.language}): ${truncateText(content.text)}`;
    case 'mind-map': {
      const root = content.map.nodes.find((node) => node.id === content.map.rootId);
      return `Mind map: ${truncateText(root?.label ?? 'Untitled')}`;
    }
    case 'shape':
      return `Shape (${content.shape.kind}): ${truncateText(content.shape.text ?? 'Unlabeled')}`;
    case 'stroke':
      return `${content.tool === 'pencil' ? 'Pencil' : 'Marker'} stroke`;
    case 'image':
      return `Image: ${truncateText(content.altText || content.name)}`;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CanvasOutlineProps {
  /** The canvas document whose blocks are outlined. */
  readonly document: CanvasDocument;
  /** IDs of currently selected blocks. */
  readonly selectedIds: readonly string[];
  /** Called when a block is activated (click, Enter, or Space). */
  readonly onActivate?: (blockId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CanvasOutline({ document, selectedIds, onActivate }: CanvasOutlineProps) {
  const blocks = React.useMemo(() => pageOrderedBlocks(document), [document]);
  const itemRefs = React.useRef<Array<HTMLLIElement | null>>([]);

  // Keep the ref array sized to the current block count.
  if (itemRefs.current.length !== blocks.length) {
    itemRefs.current = blocks.map((_, i) => itemRefs.current[i] ?? null);
  }

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  // The tabbable item: first selected block, or the first block.
  const tabbableIndex = React.useMemo(() => {
    if (blocks.length === 0) return -1;
    const idx = blocks.findIndex((b) => selectedSet.has(b.id));
    return idx >= 0 ? idx : 0;
  }, [blocks, selectedSet]);

  const focusItem = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, blocks.length - 1));
      itemRefs.current[clamped]?.focus();
    },
    [blocks.length],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLLIElement>, blockId: string, index: number) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusItem(index + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusItem(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusItem(0);
          break;
        case 'End':
          event.preventDefault();
          focusItem(blocks.length - 1);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          onActivate?.(blockId);
          break;
      }
    },
    [blocks.length, focusItem, onActivate],
  );

  if (blocks.length === 0) {
    return (
      <nav aria-label="Canvas object outline">
        <p className="px-3 py-4 text-sm text-muted-foreground">No canvas objects yet</p>
      </nav>
    );
  }

  return (
    <nav aria-label="Canvas object outline">
      <ul role="tree" aria-label="Canvas object outline" className="flex flex-col gap-0.5 p-1">
        {blocks.map((block, index) => {
          const isSelected = selectedSet.has(block.id);
          const label = blockOutlineLabel(block);
          return (
            <li
              key={block.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              role="treeitem"
              aria-label={label}
              aria-selected={isSelected}
              aria-level={block.content.kind === 'heading' ? block.content.level : undefined}
              tabIndex={index === tabbableIndex ? 0 : -1}
              onClick={() => onActivate?.(block.id)}
              onKeyDown={(event) => handleKeyDown(event, block.id, index)}
              className={[
                'cursor-pointer rounded-md px-3 py-1.5 text-sm outline-none transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                isSelected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              ].join(' ')}
            >
              <span aria-hidden="true" className="truncate">
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
