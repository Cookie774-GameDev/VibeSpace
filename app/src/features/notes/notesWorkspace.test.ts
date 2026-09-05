import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotesWorkspace } from './notesWorkspace';
import type { NoteRecord, NotesAuthority, NoteScope } from './notesContracts';

const scope: NoteScope = { accountId: 'account-a', projectId: 'project-a' };
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const records = new Map<string, NoteRecord>();
  const authority: NotesAuthority = {
    list: vi.fn(async (s) =>
      [...records.values()].filter(
        (n) => n.accountId === s.accountId && n.projectId === s.projectId,
      ),
    ),
    read: vi.fn(async (s, id) => {
      const n = records.get(id);
      if (!n || n.accountId !== s.accountId || n.projectId !== s.projectId)
        throw new Error('Note unavailable');
      return { ...n };
    }),
    write: vi.fn(async (s, next, expected) => {
      const prior = records.get(next.id);
      if ((prior?.revision ?? null) !== expected)
        throw new Error('Note changed elsewhere. Save a copy to resolve this conflict.');
      const saved = { ...next, nativeId: `native-${next.id}` };
      records.set(next.id, saved);
      return saved;
    }),
  };
  const workspace = createNotesWorkspace(scope, { authority, storage, saveDelayMs: 500 });
  return { workspace, authority, storage, records, values };
}
afterEach(() => vi.useRealTimers());

describe('Notes workspace durability', () => {
  it('creates and selects an editable blank draft without awaiting storage or indexing', () => {
    vi.useFakeTimers();
    const { workspace, authority } = fixture();
    const id = workspace.create();
    expect(workspace.getSnapshot().activeId).toBe(id);
    expect(workspace.getSnapshot().active?.body).toBe('');
    expect(workspace.getSnapshot().active?.title).toBe('Untitled note');
    expect(authority.list).not.toHaveBeenCalled();
    expect(authority.write).not.toHaveBeenCalled();
  });

  it('debounces writes and never lets an old save replace newer typing', async () => {
    vi.useFakeTimers();
    const { workspace, authority } = fixture();
    const id = workspace.create();
    workspace.edit(id, { body: 'first' });
    let finish!: () => void;
    vi.mocked(authority.write).mockImplementationOnce(
      async (_scope, n) =>
        new Promise((resolve) => {
          finish = () => resolve({ ...n, nativeId: 'native-a' });
        }),
    );
    const pending = workspace.flush(id);
    await Promise.resolve();
    workspace.edit(id, { body: 'newer text' });
    expect(workspace.getSnapshot().active?.body).toBe('newer text');
    expect(authority.write).toHaveBeenCalledTimes(1);
    vi.mocked(authority.write).mockImplementation(async (_scope, n) => ({
      ...n,
      nativeId: 'native-a',
    }));
    finish();
    await pending;
    expect(workspace.getSnapshot().active?.body).toBe('newer text');
    expect(vi.mocked(authority.write).mock.calls[1][2]).toBe(
      vi.mocked(authority.write).mock.calls[0][1].revision,
    );
    expect(workspace.getSnapshot().status).toBe('saved');
  });

  it('retains failed drafts across reload and retries the same idempotent attempt', async () => {
    vi.useFakeTimers();
    const { workspace, authority, storage } = fixture();
    const id = workspace.create();
    workspace.edit(id, { title: 'Recovery', body: 'keep this exact draft' });
    vi.mocked(authority.write).mockRejectedValueOnce(new Error('SiYuan unavailable'));
    await expect(workspace.flush(id)).rejects.toThrow('SiYuan unavailable');
    expect(workspace.getSnapshot().status).toBe('error');
    const reloaded = createNotesWorkspace(scope, { authority, storage, saveDelayMs: 500 });
    expect(reloaded.getSnapshot().active?.body).toBe('keep this exact draft');
    await reloaded.flush(id);
    expect(vi.mocked(authority.write).mock.calls[1][1].revision).toBe(
      vi.mocked(authority.write).mock.calls[0][1].revision,
    );
    expect(reloaded.getSnapshot().status).toBe('saved');
  });

  it('does not silently overwrite a conflicting revision and offers a separate copy', async () => {
    vi.useFakeTimers();
    const { workspace, records } = fixture();
    const id = workspace.create();
    await workspace.flush(id);
    const saved = records.get(id)!;
    records.set(id, { ...saved, revision: 'external-revision', body: 'other writer' });
    workspace.edit(id, { body: 'my writing' });
    await expect(workspace.flush(id)).rejects.toThrow('changed elsewhere');
    expect(workspace.getSnapshot().active?.body).toBe('my writing');
    const copyId = workspace.saveCopy(id);
    expect(copyId).not.toBe(id);
    await workspace.flush(copyId);
    expect(records.get(id)?.body).toBe('other writer');
    expect(records.get(copyId)?.body).toBe('my writing');
  });

  it('keeps account/project drafts, last selection, and width isolated', () => {
    vi.useFakeTimers();
    const { workspace, authority, storage } = fixture();
    const id = workspace.create();
    workspace.edit(id, { body: 'private draft' });
    workspace.setListWidth(351);
    const a = createNotesWorkspace(scope, { authority, storage });
    expect(a.getSnapshot().activeId).toBe(id);
    expect(a.getSnapshot().listWidth).toBe(351);
    for (const other of [
      { ...scope, accountId: 'account-b' },
      { ...scope, projectId: 'project-b' },
    ]) {
      const b = createNotesWorkspace(other, { authority, storage });
      expect(b.getSnapshot().notes).toHaveLength(0);
      expect(b.getSnapshot().active).toBeNull();
    }
  });

  it('flushes pending edits before resolving a reference and refuses missing or trashed notes', async () => {
    vi.useFakeTimers();
    const { workspace, authority, records } = fixture();
    const id = workspace.create();
    workspace.edit(id, { body: 'send latest body' });
    const [resolved] = await workspace.resolve([id]);
    expect(resolved.body).toBe('send latest body');
    expect(authority.read).toHaveBeenCalled();
    records.delete(id);
    await expect(workspace.resolve([id])).rejects.toThrow('unavailable');
    const next = workspace.create();
    workspace.edit(next, { trashed: true });
    await expect(workspace.resolve([next])).rejects.toThrow('Trash');
  });

  it('stores only metadata for saved notes, not a competing editable body cache', async () => {
    vi.useFakeTimers();
    const { workspace, values } = fixture();
    const id = workspace.create();
    const body = 'a'.repeat(300) + 'NEVER_PERSIST_FULL_SAVED_BODY';
    workspace.edit(id, { body });
    await workspace.flush(id);
    expect([...values.values()].join('')).not.toContain('NEVER_PERSIST_FULL_SAVED_BODY');
  });

  it('reports a local checkpoint failure without blocking immediate typing or inventing Saved', () => {
    vi.useFakeTimers();
    const { authority } = fixture();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    const workspace = createNotesWorkspace(scope, { authority, storage });
    const id = workspace.create();
    workspace.edit(id, { body: 'still editable' });
    expect(workspace.getSnapshot().active?.body).toBe('still editable');
    expect(workspace.getSnapshot().checkpointError).toContain('checkpoint');
    expect(workspace.getSnapshot().status).not.toBe('saved');
  });
  it('allows an empty title while renaming and recovers that in-progress edit', () => {
    vi.useFakeTimers();
    const { workspace, authority, storage } = fixture();
    const id = workspace.create();
    expect(() => workspace.edit(id, { title: '' })).not.toThrow();
    expect(createNotesWorkspace(scope, { authority, storage }).getSnapshot().active?.title).toBe(
      '',
    );
  });
});
