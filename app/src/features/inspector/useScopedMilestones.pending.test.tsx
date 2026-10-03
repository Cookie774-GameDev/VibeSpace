// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db/database';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useMilestonesStore } from './milestonesStore';
import { useScopedMilestones } from './useScopedMilestones';

const fixture = vi.hoisted(() => ({
  database: undefined as unknown as import('@/lib/db/database').JarvisDexie,
  hold: false,
  heldReads: 0,
  completedHeldReads: 0,
  pending: [] as Array<{ owner: string | undefined; release: () => void }>,
}));
vi.mock('@/stores/auth', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ localUserId: 'S61-pending-account', cloudSession: null,
    workspaceId: 'S61-pending-workspace', projectId: 'S61-pending-project' })) };
});
vi.mock('@/lib/db/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/database')>('@/lib/db/database');
  return { ...actual, get db() { return fixture.database; } };
});
vi.mock('@/lib/db/repositories', () => ({
  workspaceRepo: { getById: async (id: string) => {
    // A real observed Dexie read happens before the intentionally deferred verification.
    const row = await fixture.database.workspaces.get(id as never);
    if (fixture.hold) {
      fixture.heldReads += 1;
      await new Promise<void>((resolve) => fixture.pending.push({ owner: row?.owner_id, release: resolve }));
      fixture.completedHeldReads += 1;
    }
    return row;
  } },
  projectRepo: { getById: (id: string) => fixture.database.projects.get(id as never) },
}));

const accountId = 'S61-pending-account';
const workspaceId = 'S61-pending-workspace';
const projectId = 'S61-pending-project';
const workspace = { id: workspaceId as never, name: 'S61 owned workspace', owner_id: accountId,
  created_at: 1, updated_at: 1 };
const project = { id: projectId as never, name: 'S61 owned project', workspace_id: workspaceId as never,
  created_at: 1, updated_at: 1 };
const own = { id: 'S61-pending-milestone', title: 'S61 exact retained title', kind: 'todo' as const,
  status: 'done' as const, createdAt: 1, updatedAt: 1,
  scope: { accountId, workspaceId, projectId, requestId: 'S61-canonical-request' } };
const bytes = () => localStorage.getItem('jarvis-inspector-milestones-v1');
function releaseAll() {
  fixture.hold = false;
  fixture.pending.splice(0).forEach((pending) => pending.release());
}
const otherDatabases: JarvisDexie[] = [];

beforeEach(async () => {
  fixture.hold = false; fixture.heldReads = 0; fixture.completedHeldReads = 0; fixture.pending = [];
  fixture.database = createJarvisDb(uniqueTestDbName('S61B1-R29-pending'), TEST_INDEXED_DB);
  await fixture.database.open();
  await fixture.database.workspaces.put(workspace);
  await fixture.database.projects.put(project);
  localStorage.clear();
  useMilestonesStore.setState({ items: [own,
    { ...own, id: 'S61-foreign', scope: { ...own.scope, accountId: 'S61-foreign-account' } },
    { id: 'S61-legacy', title: 'S61 unassigned retained', status: 'todo', createdAt: 1, updatedAt: 1 }] });
});
afterEach(async () => {
  releaseAll();
  cleanup();
  await fixture.database.delete();
  for (const database of otherDatabases.splice(0)) await database.delete();
});

function assertMutationDenied(port: ReturnType<typeof useScopedMilestones>, before: string | null) {
  expect(port.addMilestone('S61 rejected creation', 'milestone')).toBeNull();
  expect(port.updateMilestone(own.id, { title: 'S61 rejected edit' })).toBe(false);
  expect(port.toggleDone(own.id)).toBe(false);
  expect(port.removeMilestone(own.id)).toBe(false);
  expect(port.clearCompletedTodos()).toEqual([]);
  expect(bytes()).toBe(before);
}

