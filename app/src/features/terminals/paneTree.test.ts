import { describe, expect, it } from 'vitest';
import {
  flattenLeaves,
  fromLeaves,
  newLeaf,
  resolvePaneAgentMode,
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
  it('stores agent mode on leaves and preserves it through flat tree rebuilding', () => {
    const first = newLeaf({ agentSlug: 'coder', agentMode: 'coordinated' });
    const second = newLeaf({ agentSlug: 'critic', agentMode: 'no-context' });
    const tree = fromLeaves([
      first as Extract<PaneNode, { kind: 'leaf' }>,
      second as Extract<PaneNode, { kind: 'leaf' }>,
    ]);

    const leaves = flattenLeaves(tree);
    expect(leaves[0]?.agentMode).toBe('coordinated');
    expect(leaves[1]?.agentMode).toBe('no-context');
  });

  it('updates agent mode without clearing the selected agent slug', () => {
    const leaf = newLeaf({ agentSlug: 'coder', agentMode: 'default' }) as Extract<PaneNode, { kind: 'leaf' }>;
    const tree = updateLeaf(leaf, leaf.id, { agentMode: 'no-context' });

    const updated = flattenLeaves(tree)[0];
    expect(updated?.agentSlug).toBe('coder');
    expect(updated?.agentMode).toBe('no-context');
  });

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

describe('resolvePaneAgentMode', () => {
  it('returns undefined for plain shell panes', () => {
    expect(resolvePaneAgentMode({})).toBeUndefined();
    expect(resolvePaneAgentMode({ agentMode: 'coordinated' })).toBeUndefined();
  });

  it('preserves no-context without a slug', () => {
    expect(resolvePaneAgentMode({ agentMode: 'no-context' })).toBe('no-context');
  });

  it('defaults named agents to default mode', () => {
    expect(resolvePaneAgentMode({ agentSlug: 'coder' })).toBe('default');
    expect(resolvePaneAgentMode({ agentSlug: 'coder', agentMode: 'coordinated' })).toBe(
      'coordinated',
    );
  });
});
