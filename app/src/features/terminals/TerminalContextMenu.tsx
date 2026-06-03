import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Sparkles, Copy, Edit2, Eraser, Columns, Rows, Trash2 } from 'lucide-react';

interface TerminalContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onAskJarvis: () => void;
  onCopyOutput: () => void;
  onRename: () => void;
  onClear: () => void;
  onSplit: (direction: 'col' | 'row') => void;
  onCloseTerminal: () => void;
}

export function TerminalContextMenu({
  x,
  y,
  onClose,
  onAskJarvis,
  onCopyOutput,
  onRename,
  onClear,
  onSplit,
  onCloseTerminal,
}: TerminalContextMenuProps) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Position adjustment to keep menu inside viewport bounds
  const [adjustedPos, setAdjustedPos] = React.useState({ left: x, top: y });

  React.useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = x;
    let top = y;

    // Check right edge
    if (x + rect.width > viewportWidth) {
      left = viewportWidth - rect.width - 8;
    }
    // Check bottom edge
    if (y + rect.height > viewportHeight) {
      top = viewportHeight - rect.height - 8;
    }

    setAdjustedPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  // Click outside to close
  React.useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = () => onClose();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // Capture phase listener to prevent clicks from hitting underlying items first
    document.addEventListener('click', handleOutsideClick, true);
    document.addEventListener('contextmenu', handleOutsideClick, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('keydown', handleKey, true);

    return () => {
      document.removeEventListener('click', handleOutsideClick, true);
      document.removeEventListener('contextmenu', handleOutsideClick, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: `${adjustedPos.left}px`,
        top: `${adjustedPos.top}px`,
        zIndex: 9999,
      }}
      className="w-48 overflow-hidden rounded-lg border border-border bg-panel text-foreground shadow-lg flex flex-col p-1.5 animate-in fade-in zoom-in-95 duration-100 ease-out"
    >
      <button
        type="button"
        onClick={() => {
          onAskJarvis();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata hover:bg-accent-copper/10 hover:text-accent-copper transition-colors text-left"
      >
        <Sparkles className="h-3.5 w-3.5 text-accent-copper" />
        <span>Ask Jarvis</span>
      </button>

      <div className="my-1 border-t border-border/60" />

      <button
        type="button"
        onClick={() => {
          onCopyOutput();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata hover:bg-panel-soft transition-colors text-left"
      >
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Copy output</span>
      </button>

      <button
        type="button"
        onClick={() => {
          onRename();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata hover:bg-panel-soft transition-colors text-left"
      >
        <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Rename terminal</span>
      </button>

      <button
        type="button"
        onClick={() => {
          onClear();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata hover:bg-panel-soft transition-colors text-left"
      >
        <Eraser className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Clear terminal</span>
      </button>

      <div className="my-1 border-t border-border/60" />

      <button
        type="button"
        onClick={() => {
          onSplit('col');
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata hover:bg-panel-soft transition-colors text-left"
      >
        <Columns className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Split horizontally</span>
      </button>

      <button
        type="button"
        onClick={() => {
          onSplit('row');
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata hover:bg-panel-soft transition-colors text-left"
      >
        <Rows className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Split vertically</span>
      </button>

      <div className="my-1 border-t border-border/60" />

      <button
        type="button"
        onClick={() => {
          onCloseTerminal();
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-metadata text-rose-500 hover:bg-rose-500/10 transition-colors text-left"
      >
        <Trash2 className="h-3.5 w-3.5 text-rose-500" />
        <span>Close terminal</span>
      </button>
    </div>,
    document.body,
  );
}
