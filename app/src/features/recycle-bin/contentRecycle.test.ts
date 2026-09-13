import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  project: { getById: vi.fn(), restore: vi.fn(), delete: vi.fn() },
  task: { getById: vi.fn(), restore: vi.fn(), delete: vi.fn() },
  chats: { listByProject: vi.fn(), getById: vi.fn(), update: vi.fn() },
  stat: vi.fn(),
  mkdir: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/lib/db/repositories', () => ({
  projectRepo: mocks.project,
  taskRepo: mocks.task,
  chatRepo: mocks.chats,
}));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ source: 'local', accountId: 'recycle-test' }),
}));
vi.mock('@/lib/fs', () => ({
  statProjectPath: mocks.stat,
  createDirectoryWithReceipt: mocks.mkdir,
  moveProjectFileWithReceipt: mocks.move,
  deleteProjectFile: mocks.remove,
}));
import { recycleBinStore, resetRecycleBinStoreForTests } from './recycleBinStore';
import { recycleFile, recycleProject, recycleTask, restoreRecycledContent } from './contentRecycle';
import {
  createSpeechHistorySession,
  deleteSpeechHistoryEntry,
  readSpeechHistory,
} from '@/features/composer-stt/speechHistory';
import type { Project } from '@/lib/db';
import type { TaskId } from '@/types';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  resetRecycleBinStoreForTests();
  mocks.stat.mockResolvedValue({ ok: true, kind: 'file', size: 42 });
  mocks.mkdir.mockResolvedValue({ ok: true });
  mocks.move.mockResolvedValue({ ok: true });
});
describe('recoverable content deletion', () => {
  it('preserves transcript text, provider, and status through durable deletion and restore', async () => {
    const speech = createSpeechHistorySession('deepgram');
    speech.final('café 🎤');
    speech.finish('completed');
    const original = readSpeechHistory()[0];
    expect(deleteSpeechHistoryEntry(original.id)).toBe(true);
    resetRecycleBinStoreForTests();
    const archived = recycleBinStore.getSnapshot()[0];
    expect(archived.kind).toBe('speech');
    if (archived.kind !== 'speech') throw Error('Missing speech archive');
    expect(readSpeechHistory()).toEqual([]);
    await restoreRecycledContent(archived);
    expect(readSpeechHistory()[0]).toMatchObject({
      text: original.text,
      provider: 'deepgram',
      status: 'completed',
    });
    expect(readSpeechHistory()[0].id).not.toBe(original.id);
    expect(recycleBinStore.getSnapshot()).toEqual([]);
  });
  it('keeps a transcript when the archive cannot be persisted', () => {
    createSpeechHistorySession('system').final('Keep me');
    const original = readSpeechHistory()[0];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    expect(deleteSpeechHistoryEntry(original.id)).toBe(false);
    expect(readSpeechHistory()[0].text).toBe('Keep me');
  });
  it('archives the exact task before removing it and restores its original identity', async () => {
    const task = {
      id: 'task-1' as TaskId,
      title: 'Task',
      notes: 'Important details',
      reminders: [],
    };
    mocks.task.getById.mockResolvedValue(task);
    mocks.task.delete.mockImplementation(async () => {
      expect(recycleBinStore.getSnapshot()[0].payload).toEqual(task);
    });
    await recycleTask(task.id);
    const archive = recycleBinStore.getSnapshot()[0];
    if (archive.kind !== 'task') throw Error('Missing task');
    await restoreRecycledContent(archive);
    expect(mocks.task.restore).toHaveBeenCalledWith(task);
  });
  it('retains project settings and chat memberships without overwriting a reassigned chat', async () => {
    const project = {
      id: 'project-1',
      workspace_id: 'workspace-1',
      name: 'Project',
      system_prompt: 'Keep settings',
    } as unknown as Project;
    mocks.project.getById.mockResolvedValueOnce(project).mockResolvedValueOnce(undefined);
    mocks.chats.listByProject.mockResolvedValue([{ id: 'chat-1' }, { id: 'chat-2' }]);
    mocks.chats.getById
      .mockResolvedValueOnce({ id: 'chat-1' })
      .mockResolvedValueOnce({ id: 'chat-2', project_id: 'other-project' });
    await recycleProject(project);
    const archive = recycleBinStore.getSnapshot()[0];
    if (archive.kind !== 'project') throw Error('Missing project');
    mocks.chats.update.mockClear();
    await restoreRecycledContent(archive);
    expect(mocks.project.restore).toHaveBeenCalledWith(project);
    expect(mocks.chats.update).toHaveBeenCalledExactlyOnceWith('chat-1', {
      project_id: 'project-1',
    });
  });
  it('persists the recovery pointer before a native file move; restore cannot overwrite', async () => {
    mocks.move.mockImplementationOnce(async () => {
      expect(recycleBinStore.getSnapshot()[0].kind).toBe('file');
      return { ok: true };
    });
    await recycleFile('C:/project/binary.dat', 'C:/project');
    const archive = recycleBinStore.getSnapshot()[0];
    if (archive.kind !== 'file') throw Error('Missing file');
    expect(mocks.move).toHaveBeenCalledWith('C:/project/binary.dat', archive.payload.archivePath, {
      root: 'C:/project',
    });
    mocks.move.mockResolvedValueOnce({
      ok: false,
      error: { code: 'already_exists', raw: 'already_exists' },
    });
    await expect(restoreRecycledContent(archive)).rejects.toThrow('already_exists');
    expect(recycleBinStore.getSnapshot()).toHaveLength(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('removing an archive preserves newer durable entries from another window', () => {
    const first = recycleBinStore.archiveContent('speech', 'first', 'First', {
      id: 'first',
      text: 'First',
      provider: 'system',
      status: 'completed',
      startedAt: Date.now(),
    });
    const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find(
      (k) => k.startsWith('vibespace-recycle-bin-v1'),
    )!;
    const second = {
      ...first,
      archiveId: 'other-archive',
      entityId: 'second',
      name: 'Second',
      payload: { ...first.payload, id: 'second', text: 'Second' },
    };
    localStorage.setItem(key, JSON.stringify({ items: [first, second] }));
    recycleBinStore.removeArchive(first.archiveId);
    expect(recycleBinStore.getSnapshot().map((x) => x.entityId)).toEqual(['second']);
  });
  it('refuses oversized files, traversal, and failed durable storage before moving any file', async () => {
    mocks.stat.mockResolvedValueOnce({ ok: true, kind: 'file', size: 101 * 1024 * 1024 });
    await expect(recycleFile('C:/project/large.dat', 'C:/project')).rejects.toThrow('100 MiB');
    await expect(recycleFile('C:/project/../private.dat', 'C:/project')).rejects.toThrow('inside');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    await expect(recycleFile('C:/project/file.dat', 'C:/project')).rejects.toThrow('quota');
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
