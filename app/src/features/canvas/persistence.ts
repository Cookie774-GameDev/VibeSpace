/**
 * Account-scoped, transactional Dexie persistence for the Infinite Idea Canvas.
 *
 * This module maps the canonical `CanvasDocument` aggregate (see `./contracts`)
 * onto the V8 `canvas_*` tables (see `@/lib/db/schema`) and exposes:
 *   - `createCanvasPersistenceRepository(db)` — a low-level repository with an
 *     atomic save/load, a recovery journal (write/clear/list), revision
 *     listing, and optimistic `expectedRevision` conflict handling.
 *   - `createCanvasPersistencePort(repository, scope)` — a `CanvasPersistencePort`
 *     adapter (see `./autosave`) bound to a fixed account/project/owner scope.
 *
 * Isolation: every read and write is scoped by `accountId` and verified against
 * `projectId`/`ownerId`. Child-row cleanup uses the compound
 * `[accountId+documentId]` index, so removing stale rows for one document can
 * never touch another document or another account.
 *
 * Order invariants: `pageOrder` and `presentationOrder` round-trip exactly.
 * `blocks` are restored in page order and `placements` keyed by block id
 * (sorted), matching the domain's own `pageOrderedBlocks`/`placementsByBlockId`
 * selectors — the blocks/placements array order is not a persisted invariant.
 *
 * `canvas_objects` keys on block id, so save preflights every incoming id
 * inside the same transaction and fails atomically if another account or
 * document already owns it. Page/spatial/revision rows use document-scoped
 * surrogate ids derived below.
 */

import {
  type CanvasCameraRow,
  type CanvasDocumentRow,
  type CanvasObjectRow,
  type CanvasPageRow,
  type CanvasRecoveryRow,
  type CanvasRevisionRow,
  type CanvasSpatialRow,
  type JarvisDexie,
} from '@/lib/db';
import {
  CanvasPersistenceConflictError,
  type CanvasPersistencePort,
  type CanvasRecoveryEntry,
  type CanvasSaveResult,
} from './autosave';
import {
  parseCanvasDocument,
  parseCanvasDocumentId,
  type CanvasDocument,
  type CanvasDocumentId,
} from './contracts';

export type CanvasPersistenceScope = {
  readonly accountId: string;
  readonly projectId: string;
  readonly ownerId: string;
};

export type CanvasPersistenceErrorCode =
  | 'account_scope_mismatch'
  | 'project_scope_mismatch'
  | 'owner_scope_mismatch'
  | 'invalid_scope'
  | 'recovery_scope_mismatch'
  | 'integrity_error';

export class CanvasPersistenceError extends Error {
  readonly code: CanvasPersistenceErrorCode;
  constructor(code: CanvasPersistenceErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CanvasPersistenceError';
    this.code = code;
  }
}

export type CanvasSaveOptions = {
  /**
   * Enables optimistic concurrency. When provided, the save rejects with
   * `CanvasPersistenceConflictError` if the currently persisted localRevision
   * (0 for a not-yet-persisted document) does not equal this value.
   */
  readonly expectedRevision?: number;
};

export type CanvasPersistenceRepository = {
  save(
    scope: CanvasPersistenceScope,
    document: CanvasDocument,
    options?: CanvasSaveOptions,
  ): Promise<CanvasDocumentRow>;
  load(scope: CanvasPersistenceScope, documentId: string): Promise<CanvasDocument | undefined>;
  list(scope: CanvasPersistenceScope): Promise<readonly CanvasDocument[]>;
  loadLatest(scope: CanvasPersistenceScope): Promise<CanvasDocument | undefined>;
  writeRecovery(scope: CanvasPersistenceScope, entry: CanvasRecoveryEntry): Promise<void>;
  clearRecovery(scope: CanvasPersistenceScope, recoveryId: string): Promise<void>;
  listRecovery(
    scope: CanvasPersistenceScope,
    documentId?: string,
  ): Promise<readonly CanvasRecoveryEntry[]>;
  listRevisions(
    scope: CanvasPersistenceScope,
    documentId: string,
  ): Promise<readonly CanvasRevisionRow[]>;
};

