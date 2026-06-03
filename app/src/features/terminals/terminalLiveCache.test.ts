/**
 * Unit tests for `terminalLiveCache`.
 *
 * Why these matter — the cache is the only thing standing between
 * "switch project A → B → A and your `opencode` is still running"
 * and "every project switch wipes your terminals". The behaviour
 * needs to be obviously correct so we don't regress quietly.
 *
 * The contract under test (verbatim from the module):
 *   1. captureLiveTree(pid, tree) overwrites whatever was there.
 *   2. getLiveTree(pid) returns the most recent snapshot.
 *   3. Unknown projects return `undefined` (NOT null, NOT a default tree).
 *   4. null and undefined project ids collapse to the same slot.
 *   5. clearLiveTree(pid) removes a single project's entry.
 *   6. _resetLiveCacheForTests() resets everything (test-only).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureLiveTree,
  getLiveTree,
  clearLiveTree,
  _resetLiveCacheForTests,
} from './terminalLiveCache';
import type { PaneNode } from './paneTree';

function makeLeaf(id: string, sessionId?: string): PaneNode {
  return {
    kind: 'leaf',
    id,
    sessionId: sessionId ?? null,
    command: 'powershell',
  };
}

function makeSplit(left: PaneNode, right: PaneNode): PaneNode {
  return {
    kind: 'split',
    id: 'split_root',
    orientation: 'h',
    ratio: 0.5,
    left,
    right,
  };
}

describe('terminalLiveCache', () => {
  beforeEach(() => {
    _resetLiveCacheForTests();
  });

  it('returns undefined for a project that has never been captured', () => {
    expect(getLiveTree('proj_a')).toBeUndefined();
    expect(getLiveTree(null)).toBeUndefined();
  });

  it('round-trips a single tree under its project id', () => {
    const tree = makeLeaf('leaf_1', 'tty_abc123');
    captureLiveTree('proj_a', tree);
    expect(getLiveTree('proj_a')).toBe(tree);
  });

  it('preserves session ids across capture and retrieval', () => {
    // The whole point of the cache: keep `sessionId` alive so
    // <TerminalView> can re-attach instead of spawning a new PTY.
    const tree = makeSplit(
      makeLeaf('a', 'tty_session_one'),
      makeLeaf('b', 'tty_session_two'),
    );
    captureLiveTree('proj_a', tree);
    const restored = getLiveTree('proj_a');
    expect(restored).toBeDefined();
    if (!restored || restored.kind !== 'split') {
      throw new Error('expected split');
    }
    if (restored.left.kind !== 'leaf' || restored.right.kind !== 'leaf') {
      throw new Error('expected leaves under split');
    }
    expect(restored.left.sessionId).toBe('tty_session_one');
    expect(restored.right.sessionId).toBe('tty_session_two');
  });

  it('isolates trees by project id', () => {
    const treeA = makeLeaf('a_only', 'tty_a');
    const treeB = makeLeaf('b_only', 'tty_b');
    captureLiveTree('proj_a', treeA);
    captureLiveTree('proj_b', treeB);
    expect(getLiveTree('proj_a')).toBe(treeA);
    expect(getLiveTree('proj_b')).toBe(treeB);
  });

  it('overwrites the previous snapshot on subsequent captures', () => {
    const v1 = makeLeaf('v1', 'tty_1');
    const v2 = makeLeaf('v2', 'tty_2');
    captureLiveTree('proj_a', v1);
    captureLiveTree('proj_a', v2);
    expect(getLiveTree('proj_a')).toBe(v2);
  });

  it('treats null and undefined project ids as the same slot', () => {
    // Both legitimate states ("no project active") and we don't want
    // them ending up in different keys in the underlying Map.
    const tree = makeLeaf('orphan', 'tty_orphan');
    captureLiveTree(null, tree);
    expect(getLiveTree(undefined)).toBe(tree);
    expect(getLiveTree(null)).toBe(tree);
  });

  it('keeps null-project and a real project separate', () => {
    const orphan = makeLeaf('orphan', 'tty_x');
    const real = makeLeaf('real', 'tty_y');
    captureLiveTree(null, orphan);
    captureLiveTree('proj_a', real);
    expect(getLiveTree(null)).toBe(orphan);
    expect(getLiveTree('proj_a')).toBe(real);
  });

  it('clears only the targeted project', () => {
    captureLiveTree('proj_a', makeLeaf('a'));
    captureLiveTree('proj_b', makeLeaf('b'));
    clearLiveTree('proj_a');
    expect(getLiveTree('proj_a')).toBeUndefined();
    expect(getLiveTree('proj_b')).toBeDefined();
  });

  it('clear is a no-op for an unknown project (does not throw)', () => {
    expect(() => clearLiveTree('never_seen')).not.toThrow();
    expect(getLiveTree('proj_a')).toBeUndefined();
  });

  it('simulates the A → B → A re-attach scenario', () => {
    // The exact bug the user reported: "I open 6-7 terminals, type
    // opencode, switch project, come back, and the opencode commands
    // are gone." With the cache in play the flip should round-trip
    // the same tree object.
    const projA = makeSplit(
      makeLeaf('pane_1', 'tty_opencode_1'),
      makeLeaf('pane_2', 'tty_opencode_2'),
    );
    const projB = makeLeaf('pane_b1', 'tty_b1');

    // User builds project A's terminals.
    captureLiveTree('proj_a', projA);

    // Switches to B; the page builds B's tree; cache writes it.
    captureLiveTree('proj_b', projB);

    // Switches back to A; we look it up before falling back to disk.
    const restored = getLiveTree('proj_a');
    expect(restored).toBe(projA);
    if (!restored || restored.kind !== 'split') {
      throw new Error('expected split');
    }
    if (restored.left.kind !== 'leaf' || restored.right.kind !== 'leaf') {
      throw new Error('expected leaves');
    }
    // Critical: the live session ids survived. The next mount of
    // <TerminalView> with these ids will attach instead of spawning.
    expect(restored.left.sessionId).toBe('tty_opencode_1');
    expect(restored.right.sessionId).toBe('tty_opencode_2');
  });
});
