import { noteScopeKey, sameNoteScope, type NoteReference, type NoteScope } from './notesContracts';

// Transient composer state only. Authoritative note bodies remain in SiYuan.
const drafts = new Map<string, { text: string; references: NoteReference[] }>();
export function notesComposerKey(scope: NoteScope | null, chatId: string): string {
  return scope ? JSON.stringify([noteScopeKey(scope), chatId]) : '';
}
export function readNotesComposerDraft(scope: NoteScope | null, chatId: string) {
  const draft = drafts.get(notesComposerKey(scope, chatId));
  return {
    text: draft?.text ?? '',
    references: draft?.references.map((ref) => ({ ...ref })) ?? [],
  };
}
export function checkpointNotesComposer(
  scope: NoteScope | null,
  chatId: string,
  text: string,
  references: readonly NoteReference[],
): void {
  if (!scope || references.some((ref) => !sameNoteScope(ref, scope))) return;
  const key = notesComposerKey(scope, chatId);
  if (!references.length) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, { text, references: references.map((ref) => ({ ...ref })) });
  while (drafts.size > 32) drafts.delete(drafts.keys().next().value!);
}
