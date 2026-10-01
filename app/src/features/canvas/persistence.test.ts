import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import {
  createCanvasBlock,
  createCanvasDocument,
  parseCanvasDocument,
  parseCanvasBlockId,
  withBlockAdded,
  withBlockRemoved,
  withCamera,
  withPageOrder,
  withPlacement,
  withPresentationNote,
  withPresentationOrder,
  withTitle,
  withoutPlacement,
  type CanvasDocument,
} from './contracts';
import {
  CanvasPersistenceConflictError,
  createCanvasAutosaveController,
  type CanvasRecoveryEntry,
} from './autosave';
import {
  CanvasPersistenceError,
  createCanvasPersistencePort,
  createCanvasPersistenceRepository,
  type CanvasPersistenceRepository,
  type CanvasPersistenceScope,
} from './persistence';

const NOW = 1_700_000_000_000;

function makeScope(overrides: Partial<CanvasPersistenceScope> = {}): CanvasPersistenceScope {
  return {
    accountId: 'acct_alpha',
    projectId: 'proj_one',
    ownerId: 'owner_one',
    ...overrides,
  };
}

/**
 * Builds a valid document with three blocks (page order == block order), one
 * edgeless placement on the middle block, and a non-default camera. `prefix`
 * namespaces block ids so multiple documents can coexist in one database
 * (canvas_objects keys on the globally-unique block id).
 */
function buildDocument(
  scope: CanvasPersistenceScope,
  id: string,
  prefix: string,
  now: number = NOW,
): CanvasDocument {
  let doc = createCanvasDocument({ id, projectId: scope.projectId, ownerId: scope.ownerId, now });
  doc = withBlockAdded(
    doc,
    createCanvasBlock({
      id: `${prefix}A`,
      content: { kind: 'heading', level: 1, text: 'Title' },
      now,
    }),
    now,
  );
  doc = withBlockAdded(
    doc,
    createCanvasBlock({ id: `${prefix}B`, content: { kind: 'text', text: 'hello' }, now }),
    now,
  );
  doc = withBlockAdded(
    doc,
    createCanvasBlock({ id: `${prefix}C`, content: { kind: 'note', text: 'a note' }, now }),
    now,
  );
  doc = withPlacement(
    doc,
    { blockId: `${prefix}B`, x: 10, y: 20, width: 100, height: 50, rotation: 0, z: 0 },
    now,
  );
  doc = withCamera(doc, { x: 5, y: 6, zoom: 2 });
  return doc;
}

function recoveryEntry(
  scope: CanvasPersistenceScope,
  doc: CanvasDocument,
  id: string,
  baseRevision = 0,
): CanvasRecoveryEntry {
  return {
    schemaVersion: 1,
    id,
    documentId: doc.id,
    projectId: scope.projectId,
    ownerId: scope.ownerId,
    baseRevision,
    createdAt: doc.updatedAt + 1,
    document: doc,
  };
}

/**
 * Order-insensitive comparator for blocks/placements (the schema persists
 * pageOrder as canonical and placements keyed by block id) while keeping every
 * other field, including pageOrder/presentationOrder, order-sensitive.
 */
