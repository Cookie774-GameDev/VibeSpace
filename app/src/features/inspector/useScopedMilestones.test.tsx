// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { useMilestonesStore } from './milestonesStore';
import { captureMilestoneScopeRead, useScopedMilestoneDraft, useScopedMilestones, verifyMilestoneOwnerScope } from './useScopedMilestones';

const fixture = vi.hoisted(() => ({ workspace: vi.fn(), project: vi.fn() }));
vi.mock('@/stores/auth', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ localUserId: 'S61-account-A', cloudSession: null,
    workspaceId: 'S61-workspace-A', projectId: 'S61-project-A' })) };
});
vi.mock('@/lib/db/repositories', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/repositories')>('@/lib/db/repositories');
  return { ...actual, workspaceRepo: { ...actual.workspaceRepo, getById: fixture.workspace },
    projectRepo: { ...actual.projectRepo, getById: fixture.project } };
});
const scope = { accountId: 'S61-account-A', workspaceId: 'S61-workspace-A', projectId: 'S61-project-A' };
const workspace = { id: scope.workspaceId, owner_id: scope.accountId };
const project = { id: scope.projectId, workspace_id: scope.workspaceId };
const setProject = (projectId: string) => useAuthStore.setState({ projectId: projectId as never });
const item = (id: string, projectId = scope.projectId) => ({ id, title: id, kind: 'milestone' as const,
  status: 'todo' as const, createdAt: 1, updatedAt: 1,
  scope: { ...scope, projectId, requestId: `request:${id}` } });

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ localUserId: scope.accountId, cloudSession: null,
    workspaceId: scope.workspaceId as never, projectId: scope.projectId as never });
  useMilestonesStore.setState({ items: [item('own-A'), item('foreign-B', 'S61-project-B'),
    { id: 'legacy', title: 'legacy', kind: 'milestone', status: 'todo', createdAt: 1, updatedAt: 1 }] });
  fixture.workspace.mockReset().mockResolvedValue(workspace);
  fixture.project.mockReset().mockImplementation(async (id) => ({ ...project, id }));
});
afterEach(cleanup);

describe('milestone owner admission with actual identity resolver and UI hook', () => {
  it('requires the exact workspace owner and project/workspace join before exposing rows', async () => {
    expect(await verifyMilestoneOwnerScope(scope)).toBe(true);
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items.map((row) => row.id)).toEqual(['own-A']);
    expect(useMilestonesStore.getState().items).toHaveLength(3);
  });
  it.each([
    ['workspace owner', { ...workspace, owner_id: 'S61-foreign-account' }, project],
    ['workspace identity', { ...workspace, id: 'S61-other-workspace' }, project],
    ['project parent', workspace, { ...project, workspace_id: 'S61-other-workspace' }],
    ['project identity', workspace, { ...project, id: 'S61-other-project' }],
  ])('rejects a mismatched %s without adopting or deleting legacy rows', async (_name, ws, pj) => {
    fixture.workspace.mockResolvedValue(ws);
    fixture.project.mockResolvedValue(pj);
    const before = JSON.stringify(useMilestonesStore.getState().items);
    expect(await verifyMilestoneOwnerScope(scope)).toBe(false);
    expect(JSON.stringify(useMilestonesStore.getState().items)).toBe(before);
  });
  it('denies missing scope without repository reads', async () => {
    expect(await verifyMilestoneOwnerScope(null)).toBe(false);
    expect(fixture.workspace).not.toHaveBeenCalled();
    expect(fixture.project).not.toHaveBeenCalled();
  });
  it('fails closed on a repository read error', async () => {
    fixture.workspace.mockRejectedValue(new Error('S61 injected read failure'));
    expect(await verifyMilestoneOwnerScope(scope)).toBe(false);
  });
  it('keeps an old A update callback from changing a row after switching to B', async () => {
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const previous = result.current;
    act(() => setProject('S61-project-B'));
    await waitFor(() => expect(result.current.items.map((row) => row.id)).toEqual(['foreign-B']));
    expect(previous.updateMilestone('own-A', { title: 'stale edit' })).toBe(false);
    expect(useMilestonesStore.getState().items.find((row) => row.id === 'own-A')?.title).toBe('own-A');
  });
  it('keeps old A callbacks stale after a batched A -> B -> A transition', async () => {
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const previous = result.current;
    act(() => { setProject('S61-project-B'); setProject(scope.projectId); });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(previous.toggleDone('own-A')).toBe(false);
    expect(useMilestonesStore.getState().items.find((row) => row.id === 'own-A')?.status).toBe('todo');
  });
  it('ignores a delayed A join result after B becomes current', async () => {
    let resolveA!: (value: unknown) => void;
    fixture.workspace.mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }));
    const { result } = renderHook(() => useScopedMilestones());
    await waitFor(() => expect(fixture.workspace).toHaveBeenCalled());
    act(() => setProject('S61-project-B'));
    await waitFor(() => expect(result.current.items.map((row) => row.id)).toEqual(['foreign-B']));
    await act(async () => { resolveA(workspace); await Promise.resolve(); });
    expect(result.current.items.map((row) => row.id)).toEqual(['foreign-B']);
  });
  it('retains drafts by account/project and never displays an A draft in B', () => {
    const { result, rerender } = renderHook(({ key }) => useScopedMilestoneDraft(key),
      { initialProps: { key: 'scope-A' } });
    act(() => result.current[1]('S61 draft A'));
    rerender({ key: 'scope-B' });
    expect(result.current[0]).toBe('');
    act(() => result.current[1]('S61 draft B'));
    rerender({ key: 'scope-A' });
    expect(result.current[0]).toBe('S61 draft A');
  });
  it('invalidates an async aggregate scope read after ABA and releases its subscription', () => {
    const lease = captureMilestoneScopeRead();
    setProject('S61-project-B'); setProject(scope.projectId);
    expect(lease.isCurrent()).toBe(false);
    lease.dispose();
  });
});
