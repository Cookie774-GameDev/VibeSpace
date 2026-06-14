import { describe, expect, it } from 'vitest';
import {
  flattenLeaves,
  fromLeaves,
  newLeaf,
  resizeAdjacentTracks,
  resolvePaneTreeChange,
  updateLeaf,
  type PaneNode,
} from './paneTree';

function twoPaneTree(): PaneNode {
  const first = newLeaf({ command: 'powershell.exe', projectId: 'project-a' });
  const second = newLeaf({ command: 'powershell.exe', projectId: 'project-a' });
  return fromLeaves([
    { ...(first as Extract<PaneNode, { kind: 'leaf' }>), id: 'pane-a' },
    { ...(second as Extract<PaneNode, { kind: 'leaf' }>), id: 'pane-b' },
  ]);
}

describe('paneTree change resolution', () => {
  it('merges concurrent async session attach updates against the latest tree', () => {
    let tree = twoPaneTree();

    tree = resolvePaneTreeChange(tree, (current) =>
      updateLeaf(current, 'pane-a', { sessionId: 'session-a' }),
    );
    tree = resolvePaneTreeChange(tree, (current) =>
      updateLeaf(current, 'pane-b', { sessionId: 'session-b' }),
    );

    const leaves = flattenLeaves(tree);
    expect(leaves.find((leaf) => leaf.id === 'pane-a')?.sessionId).toBe('session-a');
    expect(leaves.find((leaf) => leaf.id === 'pane-b')?.sessionId).toBe('session-b');
  });
});

describe('resizeAdjacentTracks', () => {
  it('clamps adjacent resize without changing the total track size', () => {
    const next = resizeAdjacentTracks([1, 1, 1], 0, 5, 3, 0.35);

    expect(next[0]).toBeCloseTo(1.65);
    expect(next[1]).toBeCloseTo(0.35);
    expect(next[2]).toBeCloseTo(1);
    expect(next.reduce((sum, value) => sum + value, 0)).toBeCloseTo(3);
  });
});
