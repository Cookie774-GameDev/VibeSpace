import {
  buildContextChatAttachment,
  type ContextChatAttachment,
} from '../context/contextChatIntegration';
import { retrieveContextForConsumer } from '../context/contextResponseIntegration';
import {
  assertNoteScope,
  noteDigest,
  noteReferenceKey,
  noteScopeKey,
  parseNoteRecord,
  sameNoteScope,
  type NoteRecord,
  type NoteReference,
  type NoteScope,
} from './notesContracts';

export interface NotesCommandSpan {
  start: number;
  end: number;
  query: string;
}
export function findNotesCommand(text: string, caret: number): NotesCommandSpan | null {
  const end = Math.max(0, Math.min(text.length, caret));
  const prefix = text.slice(0, end);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const line = prefix.slice(lineStart);
  const matches = [...line.matchAll(/(^|[ \t])\/notes(?=$|[ \t])/giu)];
  const match = matches[matches.length - 1];
  if (!match || match.index === undefined) return null;
  const start = lineStart + match.index + match[1].length;
  return { start, end, query: text.slice(start + 6, end).trimStart() };
}
export function removeNotesCommand(text: string, span: NotesCommandSpan): string {
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end > text.length ||
    span.end < span.start ||
    !/^\/notes(?:$|[ \t])/iu.test(text.slice(span.start, span.end))
  ) {
    throw new Error('The /notes command changed. Reopen the picker to attach these notes.');
  }
  return text.slice(0, span.start) + text.slice(span.end);
}
function reference(ref: NoteReference, scope: NoteScope): NoteReference {
  if (
    !sameNoteScope(ref, scope) ||
    typeof ref.id !== 'string' ||
    typeof ref.revision !== 'string' ||
    !ref.id ||
    !ref.revision ||
    ref.id.length > 200 ||
    ref.revision.length > 200 ||
    typeof ref.title !== 'string'
  ) {
    throw new Error('This note reference belongs to another account/project or is invalid.');
  }
  return {
    accountId: ref.accountId,
    projectId: ref.projectId,
    id: ref.id,
    title: ref.title,
    revision: ref.revision,
  };
}
export function mergeNoteReferences(
  existing: readonly NoteReference[],
  incoming: readonly NoteReference[],
  scope: NoteScope,
): NoteReference[] {
  assertNoteScope(scope);
  const refs = new Map<string, NoteReference>();
  for (const value of [...existing, ...incoming]) {
    const ref = reference(value, scope);
    refs.set(noteReferenceKey(ref), ref);
  }
  return [...refs.values()];
}
export async function buildNoteContextAttachments(
  records: readonly NoteRecord[],
  scope: NoteScope,
): Promise<ContextChatAttachment[]> {
  assertNoteScope(scope);
  const hash = (await noteDigest(noteScopeKey(scope))).slice(0, 24);
  return records.map((value) => {
    const note = parseNoteRecord(value, scope);
    if (note.trashed)
      throw new Error('A selected note is in Trash. Restore it or remove the reference.');
    if (note.body.length > 32_768)
      throw new Error(
        `Note “${note.title}” is too large for a chat reference. Split it into smaller notes before sending.`,
      );
    return buildContextChatAttachment({
      projectId: scope.projectId,
      rootDir: `notes://${hash}`,
      generatedAt: note.updatedAt,
      nodeId: `note:${note.id}`,
      mapId: `notes:${hash}:${note.id}`,
      title: note.title || 'Untitled note',
      kind: 'note',
      summary: note.preview || 'Empty note',
      attachmentLevel: 'note',
      source: {
        type: 'linked_vibespace_content',
        label: `Notes / ${hash} / ${note.id} / ${note.revision}`,
        branchRef: note.revision,
      },
      freshness: 'current',
      itemCount: 1,
      lastIndexedAt: Date.now(),
      exactExcerpt: note.body.trim() ? note.body : '[Empty note]',
      path: `Notes/${note.id}.md`,
      sizeBytes: new TextEncoder().encode(note.body).byteLength,
      createdAt: note.createdAt,
      modifiedAt: note.updatedAt,
    });
  });
}
export async function verifyNotesContextCapacity(
  notes: readonly ContextChatAttachment[],
  all: readonly ContextChatAttachment[],
  scope: NoteScope,
  userText: string,
): Promise<void> {
  if (!notes.length) return;
  const result = await retrieveContextForConsumer({
    consumer: 'chat',
    projectId: scope.projectId,
    userText,
    attachments: all,
  });
  if (
    notes.some(
      (note) =>
        !result.items.some(
          (item) =>
            item.mapId === note.mapId &&
            item.entity.entityId === note.nodeId &&
            item.exactExcerpt === note.exactExcerpt,
        ),
    )
  ) {
    throw new Error(
      'The current chat context budget cannot include every selected note in full. Choose fewer or shorter notes, or remove other context attachments. Your message has not been sent.',
    );
  }
}