describe('real Dexie same-tuple owner invalidation and deferred rejoin', () => {
  it.each(['workspace owner changes', 'project moves', 'project is deleted'])
    ('denies every old/current mutation while %s is pending, preserving all stored rows', async (change) => {
      const { result } = renderHook(() => useScopedMilestones());
      await waitFor(() => expect(result.current.ready).toBe(true));
      const previouslyAllowed = result.current;
      const before = bytes();
      fixture.hold = true;
      await act(async () => {
        if (change === 'workspace owner changes')
          await fixture.database.workspaces.update(workspaceId as never, { owner_id: 'S61-foreign-account' });
        else if (change === 'project moves')
          await fixture.database.projects.update(projectId as never, { workspace_id: 'S61-foreign-workspace' as never });
        else await fixture.database.projects.delete(projectId as never);
      });
      await waitFor(() => expect(fixture.heldReads).toBeGreaterThan(0));
      expect(result.current.ready).toBe(false);
      expect(result.current.items).toEqual([]);
      assertMutationDenied(previouslyAllowed, before);
      assertMutationDenied(result.current, before);
      const heldBeforeRelease = fixture.heldReads;
      await act(async () => { releaseAll(); await Promise.resolve(); });
      await waitFor(() => expect(fixture.completedHeldReads).toBe(heldBeforeRelease));
      expect(result.current.ready).toBe(false);
      assertMutationDenied(previouslyAllowed, before);
    });

  it('re-admits a harmless own-workspace rename only after the held fresh join completes', async () => {
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const before = bytes();
    const previouslyAllowed = result.current;
    fixture.hold = true;
    await act(async () => { await fixture.database.workspaces.update(workspaceId as never, { name: 'S61 renamed' }); });
    await waitFor(() => expect(fixture.heldReads).toBeGreaterThan(0));
    expect(result.current.ready).toBe(false);
    assertMutationDenied(previouslyAllowed, before);
    const heldBeforeRelease = fixture.heldReads;
    await act(async () => { releaseAll(); await Promise.resolve(); });
    await waitFor(() => expect(fixture.completedHeldReads).toBe(heldBeforeRelease));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items.map((item) => item.id)).toEqual([own.id]);
    act(() => { expect(result.current.updateMilestone(own.id, { title: 'S61 freshly admitted edit' })).toBe(true); });
    expect(useMilestonesStore.getState().items.find((item) => item.id === own.id)?.title).toBe('S61 freshly admitted edit');
    expect(useMilestonesStore.getState().items.find((item) => item.id === 'S61-legacy')?.scope).toBeUndefined();
  });

  it('cannot resurrect an older allowed result after a newer ownership mutation is still pending', async () => {
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const before = bytes();
    const previouslyAllowed = result.current;
    fixture.hold = true;
    await act(async () => { await fixture.database.workspaces.update(workspaceId as never, { name: 'S61 first rejoin' }); });
    await waitFor(() => expect(fixture.pending.some((pending) => pending.owner === accountId)).toBe(true));
    await act(async () => { await fixture.database.workspaces.update(workspaceId as never, { owner_id: 'S61-foreign-account' }); });
    await waitFor(() => expect(fixture.pending.some((pending) => pending.owner === 'S61-foreign-account')).toBe(true));
    const obsolete = fixture.pending.find((pending) => pending.owner === accountId)!;
    const completedBeforeObsolete = fixture.completedHeldReads;
    await act(async () => { obsolete.release(); await Promise.resolve(); });
    await waitFor(() => expect(fixture.completedHeldReads).toBe(completedBeforeObsolete + 1));
    expect(result.current.ready).toBe(false);
    assertMutationDenied(previouslyAllowed, before);
    const heldBeforeRelease = fixture.heldReads;
    await act(async () => { releaseAll(); await Promise.resolve(); });
    await waitFor(() => expect(fixture.completedHeldReads).toBe(heldBeforeRelease));
    expect(result.current.ready).toBe(false);
    expect(bytes()).toBe(before);
  });

  it('does not revoke authority for a real mutation in a different database namespace', async () => {
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const other = createJarvisDb(uniqueTestDbName('S61B1-R29-other'), TEST_INDEXED_DB);
    otherDatabases.push(other);
    await other.open();
    fixture.hold = true;
    await act(async () => { await other.workspaces.put({ ...workspace, owner_id: 'S61-other-database-owner' }); });
    expect(result.current.ready).toBe(true);
    expect(fixture.heldReads).toBe(0);
    act(() => { expect(result.current.updateMilestone(own.id, { title: 'S61 unchanged authority' })).toBe(true); });
  });
});
