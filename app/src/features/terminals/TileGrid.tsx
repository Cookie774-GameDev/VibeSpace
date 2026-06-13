/**
 * TileGrid — auto-tiled flex layout for the terminals page.
 *
 * Where the legacy `<TerminalGrid>` walks a binary tree of splits with
 * draggable separators, this renderer ignores splits entirely and lays
 * every leaf out as a uniform cell in a 2D flex grid. That matches the
 * "OpenCode 2x2" look the user wanted: equal rectangles, no overflow,
 * no chrome dragging by default.
 *
 * V3.1 — manual resize.
 * The user asked for "let me manually resize the terminals if I want to."
 * Each row and column boundary now has a drag handle. Drag to redistribute
 * fr units between adjacent tracks; double-click to reset that boundary
 * to equal. Sizes persist per project and layout dimension (e.g. "2x2"
 * or "3x2") via localStorage so each project remembers its own terminal
 * ratios across reloads and close/reopen cycles.
 *
 * Sizing comes from `gridDimensions(N)`:
 *   1 → 1x1, 2 → 2x1, 3 → 3x1, 4 → 2x2, 5-6 → 3x2.
 *
 * Each tile gets a thin chrome strip with the agent role pill, the running
 * command label, and the shared `<PaneToolbar>` (font size, clear,
 * fullscreen, close). Splits-mode chrome reuses the same toolbar plus a
 * pair of split-direction buttons.
 *
 * Closing a tile kills the backing PTY before mutating the tree. The
 * earlier behaviour mutated the tree only and relied on `<TerminalView>`
 * unmount cleanup to reach `terminal_kill` — but that cleanup
 * deliberately skips the kill so cross-mode toggles (Tiles ↔ Splits) and
 * fullscreen exits can re-attach to the same PTY. Without an explicit
 * kill on the close path, every dismissed tile leaked one PTY backend-
 * side. The audit's blocker finding.
 *
 * Fullscreen: when `fullscreenPaneId` matches a leaf, TileGrid filters the
 * leaves array down to that one and forces a 1×1 grid. The other panes'
 * `<TerminalView>`s unmount (their PTY sessions stay alive backend-side
 * and re-attach via `existingSessionId` when the user exits fullscreen).
 *
 * State is kept on the same `PaneNode` shape so toggling between
 * "Tiles" and "Splits" preserves PTY sessions, agent assignments, and
 * per-pane font sizes.
 */
import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TerminalView } from './TerminalView';
import { AgentRolePicker } from './AgentRolePicker';
import { ConnectedFilesButton } from './ConnectedFilesButton';
import {
  type PaneNode,
  type PaneTreeChange,
  newLeaf,
  MAX_PANES,
  flattenLeaves,
  fromLeaves,
  updateLeaf,
  closePane,
  gridDimensions,
} from './paneTree';
import {
  PaneToolbar,
  nextFontSize,
} from './PaneToolbar';
import { TerminalContextMenu } from './TerminalContextMenu';
import { clearTerminalSession } from './terminalClear';
import { toast } from '@/components/ui/toast';
import { useTerminalTranscriptStore } from './transcriptStore';
import {
  parseTerminalRef,
  serializeTerminalRef,
  type TerminalRef,
} from './terminalRefs';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';

/** Refit mounted xterms after pane swap or drag — layout may settle one frame late. */
function scheduleTerminalRefit(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('jarvis:terminals:visible'));
    });
  });
}

interface TileGridProps {
  tree: PaneNode;
  onChange: (next: PaneTreeChange) => void;
  defaultCommand?: string;
  /**
   * Called when an agent role is picked on a pane that has no command yet.
   * The page uses this to pre-fill a sensible CLI for the role
   * (Builder → 'claude', Scout → 'opencode', etc.).
   */
  defaultCommandForAgent?: (slug: string) => string | undefined;
  /**
   * When non-null, only the matching leaf is rendered (1×1 grid). The
   * page owns this state so Esc-to-exit and "fullscreen on close auto-
   * clears" stay correctly coordinated with the rest of the workspace
   * (see `TerminalsPage.tsx`). When null, the full tree is rendered.
   */
  fullscreenPaneId?: string | null;
  /** Active project id. Used only to scope persisted resize ratios. */
  projectId?: string | null;
  /** Active project name. */
  projectName?: string | null;
  /**
   * Toggle handler for the fullscreen button in each tile's toolbar.
   * Called with the leaf id; the page decides whether to enter or exit.
   */
  onFullscreenToggle?: (paneId: string) => void;
  /** Move/reorder a dragged terminal ref into a project/grid position. */
  onMoveTerminal?: (
    ref: TerminalRef,
    targetProjectId: string | null,
    targetPaneId?: string | null,
    targetProjectName?: string | null,
  ) => void;
}

const TERMINAL_MIME = 'application/x-jarvis-terminal';
const TERMINAL_PANE_MIME = 'application/x-jarvis-terminal-pane-id';
const DEFAULT_PROJECT_KEY = '__default__';

function encodeDropProjectId(projectId: string | null | undefined): string {
  return projectId ?? DEFAULT_PROJECT_KEY;
}

function decodeDropProjectId(projectId: string | null | undefined): string | null {
  if (!projectId || projectId === DEFAULT_PROJECT_KEY) return null;
  return projectId;
}

