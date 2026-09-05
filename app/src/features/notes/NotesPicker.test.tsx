import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesPicker } from './NotesPicker';
import type { NoteSummary } from './notesContracts';
const notes: NoteSummary[] = ['A', 'B', 'C'].map((id) => ({
  accountId: 'a',
  projectId: 'p',
  id,
  title: `Fixture ${id}`,
  preview: `${id} preview`,
  revision: 'rev',
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  favorite: false,
  trashed: false,
}));
afterEach(cleanup);
describe('/notes multi-select picker', () => {
  it('keeps clicks open, preserves selection across search, and confirms all notes with Enter', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(<NotesPicker notes={notes} onConfirm={confirm} onCancel={cancel} />);
    fireEvent.click(screen.getByRole('option', { name: 'Fixture A' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fixture B' }));
    expect(confirm).not.toHaveBeenCalled();
    const search = screen.getByRole('textbox', { name: 'Search notes to attach' });
    fireEvent.change(search, { target: { value: 'Fixture C' } });
    expect(screen.queryByRole('option', { name: 'Fixture A' })).toBeNull();
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Fixture C' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fixture C' }));
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].map((n: NoteSummary) => n.id)).toEqual(['A', 'B']);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('wraps both arrow directions and exposes the active option to the search input', () => {
    render(<NotesPicker notes={notes} onConfirm={() => {}} onCancel={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Search notes to attach' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const last = screen.getByRole('option', { name: 'Fixture C' });
    expect(last.getAttribute('data-active')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(last.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Fixture A' }).getAttribute('data-active')).toBe(
      'true',
    );
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(last.getAttribute('data-active')).toBe('true');
  });
  it('consumes empty Enter, cancels Escape, and does not intercept IME confirmation', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(<NotesPicker notes={notes} onConfirm={confirm} onCancel={cancel} />);
    const input = screen.getByRole('textbox', { name: 'Search notes to attach' });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'Fixture A' }));
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('navigates with arrows and toggles with Space without selecting a trashed note', () => {
    const confirm = vi.fn();
    render(
      <NotesPicker
        notes={[...notes, { ...notes[0], id: 'trash', title: 'Trashed', trashed: true }]}
        onConfirm={confirm}
        onCancel={() => {}}
      />,
    );
    const root = screen.getByRole('dialog', { name: 'Attach notes' });
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    fireEvent.keyDown(root, { key: ' ' });
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    fireEvent.keyDown(root, { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Add selected notes' }));
    expect(confirm.mock.calls[0][0].map((n: NoteSummary) => n.id)).toEqual(['A', 'B']);
    expect(screen.queryByRole('option', { name: 'Trashed' })).toBeNull();
  });
});
