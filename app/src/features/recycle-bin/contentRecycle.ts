import { chatRepo, projectRepo, taskRepo } from '@/lib/db/repositories';
import type { Project } from '@/lib/db';
import type { TaskId, ProjectId } from '@/types';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { restoreSpeechHistoryEntry } from '@/features/composer-stt/speechHistory';
import {
  createDirectoryWithReceipt,
  statProjectPath,
  moveProjectFileWithReceipt,
  deleteProjectFile,
} from '@/lib/fs';
import { recycleBinStore, validRecycledFile, type RecycledContentItem } from './recycleBinStore';

export const MAX_RECYCLED_FILE_BYTES = 100 * 1024 * 1024;
const locks = new Set<string>();

function scopeGuard() {
  const key = () => JSON.stringify(getActiveAccountIdentity());
  const original = key();
  return () => {
    if (key() !== original)
      throw new Error('The account changed. Return to the original account and retry.');
  };
}
async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (locks.has(key)) throw new Error('This item already has an operation in progress.');
  locks.add(key);
  try {
    return await action();
  } finally {
    locks.delete(key);
  }
}

export async function recycleProject(project: Project): Promise<void> {
  return exclusive(`project:${project.id}`, async () => {
    const assertScope = scopeGuard();
    const latest = await projectRepo.getById(project.id);
    if (!latest) throw new Error('This project is no longer available.');
    const chats = await chatRepo.listByProject(project.id);
    assertScope();
    recycleBinStore.archiveContent('project', latest.id, latest.name, {
      project: latest,
      chatIds: chats.map((c) => c.id),
    });
    // Keep the archive even if a later operation fails: it records the full recovery state.
    for (const chat of chats) {
      assertScope();
      await chatRepo.update(chat.id, { project_id: undefined });
    }
    assertScope();
    await projectRepo.delete(project.id);
  });
}

export async function recycleTask(id: TaskId): Promise<void> {
  return exclusive(`task:${id}`, async () => {
    const assertScope = scopeGuard();
    const task = await taskRepo.getById(id);
    if (!task) throw new Error('This task is no longer available.');
    assertScope();
    recycleBinStore.archiveContent('task', id, task.title, task);
    await taskRepo.delete(id);
  });
}

export async function recycleFile(path: string, root: string): Promise<void> {
  return exclusive(`file:${path}`, async () => {
    const assertScope = scopeGuard();
    const stat = await statProjectPath(path, false, { root });
    if (!stat.ok) throw new Error(stat.error.raw || 'The file could not be read.');
    if (stat.kind !== 'file' || stat.size === undefined || stat.size > MAX_RECYCLED_FILE_BYTES)
      throw new Error('Only files up to 100 MiB can be recycled. The file was kept.');
    const folder = root.replace(/[\\/]$/, '') + '/.vibespace/recycle-bin';
    const payload = {
      path,
      root,
      archivePath: folder + '/' + crypto.randomUUID(),
      bytes: stat.size,
    };
    if (!validRecycledFile(payload)) throw new Error('The file must be inside the project folder.');
    const dir = await createDirectoryWithReceipt(folder, { root });
    if (!dir.ok) throw new Error(dir.error.raw || 'The recovery folder could not be created.');
    assertScope();
    const archived = recycleBinStore.archiveContent(
      'file',
      path,
      path.replace(/\\/g, '/').split('/').at(-1)!,
      payload,
    );
    const moved = await moveProjectFileWithReceipt(path, payload.archivePath, { root });
    if (!moved.ok) {
      // A failed or lost response can follow a successful move. Retain its durable
      // recovery pointer unless we can prove the source is still present.
      const original = await statProjectPath(path, false, { root });
      const backup = await statProjectPath(payload.archivePath, false, { root });
      assertScope();
      if (original.ok && !backup.ok && backup.error.code === 'not_found')
        recycleBinStore.removeArchive(archived.archiveId);
      throw new Error(moved.error.raw || 'The file could not be recycled.');
    }
  });
}

export async function restoreRecycledContent(item: RecycledContentItem) {
  return exclusive(item.archiveId, async () => {
    const assertScope = scopeGuard();
    if (!recycleBinStore.getSnapshot().some((row) => row.archiveId === item.archiveId))
      throw new Error('This item is no longer in the active Recycle Bin.');
    let entityId = item.entityId;
    if (item.kind === 'speech') entityId = restoreSpeechHistoryEntry(item.payload);
    else if (item.kind === 'project') {
      const active = await projectRepo.getById(item.payload.project.id);
      assertScope();
      if (active && JSON.stringify(active) !== JSON.stringify(item.payload.project))
        throw new Error('A project with this identity already exists. The recovery copy was kept.');
      if (!active) await projectRepo.restore(item.payload.project);
      for (const id of item.payload.chatIds) {
        const chat = await chatRepo.getById(id);
        assertScope();
        if (chat && !chat.project_id)
          await chatRepo.update(id, { project_id: item.payload.project.id });
      }
    } else if (item.kind === 'task') {
      if (
        item.payload.project_id &&
        !(await projectRepo.getById(item.payload.project_id as ProjectId))
      )
        throw new Error('Restore this task’s project first.');
      assertScope();
      await taskRepo.restore(item.payload);
    } else {
      if (!validRecycledFile(item.payload)) throw new Error('The recovery path is invalid.');
      const restored = await moveProjectFileWithReceipt(
        item.payload.archivePath,
        item.payload.path,
        { root: item.payload.root },
      );
      if (!restored.ok)
        throw new Error(
          restored.error.raw ||
            'The file could not be restored. Existing files are never overwritten.',
        );
    }
    assertScope();
    recycleBinStore.removeArchive(item.archiveId);
    return { kind: item.kind, entityId, renamed: false as const };
  });
}

export async function permanentlyDeleteRecycledFile(
  item: Extract<RecycledContentItem, { kind: 'file' }>,
) {
  if (!validRecycledFile(item.payload)) throw new Error('The recovery path is invalid.');
  const result = await deleteProjectFile(item.payload.archivePath, { root: item.payload.root });
  if (!result.ok && result.error.code !== 'not_found')
    throw new Error(result.error.raw || 'The recovery file could not be removed.');
}
