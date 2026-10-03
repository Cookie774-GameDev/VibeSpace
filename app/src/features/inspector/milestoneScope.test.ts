// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { openMilestoneCount, useMilestonesStore } from '@/features/inspector/milestonesStore';
import type { MilestoneItem, MilestoneScope } from '@/features/inspector/types';
import { createScopedMilestonePort, milestoneBelongsToScope } from './milestoneScope';

const scope = { accountId: 'S61-account-A', workspaceId: 'S61-workspace-A', projectId: 'S61-project-A' };
const row = (id: string, binding?: MilestoneScope): MilestoneItem => ({
  id, title: id, kind: 'todo', status: 'done', createdAt: 1, updatedAt: 1,
  ...(binding ? { scope: binding } : {}),
});
const request = { ...scope, requestId: 'canonical-approved-request' };
const fixtures = () => [
  row('own', request),
  row('foreign-account', { ...request, accountId: 'S61-account-B' }),
  row('foreign-workspace', { ...request, workspaceId: 'S61-workspace-B' }),
  row('foreign-project', { ...request, projectId: 'S61-project-B' }),
  row('legacy-unrecorded-owner'),
];
const persistedRows = () => JSON.parse(localStorage.getItem('jarvis-inspector-milestones-v1') ?? '{}').state.items;

describe('scoped milestone port with the real milestone store', () => {
  beforeEach(() => {
    localStorage.clear();
    useMilestonesStore.setState({ items: fixtures() });
  });
  it('selects only the exact account/workspace/project and ignores request identity for visibility', () => {
    const port = createScopedMilestonePort(useMilestonesStore, scope, () => true);
    expect(port.list().map((item) => item.id)).toEqual(['own']);
    expect(milestoneBelongsToScope(row('another-request', { ...request, requestId: 'ui-created' }), scope)).toBe(true);
  });
  it('preserves every legacy row byte-for-byte without assigning the current account during read', () => {
    const before = JSON.stringify(persistedRows());
    createScopedMilestonePort(useMilestonesStore, scope, () => true).list();
    expect(JSON.stringify(persistedRows())).toBe(before);
    expect(useMilestonesStore.getState().items.find((item) => item.id === 'legacy-unrecorded-owner')?.scope).toBeUndefined();
  });
  it('stamps a genuinely new milestone with the exact bound scope and keeps canonical request scopes intact', () => {
    const oldCanonical = JSON.stringify(useMilestonesStore.getState().items[0]);
    const port = createScopedMilestonePort(useMilestonesStore, scope, () => true);
    const id = port.add('S61 new scoped milestone', 'milestone', 'ui-create-unique', 'S61 exact description', 1000);
    expect(persistedRows().find((item: MilestoneItem) => item.id === id)).toMatchObject({
      title: 'S61 new scoped milestone', kind: 'milestone', scope: { ...scope, requestId: 'ui-create-unique' },
    });
    expect(JSON.stringify(useMilestonesStore.getState().items.find((item) => item.id === 'own'))).toBe(oldCanonical);
  });
  it('blocks edits, toggle and removal of each foreign/legacy ID even if called directly', () => {
    const before = JSON.stringify(persistedRows());
    const port = createScopedMilestonePort(useMilestonesStore, scope, () => true);
    for (const item of fixtures().slice(1)) {
      expect(port.update(item.id, { title: 'unauthorized' })).toBe(false);
      expect(port.toggle(item.id)).toBe(false);
      expect(port.remove(item.id)).toBe(false);
    }
    expect(JSON.stringify(persistedRows())).toBe(before);
  });
  it('clears only completed own to-dos and preserves foreign done rows and own long-running milestones', () => {
    const ownMilestone = { ...row('own-milestone', request), kind: 'milestone' as const };
    useMilestonesStore.setState({ items: [...fixtures(), ownMilestone] });
    const protectedRows = useMilestonesStore.getState().items.filter((item) => item.id !== 'own');
    const port = createScopedMilestonePort(useMilestonesStore, scope, () => true);
    expect(port.clearCompletedTodos()).toEqual(['own']);
    expect(persistedRows()).toEqual(protectedRows);
  });
  it('rejects all mutations when the active account/project changes after mounting', () => {
    let active = true;
    const port = createScopedMilestonePort(useMilestonesStore, scope, () => active);
    const before = JSON.stringify(persistedRows());
    active = false;
    expect(port.list()).toEqual([]);
    expect(port.update('own', { title: 'stale edit' })).toBe(false);
    expect(port.toggle('own')).toBe(false);
    expect(port.remove('own')).toBe(false);
    expect(port.clearCompletedTodos()).toEqual([]);
    expect(() => port.add('stale create', 'todo', 'ui-stale')).toThrow();
    expect(JSON.stringify(persistedRows())).toBe(before);
  });
  it('fails closed for missing/empty owner scope and never guesses ownership from a row ID', () => {
    const before = JSON.stringify(persistedRows());
    for (const missing of [null, { ...scope, accountId: '' }, { ...scope, projectId: ' ' }]) {
      const port = createScopedMilestonePort(useMilestonesStore, missing, () => true);
      expect(port.list()).toEqual([]);
      expect(port.toggle('own')).toBe(false);
      expect(() => port.add('invalid scope', 'todo', 'ui-invalid')).toThrow();
    }
    expect(JSON.stringify(persistedRows())).toBe(before);
  });
  it('copies the mounted scope so mutating a caller object cannot adopt a foreign project', () => {
    const caller = { ...scope };
    const port = createScopedMilestonePort(useMilestonesStore, caller, (bound) => bound.projectId === scope.projectId);
    caller.projectId = 'S61-project-B';
    expect(port.list().map((item) => item.id)).toEqual(['own']);
    expect(port.toggle('foreign-project')).toBe(false);
  });
  it('requires an explicit scope for counts rather than exposing the global legacy/foreign aggregate', () => {
    useMilestonesStore.getState().toggleDone('own');
    useMilestonesStore.getState().toggleDone('foreign-account');
    expect(openMilestoneCount()).toBe(0);
    expect(openMilestoneCount(scope)).toBe(1);
  });
});
