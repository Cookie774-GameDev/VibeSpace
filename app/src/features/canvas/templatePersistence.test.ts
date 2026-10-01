import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createCanvasBlock, createCanvasDocument, withBlockAdded } from './contracts';
import {
  createCustomCanvasTemplateStore,
  deleteCustomTemplate,
  renameCustomTemplate,
  saveCanvasDocumentAsTemplate,
} from './templates';
import {
  CanvasTemplatePersistenceError,
  createCanvasTemplatePersistenceRepository,
  type CanvasTemplatePersistenceScope,
} from './templatePersistence';

const SCOPE: CanvasTemplatePersistenceScope = {
  accountId: 'account-a',
  ownerId: 'account-a',
  projectId: 'project-a',
};

function brandedScope(ownerId: string, projectId: string) {
  const document = createCanvasDocument({
    id: `scope-${ownerId}-${projectId}`,
    ownerId,
    projectId,
    now: 1,
  });
  return { ownerId: document.ownerId, projectId: document.projectId };
}

const ROW_SCOPE = brandedScope(SCOPE.ownerId, SCOPE.projectId);
const OTHER_OWNER_SCOPE = brandedScope('owner-other', SCOPE.projectId);
const OTHER_ACCOUNT_SCOPE = brandedScope('account-other', 'project-other');

function sourceDocument(text = 'Durable idea') {
  const base = createCanvasDocument({
    id: 'source-canvas',
    ownerId: SCOPE.ownerId,
    projectId: SCOPE.projectId,
    title: 'Team board',
    now: 10,
  });
  return withBlockAdded(
    base,
    createCanvasBlock({
      id: 'source-note',
      content: { kind: 'note', text },
      now: 10,
    }),
    10,
  );
}

function savedStore(templateId = 'template-a', text = 'Durable idea') {
  return saveCanvasDocumentAsTemplate(createCustomCanvasTemplateStore(), {
    source: sourceDocument(text),
    templateId,
    ownerId: SCOPE.ownerId,
    projectId: SCOPE.projectId,
    title: 'Team board',
    now: 20,
  }).store;
}

