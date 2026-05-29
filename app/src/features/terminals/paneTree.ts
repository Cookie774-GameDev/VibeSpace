/**
 * Pane tree data structure for the multi-pane terminal grid.
 *
 * Immutable updates: every mutation returns a fresh tree. Caller stores
 * the tree in component state and serialises shape (not session ids) to
 * `localStorage` between reloads.
 *
 * Cap: max 16 leaves at any time; `splitPane` returns the unchanged tree
 * past the cap.
 */

let nextId = 1;
function generateId(prefix: string): string {
  return `${prefix}_${nextId++}_${Math.random().toString(36).slice(2, 8)}`;
}

export type PaneNode =
  | { kind: 'leaf'; id: string; sessionId?: string | null; command?: string }
  | {
      kind: 'split';
      id: string;
      orientation: 'h' | 'v';
      ratio: number;
      left: PaneNode;
      right: PaneNode;
    };

export const MAX_PANES = 16;

export function newLeaf(seed?: Partial<{ command: string }>): PaneNode {
  return {
    kind: 'leaf',
    id: generateId('leaf'),
    sessionId: null,
    command: seed?.command,
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

export function splitPane(tree: PaneNode, paneId: string, orientation: 'h' | 'v'): PaneNode {
  if (countLeaves(tree) >= MAX_PANES) return tree;

  function recurse(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') {
      if (node.id !== paneId) return node;
      return {
        kind: 'split',
        id: generateId('split'),
        orientation,
        ratio: 0.5,
        left: node,
        right: newLeaf({ command: node.command }),
      };
    }
    return {
      ...node,
      left: recurse(node.left),
      right: recurse(node.right),
    };
  }
  return recurse(tree);
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

export function setRatio(tree: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.1, Math.min(0.9, ratio));
  function recurse(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') return node;
    if (node.id === splitId) return { ...node, ratio: clamped };
    return {
      ...node,
      left: recurse(node.left),
      right: recurse(node.right),
    };
  }
  return recurse(tree);
}

export function updateLeaf(
  tree: PaneNode,
  paneId: string,
  patch: Partial<Extract<PaneNode, { kind: 'leaf' }>>,
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

/** Find the id of the first leaf in a depth-first walk. Used by "+" button. */
export function firstLeafId(tree: PaneNode): string | null {
  if (tree.kind === 'leaf') return tree.id;
  return firstLeafId(tree.left) ?? firstLeafId(tree.right);
}