function dataTransferHasTerminal(types: DOMStringList | readonly string[]): boolean {
  if (typeof (types as DOMStringList).contains === 'function') {
    const list = types as DOMStringList;
    return list.contains(TERMINAL_MIME) || list.contains(TERMINAL_PANE_MIME);
  }
  return (types as readonly string[]).includes(TERMINAL_MIME) || (types as readonly string[]).includes(TERMINAL_PANE_MIME);
}

/* --------------------------------------------------------------------------
 * Resize sizing — persisted per project and layout dimension.
 *
 * `SavedSizes` maps a layout key (e.g. "2x2", "3x2") to its column +
 * row fractions. We key by dimension (not pane count) so that two
 * different counts that happen to share a layout shape (5 and 6 both →
 * 3x2) share the same resize memory. Sizes are floats in arbitrary fr
 * units — only their ratios matter.
 * -------------------------------------------------------------------------*/

const SIZES_KEY_PREFIX = 'jarvis-tile-grid-sizes-v1';
const LEGACY_SIZES_KEY = 'jarvis-tile-grid-sizes-v1';
/** Minimum fr each track is allowed to shrink to. Keeps a track from disappearing entirely. */
const MIN_FR = 0.28;

interface SavedSizes {
  [layoutKey: string]: { cols: number[]; rows: number[] };
}

function sizesStorageKey(projectId: string | null): string {
  return `${SIZES_KEY_PREFIX}:${projectId ?? '__default__'}`;
}

function parseSavedSizes(raw: string | null): SavedSizes | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as SavedSizes;
  }
  return null;
}

function loadSavedSizes(projectId: string | null): SavedSizes {
  try {
    if (typeof window === 'undefined') return {};
    const key = sizesStorageKey(projectId);
    const scoped = parseSavedSizes(window.localStorage.getItem(key));
    if (scoped) return scoped;

    const legacy = parseSavedSizes(window.localStorage.getItem(LEGACY_SIZES_KEY));
    if (legacy) {
      try {
        window.localStorage.setItem(key, JSON.stringify(legacy));
      } catch {
        /* localStorage may be full; non-fatal */
      }
      return legacy;
    }
  } catch {
    // localStorage may be unavailable or corrupt; fall through to {}
  }
  return {};
}

function persistSavedSizes(projectId: string | null, s: SavedSizes): void {
  try {
    window.localStorage.setItem(sizesStorageKey(projectId), JSON.stringify(s));
  } catch {
    // localStorage may be full; non-fatal — sizes simply won't persist
  }
}

function defaultSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1);
}

function mandatoryFontSize(paneCount: number): number {
  if (paneCount <= 1) return 13;
  if (paneCount <= 2) return 12;
  if (paneCount <= 4) return 11;
  if (paneCount <= 6) return 10;
  return 9;
}

function inferTerminalLabel(command?: string): string {
  const normalized = (command ?? '').trim().toLowerCase();
  if (!normalized) return 'shell';
  if (/\b(opencode|open-code|open code)\b/.test(normalized)) return 'OpenCode';
  if (/\bclaude\b/.test(normalized)) return 'Claude';
  if (/\bcodex\b/.test(normalized)) return 'Codex';
  if (/\b(gemini|google)\b/.test(normalized)) return 'Gemini';
  if (/\bnode\b/.test(normalized) || /\bnpm\b/.test(normalized) || /\bpnpm\b/.test(normalized)) return 'Node';
  if (/\bcargo\b|\brustc\b/.test(normalized)) return 'Rust';
  if (/\bpython\b|\bpy\b/.test(normalized)) return 'Python';
  if (/\bpowershell\b|\bpwsh\b/.test(normalized)) return 'PowerShell';
  if (/\bbash\b|\bzsh\b|\bsh\b/.test(normalized)) return 'Shell';
  return command?.split(/\s+/)[0] || 'shell';
}

