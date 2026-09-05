import { describe, expect, it } from 'vitest';
import { assertNoteScope, notePreview, parseNoteSummary } from './notesContracts';
const scope = { accountId: 'account-a', projectId: 'project-a' };
const summary = {
  ...scope,
  id: 'note-a',
  revision: 'rev-a',
  title: 'A',
  preview: '',
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  favorite: false,
  trashed: false,
};
describe('Notes boundary validation', () => {
  it('does not coerce absent scope identifiers into the string undefined', () => {
    expect(() => assertNoteScope({} as typeof scope)).toThrow();
    expect(() =>
      assertNoteScope({ accountId: undefined, projectId: undefined } as unknown as typeof scope),
    ).toThrow();
  });
  it('rejects absent note and revision identifiers', () => {
    expect(() => parseNoteSummary({ ...summary, id: undefined }, scope)).toThrow();
    expect(() => parseNoteSummary({ ...summary, revision: undefined }, scope)).toThrow();
  });
  it('never cuts a preview in the middle of a UTF-16 surrogate pair', () => {
    const preview = notePreview('a'.repeat(179) + '🌿');
    expect(() => encodeURIComponent(preview)).not.toThrow();
    expect(preview.length).toBeLessThanOrEqual(180);
  });
});