describe('CanvasTemplatePersistenceRepository', () => {
  let database: JarvisDexie;

  beforeEach(async () => {
    database = createJarvisDb(uniqueTestDbName('canvas-template-persistence'), TEST_INDEXED_DB);
    await database.open();
  });

  afterEach(async () => {
    await database.delete();
  });

  it('loads only the exact account, owner, and project scope as detached frozen domain data', async () => {
    const storedTemplate = savedStore().templates[0]!;
    await database.canvas_templates.bulkAdd([
      {
        id: 'template-a',
        accountId: SCOPE.accountId,
        ownerId: ROW_SCOPE.ownerId,
        projectId: ROW_SCOPE.projectId,
        name: 'Team board',
        layoutMode: storedTemplate.snapshot.layoutMode,
        background: storedTemplate.snapshot.background,
        snapshot: storedTemplate.snapshot,
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: 'template-other-owner',
        accountId: SCOPE.accountId,
        ownerId: OTHER_OWNER_SCOPE.ownerId,
        projectId: OTHER_OWNER_SCOPE.projectId,
        name: 'Private board',
        layoutMode: storedTemplate.snapshot.layoutMode,
        background: storedTemplate.snapshot.background,
        snapshot: storedTemplate.snapshot,
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: 'template-other-account',
        accountId: 'account-other',
        ownerId: OTHER_ACCOUNT_SCOPE.ownerId,
        projectId: ROW_SCOPE.projectId,
        name: 'Other account board',
        layoutMode: storedTemplate.snapshot.layoutMode,
        background: storedTemplate.snapshot.background,
        snapshot: storedTemplate.snapshot,
        createdAt: 20,
        updatedAt: 20,
      },
    ]);
    const repository = createCanvasTemplatePersistenceRepository(database);

    const loaded = await repository.load(SCOPE);
    expect(loaded.templates.map((template) => template.id)).toEqual(['template-a']);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.templates[0]?.snapshot)).toBe(true);

    const row = await database.canvas_templates.get('template-a');
    (row!.snapshot as { blocks: unknown[] }).blocks = [];
    expect(loaded.templates[0]?.snapshot.blocks).toHaveLength(1);
  });

  it('atomically creates, updates, and deletes the exact scoped store', async () => {
    const repository = createCanvasTemplatePersistenceRepository(database);
    const created = savedStore();
    await repository.replace(SCOPE, created);
    expect((await repository.load(SCOPE)).templates[0]?.title).toBe('Team board');

    const renamed = renameCustomTemplate(created, {
      templateId: 'template-a',
      title: 'Renamed board',
      ownerId: SCOPE.ownerId,
      projectId: SCOPE.projectId,
      now: 30,
    }).store;
    await repository.replace(SCOPE, renamed);
    expect((await repository.load(SCOPE)).templates[0]?.title).toBe('Renamed board');

    const emptied = deleteCustomTemplate(renamed, {
      templateId: 'template-a',
      ownerId: SCOPE.ownerId,
      projectId: SCOPE.projectId,
    }).store;
    await repository.replace(SCOPE, emptied);
    expect((await repository.load(SCOPE)).templates).toEqual([]);
  });

  it('rejects a template id already owned by another account without revealing that row', async () => {
    await database.canvas_templates.add({
      id: 'template-a',
      accountId: 'account-other',
      ownerId: OTHER_ACCOUNT_SCOPE.ownerId,
      projectId: OTHER_ACCOUNT_SCOPE.projectId,
      name: 'Secret title',
      layoutMode: 'page',
      background: { kind: 'plain', color: '#ffffff' },
      snapshot: savedStore().templates[0]!.snapshot,
      createdAt: 20,
      updatedAt: 20,
    });
    const repository = createCanvasTemplatePersistenceRepository(database);

    await expect(repository.replace(SCOPE, savedStore())).rejects.toMatchObject({
      code: 'scope-conflict',
      message: 'A template identifier is unavailable in this scope.',
    });
    expect((await database.canvas_templates.get('template-a'))?.name).toBe('Secret title');
  });

  it('fails closed on malformed scoped rows and bounded row-count or payload limits', async () => {
    await database.canvas_templates.add({
      id: 'malformed',
      accountId: SCOPE.accountId,
      ownerId: ROW_SCOPE.ownerId,
      projectId: ROW_SCOPE.projectId,
      name: 'Malformed',
      layoutMode: 'page',
      background: { kind: 'plain', color: '#ffffff' },
      snapshot: { blocks: 'not-an-array' },
      createdAt: 20,
      updatedAt: 20,
    });
    const repository = createCanvasTemplatePersistenceRepository(database);
    await expect(repository.load(SCOPE)).rejects.toMatchObject({
      code: 'invalid-data',
      message: 'Saved templates could not be loaded safely.',
    });

    await database.canvas_templates.clear();
    const bounded = createCanvasTemplatePersistenceRepository(database, {
      maxTemplatesPerScope: 0,
      maxRowBytes: 100,
      maxScopeBytes: 100,
    });
    await expect(bounded.replace(SCOPE, savedStore())).rejects.toBeInstanceOf(
      CanvasTemplatePersistenceError,
    );
    await expect(bounded.replace(SCOPE, savedStore())).rejects.toMatchObject({
      code: 'limit-exceeded',
    });
  });

  it('rolls back the complete scoped replacement when the storage write fails', async () => {
    const repository = createCanvasTemplatePersistenceRepository(database);
    const original = savedStore();
    await repository.replace(SCOPE, original);
    const renamed = renameCustomTemplate(original, {
      templateId: 'template-a',
      title: 'Must roll back',
      ownerId: SCOPE.ownerId,
      projectId: SCOPE.projectId,
      now: 30,
    }).store;
    const failure = vi
      .spyOn(database.canvas_templates, 'bulkPut')
      .mockRejectedValueOnce(new Error('simulated quota failure'));

    await expect(repository.replace(SCOPE, renamed)).rejects.toMatchObject({
      code: 'storage-failure',
      message: 'Templates could not be saved locally.',
    });
    failure.mockRestore();
    expect((await repository.load(SCOPE)).templates[0]?.title).toBe('Team board');
  });
});
