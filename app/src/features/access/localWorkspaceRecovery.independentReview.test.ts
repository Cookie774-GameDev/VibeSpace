import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/database';
import { useAuthStore } from '@/stores/auth';
import { revokeLocalAccountReadiness, settleLocalAccountReadiness } from '@/lib/localAccountReadiness';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { previewLocalWorkspaceRecovery, recoverLocalWorkspace } from './localWorkspaceRecovery';

const source = { localUserId: 'usr_independent_review', workspaceId: 'wks_absent_review' as WorkspaceId, projectId: 'prj_orphan_review' as ProjectId };
const key = `local-workspace-recovery:v1:${source.localUserId}`;
const originalOptions = useAuthStore.persist.getOptions();
async function ready() {
  await settleLocalAccountReadiness({ accountId: source.localUserId, persistenceGeneration: 31, teardown: Promise.resolve(), isCurrent: () => true });
}
beforeEach(async () => {
  vi.restoreAllMocks();
  useAuthStore.persist.setOptions(originalOptions);
  localStorage.clear();
  useAuthStore.setState({ ...source, cloudSession: null, displayName: 'Before recovery' });
  await db.open();
  await Promise.all([db.workspaces.clear(), db.projects.clear(), db.settings.clear()]);
  await db.projects.add({ id: source.projectId, workspace_id: source.workspaceId, name: 'Existing orphan', created_at: 1, updated_at: 1 });
  await ready();
});
afterEach(() => { vi.restoreAllMocks(); useAuthStore.persist.setOptions(originalOptions); revokeLocalAccountReadiness(); });

async function leaveDurableReceipt() {
  const preview = await previewLocalWorkspaceRecovery();
  const set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, value) {
    if (k === 'jarvis-auth') throw new Error('review quota');
    set.call(this, k, value);
  });
  await expect(recoverLocalWorkspace(preview)).rejects.toThrow('review quota');
  vi.restoreAllMocks();
  return (await db.settings.get(key))!.value as { source: typeof source; target: typeof source; version: number; createdAt: number };
}

describe('independent recovery negatives', () => {
  it('does not reuse one confirmation twice', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    const [one, two] = await Promise.allSettled([recoverLocalWorkspace(preview), recoverLocalWorkspace(preview)]);
    expect(one.status).toBe('fulfilled');
    expect(two.status).toBe('rejected');
    expect(await db.workspaces.count()).toBe(1);
    expect(await db.projects.count()).toBe(2);
  });
  it('serializes separate confirmations without a second pair', async () => {
    const [one, two] = await Promise.all([previewLocalWorkspaceRecovery(), previewLocalWorkspaceRecovery()]);
    const outcomes = await Promise.allSettled([recoverLocalWorkspace(one), recoverLocalWorkspace(two)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.workspaces.count()).toBe(1);
    expect(await db.projects.count()).toBe(2);
  });
  it('rolls back workspace creation when the project insert fails', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    vi.spyOn(db.projects, 'add').mockRejectedValueOnce(new Error('project insert failed'));
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('project insert failed');
    expect(await db.workspaces.count()).toBe(0);
    expect(await db.projects.count()).toBe(1);
    expect(await db.settings.get(key)).toBeUndefined();
  });
  it('rolls back when readiness is revoked at the final receipt write', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    const add = db.settings.add.bind(db.settings);
    vi.spyOn(db.settings, 'add').mockImplementation((...args) => add(...args).then((result) => { revokeLocalAccountReadiness(); return result; }));
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow();
    expect(await db.workspaces.count()).toBe(0);
    expect(await db.projects.count()).toBe(1);
    expect(await db.settings.get(key)).toBeUndefined();
  });
  it.each(['extra-workspace', 'missing-project', 'crosslinked-project', 'different-owner', 'wrong-receipt-account', 'wrong-receipt-version'] as const)('refuses damaged resume: %s', async (kind) => {
    const receipt = await leaveDurableReceipt();
    if (kind === 'extra-workspace') await db.workspaces.add({ id: 'wks_foreign_review' as WorkspaceId, name: 'Other', owner_id: 'foreign', created_at: 1, updated_at: 1 });
    if (kind === 'missing-project') await db.projects.delete(receipt.target.projectId);
    if (kind === 'crosslinked-project') await db.projects.update(receipt.target.projectId, { workspace_id: source.workspaceId });
    if (kind === 'different-owner') await db.workspaces.update(receipt.target.workspaceId, { owner_id: 'foreign' });
    if (kind === 'wrong-receipt-account') await db.settings.update(key, { value: { ...receipt, target: { ...receipt.target, localUserId: 'foreign' } } });
    if (kind === 'wrong-receipt-version') await db.settings.update(key, { value: { ...receipt, version: 2 } });
    const before = await Promise.all([db.workspaces.toArray(), db.projects.toArray(), db.settings.toArray()]);
    await expect(previewLocalWorkspaceRecovery()).rejects.toThrow();
    expect(await Promise.all([db.workspaces.toArray(), db.projects.toArray(), db.settings.toArray()])).toEqual(before);
    expect(useAuthStore.getState()).toMatchObject(source);
  });
  it.each(['workspace', 'project', 'owner'] as const)('rejects a persisted target with a receipt-mismatched %s', async (field) => {
    const receipt = await leaveDurableReceipt();
    const raw = JSON.parse(localStorage.getItem('jarvis-auth')!);
    Object.assign(raw.state, receipt.target);
    raw.state[field === 'workspace' ? 'workspaceId' : field === 'project' ? 'projectId' : 'localUserId'] = 'different';
    localStorage.setItem('jarvis-auth', JSON.stringify(raw));
    const before = localStorage.getItem('jarvis-auth');
    await expect(previewLocalWorkspaceRecovery()).rejects.toThrow('saved local profile changed');
    expect(localStorage.getItem('jarvis-auth')).toBe(before);
    expect(useAuthStore.getState()).toMatchObject(source);
  });
  it('preserves an atomic receipt for retry after authority changes after commit', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    const transact = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, 'transaction');
    spy.mockImplementation(((...args: unknown[]) => transact(...args).then((result) => {
      if (args[0] === 'rw') {
        useAuthStore.setState({ projectId: 'prj_intervening' as ProjectId });
        useAuthStore.setState(source);
      }
      return result;
    })) as typeof db.transaction);
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('changed');
    spy.mockRestore();
    expect(await db.workspaces.count()).toBe(1);
    expect(await db.projects.count()).toBe(2);
    const receipt = await db.settings.get(key);
    expect(receipt).toBeTruthy();
    expect(useAuthStore.getState()).toMatchObject(source);
    await ready();
    await recoverLocalWorkspace(await previewLocalWorkspaceRecovery());
    expect(await db.settings.get(key)).toEqual(receipt);
    expect(await db.workspaces.count()).toBe(1);
  });
  it('preserves newer preferences written between check and confirmation', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    useAuthStore.getState().setDisplayName('Newer preference');
    await recoverLocalWorkspace(preview);
    expect(useAuthStore.getState().displayName).toBe('Newer preference');
    expect(JSON.parse(localStorage.getItem('jarvis-auth')!).state.displayName).toBe('Newer preference');
  });
});
