import { describe, expect, it } from 'vitest';
import { parseChatNoteReference } from './notesChatReferences';
import type { Part } from '@/types';
const project = 'project-a';
const map = 'notes:0123456789abcdef01234567:note-a';
const node = 'note:note-a';
const part: Part = {
  kind: 'file_ref',
  ref: {
    kind: 'memory',
    id: `context:p${project.length}:${project}${map.length}:${map}${node.length}:${node}note`,
    excerpt: 'Context: Design notes',
  },
};
describe('chat note reference disclosure', () => {
  it('reads the existing length-prefixed references without exposing internal IDs', () => {
    expect(parseChatNoteReference(part)).toEqual({
      projectId: project,
      scopeHash: '0123456789abcdef01234567',
      id: 'note-a',
      title: 'Design notes',
    });
  });
  it('does not classify other attachments or malformed references as notes', () => {
    expect(parseChatNoteReference({ kind: 'text', text: 'notes:hello' })).toBeNull();
    expect(
      parseChatNoteReference({ kind: 'file_ref', ref: { kind: 'file', id: 'notes:hello' } }),
    ).toBeNull();
    expect(
      parseChatNoteReference({ ...part, ref: { ...part.ref, id: part.ref.id + 'extra' } }),
    ).toBeNull();
    expect(
      parseChatNoteReference({
        ...part,
        ref: { ...part.ref, id: part.ref.id.replace('p9:', 'p999:') },
      }),
    ).toBeNull();
  });
});
