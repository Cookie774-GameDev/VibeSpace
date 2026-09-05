import {
  getProductionSiyuanRlmPort,
  type ProductionSiyuanRlmPort,
  type SiyuanManagedDocument,
} from '../context/siyuanRlmProduction';
import {
  MAX_NOTES,
  assertNoteScope,
  noteDigest,
  noteScopeKey,
  noteSummary,
  parseNoteRecord,
  parseNoteSummary,
  type NotesAuthority,
  type NoteRecord,
  type NoteScope,
  type NoteSummary,
} from './notesContracts';

export type NotesSiyuanPort = Pick<
  ProductionSiyuanRlmPort,
  'readManagedDocument' | 'createManagedDocument' | 'updateManagedDocument' | 'getBlock'
>;
type Catalog = { document: SiyuanManagedDocument | null; notes: NoteSummary[] };
const conflict = () =>
  new Error(
    'This note changed elsewhere. Your draft is safe. Save a copy to resolve the conflict.',
  );
const unavailable = () =>
  new Error('This note is unavailable. Restore it or remove its reference and retry.');

// SiYuan exports block IALs alongside Markdown. They are storage metadata, not note text.
// Keep literal attribute-looking lines inside user code fences intact.
function withoutBlockAttributes(markdown: string): string {
  let fence: { char: string; length: number } | null = null;
  return markdown
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = { char: marker[0], length: marker.length };
        else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
        return true;
      }
      return Boolean(fence) || !/^\s*\{:\s+id="[^"]+"[^\n]*\}\s*$/u.test(line);
    })
    .join('\n');
}