function assertScope(scope: CanvasPersistenceScope): void {
  if (
    typeof scope.accountId !== 'string' ||
    scope.accountId.length === 0 ||
    scope.accountId !== scope.accountId.trim()
  ) {
    throw new CanvasPersistenceError(
      'invalid_scope',
      'accountId must be a non-empty trimmed string',
    );
  }
  if (typeof scope.projectId !== 'string' || scope.projectId.length === 0) {
    throw new CanvasPersistenceError('invalid_scope', 'projectId is required');
  }
  if (typeof scope.ownerId !== 'string' || scope.ownerId.length === 0) {
    throw new CanvasPersistenceError('invalid_scope', 'ownerId is required');
  }
}

function assertDocumentMatchesScope(scope: CanvasPersistenceScope, doc: CanvasDocument): void {
  if (doc.projectId !== scope.projectId) {
    throw new CanvasPersistenceError(
      'project_scope_mismatch',
      'document projectId does not match the persistence scope',
    );
  }
  if (doc.ownerId !== scope.ownerId) {
    throw new CanvasPersistenceError(
      'owner_scope_mismatch',
      'document ownerId does not match the persistence scope',
    );
  }
}

function recoveryString(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CanvasPersistenceError('integrity_error', `${path} is invalid`);
  }
  return value;
}

function recoveryInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CanvasPersistenceError('integrity_error', `${path} is invalid`);
  }
  return value as number;
}

function parseRecoveryEntry(value: unknown): CanvasRecoveryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CanvasPersistenceError('integrity_error', 'recovery payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) {
    throw new CanvasPersistenceError(
      'integrity_error',
      'recovery payload schemaVersion is unsupported',
    );
  }
  const document = parseCanvasDocument(input.document);
  const entry = Object.freeze({
    schemaVersion: 1 as const,
    id: recoveryString(input.id, 'recovery.id'),
    documentId: parseCanvasDocumentId(input.documentId),
    projectId: recoveryString(input.projectId, 'recovery.projectId'),
    ownerId: recoveryString(input.ownerId, 'recovery.ownerId'),
    baseRevision: recoveryInteger(input.baseRevision, 'recovery.baseRevision'),
    createdAt: recoveryInteger(input.createdAt, 'recovery.createdAt'),
    document,
  });
  if (
    entry.document.id !== entry.documentId ||
    entry.document.projectId !== entry.projectId ||
    entry.document.ownerId !== entry.ownerId
  ) {
    throw new CanvasPersistenceError(
      'recovery_scope_mismatch',
      'recovery document does not match its envelope',
    );
  }
  if (entry.baseRevision > entry.document.localRevision) {
    throw new CanvasPersistenceError(
      'integrity_error',
      'recovery baseRevision cannot exceed the document localRevision',
    );
  }
  if (entry.createdAt < entry.document.updatedAt) {
    throw new CanvasPersistenceError(
      'integrity_error',
      'recovery createdAt cannot precede the document updatedAt',
    );
  }
  return entry;
}

function assertRecoveryMatchesScope(
  scope: CanvasPersistenceScope,
  entry: CanvasRecoveryEntry,
): void {
  if (entry.projectId !== scope.projectId || entry.ownerId !== scope.ownerId) {
    throw new CanvasPersistenceError(
      'recovery_scope_mismatch',
      'recovery entry project/owner does not match the persistence scope',
    );
  }
}

function recoveryRowMatchesEntry(row: CanvasRecoveryRow, entry: CanvasRecoveryEntry): boolean {
  return (
    entry.id === row.id && entry.documentId === row.documentId && entry.createdAt === row.createdAt
  );
}

