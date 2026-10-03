import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createCanvasBlock, createCanvasDocument, withBlockAdded, withTitle } from '@/features/canvas/contracts';
import { createCanvasPersistenceRepository, type CanvasPersistenceScope } from '@/features/canvas/persistence';
import { CanvasPersistenceConflictError, type CanvasRecoveryEntry } from '@/features/canvas/autosave';

// Prepared source tests. Uses only its own fake IndexedDB, never the native profile.
const scope: CanvasPersistenceScope = { accountId: 'S61B4D-account-a', projectId: 'S61B4D-project-a', ownerId: 'S61B4D-owner-a' };
const now = 1_800_000_000_000;
function document() {
  const doc = createCanvasDocument({ id: 'S61B4D-canvas', projectId: scope.projectId, ownerId: scope.ownerId, now });
  return withBlockAdded(doc, createCanvasBlock({ id: 'S61B4D-note', content: { kind: 'note', text: 'S61B4D exact note: Ω\nsecond line' }, now }), now);
}
describe('S61B4D actual Canvas repository durability across a fresh connection', () => {
  let db: JarvisDexie;
  let name: string;
  beforeEach(async () => { name = uniqueTestDbName('S61B4D'); db = createJarvisDb(name, TEST_INDEXED_DB); await db.open(); });
  afterEach(async () => { await db.delete(); });
  async function reopen() {
    db.close();
    db = createJarvisDb(name, TEST_INDEXED_DB);
    await db.open();
    return createCanvasPersistenceRepository(db);
  }
  it('reopens the complete saved aggregate including its note without duplicating rows', async () => {
    const saved = document();
    await createCanvasPersistenceRepository(db).save(scope, saved, { expectedRevision: 0 });
    const fresh = await reopen();
    expect(await fresh.load(scope, saved.id)).toEqual(saved);
    expect((await fresh.list(scope)).map(doc => doc.id)).toEqual([saved.id]);
    expect(await db.canvas_documents.count()).toBe(1);
    expect(await db.canvas_objects.count()).toBe(1);
    expect(await fresh.listRevisions(scope, saved.id)).toHaveLength(1);
  });
  it('preserves the winning edit and losing recovery journal after a stale save and reopen', async () => {
    const base = document();
    const repo = createCanvasPersistenceRepository(db);
    await repo.save(scope, base, { expectedRevision: 0 });
    const winner = withTitle(base, 'S61B4D winning title', now + 1);
    await repo.save(scope, winner, { expectedRevision: base.localRevision });
    const loser = withTitle(base, 'S61B4D losing title', now + 2);
    const journal: CanvasRecoveryEntry = { schemaVersion: 1, id: 'S61B4D-recovery', documentId: loser.id, projectId: scope.projectId, ownerId: scope.ownerId, baseRevision: base.localRevision, createdAt: loser.updatedAt + 1, document: loser };
    await repo.writeRecovery(scope, journal);
    await expect(repo.save(scope, loser, { expectedRevision: base.localRevision })).rejects.toBeInstanceOf(CanvasPersistenceConflictError);
    const fresh = await reopen();
    expect(await fresh.load(scope, base.id)).toEqual(winner);
    expect(await fresh.listRecovery(scope, base.id)).toEqual([journal]);
    expect(await fresh.listRevisions(scope, base.id)).toHaveLength(2);
  });
  it('does not expose document or journal to another account/project/owner after reopening', async () => {
    const doc = document();
    const repo = createCanvasPersistenceRepository(db);
    await repo.save(scope, doc);
    await repo.writeRecovery(scope, { schemaVersion: 1, id: 'S61B4D-isolated-recovery', documentId: doc.id, projectId: scope.projectId, ownerId: scope.ownerId, baseRevision: 0, createdAt: doc.updatedAt + 1, document: doc });
    const fresh = await reopen();
    for (const other of [{ ...scope, accountId: 'S61B4D-account-b' }, { ...scope, projectId: 'S61B4D-project-b' }, { ...scope, ownerId: 'S61B4D-owner-b' }]) {
      expect(await fresh.load(other, doc.id)).toBeUndefined();
      expect(await fresh.list(other)).toEqual([]);
      expect(await fresh.listRecovery(other, doc.id)).toEqual([]);
      expect(await fresh.listRevisions(other, doc.id)).toEqual([]);
    }
    expect(await fresh.load(scope, doc.id)).toEqual(doc);
    expect(await fresh.listRecovery(scope, doc.id)).toHaveLength(1);
    expect(await fresh.listRevisions(scope, doc.id)).toHaveLength(1);
  });
});
