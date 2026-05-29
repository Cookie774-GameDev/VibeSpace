/**
 * TerminalsPage — the `'terminal'` route's body.
 *
 * Owns the pane tree state, persists shape (not session ids) to
 * localStorage so reloads restore the layout without zombie PTYs.
 */

import * as React from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TerminalGrid } from './TerminalGrid';
import {
  type PaneNode,
  newLeaf,
  splitPane,
  countLeaves,
  firstLeafId,
  MAX_PANES,
} from './paneTree';

const STORAGE_KEY = 'jarvis-terminal-pane-tree';

function defaultShell(): string {
  if (typeof navigator === 'undefined') return 'bash';
  const plat = (navigator.platform || '').toLowerCase();
  if (plat.includes('win')) return 'powershell';
  return 'bash';
}

function loadTree(): PaneNode {
  try {
    if (typeof window === 'undefined') return newLeaf({ command: defaultShell() });
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return newLeaf({ command: defaultShell() });
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && (parsed.kind === 'leaf' || parsed.kind === 'split')) {
      return parsed as PaneNode;
    }
  } catch {
    // fall through to fresh tree
  }
  return newLeaf({ command: defaultShell() });
}

export function TerminalsPage() {
  const [tree, setTree] = React.useState<PaneNode>(() => loadTree());

  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
    } catch {
      // localStorage may be full; non-fatal
    }
  }, [tree]);

  const handleChange = (next: PaneNode | null) => {
    setTree(next ?? newLeaf({ command: defaultShell() }));
  };

  const handleAddLeaf = () => {
    const id = firstLeafId(tree);
    if (!id) {
      setTree(newLeaf({ command: defaultShell() }));
      return;
    }
    setTree(splitPane(tree, id, 'h'));
  };

  const handleReset = () => {
    setTree(newLeaf({ command: defaultShell() }));
  };

  const count = countLeaves(tree);
  const atCap = count >= MAX_PANES;

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="shrink-0 px-6 py-4 border-b border-border">
        <p className="eyebrow text-muted-foreground mb-1">
          Multi-pane workspace · Mod+J 'open 4 terminals' works too
        </p>
        <h1 className="font-display text-hero text-foreground">Terminals</h1>
      </header>

      <div className="shrink-0 flex items-center justify-between px-6 py-2 border-b border-border bg-paper-soft">
        <div className="text-metadata text-muted-foreground">
          {count} / {MAX_PANES} pane{count === 1 ? '' : 's'}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddLeaf}
            disabled={atCap}
            className="gap-1"
            title={atCap ? 'Max 16 panes' : 'Add a pane (split first)'}
          >
            <Plus className="h-3.5 w-3.5" /> Add pane
          </Button>
          <Button variant="ghost" size="sm" onClick={handleReset} className="gap-1">
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-3">
        <TerminalGrid tree={tree} onChange={handleChange} defaultCommand={defaultShell()} />
      </div>
    </div>
  );
}
