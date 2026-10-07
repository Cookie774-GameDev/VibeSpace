import Dexie from 'dexie';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService } from './contextPersistence';
import {
  createContextAutoUpdater,
  type ContextAutoUpdatePorts,
  type ContextAutoUpdateSetting,
} from './contextAutoUpdate';
import { createContextSearchIndexPopulationPort } from './contextSearchIndexing';
import {
  buildProjectContextTreeFromSiyuanIndex,
  type SiyuanSafeIndex,
} from './siyuan/siyuanSafeIndex';
import type { ContextMapRecord, ProjectContextTree } from './tree';
import type { ContextSearchDocumentInput } from './contextSearchPipeline';

// Exercise the actual production IPC adapter. Only the native boundary is injected:
// staged term deletion uses exact document IDs, matching the Rust contract.
const native = vi.hoisted(() => ({
  documents: new Map<string, ContextSearchDocumentInput>(),
  staged: new Map<string, ContextSearchDocumentInput>(),
  calls: [] as Array<{ command: string; request: any }>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, { request }: { request: any }) => {
    native.calls.push({ command, request: structuredClone(request) });
    const status = () => ({
      documentCount: native.documents.size,
      indexId: 'fixture-index',
      engine: 'tantivy-0.22.1',
      schemaVersion: 1,
      needsRebuild: false,
      recoveredCorruption: false,
    });
    if (command === 'context_search_status') return status();
    if (command === 'context_search_begin_refresh') {
      native.staged = new Map(native.documents);
      return 't'.repeat(32);
    }
    if (command === 'context_search_stage_refresh') {
      if (request.retainDocumentIds !== undefined) {
        const retained = new Set(request.retainDocumentIds);
        for (const id of native.staged.keys()) if (!retained.has(id)) native.staged.delete(id);
      }
      for (const id of request.documentIds) native.staged.delete(id);
      for (const doc of request.documents) native.staged.set(doc.documentId, doc);
      return;
    }
    if (command === 'context_search_finish_refresh') {
      if (request.commit) native.documents = new Map(native.staged);
      return native.documents.size;
    }
    if (command === 'context_search_replace_documents') {
      for (const doc of request.documents) native.documents.set(doc.documentId, doc);
      return { affectedDocuments: request.documents.length, status: status() };
    }
    if (command === 'context_search_delete_documents') {
      let count = 0;
      for (const id of request.documentIds) if (native.documents.delete(id)) count++;
      return { affectedDocuments: count, status: status() };
    }
    throw new Error(`Unexpected native command: ${command}`);
  },
}));

let database: JarvisDexie;
let databaseName: string;
beforeEach(async () => {
  localStorage.clear();
  native.documents.clear();
  native.staged.clear();
  native.calls = [];
  databaseName = uniqueTestDbName('auto-update-persistence');
  database = createJarvisDb(databaseName, TEST_INDEXED_DB);
  await database.open();
});
afterEach(async () => {
  database.close();
  await new Dexie(databaseName, TEST_INDEXED_DB).delete();
  localStorage.clear();
});

