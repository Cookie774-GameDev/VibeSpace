import { beforeEach, describe, expect, it } from 'vitest';
import { flattenLeaves, type PaneNode } from './paneTree';
import {
  loadTerminalTreeForProject,
  moveTerminalLeafToProject,
  saveTerminalTree,
  terminalTreeStorageKey,
} from './terminalProjectMove';
import { _resetLiveCacheForTests } from './terminalLiveCache';

function leaf(id: string, sessionId: string | null, projectId?: string | null): PaneNode {
  return {
    kind: 'leaf',
    id,
    sessionId,
    projectId,
    command: 'powershell.exe',
  };
}

describe('terminal project ownership repair', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetLiveCacheForTests();
  });

  it('stamps saved terminal leaves with their owning project id', () => {
    saveTerminalTree('proj_a', leaf('pane_a', 'tty_a'));

    const restored = loadTerminalTreeForProject('proj_a');
    const leaves = flattenLeaves(restored);

    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.id).toBe('pane_a');
    expect(leaves[0]?.sessionId).toBe('tty_a');
    expect(leaves[0]?.projectId).toBe('proj_a');
  });

  it('does not load a terminal leaf saved under the wrong project owner', () => {
    window.localStorage.setItem(
      terminalTreeStorageKey('proj_a'),
      JSON.stringify({
        kind: 'leaf',
        id: 'pane_wrong',
        sessionId: 'tty_wrong',
        projectId: 'proj_b',
        command: 'powershell.exe',
      }),
    );

    const restored = loadTerminalTreeForProject('proj_a');
    const leaves = flattenLeaves(restored);

    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.id).not.toBe('pane_wrong');
    expect(leaves[0]?.sessionId).toBeNull();
    expect(leaves[0]?.projectId).toBe('proj_a');
  });

  it('intentionally moving a terminal updates target ownership', () => {
    saveTerminalTree('proj_a', leaf('pane_a', 'tty_a', 'proj_a'));

    const result = moveTerminalLeafToProject({
      ref: { paneId: 'pane_a', sessionId: 'tty_a', projectId: 'proj_a' },
      sourceProjectId: 'proj_a',
      targetProjectId: 'proj_b',
      targetProjectName: 'Project B',
    });

    expect(result.ok).toBe(true);
    const targetLeaves = flattenLeaves(loadTerminalTreeForProject('proj_b'));
    expect(targetLeaves).toHaveLength(1);
    expect(targetLeaves[0]?.sessionId).toBe('tty_a');
    expect(targetLeaves[0]?.projectId).toBe('proj_b');
  });
});