export function TileGrid({
  tree,
  onChange,
  defaultCommand,
  defaultCommandForAgent,
  fullscreenPaneId = null,
  projectId = null,
  projectName = null,
  onFullscreenToggle,
  onMoveTerminal,
}: TileGridProps) {
  // Memo so we don't re-flatten on every parent re-render.
  const allLeaves = React.useMemo(() => flattenLeaves(tree), [tree]);

  // Filter when fullscreen so only the chosen pane is mounted (the
  // others' PTYs stay alive backend-side; their xterm instances unmount).
  const leaves = React.useMemo(() => {
    if (!fullscreenPaneId) return allLeaves;
    const focus = allLeaves.find((l) => l.id === fullscreenPaneId);
    return focus ? [focus] : allLeaves;
  }, [allLeaves, fullscreenPaneId]);

  const { cols, rows } = gridDimensions(leaves.length);
  const defaultTerminalFontSize = useUIStore((s) => s.defaultTerminalFontSize);
  const canFullscreen = allLeaves.length > 1;
  const layoutKey = `${cols}x${rows}`;

  /* --------------------------------------------------------------------
   * Resize state.
   *
   * `savedSizes` is the source of truth that survives reloads and
   * grid-dimension changes (e.g. user removes a tile so the layout flips
   * from 2x2 to 3x1; the 2x2 sizes stay in storage and reapply when the
   * user re-adds a tile).
   *
   * `colSizes` / `rowSizes` are the actively-rendered values. Drag
   * handlers mutate them frame-by-frame for smoothness, then write the
   * final values into `savedSizes` on mouseup.
   * -------------------------------------------------------------------*/
  const [savedSizes, setSavedSizes] = React.useState<SavedSizes>(() => loadSavedSizes(projectId));

  const [colSizes, setColSizes] = React.useState<number[]>(() => {
    const s = savedSizes[layoutKey];
    return s && s.cols.length === cols ? [...s.cols] : defaultSizes(cols);
  });
  const [rowSizes, setRowSizes] = React.useState<number[]>(() => {
    const s = savedSizes[layoutKey];
    return s && s.rows.length === rows ? [...s.rows] : defaultSizes(rows);
  });

  // When grid dimensions change (user added or removed tiles), swap the
  // displayed sizes for whatever's saved at the new dimension key (or
  // defaults if nothing is saved). We intentionally don't depend on
  // `savedSizes` here — that would reset the displayed sizes mid-drag.
  React.useEffect(() => {
    const loaded = loadSavedSizes(projectId);
    setSavedSizes(loaded);
    const s = loaded[layoutKey];
    setColSizes(s && s.cols.length === cols ? [...s.cols] : defaultSizes(cols));
    setRowSizes(s && s.rows.length === rows ? [...s.rows] : defaultSizes(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, layoutKey, cols, rows]);

  // Listen for global reset sizes event
  React.useEffect(() => {
    const handleResetEvent = () => {
      const key = sizesStorageKey(projectId);
      try {
        window.localStorage.removeItem(key);
      } catch {}
      setSavedSizes({});
      setColSizes(defaultSizes(cols));
      setRowSizes(defaultSizes(rows));
    };
    window.addEventListener('jarvis:reset-terminal-sizes', handleResetEvent);
    return () => {
      window.removeEventListener('jarvis:reset-terminal-sizes', handleResetEvent);
    };
  }, [projectId, cols, rows]);

  const containerRef = React.useRef<HTMLDivElement>(null);

  /**
   * Generic drag handler for column or row resize.
   *
   * `axis === 'col'` drags horizontally between columns `idx` and `idx+1`;
   * `axis === 'row'` drags vertically between rows `idx` and `idx+1`.
   *
   * We capture the starting fr distribution into a closure so the move
   * handler is purely a function of mouse delta — that avoids the React
   * stale-closure trap and gives buttery-smooth resizing without depending
   * on requestAnimationFrame or special concurrency primitives.
   */
  const startDrag = (
    axis: 'col' | 'row',
    idx: number,
    e: React.MouseEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const totalPx = axis === 'col' ? rect.width : rect.height;
    if (totalPx <= 0) return;

    const startSizes = [...(axis === 'col' ? colSizes : rowSizes)];
    const totalFr = startSizes.reduce((a, b) => a + b, 0);
    const startCoord = axis === 'col' ? e.clientX : e.clientY;
    let latest = startSizes;

    const onMove = (ev: MouseEvent) => {
      const coord = axis === 'col' ? ev.clientX : ev.clientY;
      const dPx = coord - startCoord;
      const dFr = (dPx / totalPx) * totalFr;
      const a = startSizes[idx]! + dFr;
      const b = startSizes[idx + 1]! - dFr;
      // Clamp: if either neighbour would shrink below the minimum, snap
      // to the boundary instead of refusing the move outright. That gives
      // the user predictable behaviour all the way to the limits.
      if (a < MIN_FR || b < MIN_FR) {
        const total = startSizes[idx]! + startSizes[idx + 1]!;
        const clampedA = a < MIN_FR ? MIN_FR : total - MIN_FR;
        const clampedB = total - clampedA;
        const next = [...startSizes];
        next[idx] = clampedA;
        next[idx + 1] = clampedB;
        latest = next;
      } else {
        const next = [...startSizes];
        next[idx] = a;
        next[idx + 1] = b;
        latest = next;
      }
      if (axis === 'col') setColSizes(latest);
      else setRowSizes(latest);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist the post-drag distribution. We pull `cols`/`rows` from
      // the closure (the layoutKey at drag start) so a mid-drag layout
      // change can't write the wrong shape into storage.
      setSavedSizes((prev) => {
        const cur = prev[layoutKey] ?? {
          cols: defaultSizes(cols),
          rows: defaultSizes(rows),
        };
        const next: SavedSizes = {
          ...prev,
          [layoutKey]:
            axis === 'col'
              ? { cols: latest, rows: cur.rows }
              : { cols: cur.cols, rows: latest },
        };
        persistSavedSizes(projectId, next);
        return next;
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  /**
   * Reset a single boundary to even-split between its two neighbours.
   * Called on double-click of the resize handle.
   */
  const resetBoundary = (axis: 'col' | 'row', idx: number) => {
    const sizes = axis === 'col' ? colSizes : rowSizes;
    const total = sizes[idx]! + sizes[idx + 1]!;
    const next = [...sizes];
    next[idx] = total / 2;
    next[idx + 1] = total / 2;
    if (axis === 'col') setColSizes(next);
    else setRowSizes(next);
    setSavedSizes((prev) => {
      const cur = prev[layoutKey] ?? {
        cols: defaultSizes(cols),
        rows: defaultSizes(rows),
      };
      const updated: SavedSizes = {
        ...prev,
        [layoutKey]:
          axis === 'col'
            ? { cols: next, rows: cur.rows }
            : { cols: cur.cols, rows: next },
      };
      persistSavedSizes(projectId, updated);
      return updated;
    });
  };

  const handleClose = (paneId: string) => {
    // Kill the backing PTY (and clear its transcript) before pruning
    // the tree. `<TerminalView>`'s unmount cleanup deliberately skips
    // `terminal_kill` so layout-mode toggles and fullscreen exits can
    // re-attach to the same PTY — but the close path has no future
    // mount waiting, so we kill explicitly here. Without this, every
    // dismissed pane leaked one PTY backend-side until app exit.
    const leaf = allLeaves.find((l) => l.id === paneId);
    const sid = leaf?.sessionId;
    if (sid) {
      invoke('terminal_kill', { sessionId: sid }).catch(() => {
        /* PTY may have already exited; the tree mutation below is the
           authoritative cleanup as far as the UI is concerned. */
      });
      try {
        useTerminalTranscriptStore.getState().forgetSession(sid);
      } catch {
        /* transcript store should never throw, but defend against it */
      }
    }
    onChange((currentTree) => closePane(currentTree, paneId));
  };

  const handleSessionAttach = (paneId: string, sessionId: string) => {
    onChange((currentTree) => updateLeaf(currentTree, paneId, { sessionId }));
  };

  const handlePendingCommandSent = (paneId: string) => {
    onChange((currentTree) =>
      updateLeaf(currentTree, paneId, {
        pendingCommand: undefined,
        pendingCommandId: undefined,
      }),
    );
  };

  const handleAgentChange = (paneId: string, slug: string | null) => {
    // If the pane has no command yet and we're picking an agent that
    // implies a CLI, pre-fill it. We never overwrite a user-set command.
    onChange((currentTree) => {
      const leaf = flattenLeaves(currentTree).find((l) => l.id === paneId);
      let nextCommand = leaf?.command;
      if (slug && !leaf?.command) {
        const suggested = defaultCommandForAgent?.(slug);
        if (suggested) nextCommand = suggested;
      }
      return updateLeaf(currentTree, paneId, {
        agentSlug: slug ?? undefined,
        command: nextCommand,
      });
    });
  };

  const handleFontSizeCycle = (paneId: string) => {
    onChange((currentTree) => {
      const leaf = flattenLeaves(currentTree).find((l) => l.id === paneId);
      if (!leaf) return currentTree;
      const current = leaf.fontSize ?? defaultTerminalFontSize;
      return updateLeaf(currentTree, paneId, {
        fontSize: nextFontSize(current, defaultTerminalFontSize),
      });
    });
  };

  const handleSwapLeaves = (fromId: string, toId: string) => {
    onChange((currentTree) => {
      const currentLeaves = flattenLeaves(currentTree);
      const fromIdx = currentLeaves.findIndex((l) => l.id === fromId);
      const toIdx = currentLeaves.findIndex((l) => l.id === toId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return currentTree;
      const nextLeaves = [...currentLeaves];
      const temp = nextLeaves[fromIdx]!;
      nextLeaves[fromIdx] = nextLeaves[toIdx]!;
      nextLeaves[toIdx] = temp;
      return fromLeaves(nextLeaves);
    });
    scheduleTerminalRefit();
  };

  const handleConnectedFilesChange = (paneId: string, next: string[]) => {
    onChange((currentTree) =>
      updateLeaf(currentTree, paneId, {
        connectedFiles: next.length > 0 ? next : undefined,
      }),
    );
  };

  const renderTile = (
    leaf: typeof allLeaves[number],
    paneCountForTile = leaves.length,
  ) => (
    <Tile
      tree={tree}
      onChange={onChange}
      leaf={leaf}
      defaultCommand={defaultCommand}
      isFullscreen={fullscreenPaneId === leaf.id}
      canFullscreen={canFullscreen}
      onClose={() => handleClose(leaf.id)}
      onAttach={(sid) => handleSessionAttach(leaf.id, sid)}
      onPendingCommandSent={() => handlePendingCommandSent(leaf.id)}
      onAgentChange={(slug) => handleAgentChange(leaf.id, slug)}
      onFontSizeCycle={() => handleFontSizeCycle(leaf.id)}
      onFullscreenToggle={() => onFullscreenToggle?.(leaf.id)}
      onConnectedFilesChange={(next) =>
        handleConnectedFilesChange(leaf.id, next)
      }
      paneCount={paneCountForTile}
      projectId={projectId}
      projectName={projectName}
      onSwap={(fromId) => handleSwapLeaves(fromId, leaf.id)}
      onMoveTerminal={onMoveTerminal}
    />
  );

  // Chunk the flat leaves array into rows so we can lay out as flex of
  // flex-rows. The last row may be short (e.g. N=5 with cols=3 has a row
  // of 2 leaves); we pad with `null` so the column widths line up across
  // rows. The placeholder takes its column's flex value but renders no
  // tile, matching the previous CSS-Grid behaviour where the unused cell
  // simply showed empty space.
  const rowChunks = React.useMemo(() => {
    const out: (typeof leaves[number] | null)[][] = [];
    for (let r = 0; r < rows; r++) {
      const rowLeaves: (typeof leaves[number] | null)[] = [];
      for (let c = 0; c < cols; c++) {
        rowLeaves.push(leaves[r * cols + c] ?? null);
      }
      out.push(rowLeaves);
    }
    return out;
  }, [leaves, cols, rows]);

  const fullscreenLeaf = fullscreenPaneId
    ? allLeaves.find((leaf) => leaf.id === fullscreenPaneId) ?? null
    : null;

  if (fullscreenPaneId && fullscreenLeaf) {
    return (
      <div
        ref={containerRef}
        className="relative flex h-full w-full overflow-hidden"
      >
        {allLeaves.map((leaf) => {
          const active = leaf.id === fullscreenPaneId;
          return (
            <div
              key={leaf.id}
              className={cn(
                active
                  ? 'h-full w-full'
                  : 'pointer-events-none absolute h-px w-px -translate-x-[200vw] overflow-hidden opacity-0',
              )}
              aria-hidden={!active}
            >
              {renderTile(leaf, active ? 1 : allLeaves.length)}
            </div>
          );
        })}
      </div>
    );
  }


  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col overflow-hidden"
    >
      {rowChunks.map((rowLeaves, rowIdx) => {
        // Build the flat list of children for this row: tile, handle,
        // tile, handle, ..., tile. We assemble manually instead of using
        // React.Fragment-with-key so each Tile keeps a stable leaf-id key
        // (which keeps the xterm instance from remounting).
        const rowChildren: React.ReactNode[] = [];
        for (let colIdx = 0; colIdx < cols; colIdx++) {
          const leaf = rowLeaves[colIdx];
          rowChildren.push(
            <div
              key={leaf?.id ?? `__empty_${rowIdx}_${colIdx}`}
              style={{ flex: colSizes[colIdx] ?? 1, minWidth: 0, minHeight: 0 }}
              className="flex p-0.5"
            >
              {leaf ? (
                renderTile(leaf)
              ) : null}
            </div>,
          );
          if (colIdx < cols - 1) {
            rowChildren.push(
              <ResizeHandle
                key={`__hcol_${rowIdx}_${colIdx}`}
                axis="col"
                onMouseDown={(e) => startDrag('col', colIdx, e)}
                onDoubleClick={() => resetBoundary('col', colIdx)}
              />,
            );
          }
        }

        return (
          <React.Fragment key={`row-${rowIdx}`}>
            <div
              style={{ flex: rowSizes[rowIdx] ?? 1, minHeight: 0, minWidth: 0 }}
              className="flex flex-row"
            >
              {rowChildren}
            </div>
            {rowIdx < rows - 1 && (
              <ResizeHandle
                axis="row"
                onMouseDown={(e) => startDrag('row', rowIdx, e)}
                onDoubleClick={() => resetBoundary('row', rowIdx)}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

interface ResizeHandleProps {
  axis: 'col' | 'row';
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}

/**
 * Thin draggable separator between two tracks.
 *
 * Shows a faint hairline at rest; the full strip lights copper on hover
 * so the affordance is discoverable without being noisy. The hit region
 * is the whole 6px-wide strip even though the visible hairline is 1px,
 * so users don't need pixel-perfect aim to start a drag.
 */
function ResizeHandle({ axis, onMouseDown, onDoubleClick }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation={axis === 'col' ? 'vertical' : 'horizontal'}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
      className={cn(
        'group flex shrink-0 select-none items-center justify-center bg-transparent transition-colors',
        axis === 'col'
          ? 'w-1.5 cursor-col-resize hover:bg-accent-copper/20 active:bg-accent-copper/35'
          : 'h-1.5 cursor-row-resize hover:bg-accent-copper/20 active:bg-accent-copper/35',
      )}
    >
      <div
        aria-hidden
        className={cn(
          'transition-colors bg-border/40 group-hover:bg-accent-copper/70 group-active:bg-accent-copper',
          axis === 'col' ? 'h-full w-px' : 'w-full h-px',
        )}
      />
    </div>
  );
}

interface TileProps {
  tree: PaneNode;
  onChange: (next: PaneTreeChange) => void;
  leaf: Extract<PaneNode, { kind: 'leaf' }>;
  defaultCommand?: string;
  isFullscreen: boolean;
  canFullscreen: boolean;
  onClose: () => void;
  onAttach: (sessionId: string) => void;
  onPendingCommandSent: () => void;
  onAgentChange: (slug: string | null) => void;
  onFontSizeCycle: () => void;
  onFullscreenToggle: () => void;
  onConnectedFilesChange: (next: string[]) => void;
  paneCount: number;
  projectId?: string | null;
  projectName?: string | null;
  onSwap: (fromId: string) => void;
  onMoveTerminal?: (
    ref: TerminalRef,
    targetProjectId: string | null,
    targetPaneId?: string | null,
    targetProjectName?: string | null,
  ) => void;
}

function Tile({
  tree,
  onChange,
  leaf,
  defaultCommand,
  isFullscreen,
  canFullscreen,
  onClose,
  onAttach,
  onPendingCommandSent,
  onAgentChange,
  onFontSizeCycle,
  onFullscreenToggle,
  onConnectedFilesChange,
  paneCount,
  projectId,
  projectName,
  onSwap,
  onMoveTerminal,
}: TileProps) {
  const [isFocused, setIsFocused] = React.useState(false);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [contextMenu, setContextMenu] = React.useState<{ x: number; y: number } | null>(null);
  const [isEditingName, setIsEditingName] = React.useState(false);
  const [editNameValue, setEditNameValue] = React.useState('');

  const handleAskJarvis = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:terminal:attach', {
        detail: { ref: terminalRef, raw: serializedRef },
      }),
    );
  };

  const handleCopyOutput = () => {
    const sid = leaf.sessionId;
    const text = sid ? useTerminalTranscriptStore.getState().sessions[sid]?.text : '';
    if (text) {
      navigator.clipboard.writeText(text)
        .then(() => toast.success('Copied output', 'Terminal transcript copied to clipboard.'))
        .catch(() => toast.error('Copy failed', 'Failed to copy transcript to clipboard.'));
    } else {
      toast.info('No output', 'There is no captured transcript for this session yet.');
    }
  };

  const handleRename = () => {
    setEditNameValue(leaf.name || '');
    setIsEditingName(true);
  };

  const handleClear = () => {
    const sid = leaf.sessionId;
    if (!sid) return;
    clearTerminalSession(sid, leaf.id);
  };

  const handleSplit = (direction: 'col' | 'row') => {
    onChange((currentTree) => {
      const allLeaves = flattenLeaves(currentTree);
      if (allLeaves.length >= MAX_PANES) {
        toast.warning('Cannot split', `Maximum of ${MAX_PANES} terminals reached.`);
        return currentTree;
      }
      const currentLeaf = allLeaves.find((l) => l.id === leaf.id);
      const idx = currentLeaf ? allLeaves.indexOf(currentLeaf) : -1;
      if (idx === -1 || !currentLeaf) return currentTree;
      const nextLeaves = [...allLeaves];
      const spawnedLeaf = newLeaf({
        command: currentLeaf.command || defaultCommand,
        agentSlug: currentLeaf.agentSlug,
        fontSize: currentLeaf.fontSize,
        projectId: currentLeaf.projectId ?? projectId ?? null,
      }) as Extract<PaneNode, { kind: 'leaf' }>;

      nextLeaves.splice(idx + 1, 0, spawnedLeaf);
      return fromLeaves(nextLeaves);
    });
  };
  const globalDefaultFontSize = useUIStore((s) => s.defaultTerminalFontSize);
  const fontSize = leaf.fontSize ?? globalDefaultFontSize;
  // Display label priority: user/AI-given pane name > inferred command label > shell fallback.
  // The Memory Keeper / first-reply auto-namer fills `leaf.name` after the
  // first turn so a "powershell, powershell, powershell" grid promotes
  // itself to "auth-fix · db-migrate · scratch" over time.
  const displayLabel = leaf.name || inferTerminalLabel(leaf.startupCommand || leaf.command || defaultCommand);
  const labelHasName = !!leaf.name;
  const terminalRef = React.useMemo<TerminalRef>(() => ({
    paneId: leaf.id,
    sessionId: leaf.sessionId ?? undefined,
    projectId,
    label: displayLabel,
    command: leaf.startupCommand || leaf.command || defaultCommand,
    agentSlug: leaf.agentSlug ?? null,
  }), [
    defaultCommand,
    displayLabel,
    leaf.agentSlug,
    leaf.command,
    leaf.id,
    leaf.sessionId,
    leaf.startupCommand,
    projectId,
  ]);
  const serializedRef = React.useMemo(
    () => serializeTerminalRef(terminalRef),
    [terminalRef],
  );

  const finishTerminalDrop = React.useCallback(
    (dropTarget: HTMLElement | null) => {
      const kind = dropTarget?.dataset.terminalDrop;
      if (!kind) return;

      if (kind === 'chat') {
        const targetChatId = dropTarget.dataset.terminalDropChatId;
        window.dispatchEvent(
          new CustomEvent('jarvis:terminal:attach', {
            detail: { ref: terminalRef, raw: serializedRef, chatId: targetChatId },
          }),
        );
        return;
      }

      if (!onMoveTerminal) return;

      const targetProjectId = decodeDropProjectId(
        dropTarget.dataset.terminalDropProjectId,
      );
      const targetProjectName = dropTarget.dataset.terminalDropProjectName ?? null;

      if (kind === 'project') {
        onMoveTerminal(terminalRef, targetProjectId, null, targetProjectName);
        return;
      }

      if (kind === 'pane') {
        const targetPaneId = dropTarget.dataset.terminalDropPaneId;
        if (!targetPaneId) return;
        if (targetPaneId === leaf.id && targetProjectId === (projectId ?? null)) return;
        const sourceProjectId = terminalRef.projectId ?? projectId ?? null;
        if (targetProjectId === sourceProjectId) {
          onSwap(targetPaneId);
          return;
        }
        onMoveTerminal(terminalRef, targetProjectId, targetPaneId, targetProjectName);
      }
    },
    [leaf.id, onMoveTerminal, onSwap, projectId, serializedRef, terminalRef],
  );

  const startRightButtonDrag = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      let latestX = startX;
      let latestY = startY;
      let dragging = false;
      let frame = 0;
      let preview: HTMLDivElement | null = null;
      let hoverTarget: HTMLElement | null = null;
      let hoverProjectTimer: ReturnType<typeof setTimeout> | null = null;
      let cancelled = false;
      let suppressNativeMenuUntil = 0;

      const clearProjectHoverTimer = () => {
        if (hoverProjectTimer) clearTimeout(hoverProjectTimer);
        hoverProjectTimer = null;
      };

      const clearHoverTarget = () => {
        hoverTarget?.classList.remove('jarvis-terminal-drop-hover');
        hoverTarget = null;
        clearProjectHoverTimer();
      };

      const findDropTarget = () => {
        const el = document.elementFromPoint(latestX, latestY) as HTMLElement | null;
        return el?.closest('[data-terminal-drop]') as HTMLElement | null;
      };

      const armProjectHover = (target: HTMLElement) => {
        clearProjectHoverTimer();
        if (target.dataset.terminalDrop !== 'project') return;
        const targetProjectId = decodeDropProjectId(target.dataset.terminalDropProjectId);
        if (targetProjectId === (projectId ?? null)) return;
        hoverProjectTimer = setTimeout(() => {
          useAuthStore.getState().setProjectId(targetProjectId as never);
          useUIStore.getState().setRoute('terminal');
        }, 450);
      };

      const setHoverTarget = (target: HTMLElement | null) => {
        if (target === hoverTarget) return;
        clearHoverTarget();
        hoverTarget = target;
        if (!hoverTarget) return;
        hoverTarget.classList.add('jarvis-terminal-drop-hover');
        armProjectHover(hoverTarget);
      };

      const ensurePreview = () => {
        if (preview) return;
        preview = document.createElement('div');
        preview.className = 'jarvis-terminal-drag-preview';
        preview.textContent = `Move terminal · ${displayLabel}`;
        document.body.appendChild(preview);
        document.body.classList.add('jarvis-terminal-right-dragging');
      };

      const updatePreview = () => {
        frame = 0;
        if (!preview) return;
        preview.style.transform = `translate3d(${latestX + 14}px, ${latestY + 14}px, 0)`;
      };

      const requestPreviewUpdate = () => {
        if (frame) return;
        frame = requestAnimationFrame(updatePreview);
      };

      const cleanup = (refit = false) => {
        if (frame) cancelAnimationFrame(frame);
        clearHoverTarget();
        preview?.remove();
        preview = null;
        setIsDragging(false);
        document.body.classList.remove('jarvis-terminal-right-dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('keydown', onKeyDown, true);
        const delay = Math.max(0, suppressNativeMenuUntil - Date.now()) + 50;
        window.setTimeout(() => {
          document.removeEventListener('contextmenu', onContextMenu, true);
        }, delay);
        if (refit) scheduleTerminalRefit();
      };

      const onContextMenu = (ev: MouseEvent) => {
        ev.preventDefault();
      };

      const onMove = (ev: PointerEvent) => {
        latestX = ev.clientX;
        latestY = ev.clientY;
        if ((ev.buttons & 2) === 0) {
          onUp(ev);
          return;
        }
        const moved = Math.hypot(latestX - startX, latestY - startY);
        if (!dragging && moved < 6) return;
        dragging = true;
        setIsDragging(true);
        ev.preventDefault();
        ensurePreview();
        requestPreviewUpdate();
        setHoverTarget(findDropTarget());
      };

      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        cancelled = true;
        ev.preventDefault();
        cleanup(dragging);
      };

      const onUp = (ev: PointerEvent) => {
        latestX = ev.clientX;
        latestY = ev.clientY;
        const target = dragging ? findDropTarget() : null;
        const didDrag = dragging;
        if (dragging || ev.button === 2) {
          suppressNativeMenuUntil = Date.now() + 900;
          document.body.dataset.jarvisSuppressContextMenuUntil = String(suppressNativeMenuUntil);
        }
        cleanup(didDrag);
        if (cancelled) return;
        ev.preventDefault();
        if (dragging) {
          finishTerminalDrop(target);
        } else {
          setContextMenu({
            x: ev.clientX,
            y: ev.clientY,
          });
        }
      };

      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', onUp);
      document.addEventListener('keydown', onKeyDown, true);
    },
    [displayLabel, finishTerminalDrop, projectId, leaf, tree, onChange, defaultCommand],
  );

  return (
    <div className={cn(
      "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-panel shadow-soft transition-[border-color,box-shadow,outline-color] duration-300",
      isFocused ? "animate-terminal-focus border-accent-copper/80 ring-2 ring-accent-copper/30" : "border-border",
      isDragOver && "jarvis-terminal-drop-hover border-accent-copper border-2 shadow-lg ring-4 ring-accent-copper/40",
      isDragging && "pointer-events-none opacity-0"
    )}
      data-terminal-drop="pane"
      data-terminal-drop-pane-id={leaf.id}
      data-terminal-drop-project-id={encodeDropProjectId(projectId)}
      data-terminal-drop-project-name={projectName ?? undefined}
      draggable={true}
      onPointerDown={startRightButtonDrag}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => {
        setIsDragging(true);
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(TERMINAL_MIME, serializedRef);
        e.dataTransfer.setData(TERMINAL_PANE_MIME, leaf.id);
        e.dataTransfer.setData('text/plain', `terminal:${displayLabel}`);
        // Avoid the browser snapshotting the xterm canvas as the drag ghost.
        const ghost = document.createElement('div');
        ghost.className = 'jarvis-terminal-drag-preview';
        ghost.textContent = `Move terminal · ${displayLabel}`;
        ghost.style.transform = 'translate(-9999px, -9999px)';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 14, 14);
        window.setTimeout(() => ghost.remove(), 0);
      }}
      onDragEnd={() => {
        setIsDragging(false);
        setIsDragOver(false);
        scheduleTerminalRefit();
      }}
      onDragOver={(e) => {
        if (dataTransferHasTerminal(e.dataTransfer.types)) {
          e.preventDefault();
        }
      }}
      onDragEnter={(e) => {
        if (dataTransferHasTerminal(e.dataTransfer.types)) {
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => {
        setIsDragOver(false);
      }}
      onDrop={(e) => {
        const rawRef = e.dataTransfer.getData(TERMINAL_MIME);
        const droppedRef = rawRef ? parseTerminalRef(rawRef) : null;
        const fromId = e.dataTransfer.getData(TERMINAL_PANE_MIME);
        setIsDragOver(false);
        if (droppedRef && onMoveTerminal) {
          e.preventDefault();
          e.stopPropagation();
          const sourceProjectId = droppedRef.projectId ?? projectId ?? null;
          const targetProjectId = projectId ?? null;
          if (sourceProjectId === targetProjectId) {
            const sourcePaneId = droppedRef.paneId ?? fromId;
            if (sourcePaneId && sourcePaneId !== leaf.id) onSwap(sourcePaneId);
          } else {
            onMoveTerminal(droppedRef, targetProjectId, leaf.id, projectName ?? null);
          }
          return;
        }
        if (fromId && fromId !== leaf.id) {
          e.preventDefault();
          e.stopPropagation();
          onSwap(fromId);
        }
      }}
      title="Right-drag to move, drop into chat, or move to a project"
    >
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-paper-soft px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <AgentRolePicker
            agentSlug={leaf.agentSlug ?? null}
            onChange={onAgentChange}
          />
          {isEditingName ? (
            <input
              type="text"
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              onBlur={() => {
                setIsEditingName(false);
                onChange((currentTree) =>
                  updateLeaf(currentTree, leaf.id, { name: editNameValue.trim() || undefined }),
                );
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setIsEditingName(false);
                  onChange((currentTree) =>
                    updateLeaf(currentTree, leaf.id, { name: editNameValue.trim() || undefined }),
                  );
                } else if (e.key === 'Escape') {
                  setIsEditingName(false);
                }
              }}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              className="h-5 min-w-0 flex-1 rounded border border-accent-copper/60 bg-paper px-1 font-display text-metadata text-foreground outline-none focus:ring-1 focus:ring-accent-copper/50"
            />
          ) : (
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-metadata cursor-text select-text',
                labelHasName
                  ? 'font-display text-foreground'
                  : 'font-mono text-muted-foreground',
                !labelHasName && leaf.command && 'text-foreground',
              )}
              title={
                labelHasName && leaf.command
                  ? `${leaf.name}  ·  ${leaf.startupCommand || leaf.command || ''}`
                  : displayLabel
              }
              onDoubleClick={handleRename}
            >
              {displayLabel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <ConnectedFilesButton
            files={leaf.connectedFiles ?? []}
            onChange={onConnectedFilesChange}
          />
          <PaneToolbar
            sessionId={leaf.sessionId}
            paneId={leaf.id}
            fontSize={fontSize}
            isFullscreen={isFullscreen}
            canFullscreen={canFullscreen}
            onFontSizeCycle={onFontSizeCycle}
            onFullscreenToggle={onFullscreenToggle}
            onClose={onClose}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView
          sessionId={leaf.sessionId ?? null}
          paneId={leaf.id}
          command={leaf.command || defaultCommand}
          startupCommand={leaf.startupCommand}
          pendingCommand={leaf.pendingCommand}
          pendingCommandId={leaf.pendingCommandId}
          cwd={leaf.cwd}
          fontSize={fontSize}
          agentSlug={leaf.agentSlug ?? null}
          onReady={onAttach}
          onPendingCommandSent={onPendingCommandSent}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          projectId={projectId}
          projectName={projectName}
          // The tile already provides a frame + chrome strip, so we ask
          // TerminalView to skip its own border/title row to avoid the
          // double-bordered look.
          hideChrome
          className="h-full w-full"
        />
      </div>
      {contextMenu && (
        <TerminalContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAskJarvis={handleAskJarvis}
          onCopyOutput={handleCopyOutput}
          onRename={handleRename}
          onClear={handleClear}
          onSplit={handleSplit}
          onCloseTerminal={onClose}
        />
      )}
    </div>
  );
}

/**
 * Helper exported for the page-level "Reset" button: collapse the tree
 * to a single fresh leaf so a `Reset` always lands the user back at 1×1.
 */
export function resetToSingleLeaf(seedCommand?: string): PaneNode {
  return fromLeaves([
    {
      kind: 'leaf',
      id: `leaf_reset_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: null,
      command: seedCommand,
    },
  ]);
}
