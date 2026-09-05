/** Bodies are authoritative in SiYuan; only unsaved drafts are checkpointed locally. */
export interface NoteScope {
  accountId: string;
  projectId: string;
}
export interface NoteSummary extends NoteScope {
  id: string;
  title: string;
  preview: string;
  revision: string;
  nativeId?: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  favorite: boolean;
  trashed: boolean;
}
export interface NoteRecord extends NoteSummary {
  body: string;
}
export interface NoteReference extends NoteScope {
  id: string;
  title: string;
  revision: string;
}
export interface NotesAuthority {
  list(scope: NoteScope): Promise<NoteSummary[]>;
  read(scope: NoteScope, id: string): Promise<NoteRecord>;
  write(scope: NoteScope, record: NoteRecord, expectedRevision: string | null): Promise<NoteRecord>;
}
export type NotePatch = Partial<
  Pick<NoteRecord, 'title' | 'body' | 'pinned' | 'favorite' | 'trashed'>
>;
export type NotesCheckpointStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const MAX_NOTE_BODY = 500_000;
export const MAX_NOTES = 10_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

export function assertNoteScope(scope: NoteScope): void {
  if (
    !scope ||
    typeof scope.accountId !== 'string' ||
    typeof scope.projectId !== 'string' ||
    !SAFE_ID.test(scope.accountId) ||
    !SAFE_ID.test(scope.projectId)
  ) {
    throw new Error('Choose an account and project before opening Notes.');
  }
}
export function sameNoteScope(a: NoteScope, b: NoteScope): boolean {
  return a.accountId === b.accountId && a.projectId === b.projectId;
}
export function noteScopeKey(scope: NoteScope): string {
  assertNoteScope(scope);
  return JSON.stringify([scope.accountId, scope.projectId]);
}
export function noteReferenceKey(ref: NoteReference): string {
  return JSON.stringify([ref.accountId, ref.projectId, ref.id]);
}
export function notePreview(body: string): string {
  return body
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180)
    .replace(/[\uD800-\uDBFF]$/u, '');
}
export function noteSummary(record: NoteRecord): NoteSummary {
  const { body: _body, ...summary } = record;
  return { ...summary, preview: notePreview(record.body) };
}
export function noteReference(summary: NoteSummary): NoteReference {
  return {
    accountId: summary.accountId,
    projectId: summary.projectId,
    id: summary.id,
    title: summary.title,
    revision: summary.revision,
  };
}
export function parseNoteSummary(value: unknown, scope: NoteScope): NoteSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Notes metadata is invalid.');
  const v = value as NoteSummary;
  if (
    !sameNoteScope(v, scope) ||
    typeof v.id !== 'string' ||
    typeof v.revision !== 'string' ||
    !SAFE_ID.test(v.id) ||
    !SAFE_ID.test(v.revision) ||
    typeof v.title !== 'string' ||
    v.title.length > 250 ||
    typeof v.preview !== 'string' ||
    v.preview.length > 180 ||
    !Number.isSafeInteger(v.createdAt) ||
    !Number.isSafeInteger(v.updatedAt) ||
    v.createdAt < 0 ||
    v.updatedAt < v.createdAt ||
    typeof v.pinned !== 'boolean' ||
    typeof v.favorite !== 'boolean' ||
    typeof v.trashed !== 'boolean' ||
    (v.nativeId !== undefined &&
      (typeof v.nativeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(v.nativeId)))
  ) {
    throw new Error('Notes metadata is invalid or belongs to a different account/project.');
  }
  return {
    accountId: v.accountId,
    projectId: v.projectId,
    id: v.id,
    title: v.title,
    preview: v.preview,
    revision: v.revision,
    ...(v.nativeId ? { nativeId: v.nativeId } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    pinned: v.pinned,
    favorite: v.favorite,
    trashed: v.trashed,
  };
}
export function parseNoteRecord(value: unknown, scope: NoteScope): NoteRecord {
  const summary = parseNoteSummary(value, scope);
  const body = (value as NoteRecord).body;
  if (typeof body !== 'string' || body.length > MAX_NOTE_BODY || body.includes('\0')) {
    throw new Error(
      'This note is too large or contains unsupported text. Your draft has not been replaced.',
    );
  }
  return { ...summary, body };
}
export async function noteDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
