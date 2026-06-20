import { describe, expect, it, vi } from 'vitest';
import { forgetTerminalLeafSessions } from './TerminalsPage';
import { fromLeaves, type PaneNode } from './paneTree';

describe('terminal reset hygiene', () => {
  it('forgets only leaf sessions that are reset', () => {
    const tree = fromLeaves([
      { kind: 'leaf', id: 'pane-a', sessionId: 'session-a' } as Extract<PaneNode, { kind: 'leaf' }>,
      { kind: 'leaf', id: 'pane-b', sessionId: null } as Extract<PaneNode, { kind: 'leaf' }>,
      { kind: 'leaf', id: 'pane-c', sessionId: 'session-c' } as Extract<PaneNode, { kind: 'leaf' }>,
    ]);
    const forget = vi.fn();

    forgetTerminalLeafSessions(tree, forget);

    expect(forget).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenCalledWith('session-a');
    expect(forget).toHaveBeenCalledWith('session-c');
  });
});