export function createNotesAuthority(
  getPort: () => NotesSiyuanPort = getProductionSiyuanRlmPort,
  assertActive: (scope: NoteScope) => void = assertNoteScope,
): NotesAuthority {
  let writes: Promise<void> = Promise.resolve();
  const guard = (scope: NoteScope) => {
    assertNoteScope(scope);
    assertActive(scope);
  };
  const scopeHash = async (scope: NoteScope) =>
    (await noteDigest(noteScopeKey(scope))).slice(0, 24);
  const indexMarker = (hash: string) => `<!-- vibespace-notes-index:${hash} -->`;
  const noteMarker = (hash: string, id: string) => `<!-- vibespace-note-key:${hash}:${id} -->`;
  async function catalog(scope: NoteScope, hash: string): Promise<Catalog> {
    guard(scope);
    const document = await getPort().readManagedDocument(scope.projectId, {
      query: `VibeSpace Notes ${hash}`,
      marker: indexMarker(hash),
    });
    guard(scope);
    if (!document) return { document: null, notes: [] };
    const json = /```json\s*\n([\s\S]*?)\n```/u.exec(document.markdown)?.[1];
    if (!json || !document.markdown.includes(indexMarker(hash)))
      throw new Error('Notes catalog is unreadable. It has not been replaced.');
    const parsed = JSON.parse(json) as { version: number; scope: NoteScope; notes: unknown[] };
    if (
      parsed.version !== 1 ||
      noteScopeKey(parsed.scope) !== noteScopeKey(scope) ||
      !Array.isArray(parsed.notes) ||
      parsed.notes.length > MAX_NOTES
    )
      throw new Error('Notes catalog scope is invalid.');
    const notes = parsed.notes.map((value) => parseNoteSummary(value, scope));
    if (new Set(notes.map((n) => n.id)).size !== notes.length || notes.some((n) => !n.nativeId)) {
      throw new Error('Notes catalog contains ambiguous identities.');
    }
    return { document, notes };
  }
  async function decode(
    scope: NoteScope,
    hash: string,
    id: string,
    document: SiyuanManagedDocument,
  ) {
    const marker = noteMarker(hash, id);
    const markdown = withoutBlockAttributes(document.markdown);
    const header =
      /^# VibeSpace Note [^\n]+\n\n(<!--[\s\S]*?-->)\n\n?<!-- vibespace-note-data:([^\n]+?) -->\n\n/u.exec(
        markdown,
      );
    if (!header || header[1] !== marker)
      throw new Error('Note identity or account/project scope is invalid.');
    const metadata = parseNoteSummary(JSON.parse(decodeURIComponent(header[2])), scope);
    if (metadata.id !== id) throw unavailable();
    const nonce = metadata.revision;
    const source = markdown.slice(header[0].length);
    const encoded = /^```vibespace-note-source\n([^\n]*)\n```\s*$/u.exec(source);
    const body: unknown = encoded ? JSON.parse(encoded[1]) : source.trimEnd();
    if (typeof body !== 'string')
      throw new Error('Note source is invalid. Your local draft is safe.');
    const record = parseNoteRecord(
      {
        ...metadata,
        nativeId: document.id,
        body,
        revision: `sha256:${await noteDigest(document.markdown)}`,
      },
      scope,
    );
    return { record, nonce };
  }
  function encode(hash: string, record: NoteRecord): string {
    const { nativeId: _nativeId, ...metadata } = noteSummary(record);
    return (
      `# VibeSpace Note ${record.id}\n\n${noteMarker(hash, record.id)}\n\n` +
      `<!-- vibespace-note-data:${encodeURIComponent(JSON.stringify(metadata))} -->\n\n` +
      '```vibespace-note-source\n' +
      // Lute inserts invisible fence guards around literal backticks in code content.
      // JSON escapes preserve the exact user source without triggering that rewrite.
      JSON.stringify(record.body).replace(/`/gu, '\\u0060') +
      '\n```'
    );
  }
  async function read(scope: NoteScope, id: string): Promise<NoteRecord> {
    guard(scope);
    const hash = await scopeHash(scope);
    const entry = (await catalog(scope, hash)).notes.find((n) => n.id === id);
    if (!entry?.nativeId) throw unavailable();
    guard(scope);
    const document = await getPort().getBlock(scope.projectId, entry.nativeId);
    guard(scope);
    return (await decode(scope, hash, id, document)).record;
  }
  async function updateCatalog(scope: NoteScope, hash: string, saved: NoteRecord): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await catalog(scope, hash);
      const old = current.notes.find((n) => n.id === saved.id);
      if (old && old.nativeId !== saved.nativeId) throw conflict();
      guard(scope);
      const fresh = await getPort().getBlock(scope.projectId, saved.nativeId!);
      if (`sha256:${await noteDigest(fresh.markdown)}` !== saved.revision) throw conflict();
      const notes = [...current.notes.filter((n) => n.id !== saved.id), noteSummary(saved)];
      if (notes.length > MAX_NOTES) throw new Error('This Notes collection is full.');
      const markdown =
        `# VibeSpace Notes ${hash}\n\n${indexMarker(hash)}\n\n` +
        '```json\n' +
        JSON.stringify({ version: 1, scope, notes }) +
        '\n```';
      guard(scope);
      try {
        if (current.document) {
          await getPort().updateManagedDocument(
            scope.projectId,
            current.document.id,
            current.document.markdown,
            markdown,
          );
        } else {
          await getPort().createManagedDocument(
            scope.projectId,
            `/VibeSpace Notes/${hash}/Catalog`,
            markdown,
          );
        }
        guard(scope);
        return;
      } catch (error) {
        if (attempt === 2 || !/conflict|changed|mismatch/iu.test(String(error))) throw error;
      }
    }
  }
  async function writeNow(
    scope: NoteScope,
    next: NoteRecord,
    expected: string | null,
  ): Promise<NoteRecord> {
    guard(scope);
    const record = parseNoteRecord(next, scope);
    record.title = record.title.trim() || 'Untitled note';
    const hash = await scopeHash(scope);
    const entry = (await catalog(scope, hash)).notes.find((n) => n.id === record.id);
    guard(scope);
    let document = entry?.nativeId
      ? await getPort().getBlock(scope.projectId, entry.nativeId)
      : await getPort().readManagedDocument(scope.projectId, {
          query: `VibeSpace Note ${record.id}`,
          marker: noteMarker(hash, record.id),
        });
    guard(scope);
    const before = document ? await decode(scope, hash, record.id, document) : null;
    // Retry an interrupted operation by its checkpointed nonce, never as a duplicate create.
    const alreadyWritten =
      before &&
      before.nonce === record.revision &&
      before.record.title === record.title &&
      before.record.body === record.body &&
      before.record.pinned === record.pinned &&
      before.record.favorite === record.favorite &&
      before.record.trashed === record.trashed &&
      before.record.updatedAt === record.updatedAt;
    if (!alreadyWritten) {
      if ((before?.record.revision ?? null) !== expected) throw conflict();
      guard(scope);
      const markdown = encode(hash, record);
      document = document
        ? await getPort().updateManagedDocument(
            scope.projectId,
            document.id,
            document.markdown,
            markdown,
          )
        : await getPort().createManagedDocument(
            scope.projectId,
            `/VibeSpace Notes/${hash}/${record.id}`,
            markdown,
          );
    }
    guard(scope);
    if (!document) throw unavailable();
    const saved = (await decode(scope, hash, record.id, document)).record;
    await updateCatalog(scope, hash, saved);
    return saved;
  }
  return {
    async list(scope) {
      guard(scope);
      return (await catalog(scope, await scopeHash(scope))).notes;
    },
    read,
    write(scope, input, expected) {
      try {
        guard(scope);
      } catch (error) {
        return Promise.reject(error);
      }
      let record: NoteRecord;
      try {
        record = parseNoteRecord(input, scope);
      } catch (error) {
        return Promise.reject(error);
      }
      const run = writes.then(() => writeNow({ ...scope }, record, expected));
      writes = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
