import { expect, it } from 'vitest';
import { createCaoTerminalPaneRegistry } from './terminalPaneControl';
import { newLeaf, fromLeaves, flattenLeaves, type PaneNode } from '@/features/terminals/paneTree';
const liveLeaf = (seed: Parameters<typeof newLeaf>[0], sessionId: string) => ({
  ...newLeaf(seed),
  kind: 'leaf' as const,
  sessionId,
});
it('replaces only the captured manual pane and preserves its siblings', () => {
  const r = createCaoTerminalPaneRegistry();
  const original = liveLeaf({ command: 'opencode', cwd: 'C:\\game', name: 'game' }, 'old');
  const sibling = liveLeaf({ name: 'peer' }, 'peer');
  let tree: PaneNode = fromLeaves([original, sibling]);
  r.register(
    'account',
    'project',
    () => true,
    () => tree,
    (next) => {
      tree = next;
    },
  );
  const handle = r.capture('account', 'project', original.id, 'old');
  handle.replace('new');
  expect(flattenLeaves(tree).map((x) => x.sessionId)).toEqual(['new', 'peer']);
  expect(flattenLeaves(tree)[1]).toBe(sibling);
  expect(() => handle.assert()).toThrow();
});
it('rejects canonical/queued executions and stale project registrations', () => {
  const r = createCaoTerminalPaneRegistry();
  const tree = liveLeaf({ executionId: 'canonical' }, 'old');
  r.register(
    'account',
    'project',
    () => true,
    () => tree,
    () => {},
  );
  expect(() => r.capture('account', 'project', tree.id, 'old')).toThrow(
    'cao_terminal_manual_pane_required',
  );
  const release = r.register(
    'account',
    'project',
    () => false,
    () => liveLeaf({}, 'old'),
    () => {},
  );
  release();
  expect(() => r.capture('account', 'project', tree.id, 'old')).toThrow();
});
