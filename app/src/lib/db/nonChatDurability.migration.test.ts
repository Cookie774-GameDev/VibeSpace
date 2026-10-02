import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { createJarvisDb, type Project } from '@/lib/db';
import { DB_VERSION, STORES_V1 } from '@/lib/db/schema';
import type { Task } from '@/types/task';
import type { ProjectId, WorkspaceId, TaskId } from '@/types/common';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
const names: string[] = [];
afterEach(async () => { for (const name of names.splice(0)) await new Dexie(name, TEST_INDEXED_DB).delete(); });
it('S61B4D preserves V1 nonchat project and Kanban task fields through actual current migrations and a second reopen', async () => {
  const name = uniqueTestDbName('S61B4D-v1-upgrade'); names.push(name);
  const project: Project = { id: 'S61B4D-project' as ProjectId, workspace_id: 'S61B4D-workspace' as WorkspaceId, name: 'S61B4D project Ω', created_at: 100, updated_at: 200 };
  const task: Task = { id: 'S61B4D-task' as TaskId, workspace_id: project.workspace_id, project_id: project.id, title: 'S61B4D board card', notes: 'Exact Kanban note\nline two', status: 'blocked', priority: 'high', effort: 3, context_tags: ['S61B4D'], energy_required: 'medium', reminders: [], created_by: 'user_text', source_refs: [], created_at: 100, updated_at: 200 };
  const legacy = new Dexie(name, TEST_INDEXED_DB); legacy.version(1).stores(STORES_V1);
  await legacy.open();
  await legacy.table('projects').add(project); await legacy.table('tasks').add(task);
  legacy.close();
  const upgraded = createJarvisDb(name, TEST_INDEXED_DB); await upgraded.open();
  expect(upgraded.verno).toBe(DB_VERSION);
  expect(await upgraded.projects.get(project.id)).toEqual(project);
  expect(await upgraded.tasks.get(task.id)).toEqual(task);
  await upgraded.tasks.update(task.id, { status: 'done', done_at: 300, updated_at: 300 });
  upgraded.close();
  const reopened = createJarvisDb(name, TEST_INDEXED_DB); await reopened.open();
  try {
    expect(await reopened.projects.get(project.id)).toEqual(project);
    expect(await reopened.tasks.get(task.id)).toEqual({ ...task, status: 'done', done_at: 300, updated_at: 300 });
    expect(await reopened.projects.count()).toBe(1);
    expect(await reopened.tasks.count()).toBe(1);
    expect(await reopened.tasks.where('project_id').equals('S61B4D-other-project').toArray()).toEqual([]);
  } finally { reopened.close(); }
});
