/**
 * TerminalGrid — recursive renderer for the multi-pane terminal layout.
 *
 * Each leaf wraps a `<TerminalView>` with a 24px chrome strip
 * (command name + split / close buttons). Splits get a draggable 4px
 * gutter that calls `setRatio` on mousemove.
 */

import * as React from 'react';
import { SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { TerminalView } from './TerminalView';
import {
  type PaneNode,
  splitPane,
  closePane,
  setRatio,
  countLeaves,
  updateLeaf,
  MAX_PANES,
} from './paneTree';
import { cn } from '@/lib/utils';

interface TerminalGridProps {
  tree: PaneNode;
  onChange: (next: PaneNode | null) => void;
  defaultCommand?: string;
}

export function TerminalGrid({ tree, onChange, defaultCommand }: TerminalGridProps) {
  const atCap = countLeaves(tree) >= MAX_PANES;

  const handleSplit = (paneId: string, orientation: 'h' | 'v') => {
    onChange(splitPane(tree, paneId, orientation));
  };

  const handleClose = (paneId: string) => {
    onChange(closePane(tree, paneId));
  };

  const handleSetRatio = (splitId: string, ratio: number) => {
    onChange(setRatio(tree, splitId, ratio));
  };

  const handleSessionAttach = (paneId: string, sessionId: string) => {
    onChange(updateLeaf(tree, paneId, { sessionId }));
  };

  return (
    <PaneRenderer
      node={tree}
      atCap={atCap}
      defaultCommand={defaultCommand}
      onSplit={handleSplit}
      onClose={handleClose}
      onSetRatio={handleSetRatio}
      onSessionAttach={handleSessionAttach}
    />
  );
}

interface PaneRendererProps {
  node: PaneNode;
  atCap: boolean;
  defaultCommand?: string;
  onSplit: (paneId: string, orientation: 'h' | 'v') => void;
  onClose: (paneId: string) => void;
  onSetRatio: (splitId: string, ratio: number) => void;
  onSessionAttach: (paneId: string, sessionId: string) => void;
}

function PaneRenderer(props: PaneRendererProps) {
  const { node, atCap, defaultCommand, onSplit, onClose, onSessionAttach } = props;

  if (node.kind === 'leaf') {
    return (
      <div className="flex h-full w-full flex-col bg-panel border border-border rounded-lg overflow-hidden shadow-soft">
        <div className="flex h-6 shrink-0 items-center justify-between px-2 bg-paper-soft border-b border-border">
          <span className="text-metadata text-muted-foreground truncate">
            {node.command || defaultCommand || 'shell'}
          </span>
          <div className="flex items-center gap-0.5">
            <ChromeBtn
              title="Split right"
              disabled={atCap}
              onClick={() => onSplit(node.id, 'h')}
            >
              <SplitSquareHorizontal className="h-3 w-3" />
            </ChromeBtn>
            <ChromeBtn
              title="Split down"
              disabled={atCap}
              onClick={() => onSplit(node.id, 'v')}
            >
              <SplitSquareVertical className="h-3 w-3" />
            </ChromeBtn>
            <ChromeBtn title="Close pane" onClick={() => onClose(node.id)}>
              <X className="h-3 w-3" />
            </ChromeBtn>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <TerminalView
            sessionId={node.sessionId ?? null}
            command={node.command || defaultCommand}
            onReady={(sid) => onSessionAttach(node.id, sid)}
          />
        </div>
      </div>
    );
  }

  return <SplitRenderer {...props} node={node} />;
}

interface SplitRendererProps extends Omit<PaneRendererProps, 'node'> {
  node: Extract<PaneNode, { kind: 'split' }>;
}

function SplitRenderer({ node, onSetRatio, ...rest }: SplitRendererProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio =
        node.orientation === 'h'
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
      onSetRatio(node.id, ratio);
    };
    const onUp = () => setDragging(false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, node.id, node.orientation, onSetRatio]);

  const isHorizontal = node.orientation === 'h';
  const leftStyle: React.CSSProperties = isHorizontal
    ? { width: `${node.ratio * 100}%` }
    : { height: `${node.ratio * 100}%` };
  const rightStyle: React.CSSProperties = isHorizontal
    ? { width: `${(1 - node.ratio) * 100}%` }
    : { height: `${(1 - node.ratio) * 100}%` };

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full w-full min-h-0 min-w-0', isHorizontal ? 'flex-row' : 'flex-col')}
    >
      <div style={leftStyle} className="min-h-0 min-w-0 overflow-hidden">
        <PaneRenderer node={node.left} onSetRatio={onSetRatio} {...rest} />
      </div>
      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        className={cn(
          'shrink-0 bg-border-mid hover:bg-accent-copper transition-colors',
          isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        )}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
      />
      <div style={rightStyle} className="min-h-0 min-w-0 overflow-hidden">
        <PaneRenderer node={node.right} onSetRatio={onSetRatio} {...rest} />
      </div>
    </div>
  );
}

interface ChromeBtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

function ChromeBtn({ children, className, ...rest }: ChromeBtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'h-5 w-5 inline-flex items-center justify-center rounded',
        'text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}
