import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesWorkspaceView } from './NotesWorkspaceView';
import { createNotesWorkspace } from './notesWorkspace';
import type { NoteRecord, NotesAuthority } from './notesContracts';
const stores: ReturnType<typeof createNotesWorkspace>[] = [];
function workspace(fail = false) {
  const scope = { accountId: 'account-a', projectId: 'project-a' };
  const records = new Map<string, NoteRecord>();
  const values = new Map<string, string>();
  const authority: NotesAuthority = {
    list: async () => [...records.values()],
    read: async (_s, id) => {
      const n = records.get(id);
      if (!n) throw new Error('Missing note');
      return n;
    },
    write: async (_s, record) => {
      if (fail) throw new Error('Fixture storage unavailable');
      const saved = { ...record, nativeId: record.id };
      records.set(record.id, saved);
      return saved;
    },
  };
  const store = createNotesWorkspace(scope, {
    authority,
    saveDelayMs: 60_000,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  });
  stores.push(store);
  return store;
}
afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});
describe('dedicated Notes workspace', () => {
  it('adds and toggles a checklist through the writing toolbar and preview', async () => {
    const store = workspace();
    render(<NotesWorkspaceView workspace={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    const editor = screen.getByRole('textbox', { name: 'Note content' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Buy tea' } });
    editor.setSelectionRange(0, 7);
    fireEvent.click(screen.getByRole('button', { name: 'Checklist' }));
    expect(store.getSnapshot().active?.body).toBe('- [ ] Buy tea');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Buy tea' }));
    expect(store.getSnapshot().active?.body).toBe('- [x] Buy tea');
    for (const name of [
      'Bullet list',
      'Numbered list',
      'Heading',
      'Quote',
      'Link',
      'Code block',
      'Bold',
      'Italic',
    ])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    await act(() => store.flushAll());
  });
  it('creates immediately and focuses writing, not a title dialog', async () => {
    const store = workspace();
    render(<NotesWorkspaceView workspace={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    const editor = screen.getByRole('textbox', { name: 'Note content' });
    expect(document.activeElement).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(editor, { target: { value: 'My first note' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
      target: { value: 'Fixture A' },
    });
    await act(() => store.flushAll());
    expect(screen.getByRole('status', { name: 'Note save status' }).textContent).toContain('Saved');
    expect(store.getSnapshot().active?.body).toBe('My first note');
    store.dispose();
  });
  it('supports pin, favorites, recoverable Trash and source preview', async () => {
    const store = workspace();
    render(<NotesWorkspaceView workspace={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note content' }), {
      target: { value: '# Fixture heading\n\n**Safe** text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorite note' }));
    expect(store.getSnapshot().active).toMatchObject({ pinned: true, favorite: true });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('region', { name: 'Note preview' }).textContent).toContain('Safe');
    fireEvent.click(screen.getByRole('button', { name: 'Move note to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore note' }));
    expect(store.getSnapshot().active?.trashed).toBe(false);
    store.dispose();
  });
  it('retains draft text and exposes Retry rather than a false Saved status', async () => {
    const store = workspace(true);
    render(<NotesWorkspaceView workspace={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    const id = store.getSnapshot().activeId!;
    fireEvent.change(screen.getByRole('textbox', { name: 'Note content' }), {
      target: { value: 'retain me' },
    });
    await act(async () => {
      await store.flush(id).catch(() => undefined);
    });
    expect(screen.getByRole('status', { name: 'Note save status' }).textContent).not.toContain(
      'Saved',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Note content' }) as HTMLTextAreaElement).value,
    ).toBe('retain me');
    expect(store.getSnapshot().activeId).toBe(id);
    store.dispose();
  });
});