function pageRowId(documentId: string, pageIndex: number): string {
  return `${documentId}:page:${pageIndex}`;
}

function spatialRowId(documentId: string, blockId: string): string {
  return `${documentId}:spatial:${blockId}`;
}

function revisionRowId(documentId: string, sequence: number): string {
  return `${documentId}:rev:${sequence}`;
}

function toDocumentRow(scope: CanvasPersistenceScope, doc: CanvasDocument): CanvasDocumentRow {
  return {
    id: doc.id,
    accountId: scope.accountId,
    ownerId: doc.ownerId,
    projectId: doc.projectId,
    schemaVersion: doc.schemaVersion,
    title: doc.title,
    icon: doc.icon,
    thumbnail: doc.thumbnail,
    layoutMode: doc.layoutMode,
    background: {
      kind: doc.background.kind,
      color: doc.background.color,
      wallpaper: doc.background.wallpaper,
    },
    localRevision: doc.localRevision,
    syncRevision: doc.syncRevision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    archivedAt: doc.archivedAt,
    deletedAt: doc.deletedAt,
  };
}

function toObjectRows(scope: CanvasPersistenceScope, doc: CanvasDocument): CanvasObjectRow[] {
  return doc.blocks.map((block) => ({
    id: block.id,
    accountId: scope.accountId,
    documentId: doc.id,
    kind: block.content.kind,
    content: block.content,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  }));
}

function toPageRows(scope: CanvasPersistenceScope, doc: CanvasDocument): CanvasPageRow[] {
  const presentationIndexByBlock = new Map<string, number>();
  const presenterNotesByBlock = new Map(
    doc.presentationNotes.map((entry) => [entry.frameId, entry.text]),
  );
  doc.presentationOrder.forEach((blockId, index) => presentationIndexByBlock.set(blockId, index));
  return doc.pageOrder.map((blockId, pageIndex) => ({
    id: pageRowId(doc.id, pageIndex),
    accountId: scope.accountId,
    documentId: doc.id,
    pageIndex,
    blockId,
    presentationIndex: presentationIndexByBlock.get(blockId) ?? null,
    presenterNotes: presenterNotesByBlock.get(blockId) ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }));
}

function toSpatialRows(scope: CanvasPersistenceScope, doc: CanvasDocument): CanvasSpatialRow[] {
  return doc.placements.map((placement) => ({
    id: spatialRowId(doc.id, placement.blockId),
    accountId: scope.accountId,
    documentId: doc.id,
    blockId: placement.blockId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    rotation: placement.rotation,
    z: placement.z,
    updatedAt: doc.updatedAt,
  }));
}

function toCameraRow(scope: CanvasPersistenceScope, doc: CanvasDocument): CanvasCameraRow {
  return {
    documentId: doc.id,
    accountId: scope.accountId,
    x: doc.camera.x,
    y: doc.camera.y,
    zoom: doc.camera.zoom,
    updatedAt: doc.updatedAt,
  };
}

function toRevisionRow(
  scope: CanvasPersistenceScope,
  doc: CanvasDocument,
  changeKind: 'created' | 'updated',
): CanvasRevisionRow {
  return {
    id: revisionRowId(doc.id, doc.localRevision),
    accountId: scope.accountId,
    documentId: doc.id,
    sequence: doc.localRevision,
    localRevision: doc.localRevision,
    syncRevision: doc.syncRevision,
    changeKind,
    snapshotAssetId: null,
    contentHash: null,
    createdAt: doc.updatedAt,
  };
}

