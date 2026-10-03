import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService } from './contextPersistence';
import { populatePersistedCreatedContextMap } from './contextMapCreationLifecycle';
import { createContextSearchIndexPopulationPort } from './contextSearchIndexing';
import type { ContextSearchDocumentInput, ContextSearchIndexPort } from './contextSearchPipeline';
import { createContextMapRlmRepository } from './contextRlmProduction';
import { createContextQueryService } from './contextQueryService';
import { contextEntityIdForTreeNode } from './migration';
import type { ContextMapRecord, ProjectContextTree } from './tree';

const ACCOUNT = 'S61B1-index-account';
const PROJECT = 'S61B1-index-project';
const ROOT = 'C:\\S61B1-index-fixture';
const TOKEN = 'zirconrelay';
let db: JarvisDexie;
let dbName: string;

beforeEach(async () => {
  localStorage.clear();
  dbName = uniqueTestDbName('S61B1-index-id');
  db = createJarvisDb(dbName, TEST_INDEXED_DB);
  await db.open();
});
afterEach(async () => {
  db.close();
  await new Dexie(dbName, TEST_INDEXED_DB).delete();
  localStorage.clear();
});

async function hash(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function treeFixture(longId = false): ProjectContextTree {
  return {
    version: 1, projectId: PROJECT, rootDir: ROOT, generatedAt: 1_000,
    model: 'S61B1-source-fixture', fileCount: 130, totalBytes: 8_000,
    summary: 'Synthetic physical-source fixture.', recommendedEntryPoints: [],
    nodes: [{ id: 'folder-docs', kind: 'area', title: 'docs', summary: '', path: 'docs',
      children: Array.from({ length: 130 }, (_, index) => ({
        id: index === 128 && longId ? `file-${'x'.repeat(180)}` : `file-${index}`,
        kind: 'file' as const, title: `part-${index}.txt`, summary: '',
        path: `docs/part-${index}.txt`, modifiedAt: 1_000,
        contentIndexEligible: index !== 129,
      })),
    }],
  };
}

async function fixture(options: { legacy?: boolean; longId?: boolean; foreignHit?: boolean } = {}) {
  const tree = treeFixture(options.longId);
  const inputBefore = JSON.stringify(tree);
  const contentFor = (path: string) => path.endsWith('part-128.txt')
    ? `The ${TOKEN} travels through the synthetic relay.\n`
    : 'Ordinary synthetic text without the requested marker.\n';
  const read = vi.fn(async (path: string) => ({ ok: true as const, path, content: contentFor(path) }));
  const stat = vi.fn(async (path: string) => ({ ok: true as const, path, kind: 'file' as const,
    size: new TextEncoder().encode(contentFor(path)).byteLength, modifiedMs: 1_000,
    sha256: await hash(contentFor(path)),
  }));
  const store = new Map<string, ContextSearchDocumentInput>();
  let indexMapId = '';
  const assertScope = (accountId: string, mapId: string) => {
    expect(accountId).toBe(ACCOUNT);
    expect(mapId).toBe(indexMapId);
  };
  const port: ContextSearchIndexPort = {
    async status(accountId, mapId) {
      assertScope(accountId, mapId);
      return { documentCount: store.size, indexId: 'S61B1-memory-index', engine: 'fixture',
        schemaVersion: 1, recoveredCorruption: false, needsRebuild: false };
    },
    async replaceDocuments(accountId, mapId, documents) {
      assertScope(accountId, mapId);
      for (const document of documents) store.set(document.documentId, document);
      return { affectedDocuments: documents.length, documentCount: store.size };
    },
    async deleteDocuments(accountId, mapId, ids) {
      assertScope(accountId, mapId);
      let affectedDocuments = 0;
      for (const id of ids) if (store.delete(id)) affectedDocuments++;
      return { affectedDocuments, documentCount: store.size };
    },
  };
  const persistence = createContextPersistenceService(db, localStorage);
  await persistence.initialize(ACCOUNT, PROJECT);
  const persisted = await persistence.saveTree(ACCOUNT, tree);
  indexMapId = persisted.selectedMapId!;
  const population = createContextSearchIndexPopulationPort({ port, stat, read, hash });
  let generatedMap: ContextMapRecord;
  if (options.legacy) {
    // Reproduce the shipped creation lifecycle: raw scan IDs populated into
    // an otherwise correctly account/map-scoped native index.
    generatedMap = { ...persisted.maps.find((map) => map.id === indexMapId)!, tree };
    await population.populateCreatedMap(ACCOUNT, generatedMap);
  } else {
    ({ generatedMap } = await populatePersistedCreatedContextMap({ persisted, tree,
      populateCreatedMap: population.populateCreatedMap,
    }));
  }
  expect(JSON.stringify(tree)).toBe(inputBefore);
  expect(store.size).toBe(129);
  const reloaded = await createContextPersistenceService(db, localStorage).load(ACCOUNT, PROJECT);
  const reloadBefore = JSON.stringify(reloaded);
  const loadedMap = reloaded.maps.find((map) => map.id === indexMapId)!;
  const lexicalSearch = vi.fn(async (request: { accountId: string; mapId: string; query: string; limit: number }) => {
    assertScope(request.accountId, request.mapId);
    const terms = request.query.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
    return [...store.values()].filter((document) =>
      terms.some((term) => document.body.toLowerCase().split(/[^a-z0-9]+/u).includes(term)))
      .slice(0, request.limit).map((document) => ({
        documentId: options.foreignHit
          ? contextEntityIdForTreeNode('S61B1-foreign-map', tree.nodes[0]!.children![128]!.id)
          : document.documentId,
        title: document.title, path: document.path, sourceType: 'file_version',
        excerpt: document.body, matchReason: 'fixture lexical body match',
        updatedAt: document.updatedAt, score: 100,
      }));
  });
  read.mockClear(); stat.mockClear();
  const repository = createContextMapRlmRepository({
    loadMaps: async (projectId) => {
      expect(projectId).toBe(PROJECT);
      return (await persistence.load(ACCOUNT, projectId)).maps;
    }, stat, read, lexicalSearch, indexStatus: port.status,
  });
  const service = createContextQueryService({ repository });
  return { tree, generatedMap, loadedMap, store, service, read, lexicalSearch,
    scope: { accountId: ACCOUNT, projectId: PROJECT },
    assertUnchanged: async () => expect(JSON.stringify(await persistence.load(ACCOUNT, PROJECT))).toBe(reloadBefore),
  };
}

describe('physical index identities across durable map reload', () => {
  it('indexes durable IDs while preserving hierarchy, paths, eligibility, and the original scan', async () => {
    const f = await fixture();
    const scanFolder = f.tree.nodes[0]!;
    const folder = f.generatedMap.tree.nodes[0]!;
    expect(folder.id).toBe(contextEntityIdForTreeNode(f.loadedMap.id, scanFolder.id));
    expect(folder.children).toHaveLength(130);
    for (const [index, child] of folder.children!.entries()) {
      expect(child).toEqual({ ...scanFolder.children![index]!,
        id: contextEntityIdForTreeNode(f.loadedMap.id, scanFolder.children![index]!.id) });
    }
    expect([...f.store.keys()].sort()).toEqual(f.loadedMap.tree.nodes[0]!.children!
      .filter((node) => node.path !== 'docs/part-129.txt').map((node) => node.id).sort());
    expect(f.store.has(folder.children![129]!.id)).toBe(false);
  });

  it.each([false, true])('save -> populate -> reload -> real search issues an openable pointer (legacy=%s)', async (legacy) => {
    const f = await fixture({ legacy });
    const result = await f.service.search({ scope: f.scope, query: TOKEN, limit: 6 });
    expect(f.lexicalSearch).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    const hit = result.items[0]!;
    expect(hit.record.sourceKind).toBe('file_version');
    expect(hit.record.id).toMatch(/^rlm:/u);
    expect(hit.record.id).not.toBe([...f.store.values()].find((document) => document.body.includes(TOKEN))!.documentId);
    expect(hit.preview).toContain(TOKEN);
    await expect(f.service.open({ scope: f.scope, pointer: hit.pointer })).resolves.toMatchObject({
      status: 'current', text: expect.stringContaining(TOKEN),
    });
    expect([...new Set(f.read.mock.calls.map(([path]) => path))]).toEqual([`${ROOT}\\docs\\part-128.txt`]);
    await f.assertUnchanged();
  });

  it('resolves the migration bounded-hash ID for a legacy raw hit without rewriting the map', async () => {
    const f = await fixture({ legacy: true, longId: true });
    expect(f.loadedMap.tree.nodes[0]!.children!.find((node) => node.path === 'docs/part-128.txt')!.id).toMatch(/^ctxent_/u);
    const result = await f.service.search({ scope: f.scope, query: TOKEN });
    expect(result.items).toHaveLength(1);
    await expect(f.service.open({ scope: f.scope, pointer: result.items[0]!.pointer })).resolves.toMatchObject({
      text: expect.stringContaining(TOKEN),
    });
    await f.assertUnchanged();
  });

  it('rejects a foreign-map canonical hit even when its raw node ID collides', async () => {
    const f = await fixture({ legacy: true, foreignHit: true });
    await expect(f.service.search({ scope: f.scope, query: TOKEN })).resolves.toMatchObject({ items: [] });
    expect(f.lexicalSearch).toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    await f.assertUnchanged();
  });

  it('keeps an unmatched generic overview query empty without inventing a fallback', async () => {
    const f = await fixture({ legacy: true });
    await expect(f.service.search({ scope: f.scope, query: 'overview' })).resolves.toMatchObject({ items: [] });
    expect(f.lexicalSearch).toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    await f.assertUnchanged();
  });
});
