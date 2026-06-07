/**
 * Pane tree data structure for the multi-pane terminal grid.
 *
 * Tile-grid only as of the Projects update — the splits-mode renderer
 * was retired because every pane now has a draggable cell border
 * (TileGrid handles resizing directly), and the "two ways to do the
 * same thing" toggle was confusing more than it helped. The
 * `kind: 'split'` arm of `PaneNode` is kept for read-back compatibility
 * with persisted trees from older builds (`flattenLeaves` walks them
 * happily) but no UI ever produces a real split anymore.
 *
 * The data lives on each leaf. The renderer reads a flat list of leaves
 * via `flattenLeaves`. Projects own their own pane tree, persisted at
 * `localStorage[`jarvis-terminal-pane-tree:<projectId>`]`.
 *
 * Immutable updates: every mutation returns a fresh tree. Caller stores
 * the tree in component state and serialises shape (not session ids) to
 * `localStorage` between reloads.
 *
 * Cap: max 10 leaves at any time (raised from 6 once cells became
 * resizable). `appendLeaf` returns the unchanged tree past the cap.
 * `gridDimensions` covers up to 16 to leave headroom for future bumps.
 */

let nextId = 1;
function generateId(prefix: string): string {
  return `${prefix}_${nextId++}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Per-leaf metadata. Lives on every leaf in either layout mode.
 *
 * `agentSlug` binds the pane to one of the seeded agents. When an AI
 * request fires for that slug, the runtime injects this pane's system
 * prompt + connected files into the request — see
 * `src/lib/ai/runtime.ts`.
 *
 * `name` is a short label the AI fills in on its first reply when the
 * pane is unnamed. Replaces the raw shell command in the chrome strip
 * (`TileGrid.tsx`) so a 2x2 of "powershell, powershell, powershell,
 * powershell" becomes "auth, db-migrate, lint, scratch".
 *
 * `connectedFiles` is a list of absolute file paths whose content gets
 * read on demand and prepended to the system prompt for any AI request
 * that targets this pane's agent slug. Keeps the model anchored to a
 * specific working set.
 *
 * `fontSize` is cycled by the per-pane toolbar. Lives on the leaf so it
 * survives layout-mode toggles and reloads.
 */
export type LeafBase = {
  /** Stable per-leaf id (survives across re-renders + serialisation). */
  id: string;
  /** Attached PTY session id, if any. Cleared on reload (sessions are not serialised). */
  sessionId?: string | null;
  /** Owning project id. Duplicates the storage-key scope for corruption repair. */
  projectId?: string | null;
  /** Shell or CLI to spawn ('powershell', 'bash', 'claude', 'opencode'…). */
  command?: string;
  /** Command typed into the shell immediately after a fresh pane is ready. */
  startupCommand?: string;
  /** One-shot command to write into an already-mounted terminal. */
  pendingCommand?: string;
  /** Monotonic token so repeated identical commands still dispatch. */
  pendingCommandId?: number;
  /** Optional working directory for the session. */
  cwd?: string;
  /** Agent slug tag for swarm UI. See note above. */
  agentSlug?: string;
  /** Short, AI-given pane label (e.g. "auth-fix"). See note above. */
  name?: string;
  /**
   * Absolute file paths whose content is injected into the AI system
   * prompt for any request targeting this pane's `agentSlug`. Empty
   * when nothing is attached.
   */
  connectedFiles?: string[];
  /** Font size in px. Cycled by the pane toolbar. Defaults to 13 if absent. */
  fontSize?: number;
};

export type PaneNode =
  | ({ kind: 'leaf' } & LeafBase)
  | {
      kind: 'split';
      id: string;
      orientation: 'h' | 'v';
      ratio: number;
      left: PaneNode;
      right: PaneNode;
    };

export type PaneTreeChange = PaneNode | null | ((current: PaneNode) => PaneNode | null);

export const MAX_PANES = 10;

export function newLeaf(seed?: Partial<LeafBase>): PaneNode {
  return {
    kind: 'leaf',
    id: generateId('leaf'),
    sessionId: null,
    projectId: seed?.projectId,
    command: seed?.command,
    startupCommand: seed?.startupCommand,
    pendingCommand: seed?.pendingCommand,
    pendingCommandId: seed?.pendingCommandId,
    cwd: seed?.cwd,
    agentSlug: seed?.agentSlug,
    name: seed?.name,
    connectedFiles: seed?.connectedFiles,
    fontSize: seed?.fontSize,
  };
}

export function countLeaves(tree: PaneNode): number {
  if (tree.kind === 'leaf') return 1;
  return countLeaves(tree.left) + countLeaves(tree.right);
}

export function findPane(tree: PaneNode, paneId: string): PaneNode | null {
  if (tree.id === paneId) return tree;
  if (tree.kind === 'split') {
    return findPane(tree.left, paneId) ?? findPane(tree.right, paneId);
  }
  return null;
}

export function closePane(tree: PaneNode, paneId: string): PaneNode | null {
  function recurse(node: PaneNode): PaneNode | null {
    if (node.kind === 'leaf') {
      return node.id === paneId ? null : node;
    }
    const left = recurse(node.left);
    const right = recurse(node.right);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    return { ...node, left, right };
  }
  return recurse(tree);
}

export function updateLeaf(
  tree: PaneNode,
  paneId: string,
  patch: Partial<LeafBase>,
): PaneNode {
  function recurse(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node;
      return { ...node, ...patch };
    }
    return {
      ...node,
      left: recurse(node.left),
      right: recurse(node.right),
    };
  }
  return recurse(tree);
}

export function resolvePaneTreeChange(
  current: PaneNode,
  change: PaneTreeChange,
  fallbackSeed?: Partial<LeafBase>,
): PaneNode {
  const next = typeof change === 'function' ? change(current) : change;
  return next ?? newLeaf(fallbackSeed);
}

/** Find the id of the first leaf in a depth-first walk. Used by callers
 *  that want a stable "default pane" id (e.g. "drop the reply transcript
 *  in the first leaf" routing). */
export function firstLeafId(tree: PaneNode): string | null {
  if (tree.kind === 'leaf') return tree.id;
  return firstLeafId(tree.left) ?? firstLeafId(tree.right);
}

/* --------------------------------------------------------------------------
 * Tile-grid helpers
 *
 * The tile-grid renderer never sees splits — it works on a flat array of
 * leaves. These helpers keep the leaf data on the same `PaneNode` shape so
 * the user can flip between "Tiles" and "Splits" without losing sessions
 * or agent assignments.
 * -------------------------------------------------------------------------*/

/** Walk the tree depth-first and return every leaf in display order. */
export function flattenLeaves(tree: PaneNode): Extract<PaneNode, { kind: 'leaf' }>[] {
  if (tree.kind === 'leaf') return [tree];
  return [...flattenLeaves(tree.left), ...flattenLeaves(tree.right)];
}

/**
 * Build a flat, leaves-only tree from a list of leaves.
 *
 * If the list has 0 elements we return a single fresh leaf so the
 * page never has nothing to render. With 2+ leaves we synthesise a
 * shallow split tree so the same shape is round-trippable through the
 * existing splits renderer if the user toggles back.
 *
 * The shape is intentionally right-leaning (a "linked-list" of splits):
 * the tile renderer ignores the split nodes entirely; the splits
 * renderer falls back to a uniform layout because every ratio is 0.5.
 */
export function fromLeaves(leaves: Extract<PaneNode, { kind: 'leaf' }>[]): PaneNode {
  if (leaves.length === 0) return newLeaf();
  if (leaves.length === 1) return leaves[0]!;
  const [first, ...rest] = leaves;
  let node: PaneNode = first!;
  for (const leaf of rest) {
    node = {
      kind: 'split',
      id: generateId('split'),
      orientation: 'h',
      ratio: 0.5,
      left: node,
      right: leaf,
    };
  }
  return node;
}

/**
 * Append a fresh leaf (used by the tile-grid "+1" button so the
 * mode toggle doesn't have to think about splits).
 */
export function appendLeaf(tree: PaneNode, seed?: Partial<LeafBase>): PaneNode {
  if (countLeaves(tree) >= MAX_PANES) return tree;
  const leaves = flattenLeaves(tree);
  return fromLeaves([...leaves, { kind: 'leaf', ...newLeafBase(seed) }]);
}

/** Helper that returns just the `LeafBase` for `appendLeaf` to spread. */
function newLeafBase(seed?: Partial<LeafBase>): LeafBase {
  return {
    id: generateId('leaf'),
    sessionId: null,
    projectId: seed?.projectId,
    command: seed?.command,
    startupCommand: seed?.startupCommand,
    pendingCommand: seed?.pendingCommand,
    pendingCommandId: seed?.pendingCommandId,
    cwd: seed?.cwd,
    agentSlug: seed?.agentSlug,
    name: seed?.name,
    connectedFiles: seed?.connectedFiles,
    fontSize: seed?.fontSize,
  };
}

/**
 * Compute (cols, rows) for a uniform CSS grid that holds N tiles.
 *
 * We bias toward roughly-square cells: 1→1×1, 2→2×1, 3→3×1, 4→2×2,
 * 5/6→3×2, 7/8→4×2, 9/10→5×2 (still legible at 1280 wide). The 11+
 * branches stay as no-ops in case `MAX_PANES` ever climbs past 10.
 */
export function gridDimensions(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 8) return { cols: 4, rows: 2 };
  if (n <= 10) return { cols: 5, rows: 2 };
  if (n <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}
