import { describe, expect, it, vi } from 'vitest';
import { createNotesAuthority, type NotesSiyuanPort } from './notesAuthority';
import type { NoteRecord, NoteScope } from './notesContracts';
import type { SiyuanManagedDocument } from '../context/siyuanRlmProduction';
const scope: NoteScope = { accountId: 'account-a', projectId: 'project-a' };
const record = (id = 'note-a'): NoteRecord => ({
  ...scope,
  id,
  title: 'Fixture A',
  preview: 'A preview',
  body: 'repeated notes '.repeat(20) + 'authoritative body - fixture only',
  revision: 'rev-a',
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  favorite: false,
  trashed: false,
});
function fixture() {
  const docs = new Map<string, SiyuanManagedDocument & { projectId: string }>();
  let sequence = 0;
  const port: NotesSiyuanPort = {
    readManagedDocument: vi.fn(async (projectId, { marker }) => {
      const matches = [...docs.values()].filter(
        (d) => d.projectId === projectId && d.markdown.includes(marker),
      );
      if (matches.length > 1) throw new Error('ambiguous managed document');
      return matches[0] ? { ...matches[0] } : null;
    }),
    createManagedDocument: vi.fn(async (projectId, path, markdown) => {
      const doc = { id: `doc-${++sequence}`, notebookId: 'book-a', projectId, path, markdown };
      docs.set(doc.id, doc);
      return { ...doc };
    }),
    updateManagedDocument: vi.fn(async (projectId, id, expected, markdown) => {
      const before = docs.get(id);
      if (!before || before.projectId !== projectId) throw new Error('Note unavailable');
      if (before.markdown !== expected) throw new Error('siyuan_revision_conflict');
      const next = { ...before, markdown };
      docs.set(id, next);
      return { ...next };
    }),
    getBlock: vi.fn(async (projectId, id) => {
      const doc = docs.get(id);
      if (!doc || doc.projectId !== projectId) throw new Error('Note unavailable');
      return { ...doc };
    }),
  };
  return { docs, port, authority: createNotesAuthority(() => port) };
}
describe('SiYuan-owned Notes authority', () => {
  it('round-trips SiYuan block attributes and exact source whitespace', async () => {
    const { authority, port } = fixture();
    const create = vi.mocked(port.createManagedDocument).getMockImplementation()!;
    const get = vi.mocked(port.getBlock).getMockImplementation()!;
    const decorate = (document: SiyuanManagedDocument) => ({
      ...document,
      markdown:
        document.markdown
          .replace(/^(".*)$/gmu, (line) => line.replace(/```/gu, '\u200d```'))
          .replace(/\n\n/gu, '\n{: id="20260905145632-fixture" updated="20260905145632"}\n\n') +
        '\n\n{: id="20260905145632-doc" type="doc"}',
    });
    vi.mocked(port.getBlock).mockImplementation(async (...args) => decorate(await get(...args)));
    vi.mocked(port.createManagedDocument).mockImplementation(async (...args) => {
      const document = await create(...args);
      return decorate(document);
    });
    const body = '  Exact source\n\n```md\n{: literal="user text"}\n```\n\n';
    // Native SiYuan/Lute inserts U+200D before embedded fences in code-block content.
    const saved = await authority.write(scope, { ...record(), body }, null);
    expect(saved.body).toBe(body);
  });
  it('writes real note documents and a metadata-only catalog', async () => {
    const { authority, docs, port } = fixture();
    const saved = await authority.write(scope, record(), null);
    expect(saved.nativeId).toBeTruthy();
    expect(saved.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(port.createManagedDocument).toHaveBeenCalledTimes(2);
    const catalog = [...docs.values()].find((d) => d.markdown.includes('vibespace-notes-index:'))!;
    expect(catalog.markdown).not.toContain('authoritative body - fixture only');
    vi.mocked(port.getBlock).mockClear();
    const notes = await authority.list(scope);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(saved.id);
    expect(notes[0]).not.toHaveProperty('body');
    expect(port.getBlock).not.toHaveBeenCalled();
  });
  it('detects direct edits to SiYuan content, even when the embedded write nonce is unchanged', async () => {
    const { authority, docs, port } = fixture();
    const saved = await authority.write(scope, record(), null);
    const doc = docs.get(saved.nativeId!)!;
    docs.set(doc.id, {
      ...doc,
      markdown: doc.markdown.replace('authoritative body - fixture only', 'external edit'),
    });
    const read = await authority.read(scope, saved.id);
    expect(read.revision).not.toBe(saved.revision);
    vi.mocked(port.updateManagedDocument).mockClear();
    await expect(
      authority.write(scope, { ...saved, body: 'my change', revision: 'rev-next' }, saved.revision),
    ).rejects.toThrow(/conflict|changed elsewhere/iu);
    expect(port.updateManagedDocument).not.toHaveBeenCalled();
    expect((await authority.read(scope, saved.id)).body).toContain('external edit');
  });
  it('recovers an interrupted catalog save without creating a second note document', async () => {
    const { authority, docs, port } = fixture();
    const original = vi.mocked(port.createManagedDocument).getMockImplementation()!;
    let failCatalog = true;
    vi.mocked(port.createManagedDocument).mockImplementation(async (...args) => {
      if (args[2].includes('vibespace-notes-index:') && failCatalog) {
        failCatalog = false;
        throw new Error('Catalog unavailable');
      }
      return original(...args);
    });
    await expect(authority.write(scope, record(), null)).rejects.toThrow('Catalog unavailable');
    const recovered = await authority.write(scope, record(), null);
    expect(recovered.nativeId).toBe('doc-1');
    expect(
      [...docs.values()].filter((d) => !d.markdown.includes('vibespace-notes-index:')),
    ).toHaveLength(1);
    expect(await authority.list(scope)).toHaveLength(1);
  });
  it('rejects mismatched account/project identities before issuing any native write', async () => {
    const { authority, port } = fixture();
    await expect(authority.write({ ...scope, accountId: 'other' }, record(), null)).rejects.toThrow(
      /account\/project/iu,
    );
    expect(port.createManagedDocument).not.toHaveBeenCalled();
    await authority.write(scope, record(), null);
    await expect(authority.read({ ...scope, accountId: 'other' }, 'note-a')).rejects.toThrow(
      /unavailable/iu,
    );
    await expect(authority.read({ ...scope, projectId: 'other' }, 'note-a')).rejects.toThrow(
      /unavailable/iu,
    );
  });
  it('keeps stable identities through pin, favorite, trash, and restore', async () => {
    const { authority } = fixture();
    const first = await authority.write(scope, record(), null);
    const trashed = await authority.write(
      scope,
      { ...first, pinned: true, favorite: true, trashed: true, revision: 'rev-trash' },
      first.revision,
    );
    const restored = await authority.write(
      scope,
      { ...trashed, trashed: false, revision: 'rev-restore' },
      trashed.revision,
    );
    expect(restored.id).toBe(first.id);
    expect(restored.nativeId).toBe(first.nativeId);
    expect(restored.body).toBe(first.body);
    expect(restored.pinned && restored.favorite).toBe(true);
    expect(restored.trashed).toBe(false);
    expect(restored.revision).not.toBe(first.revision);
  });
  it('fails closed when a catalog entry points at a missing document', async () => {
    const { authority, docs } = fixture();
    const saved = await authority.write(scope, record(), null);
    docs.delete(saved.nativeId!);
    await expect(authority.read(scope, saved.id)).rejects.toThrow(/unavailable/iu);
  });
});
