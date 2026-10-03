import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import type { AccountIdentity } from '@/lib/accountIdentity';
import type { ProjectId, ReminderId, TaskId, WorkspaceId } from '@/types/common';
import type { Task } from '@/types/task';
import { createWorkspaceBackup } from './workspaceBackup';
import { previewWorkspaceRestore, restoreWorkspaceBackup } from './workspaceRestore';

const identity: AccountIdentity = { accountId: 'S61B4D-account', source: 'local' };
const workspaceId = 'S61B4D-workspace' as WorkspaceId;
const projectId = 'S61B4D-project' as ProjectId;
const taskId = 'S61B4D-task' as TaskId;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId, workspace_id: workspaceId, project_id: projectId,
    title: 'Preserve ordinary Kanban work', notes: 'Nonchat durable notes',
    status: 'blocked', priority: 'high', effort: 3, context_tags: ['home'],
    energy_required: 'medium', reminders: [], created_by: 'user_text', source_refs: [],
    created_at: 11, updated_at: 22, ...overrides,
  };
}

describe('account-scoped portable task backup', () => {
  let source: JarvisDexie;
  let target: JarvisDexie;
  beforeEach(async () => {
    source = createJarvisDb(`S61B4D-source-${crypto.randomUUID()}`, { indexedDB, IDBKeyRange });
    target = createJarvisDb(`S61B4D-target-${crypto.randomUUID()}`, { indexedDB, IDBKeyRange });
    await Promise.all([source.open(), target.open()]);
    await source.workspaces.add({ id: workspaceId, owner_id: identity.accountId, name: 'Owned', created_at: 1, updated_at: 2 });
    await source.projects.add({ id: projectId, workspace_id: workspaceId, name: 'Owned project', created_at: 1, updated_at: 2 });
    await source.tasks.add(task());
  });
  afterEach(async () => {
    source.close(); target.close();
    await Promise.all([source.delete(), target.delete()]);
  });

  async function exportContent(): Promise<string> {
    let content = '';
    await createWorkspaceBackup({
      database: source, getAccountIdentity: () => identity,
      flush: async () => ({ completed: 0, failed: 0, timedOut: false, canvas: { completed: 0, failed: 0, timedOut: false } }),
      saveArtifact: async (artifact) => { content = artifact.content; },
    })();
    return content;
  }
  async function preview(content: string) {
    return previewWorkspaceRestore(content, { database: target, getAccountIdentity: () => identity });
  }
  async function restore(content: string) {
    return restoreWorkspaceBackup(await preview(content), { database: target, getAccountIdentity: () => identity });
  }

  it('exports and restores the actual task row, preserves a local conflict, and remains idempotent', async () => {
    const content = await exportContent();
    expect(JSON.parse(content).data.tasks).toEqual([task()]);
    expect((await preview(content)).counts.tasks).toBe(1);
    await restore(content);
    expect(await target.tasks.get(taskId)).toEqual(task());
    await target.tasks.update(taskId, { title: 'Local winner' });
    expect(await restore(content)).toEqual({ restored: 0, preservedLocal: 3 });
    expect((await target.tasks.get(taskId))?.title).toBe('Local winner');
  });

  it('excludes foreign workspace tasks and tasks redirected to a foreign project from export', async () => {
    const foreignWorkspace = 'S61B4D-foreign' as WorkspaceId;
    const foreignProject = 'S61B4D-foreign-project' as ProjectId;
    await source.workspaces.add({ id: foreignWorkspace, owner_id: 'other-account', name: 'Foreign', created_at: 1, updated_at: 2 });
    await source.projects.add({ id: foreignProject, workspace_id: foreignWorkspace, name: 'Foreign', created_at: 1, updated_at: 2 });
    await source.tasks.bulkAdd([
      task({ id: 'S61B4D-foreign-task' as TaskId, workspace_id: foreignWorkspace, project_id: foreignProject }),
      task({ id: 'S61B4D-redirected-task' as TaskId, project_id: foreignProject }),
    ]);
    expect(JSON.parse(await exportContent()).data.tasks.map((row: Task) => row.id)).toEqual([taskId]);
  });

  it('supports older version-one artifacts without inventing missing tasks', async () => {
    const old = JSON.parse(await exportContent());
    delete old.data.tasks;
    await restore(JSON.stringify(old));
    expect(await target.tasks.count()).toBe(0);
    expect(await target.workspaces.count()).toBe(1);
  });

  it('rejects cross-workspace project correlation even when both workspaces belong to the account', async () => {
    const corrupt = JSON.parse(await exportContent());
    corrupt.data.workspaces.push({ id: 'other-owned', owner_id: identity.accountId, name: 'Other', created_at: 1, updated_at: 2 });
    corrupt.data.projects[0].workspace_id = 'other-owned';
    await expect(preview(JSON.stringify(corrupt))).rejects.toMatchObject({ code: 'artifact_invalid' });
    expect(await target.tasks.count()).toBe(0);
  });

  it('rejects an existing foreign workspace collision before any backup row is inserted', async () => {
    await target.workspaces.add({ id: workspaceId, owner_id: 'foreign-account', name: 'Keep', created_at: 1, updated_at: 2 });
    await expect(restore(await exportContent())).rejects.toMatchObject({ code: 'artifact_account_mismatch' });
    expect(await target.tasks.count()).toBe(0);
    expect(await target.projects.count()).toBe(0);
    expect((await target.workspaces.get(workspaceId))?.owner_id).toBe('foreign-account');
  });

  it('rejects an existing project scope collision without changing either local scope', async () => {
    await target.projects.add({ id: projectId, workspace_id: 'foreign-workspace' as WorkspaceId, name: 'Keep', created_at: 1, updated_at: 2 });
    await expect(restore(await exportContent())).rejects.toMatchObject({ code: 'artifact_account_mismatch' });
    expect(await target.tasks.count()).toBe(0);
    expect(await target.workspaces.count()).toBe(0);
  });

  it('preserves backup reminder history but never restores pending delivery or a stale claim', async () => {
    const reminder = { id: 'S61B4D-reminder' as ReminderId, task_id: taskId, fires_at: 123,
      channels: ['in_app' as const], status: 'scheduled' as const, snooze_history: [],
      delivery_claim: { id: 'old-claim', claimed_at: 10, expires_at: 20 } };
    await source.tasks.update(taskId, { reminders: [reminder] });
    const content = await exportContent();
    expect(JSON.parse(content).data.tasks[0].reminders).toEqual([reminder]);
    await restore(content);
    const { delivery_claim: _claim, ...history } = reminder;
    expect((await target.tasks.get(taskId))?.reminders).toEqual([{ ...history, status: 'dismissed' }]);
  });

  it('rejects a reminder belonging to another task without inserting any rows', async () => {
    const corrupt = JSON.parse(await exportContent());
    corrupt.data.tasks[0].reminders = [{ task_id: 'foreign-task', status: 'scheduled' }];
    await expect(preview(JSON.stringify(corrupt))).rejects.toMatchObject({ code: 'artifact_invalid' });
    expect(await target.workspaces.count()).toBe(0);
  });

  it('rejects an account change after preview and preserves the target database', async () => {
    const prepared = await preview(await exportContent());
    await expect(restoreWorkspaceBackup(prepared, { database: target,
      getAccountIdentity: () => ({ ...identity, accountId: 'other-account' }) })).rejects.toMatchObject({ code: 'account_changed' });
    expect(await target.tasks.count()).toBe(0);
    expect(await target.workspaces.count()).toBe(0);
  });

  it('rejects object excerpts in task provenance and completion evidence before any writes', async () => {
    const content = await exportContent();
    for (const field of ['source_refs', 'completion_evidence']) {
      const corrupt = JSON.parse(content);
      const reference = { kind: 'file', id: 'S61B4D-source', excerpt: { unexpected: 'object' } };
      corrupt.data.tasks[0][field] = field === 'source_refs' ? [reference] : reference;
      await expect(preview(JSON.stringify(corrupt))).rejects.toMatchObject({ code: 'artifact_invalid' });
    }
    expect(await target.tasks.count()).toBe(0);
    expect(await target.workspaces.count()).toBe(0);
  });

  it('round-trips valid typed provenance and completion evidence unchanged', async () => {
    const reference = { kind: 'file' as const, id: 'S61B4D-source', excerpt: 'Safe source excerpt', ts: 44 };
    await source.tasks.update(taskId, { source_refs: [reference], completion_evidence: reference });
    await restore(await exportContent());
    expect(await target.tasks.get(taskId)).toMatchObject({ source_refs: [reference], completion_evidence: reference });
  });

  it('rejects object reminder text rendered by the task card before writes', async () => {
    const content = await exportContent();
    for (const field of ['smart_reason', 'message_override']) {
      const corrupt = JSON.parse(content);
      corrupt.data.tasks[0].reminders = [{ id: 'S61B4D-reminder', task_id: taskId, fires_at: 33,
        channels: ['in_app'], snooze_history: [], status: 'fired', [field]: { unexpected: 'object' } }];
      await expect(preview(JSON.stringify(corrupt))).rejects.toMatchObject({ code: 'artifact_invalid' });
    }
    expect(await target.tasks.count()).toBe(0);
  });
});
