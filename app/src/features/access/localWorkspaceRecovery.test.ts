import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/database';
import { useAuthStore } from '@/stores/auth';
import {
  revokeLocalAccountReadiness,
  settleLocalAccountReadiness,
} from '@/lib/localAccountReadiness';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { previewLocalWorkspaceRecovery, recoverLocalWorkspace } from './localWorkspaceRecovery';
const source = {
  localUserId: 'usr_local_recovery_test',
  workspaceId: 'wks_missing' as WorkspaceId,
  projectId: 'prj_orphan' as ProjectId,
};
const receiptKey = `local-workspace-recovery:v1:${source.localUserId}`;
const ready = () =>
  settleLocalAccountReadiness({
    accountId: source.localUserId,
    persistenceGeneration: 1,
    teardown: Promise.resolve(),
    isCurrent: () => true,
  });
beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAuthStore.setState({ ...source, cloudSession: null });
  await db.open();
  await Promise.all([
    db.workspaces.clear(),
    db.projects.clear(),
    db.settings.clear(),
    db.chats.clear(),
    db.prompt_forge_jobs.clear(),
  ]);
  await db.projects.add({
    id: source.projectId,
    workspace_id: source.workspaceId,
    name: 'Orphan preserved',
    created_at: 1,
    updated_at: 2,
  });
  await ready();
});
afterEach(() => {
  vi.restoreAllMocks();
  revokeLocalAccountReadiness();
});
describe('explicit local workspace recovery', () => {
  it('only previews, then atomically creates fresh IDs with the current owner and preserves orphans', async () => {
    const chat = { id: 'cht_preserved', project_id: source.projectId, title: 'Private history' };
    const job = {
      id: 'job_preserved',
      project_id: source.projectId,
      state: 'pending',
      content: 'Preserve',
    };
    await db.table('chats').put(chat);
    await db.table('prompt_forge_jobs').put(job);
    const before = await db.projects.toArray();
    const preview = await previewLocalWorkspaceRecovery();
    expect(preview.kind).toBe('create');
    expect(await db.workspaces.count()).toBe(0);
    expect(await db.settings.get(receiptKey)).toBeUndefined();
    await recoverLocalWorkspace(preview);
    const auth = useAuthStore.getState();
    expect(auth.localUserId).toBe(source.localUserId);
    expect(auth.workspaceId).not.toBe(source.workspaceId);
    expect(auth.projectId).not.toBe(source.projectId);
    expect(await db.workspaces.get(auth.workspaceId!)).toMatchObject({
      owner_id: source.localUserId,
      name: 'Personal',
    });
    expect(await db.projects.get(source.projectId)).toEqual(before[0]);
    expect(await db.table('chats').get(chat.id)).toEqual(chat);
    expect(await db.table('prompt_forge_jobs').get(job.id)).toEqual(job);
    expect(await db.projects.get(auth.projectId!)).toMatchObject({
      workspace_id: auth.workspaceId,
      name: 'Inbox',
    });
    expect((await db.settings.get(receiptKey))?.value).toMatchObject({
      version: 1,
      source,
      target: {
        localUserId: source.localUserId,
        workspaceId: auth.workspaceId,
        projectId: auth.projectId,
      },
    });
  });
  it.each(['same', 'foreign'])('requires zero TOTAL workspace rows (%s owner)', async (owner) => {
    await db.workspaces.add({
      id: 'wks_existing' as WorkspaceId,
      owner_id: owner === 'same' ? source.localUserId : 'another-owner',
      name: 'Preserved',
      created_at: 1,
      updated_at: 1,
    });
    await expect(previewLocalWorkspaceRecovery()).rejects.toThrow('already exists');
    expect(await db.projects.count()).toBe(1);
  });
  it.each(['cloud', 'missing-user', 'missing-project', 'unsettled'])(
    'fails closed for %s authority',
    async (state) => {
      if (state === 'cloud')
        useAuthStore.setState({ cloudSession: { user_id: 'cloud', email: '', expires_at: 1 } });
      if (state === 'missing-user') useAuthStore.setState({ localUserId: null });
      if (state === 'missing-project') useAuthStore.setState({ projectId: null });
      if (state === 'unsettled') revokeLocalAccountReadiness();
      await expect(previewLocalWorkspaceRecovery()).rejects.toThrow('settled');
      expect(await db.workspaces.count()).toBe(0);
    },
  );
  it.each(['scope', 'cloud', 'readiness'])('rejects %s ABA after preview', async (change) => {
    const preview = await previewLocalWorkspaceRecovery();
    if (change === 'scope') {
      useAuthStore.setState({ projectId: 'prj_other' as ProjectId });
      useAuthStore.setState(source);
    }
    if (change === 'cloud') {
      useAuthStore.setState({ cloudSession: { user_id: 'cloud', email: '', expires_at: 1 } });
      useAuthStore.setState({ cloudSession: null });
    }
    if (change === 'readiness') {
      revokeLocalAccountReadiness();
      await ready();
    }
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('changed');
    expect(await db.workspaces.count()).toBe(0);
  });
  it('rechecks total rows inside the committing transaction', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    await db.workspaces.add({
      id: 'wks_intervening' as WorkspaceId,
      name: 'New',
      owner_id: 'foreign',
      created_at: 1,
      updated_at: 1,
    });
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('already exists');
    expect(await db.workspaces.count()).toBe(1);
    expect(await db.settings.get(receiptKey)).toBeUndefined();
  });
  it('rolls back the pair and receipt if authority changes during the transaction', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    const add = db.projects.add.bind(db.projects);
    vi.spyOn(db.projects, 'add').mockImplementation((...args) =>
      add(...args).then((result) => {
        useAuthStore.setState({ projectId: 'prj_other' as ProjectId });
        useAuthStore.setState(source);
        return result;
      }),
    );
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('changed');
    expect(await db.workspaces.count()).toBe(0);
    expect(await db.projects.count()).toBe(1);
    expect(await db.settings.get(receiptKey)).toBeUndefined();
  });
  it('rolls back both rows if the durable receipt cannot be saved', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    vi.spyOn(db.settings, 'add').mockRejectedValue(new Error('receipt write failed'));
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('receipt write failed');
    expect(await db.workspaces.count()).toBe(0);
    expect(await db.projects.count()).toBe(1);
    expect(useAuthStore.getState()).toMatchObject(source);
  });
  it('resumes the same durable pair after quota failure without creating duplicates', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'jarvis-auth') throw new Error('quota');
      return set.call(this, key, value);
    });
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('quota');
    const saved = await db.settings.get(receiptKey);
    expect(await db.workspaces.count()).toBe(1);
    expect(useAuthStore.getState()).toMatchObject(source);
    vi.restoreAllMocks();
    const resume = await previewLocalWorkspaceRecovery();
    expect(resume.kind).toBe('resume');
    await recoverLocalWorkspace(resume);
    expect(await db.settings.get(receiptKey)).toEqual(saved);
    expect(await db.workspaces.count()).toBe(1);
    expect(await db.projects.count()).toBe(2);
  });
  it('resumes a persisted-target receipt after write success and verification-read failure', async () => {
    const preview = await previewLocalWorkspaceRecovery();
    const get = Storage.prototype.getItem;
    let failVerification = false;
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      set.call(this, key, value);
      if (key === 'jarvis-auth') failVerification = true;
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'jarvis-auth' && failVerification) {
        failVerification = false;
        throw new Error('verification unavailable');
      }
      return get.call(this, key);
    });
    await expect(recoverLocalWorkspace(preview)).rejects.toThrow('verification unavailable');
    expect(useAuthStore.getState()).toMatchObject(source);
    const persisted = JSON.parse(get.call(localStorage, 'jarvis-auth')!).state;
    expect(persisted.workspaceId).not.toBe(source.workspaceId);
    vi.restoreAllMocks();
    await recoverLocalWorkspace(await previewLocalWorkspaceRecovery());
    expect(useAuthStore.getState()).toMatchObject({
      workspaceId: persisted.workspaceId,
      projectId: persisted.projectId,
    });
    // Reloaded/already activated target is also idempotent.
    await ready();
    await recoverLocalWorkspace(await previewLocalWorkspaceRecovery());
    expect(await db.workspaces.count()).toBe(1);
    expect(await db.projects.count()).toBe(2);
  });
  it('refuses saved-target storage without its matching durable receipt', async () => {
    const saved = JSON.parse(localStorage.getItem('jarvis-auth')!);
    saved.state.workspaceId = 'wks_unproved';
    saved.state.projectId = 'prj_unproved';
    localStorage.setItem('jarvis-auth', JSON.stringify(saved));
    await expect(previewLocalWorkspaceRecovery()).rejects.toThrow('saved local profile changed');
    expect(await db.workspaces.count()).toBe(0);
  });
  it('refuses forged previews and changed recovery rows', async () => {
    await expect(
      recoverLocalWorkspace({ kind: 'create', accountId: source.localUserId }),
    ).rejects.toThrow('Check local');
    await recoverLocalWorkspace(await previewLocalWorkspaceRecovery());
    await ready();
    await db.workspaces.update(useAuthStore.getState().workspaceId!, { owner_id: 'foreign' });
    await expect(previewLocalWorkspaceRecovery()).rejects.toThrow('cannot be verified');
  });
});