async function fixture() {
  const service = createContextPersistenceService(database, localStorage);
  await service.initialize('account-a', 'project-a');
  let now = Date.now();
  const files = new Map([
    ['stable.txt', { body: 'Stable source marker.', modified: 100 }],
    ['rename-me.txt', { body: 'Rename source marker.', modified: 101 }],
    ['delete-me.txt', { body: 'Delete source marker.', modified: 102 }],
  ]);
  const index = (): SiyuanSafeIndex => ({
    excluded: 0,
    unreadable: 0,
    summarized: 0,
    entries: [...files].map(([path, file]) => ({
      nodeId: `path:${path}`,
      parentNodeId: null,
      kind: 'file',
      title: path,
      relativePath: path,
      sourcePointer: `C:/fixture/${path}`,
      summary: null,
      sizeBytes: Buffer.byteLength(file.body),
      modifiedAt: file.modified,
    })),
  });
  const seed: ProjectContextTree = {
    version: 1,
    projectId: 'project-a',
    rootDir: 'C:/fixture',
    generatedAt: now,
    model: 'siyuan-managed-v1',
    fileCount: 0,
    totalBytes: 0,
    summary: '',
    nodes: [],
  };
  const readMap = async () =>
    (await service.load('account-a', 'project-a')).maps.find((map) => map.id === 'map-a')!;
  const save = async (map: ContextMapRecord, tree: ProjectContextTree) => {
    const state = await service.saveTree('account-a', tree, {
      mapId: map.id,
      requireExisting: true,
      expectedUpdatedAt: map.updatedAt,
      select: false,
    });
    return state.maps.find((saved) => saved.id === map.id)!;
  };
  await service.saveTree(
    'account-a',
    buildProjectContextTreeFromSiyuanIndex(seed, index().entries),
    { mapId: 'map-a' },
  );
  const search = createContextSearchIndexPopulationPort({
    stat: async (path, includeSha) => {
      const file = files.get(path.replace('C:/fixture/', ''));
      if (!file) return { ok: false, path, error: { code: 'not_found' } };
      return {
        ok: true,
        path,
        kind: 'file',
        size: Buffer.byteLength(file.body),
        modifiedMs: file.modified,
        ...(includeSha
          ? { sha256: `sha256:${createHash('sha256').update(file.body).digest('hex')}` as const }
          : {}),
      };
    },
    read: async (path) => ({
      ok: true,
      path,
      content: files.get(path.replace('C:/fixture/', ''))!.body,
    }),
    hash: async (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`,
  });
  // This is the actual ContextPage creation order: persist, then index the returned projection.
  await search.populateCreatedMap('account-a', await readMap());
  let setting: ContextAutoUpdateSetting = {
    kind: 'context-auto-update-v1',
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    mapId: 'map-a',
    enabled: true,
    consentRevision: 1,
    fingerprint: 'fixture',
  };
  await database.settings.put({ key: 'fixture-auto-setting', value: setting, updated_at: now });
  const ports: ContextAutoUpdatePorts = {
    readSetting: async () =>
      (await database.settings.get('fixture-auto-setting'))!.value as ContextAutoUpdateSetting,
    readMap,
    fingerprint: () => 'fixture',
    active: () => true,
    scan: async () => index(),
    stage: (map, changed, deleted, signal, options) =>
      search.stageChangedMap('account-a', map, changed, deleted, signal, options),
    sync: async (map, next) => buildProjectContextTreeFromSiyuanIndex(map.tree, next.entries),
    saveTree: save,
    saveSetting: async (next) => {
      setting = next;
      await database.settings.put({ key: 'fixture-auto-setting', value: next, updated_at: now });
    },
    now: () => now,
  };
  const updater = createContextAutoUpdater(ports);
  const signal = new AbortController().signal;
  return {
    files,
    index,
    updater,
    signal,
    readMap,
    ports,
    setting: () => setting,
    async advance() {
      now += 2_000;
    },
    async hydrateCompletedTree() {
      const map = await readMap();
      return save(map, {
        ...buildProjectContextTreeFromSiyuanIndex(map.tree, index().entries),
        generatedAt: ++now,
      });
    },
    async cycle() {
      const result = await updater.tick(signal);
      if (result === 'waiting') {
        now += 2_000;
        return updater.tick(signal);
      }
      return result;
    },
  };
}

describe('auto-update with real persisted tree and index IPC adapters', () => {
  it('migrates raw/canonical mixtures and forgotten stale IDs once, then remains idle after reopen', async () => {
    const f = await fixture();
    const canonical = [...native.documents.values()][0]!;
    native.documents.set('path:forgotten.txt', {
      ...canonical,
      documentId: 'path:forgotten.txt',
      path: 'forgotten.txt',
    });
    native.documents.set('map-a:path:forgotten-canonical.txt', {
      ...canonical,
      documentId: 'map-a:path:forgotten-canonical.txt',
      path: 'forgotten-canonical.txt',
    });
    native.documents.set('path:stable.txt', {
      ...canonical,
      documentId: 'path:stable.txt',
      path: 'stable.txt',
    });
    await f.cycle();
    expect([...native.documents.values()].map((doc) => doc.path).sort()).toEqual(
      [...f.files.keys()].sort(),
    );
    expect([...native.documents.keys()].every((id) => id.startsWith('map-a:path:'))).toBe(true);
    expect(f.setting().indexIdentityVersion).toBe(1);
    expect(
      native.calls.filter((call) => call.request.retainDocumentIds !== undefined),
    ).toHaveLength(1);
    await f.hydrateCompletedTree();
    const reopened = createContextAutoUpdater(f.ports);
    const before = native.calls.length;
    expect(await reopened.tick(f.signal)).toBe('idle');
    await f.advance();
    expect(await reopened.tick(f.signal)).toBe('idle');
    expect(native.calls.slice(before)).toEqual([]);
    expect(
      native.calls.filter((call) => call.request.retainDocumentIds !== undefined),
    ).toHaveLength(1);
  });

  it('keeps canonical native document IDs and evicts renamed/deleted paths after persisted hydration', async () => {
    const f = await fixture();
    const initialIds = [...native.documents.keys()];
    // Native saved-edit step succeeds first; then completed-tree hydration republishes the map.
    f.files.get('stable.txt')!.body = 'Stable source marker changed.';
    f.files.get('stable.txt')!.modified++;
    await f.cycle();
    await f.hydrateCompletedTree();
    const renamed = f.files.get('rename-me.txt')!;
    f.files.delete('rename-me.txt');
    f.files.delete('delete-me.txt');
    f.files.set('renamed-source.txt', renamed);
    f.files.set('added-source.txt', { body: 'Added source marker.', modified: 200 });
    await f.cycle();
    expect([...native.documents.values()].map((doc) => doc.path).sort()).toEqual(
      [...f.files.keys()].sort(),
    );
    expect(native.documents.has(initialIds.find((id) => id.endsWith('path:stable.txt'))!)).toBe(
      true,
    );
  });

  it('does no update for an unchanged physical source after completed-tree hydration', async () => {
    const f = await fixture();
    await f.cycle();
    await f.hydrateCompletedTree();
    const before = native.calls.length;
    expect(await f.updater.tick(f.signal)).toBe('idle');
    expect(native.calls.slice(before)).toEqual([]);
  });
});