function canonical(doc: CanvasDocument) {
  const byKey = (a: { id?: string; blockId?: string }, b: { id?: string; blockId?: string }) => {
    const ka = a.id ?? a.blockId ?? '';
    const kb = b.id ?? b.blockId ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  return {
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    projectId: doc.projectId,
    ownerId: doc.ownerId,
    title: doc.title,
    icon: doc.icon,
    thumbnail: doc.thumbnail,
    layoutMode: doc.layoutMode,
    camera: doc.camera,
    background: doc.background,
    pageOrder: doc.pageOrder,
    presentationOrder: doc.presentationOrder,
    presentationNotes: doc.presentationNotes,
    localRevision: doc.localRevision,
    syncRevision: doc.syncRevision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    archivedAt: doc.archivedAt,
    deletedAt: doc.deletedAt,
    blocks: [...doc.blocks].sort(byKey),
    placements: [...doc.placements].sort(byKey),
  };
}

describe('canvas Dexie persistence repository', () => {
  let db: JarvisDexie;
  let repo: CanvasPersistenceRepository;

  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('canvas-persistence'), TEST_INDEXED_DB);
    await db.open();
    repo = createCanvasPersistenceRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('round-trip', () => {
    it('saves and loads canonical metadata, objects, page order, placements and camera', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docRound', 'block');
      await repo.save(scope, doc);
      const loaded = await repo.load(scope, doc.id);
      expect(loaded).toBeDefined();
      expect(canonical(loaded!)).toEqual(canonical(doc));
    });

    it('round-trips a different ambience wallpaper for each Canvas document', async () => {
      const scope = makeScope();
      const first = parseCanvasDocument({
        ...buildDocument(scope, 'docAmbienceOne', 'ambience-one'),
        background: {
          kind: 'plain',
          color: '#ffffff',
          wallpaper: {
            id: 'warm-gradient',
            paused: false,
            interactive: true,
            intensity: 0.8,
            brightness: 0.65,
            quality: 'high',
          },
        },
      });
      const second = parseCanvasDocument({
        ...buildDocument(scope, 'docAmbienceTwo', 'ambience-two'),
        background: {
          kind: 'grid',
          color: '#101820',
          wallpaper: {
            id: 'aurora',
            paused: true,
            interactive: false,
            intensity: 0.4,
            brightness: 0.3,
            quality: 'low',
          },
        },
      });

      await repo.save(scope, first);
      await repo.save(scope, second);

      await expect(repo.load(scope, first.id)).resolves.toMatchObject({
        background: { wallpaper: first.background.wallpaper },
      });
      await expect(repo.load(scope, second.id)).resolves.toMatchObject({
        background: { wallpaper: second.background.wallpaper },
      });
    });

    it('writes one revision row per distinct saved revision', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docRev', 'block');
      await repo.save(scope, doc);
      const newer = withTitle(doc, 'Renamed', doc.updatedAt + 1);
      await repo.save(scope, newer, { expectedRevision: doc.localRevision });
      const revisions = await repo.listRevisions(scope, doc.id);
      expect(revisions.map((r) => r.sequence)).toEqual([doc.localRevision, newer.localRevision]);
      expect(revisions.every((r) => r.accountId === scope.accountId)).toBe(true);
      expect(revisions.map((r) => r.changeKind)).toEqual(['created', 'updated']);
    });

    it('returns undefined for an unknown document', async () => {
      expect(await repo.load(makeScope(), 'missing-doc')).toBeUndefined();
    });

    it('loads the newest active document in the current account and project scope', async () => {
      const scope = makeScope();
      const older = buildDocument(scope, 'docOlder', 'older-block', NOW);
      const newer = buildDocument(scope, 'docNewer', 'newer-block', NOW + 100);
      const deleted = parseCanvasDocument({
        ...buildDocument(scope, 'docDeleted', 'deleted-block', NOW + 200),
        deletedAt: NOW + 201,
      });
      await repo.save(scope, older);
      await repo.save(scope, newer);
      await repo.save(scope, deleted);

      await expect(repo.loadLatest(scope)).resolves.toMatchObject({
        id: newer.id,
        updatedAt: newer.updatedAt,
      });
      await expect(repo.loadLatest(makeScope({ accountId: 'acct_beta' }))).resolves.toBeUndefined();
    });

    it('lists only documents in the exact account, project, and owner scope', async () => {
      const scope = makeScope();
      const older = buildDocument(scope, 'docListOlder', 'list-older', NOW);
      const newer = buildDocument(scope, 'docListNewer', 'list-newer', NOW + 100);
      const otherProjectScope = makeScope({ projectId: 'proj_two' });
      const otherOwnerScope = makeScope({ ownerId: 'owner_two' });
      await repo.save(scope, older);
      await repo.save(scope, newer);
      await repo.save(
        otherProjectScope,
        buildDocument(otherProjectScope, 'docOtherProject', 'other-project', NOW + 200),
      );
      await repo.save(
        otherOwnerScope,
        buildDocument(otherOwnerScope, 'docOtherOwner', 'other-owner', NOW + 300),
      );

      const listed = await repo.list(scope);

      expect(listed.map((document) => document.id)).toEqual([newer.id, older.id]);
      expect(listed.every((document) => document.projectId === scope.projectId)).toBe(true);
      expect(listed.every((document) => document.ownerId === scope.ownerId)).toBe(true);
    });

    it('preserves page order and presentation order exactly across a reorder', async () => {
      const scope = makeScope();
      let doc = buildDocument(scope, 'docOrder', 'block');
      doc = withPageOrder(doc, [...doc.pageOrder].reverse(), doc.updatedAt + 1);
      doc = withPresentationOrder(doc, [doc.pageOrder[1], doc.pageOrder[0]], doc.updatedAt + 1);
      doc = withPresentationNote(
        doc,
        doc.presentationOrder[0],
        'Explain why this frame comes first',
        doc.updatedAt + 1,
      );
      await repo.save(scope, doc);
      const loaded = await repo.load(scope, doc.id);
      expect(loaded!.pageOrder).toEqual(doc.pageOrder);
      expect(loaded!.presentationOrder).toEqual(doc.presentationOrder);
      expect(loaded!.presentationNotes).toEqual(doc.presentationNotes);
      expect([...loaded!.blocks].map((b) => b.id).sort()).toEqual(
        [...doc.blocks].map((b) => b.id).sort(),
      );
    });
  });

  describe('stale child-row removal', () => {
    it('removes objects and placements that no longer exist without leaving stale rows', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docStale', 'block');
      await repo.save(scope, doc);
      let next = withBlockRemoved(doc, 'blockC', doc.updatedAt + 1);
      next = withoutPlacement(next, 'blockB', doc.updatedAt + 1);
      await repo.save(scope, next, { expectedRevision: doc.localRevision });
      const loaded = await repo.load(scope, doc.id);
      expect(loaded!.blocks.map((b) => b.id).sort()).toEqual(['blockA', 'blockB']);
      expect(loaded!.placements).toHaveLength(0);
      expect(loaded!.localRevision).toBe(next.localRevision);
      const objectRows = await db.canvas_objects
        .where('[accountId+documentId]')
        .equals([scope.accountId, doc.id])
        .toArray();
      expect(objectRows.map((r) => r.id).sort()).toEqual(['blockA', 'blockB']);
      const spatialRows = await db.canvas_spatial
        .where('[accountId+documentId]')
        .equals([scope.accountId, doc.id])
        .toArray();
      expect(spatialRows).toHaveLength(0);
    });

    it('does not touch sibling documents in the same account when removing stale rows', async () => {
      const scope = makeScope();
      const docA = buildDocument(scope, 'docA', 'a-block');
      const docB = buildDocument(scope, 'docB', 'b-block');
      await repo.save(scope, docA);
      await repo.save(scope, docB);
      const docA2 = withBlockRemoved(docA, 'a-blockC', docA.updatedAt + 1);
      await repo.save(scope, docA2, { expectedRevision: docA.localRevision });
      const loadedB = await repo.load(scope, docB.id);
      expect(loadedB!.blocks).toHaveLength(3);
      const bObjects = await db.canvas_objects
        .where('[accountId+documentId]')
        .equals([scope.accountId, docB.id])
        .toArray();
      expect(bObjects).toHaveLength(3);
    });

    it('atomically rejects a block id already owned by another document', async () => {
      const scope = makeScope();
      const first = buildDocument(scope, 'docCollisionA', 'shared-block');
      const second = buildDocument(scope, 'docCollisionB', 'shared-block', NOW + 100);
      await repo.save(scope, first);

      await expect(repo.save(scope, second)).rejects.toMatchObject({
        code: 'integrity_error',
      });
      await expect(repo.load(scope, first.id)).resolves.toBeDefined();
      await expect(repo.load(scope, second.id)).resolves.toBeUndefined();
      expect(
        await db.canvas_objects
          .where('[accountId+documentId]')
          .equals([scope.accountId, first.id])
          .count(),
      ).toBe(3);
    });

    it('atomically rejects a block id already owned by another account', async () => {
      const firstScope = makeScope();
      const secondScope = makeScope({
        accountId: 'acct_beta',
        projectId: 'proj_beta',
        ownerId: 'owner_beta',
      });
      const first = buildDocument(firstScope, 'docAccountA', 'shared-block');
      const second = buildDocument(secondScope, 'docAccountB', 'shared-block', NOW + 100);
      await repo.save(firstScope, first);

      await expect(repo.save(secondScope, second)).rejects.toMatchObject({
        code: 'integrity_error',
      });
      await expect(repo.load(firstScope, first.id)).resolves.toBeDefined();
      await expect(repo.load(secondScope, second.id)).resolves.toBeUndefined();
    });
  });

  describe('optimistic concurrency', () => {
    it('rejects a save whose expectedRevision does not match the persisted revision', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docConflict', 'block');
      await repo.save(scope, doc);
      const newer = withTitle(doc, 'Changed', doc.updatedAt + 1);
      await expect(repo.save(scope, newer, { expectedRevision: 999 })).rejects.toBeInstanceOf(
        CanvasPersistenceConflictError,
      );
      await expect(
        repo.save(scope, newer, { expectedRevision: doc.localRevision - 1 }),
      ).rejects.toBeInstanceOf(CanvasPersistenceConflictError);
      await expect(
        repo.save(scope, newer, { expectedRevision: doc.localRevision }),
      ).resolves.toBeDefined();
    });

    it('rolls back the whole transaction when a conflict aborts the save', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docRollback', 'block');
      await repo.save(scope, doc);
      const changed = withBlockAdded(
        doc,
        createCanvasBlock({
          id: 'blockZ',
          content: { kind: 'text', text: 'z' },
          now: doc.updatedAt + 1,
        }),
        doc.updatedAt + 1,
      );
      await expect(repo.save(scope, changed, { expectedRevision: 0 })).rejects.toBeInstanceOf(
        CanvasPersistenceConflictError,
      );
      const after = await repo.load(scope, doc.id);
      expect(canonical(after!)).toEqual(canonical(doc));
      expect(await db.canvas_objects.get(parseCanvasBlockId('blockZ'))).toBeUndefined();
    });
  });

  describe('recovery journal', () => {
    it('writes, lists and clears recovery entries', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docRecovery', 'block');
      await repo.writeRecovery(scope, recoveryEntry(scope, doc, 'rec-1'));
      let list = await repo.listRecovery(scope, doc.id);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('rec-1');
      expect(list[0].document.id).toBe(doc.id);
      await repo.clearRecovery(scope, 'rec-1');
      list = await repo.listRecovery(scope, doc.id);
      expect(list).toHaveLength(0);
    });

    it('clearing an unknown recovery id is a no-op', async () => {
      await expect(repo.clearRecovery(makeScope(), 'does-not-exist')).resolves.toBeUndefined();
    });

    it('lists scope-wide recovery newest-first and deduplicates a document revision', async () => {
      const scope = makeScope();
      const first = buildDocument(scope, 'docRecoveryA', 'first-block');
      const second = buildDocument(scope, 'docRecoveryB', 'second-block', NOW + 100);
      const older = recoveryEntry(scope, first, 'rec-old', first.localRevision);
      const newer = { ...older, id: 'rec-new', createdAt: older.createdAt + 10 };
      await repo.writeRecovery(scope, older);
      await repo.writeRecovery(scope, newer);
      await repo.writeRecovery(scope, recoveryEntry(scope, second, 'rec-second'));

      const entries = await repo.listRecovery(scope);
      expect(entries.map((entry) => entry.id)).toEqual(['rec-second', 'rec-new']);
    });

    it('rejects malformed writes and excludes corrupt or cross-scope recovery rows', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docRecoveryValidation', 'block');
      await expect(
        repo.writeRecovery(scope, {
          ...recoveryEntry(scope, doc, 'rec-malformed'),
          document: { ...doc, pageOrder: ['missing-block'] },
        } as never),
      ).rejects.toBeDefined();
      await expect(
        repo.writeRecovery(scope, {
          ...recoveryEntry(scope, doc, 'rec-future-base'),
          baseRevision: doc.localRevision + 1,
        }),
      ).rejects.toBeInstanceOf(CanvasPersistenceError);
      await expect(
        repo.writeRecovery(scope, {
          ...recoveryEntry(scope, doc, 'rec-before-document'),
          createdAt: doc.updatedAt - 1,
        }),
      ).rejects.toBeInstanceOf(CanvasPersistenceError);

      const valid = recoveryEntry(scope, doc, 'rec-valid');
      await repo.writeRecovery(scope, valid);
      await db.canvas_recovery.bulkPut([
        {
          id: 'rec-corrupt',
          accountId: scope.accountId,
          documentId: doc.id,
          kind: 'canvas',
          status: 'pending',
          snapshotAssetId: null,
          payload: { ...valid, id: 'rec-corrupt', document: { nope: true } },
          contentHash: null,
          createdAt: valid.createdAt + 2,
          recoveredAt: null,
        },
        {
          id: 'rec-cross-scope',
          accountId: scope.accountId,
          documentId: doc.id,
          kind: 'canvas',
          status: 'pending',
          snapshotAssetId: null,
          payload: { ...valid, id: 'rec-cross-scope', projectId: 'proj_other' },
          contentHash: null,
          createdAt: valid.createdAt + 3,
          recoveredAt: null,
        },
        {
          id: 'rec-row-timestamp-mismatch',
          accountId: scope.accountId,
          documentId: doc.id,
          kind: 'canvas',
          status: 'pending',
          snapshotAssetId: null,
          payload: { ...valid, id: 'rec-row-timestamp-mismatch' },
          contentHash: null,
          createdAt: valid.createdAt + 4,
          recoveredAt: null,
        },
      ]);

      await expect(repo.listRecovery(scope)).resolves.toEqual([valid]);
    });
  });

  describe('account/project/owner isolation', () => {
    it('never loads a document under a different account, project or owner', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docIso', 'block');
      await repo.save(scope, doc);
      expect(await repo.load(makeScope({ accountId: 'acct_beta' }), doc.id)).toBeUndefined();
      expect(await repo.load(makeScope({ projectId: 'proj_other' }), doc.id)).toBeUndefined();
      expect(await repo.load(makeScope({ ownerId: 'owner_other' }), doc.id)).toBeUndefined();
    });

    it('rejects saving a document whose project or owner does not match the scope', async () => {
      const scope = makeScope();
      const doc = buildDocument(scope, 'docScopeGuard', 'block');
      await expect(repo.save(makeScope({ projectId: 'proj_other' }), doc)).rejects.toBeInstanceOf(
        CanvasPersistenceError,
      );
      await expect(repo.save(makeScope({ ownerId: 'owner_other' }), doc)).rejects.toBeInstanceOf(
        CanvasPersistenceError,
      );
    });

    it('rejects blank account ids', async () => {
      const doc = buildDocument(makeScope(), 'docBlankAcct', 'block');
      await expect(repo.save(makeScope({ accountId: '   ' }), doc)).rejects.toBeInstanceOf(
        CanvasPersistenceError,
      );
    });

    it('isolates recovery entries by account', async () => {
      const scopeA = makeScope();
      const scopeB = makeScope({ accountId: 'acct_beta' });
      const doc = buildDocument(scopeA, 'docRecIso', 'block');
      await repo.save(scopeA, doc);
      await repo.writeRecovery(scopeA, recoveryEntry(scopeA, doc, 'rec-iso'));
      expect(await repo.listRecovery(scopeB, doc.id)).toHaveLength(0);
      await expect(repo.clearRecovery(scopeB, 'rec-iso')).rejects.toBeInstanceOf(
        CanvasPersistenceError,
      );
      expect(await repo.listRecovery(scopeA, doc.id)).toHaveLength(1);
    });

    it('isolates revision listing by account', async () => {
      const scopeA = makeScope();
      const doc = buildDocument(scopeA, 'docRevIso', 'block');
      await repo.save(scopeA, doc);
      expect(await repo.listRevisions(makeScope({ accountId: 'acct_beta' }), doc.id)).toHaveLength(
        0,
      );
      expect(await repo.listRevisions(scopeA, doc.id)).toHaveLength(1);
    });
  });

  describe('CanvasPersistencePort adapter', () => {
    it('persists through the port and reports the persisted revision', async () => {
      const scope = makeScope();
      const port = createCanvasPersistencePort(repo, scope);
      const doc = buildDocument(scope, 'docPort', 'block');
      const result = await port.saveDocument({
        document: doc,
        expectedRevision: 0,
        recoveryId: 'rec-x',
      });
      expect(result.status).toBe('saved');
      expect(result.persistedRevision).toBe(doc.localRevision);
      const loaded = await repo.load(scope, doc.id);
      expect(canonical(loaded!)).toEqual(canonical(doc));
    });

    it('surfaces a conflict through the port when the base revision is stale', async () => {
      const scope = makeScope();
      const port = createCanvasPersistencePort(repo, scope);
      const doc = buildDocument(scope, 'docPortConflict', 'block');
      await port.saveDocument({ document: doc, expectedRevision: 0, recoveryId: 'rec-1' });
      const newer = withTitle(doc, 'Changed', doc.updatedAt + 1);
      await expect(
        port.saveDocument({ document: newer, expectedRevision: 0, recoveryId: 'rec-2' }),
      ).rejects.toBeInstanceOf(CanvasPersistenceConflictError);
    });

    it('writes recovery before saving and clears it only after success', async () => {
      const scope = makeScope();
      const port = createCanvasPersistencePort(repo, scope);
      const doc = buildDocument(scope, 'docPortRecovery', 'block');
      await port.writeRecovery(recoveryEntry(scope, doc, 'rec-flow'));
      expect(await repo.listRecovery(scope, doc.id)).toHaveLength(1);
      await port.saveDocument({ document: doc, expectedRevision: 0, recoveryId: 'rec-flow' });
      await port.clearRecovery('rec-flow');
      expect(await repo.listRecovery(scope, doc.id)).toHaveLength(0);
    });

    it('drives the real autosave controller to a durable save', async () => {
      const scope = makeScope();
      const port = createCanvasPersistencePort(repo, scope);
      const baseline = buildDocument(scope, 'docController', 'block');
      await repo.save(scope, baseline);
      const controller = createCanvasAutosaveController({
        persistence: port,
        initialRevision: baseline.localRevision,
        delayMs: 1,
      });
      const edited = withTitle(baseline, 'Autosaved', baseline.updatedAt + 1);
      controller.schedule(edited);
      await controller.flush();
      const loaded = await repo.load(scope, baseline.id);
      expect(loaded!.title).toBe('Autosaved');
      expect(loaded!.localRevision).toBe(edited.localRevision);
      expect(await repo.listRecovery(scope, baseline.id)).toHaveLength(0);
      controller.dispose();
    });
  });
});