export function createCanvasPersistenceRepository(db: JarvisDexie): CanvasPersistenceRepository {
  const save: CanvasPersistenceRepository['save'] = async (scope, document, options = {}) => {
    assertScope(scope);
    const doc = parseCanvasDocument(document);
    assertDocumentMatchesScope(scope, doc);
    const expectedRevision = options.expectedRevision;

    return db.transaction(
      'rw',
      [
        db.canvas_documents,
        db.canvas_objects,
        db.canvas_pages,
        db.canvas_spatial,
        db.canvas_cameras,
        db.canvas_revisions,
      ],
      async () => {
        const existing = await db.canvas_documents.get(doc.id);
        if (existing) {
          if (existing.accountId !== scope.accountId) {
            throw new CanvasPersistenceError(
              'account_scope_mismatch',
              'cannot overwrite a document owned by another account',
            );
          }
          if (existing.projectId !== scope.projectId) {
            throw new CanvasPersistenceError(
              'project_scope_mismatch',
              'persisted document project does not match the scope',
            );
          }
          if (existing.ownerId !== scope.ownerId) {
            throw new CanvasPersistenceError(
              'owner_scope_mismatch',
              'persisted document owner does not match the scope',
            );
          }
        }

        const currentRevision = existing?.localRevision ?? 0;
        if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
          throw new CanvasPersistenceConflictError(
            `Canvas revision conflict: expected ${expectedRevision}, persisted ${currentRevision}`,
          );
        }

        const documentRow = toDocumentRow(scope, doc);
        const changeKind: 'created' | 'updated' = existing ? 'updated' : 'created';
        const objectRows = toObjectRows(scope, doc);

        for (const candidate of objectRows) {
          const owner = await db.canvas_objects.get(candidate.id);
          if (owner && (owner.accountId !== scope.accountId || owner.documentId !== doc.id)) {
            throw new CanvasPersistenceError(
              'integrity_error',
              `canvas object "${candidate.id}" is already owned by another document`,
            );
          }
        }

        // Remove stale child rows scoped to exactly this account+document, then
        // write the fresh set. The compound index guarantees no other document
        // or account is touched.
        await db.canvas_objects
          .where('[accountId+documentId]')
          .equals([scope.accountId, doc.id])
          .delete();
        await db.canvas_pages
          .where('[accountId+documentId]')
          .equals([scope.accountId, doc.id])
          .delete();
        await db.canvas_spatial
          .where('[accountId+documentId]')
          .equals([scope.accountId, doc.id])
          .delete();

        await db.canvas_documents.put(documentRow);
        await db.canvas_objects.bulkPut(objectRows);
        await db.canvas_pages.bulkPut(toPageRows(scope, doc));
        await db.canvas_spatial.bulkPut(toSpatialRows(scope, doc));
        await db.canvas_cameras.put(toCameraRow(scope, doc));
        await db.canvas_revisions.put(toRevisionRow(scope, doc, changeKind));

        return documentRow;
      },
    );
  };

  const load: CanvasPersistenceRepository['load'] = async (scope, documentId) => {
    assertScope(scope);
    const docId: CanvasDocumentId = parseCanvasDocumentId(documentId);

    return db.transaction(
      'r',
      [
        db.canvas_documents,
        db.canvas_objects,
        db.canvas_pages,
        db.canvas_spatial,
        db.canvas_cameras,
      ],
      async () => {
        const docRow = await db.canvas_documents.get(docId);
        if (!docRow) return undefined;
        if (docRow.accountId !== scope.accountId) return undefined;
        if (docRow.projectId !== scope.projectId) return undefined;
        if (docRow.ownerId !== scope.ownerId) return undefined;

        const objectRows = await db.canvas_objects
          .where('[accountId+documentId]')
          .equals([scope.accountId, docId])
          .toArray();
        const pageRows = await db.canvas_pages
          .where('[accountId+documentId]')
          .equals([scope.accountId, docId])
          .toArray();
        const spatialRows = await db.canvas_spatial
          .where('[accountId+documentId]')
          .equals([scope.accountId, docId])
          .toArray();
        const cameraRow = await db.canvas_cameras.get(docId);
        if (cameraRow && cameraRow.accountId !== scope.accountId) return undefined;

        const objectsById = new Map(objectRows.map((row) => [row.id, row]));
        const sortedPages = [...pageRows].sort((a, b) => a.pageIndex - b.pageIndex);
        const blocks = sortedPages.map((pageRow) => {
          const object = objectsById.get(pageRow.blockId);
          if (!object) {
            throw new CanvasPersistenceError(
              'integrity_error',
              `canvas page references missing object "${pageRow.blockId}"`,
            );
          }
          return {
            id: object.id,
            content: object.content,
            createdAt: object.createdAt,
            updatedAt: object.updatedAt,
          };
        });
        const pageOrder = sortedPages.map((pageRow) => pageRow.blockId);
        const presentationOrder = pageRows
          .filter(
            (row): row is CanvasPageRow & { presentationIndex: number } =>
              row.presentationIndex !== null,
          )
          .sort((a, b) => a.presentationIndex - b.presentationIndex)
          .map((row) => row.blockId);
        const presentationNotes = pageRows
          .filter(
            (row): row is CanvasPageRow & { presentationIndex: number; presenterNotes: string } =>
              row.presentationIndex !== null &&
              typeof row.presenterNotes === 'string' &&
              row.presenterNotes.length > 0,
          )
          .sort((a, b) => a.presentationIndex - b.presentationIndex)
          .map((row) => ({ frameId: row.blockId, text: row.presenterNotes }));
        const placements = spatialRows
          .map((row) => ({
            blockId: row.blockId,
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
            rotation: row.rotation,
            z: row.z,
          }))
          .sort((a, b) => (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
        const camera = cameraRow
          ? { x: cameraRow.x, y: cameraRow.y, zoom: cameraRow.zoom }
          : { x: 0, y: 0, zoom: 1 };

        return parseCanvasDocument({
          schemaVersion: docRow.schemaVersion,
          id: docRow.id,
          projectId: docRow.projectId,
          ownerId: docRow.ownerId,
          title: docRow.title,
          icon: docRow.icon,
          thumbnail: docRow.thumbnail,
          layoutMode: docRow.layoutMode,
          camera,
          background: {
            kind: docRow.background.kind,
            color: docRow.background.color,
            wallpaper: docRow.background.wallpaper,
          },
          blocks,
          pageOrder,
          placements,
          presentationOrder,
          presentationNotes,
          localRevision: docRow.localRevision,
          syncRevision: docRow.syncRevision,
          createdAt: docRow.createdAt,
          updatedAt: docRow.updatedAt,
          archivedAt: docRow.archivedAt,
          deletedAt: docRow.deletedAt,
        });
      },
    );
  };

  const list: CanvasPersistenceRepository['list'] = async (scope) => {
    assertScope(scope);
    const candidates = await db.canvas_documents
      .where('[accountId+projectId]')
      .equals([scope.accountId, scope.projectId])
      .toArray();
    candidates.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    const loaded = await Promise.all(
      candidates.filter((row) => row.ownerId === scope.ownerId).map((row) => load(scope, row.id)),
    );
    return Object.freeze(
      loaded.filter((document): document is CanvasDocument => document !== undefined),
    );
  };

  const loadLatest: CanvasPersistenceRepository['loadLatest'] = async (scope) => {
    assertScope(scope);
    const candidates = await db.canvas_documents
      .where('[accountId+projectId]')
      .equals([scope.accountId, scope.projectId])
      .toArray();
    const latest = candidates
      .filter((row) => row.ownerId === scope.ownerId && row.deletedAt === null)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )[0];
    return latest ? load(scope, latest.id) : undefined;
  };

  const writeRecovery: CanvasPersistenceRepository['writeRecovery'] = async (scope, entry) => {
    assertScope(scope);
    const parsed = parseRecoveryEntry(entry);
    assertRecoveryMatchesScope(scope, parsed);
    const row: CanvasRecoveryRow = {
      id: parsed.id,
      accountId: scope.accountId,
      documentId: parseCanvasDocumentId(parsed.documentId),
      kind: 'canvas',
      status: 'pending',
      snapshotAssetId: null,
      payload: parsed,
      contentHash: null,
      createdAt: parsed.createdAt,
      recoveredAt: null,
    };
    await db.canvas_recovery.put(row);
  };

  const clearRecovery: CanvasPersistenceRepository['clearRecovery'] = async (scope, recoveryId) => {
    assertScope(scope);
    return db.transaction('rw', db.canvas_recovery, async () => {
      const row = await db.canvas_recovery.get(recoveryId);
      if (!row) return;
      if (row.accountId !== scope.accountId) {
        throw new CanvasPersistenceError(
          'account_scope_mismatch',
          'cannot clear a recovery entry owned by another account',
        );
      }
      const parsed = parseRecoveryEntry(row.payload);
      assertRecoveryMatchesScope(scope, parsed);
      if (!recoveryRowMatchesEntry(row, parsed)) {
        throw new CanvasPersistenceError(
          'integrity_error',
          'recovery row metadata does not match its payload',
        );
      }
      await db.canvas_recovery.delete(recoveryId);
    });
  };

  const listRecovery: CanvasPersistenceRepository['listRecovery'] = async (scope, documentId) => {
    assertScope(scope);
    const docId = documentId === undefined ? undefined : parseCanvasDocumentId(documentId);
    const rows =
      docId === undefined
        ? await db.canvas_recovery.where('accountId').equals(scope.accountId).toArray()
        : await db.canvas_recovery
            .where('[accountId+documentId]')
            .equals([scope.accountId, docId])
            .toArray();
    const valid: CanvasRecoveryEntry[] = [];
    for (const row of rows) {
      if (row.kind !== 'canvas' || row.status !== 'pending') continue;
      try {
        const entry = parseRecoveryEntry(row.payload);
        assertRecoveryMatchesScope(scope, entry);
        if (
          !recoveryRowMatchesEntry(row, entry) ||
          (docId !== undefined && entry.documentId !== docId)
        ) {
          continue;
        }
        valid.push(entry);
      } catch {
        // Corrupt or cross-scope journal rows are quarantined from recovery UI.
      }
    }
    valid.sort(
      (left, right) =>
        right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    const deduplicated: CanvasRecoveryEntry[] = [];
    const revisions = new Set<string>();
    for (const entry of valid) {
      const key = `${entry.documentId}\u0000${entry.document.localRevision}`;
      if (revisions.has(key)) continue;
      revisions.add(key);
      deduplicated.push(entry);
    }
    return Object.freeze(deduplicated);
  };

  const listRevisions: CanvasPersistenceRepository['listRevisions'] = async (scope, documentId) => {
    assertScope(scope);
    const docId: CanvasDocumentId = parseCanvasDocumentId(documentId);
    const rows = await db.canvas_revisions
      .where('[accountId+documentId]')
      .equals([scope.accountId, docId])
      .toArray();
    return [...rows].sort((a, b) => a.sequence - b.sequence);
  };

  return {
    save,
    load,
    list,
    loadLatest,
    writeRecovery,
    clearRecovery,
    listRecovery,
    listRevisions,
  };
}

export function createCanvasPersistencePort(
  repository: CanvasPersistenceRepository,
  scope: CanvasPersistenceScope,
): CanvasPersistencePort {
  assertScope(scope);
  return {
    async writeRecovery(entry) {
      await repository.writeRecovery(scope, entry);
    },
    async saveDocument(request): Promise<CanvasSaveResult> {
      const saved = await repository.save(scope, request.document, {
        expectedRevision: request.expectedRevision,
      });
      return { status: 'saved', persistedRevision: saved.localRevision };
    },
    async clearRecovery(recoveryId) {
      await repository.clearRecovery(scope, recoveryId);
    },
  };
}
