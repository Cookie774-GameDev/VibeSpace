import Dexie from 'dexie';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie, type ContextMapRow } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService, type ContextTreeCommitReceipt } from './contextPersistence';
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
  const save = async (map: ContextMapRecord, tree: ProjectContextTree, signal?: AbortSignal, onCommitted?: (receipt: ContextTreeCommitReceipt) => void) => {
    const state = await service.saveTree('account-a', tree, {
      mapId: map.id,
      requireExisting: true,
      expectedUpdatedAt: map.updatedAt,
      select: false,
      signal,
      onCommitted,
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
    prepareRollback: async map => {
      const restore = await service.captureMapRestore('account-a', 'project-a', map.id, map.updatedAt);
      return async savedUpdatedAt => { await restore(savedUpdatedAt); };
    },
    saveSetting: async (next) => {
      setting = next;
      await database.settings.put({ key: 'fixture-auto-setting', value: next, updated_at: now });
    },
    now: () => now,
  };
  const updater = createContextAutoUpdater(ports, setting);
  const signal = new AbortController().signal;
  return {
    files,
    index,
    updater,
    signal,
    readMap,
    ports,
    service,
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
  it('C08 preserves exact canonical graph identity after a native search commit failure', async () => {
    const f = await fixture();
    const before = await f.readMap();
    const documents = structuredClone([...native.documents]);
    const stage = f.ports.stage;
    f.ports.stage = async (...args) => {
      const transaction = await stage(...args);
      return { ...transaction, commit: async () => { throw new Error('C08 commit unavailable'); } };
    };
    await expect(f.cycle()).rejects.toThrow('C08 commit unavailable');
    const after = await f.readMap();
    console.log('C08_ROLLBACK_JOIN', JSON.stringify({ before: before.tree.nodes.map(n => n.id), after: after.tree.nodes.map(n => n.id) }));
    expect(after.tree).toEqual(before.tree);
    expect([...native.documents]).toEqual(documents);
  });

  it('C08 manually reconciles edit/add/rename/delete and all 125 files without changing automatic consent or selection', async () => {
    const f = await fixture();
    await f.service.selectFile('account-a', 'project-a', 'stable.txt');
    const settings = await database.settings.toArray();
    f.files.get('stable.txt')!.body = 'Edited source marker.';
    f.files.get('stable.txt')!.modified++;
    const renamed = f.files.get('rename-me.txt')!;
    f.files.delete('rename-me.txt'); f.files.delete('delete-me.txt');
    f.files.set('renamed.txt', renamed);
    for (let i = 0; i < 123; i++) f.files.set(`added-${i}.txt`, { body: `Added ${i}`, modified: 200 + i });
    expect(await f.updater.refresh(f.signal)).toBe('updated');
    expect([...native.documents.values()].map(doc => doc.path).sort()).toEqual([...f.files.keys()].sort());
    expect(native.documents.size).toBe(125);
    expect(native.documents.get('map-a:path:stable.txt')?.body).toBe('Edited source marker.');
    expect((await f.readMap()).tree.fileCount).toBe(125);
    expect(await database.settings.toArray()).toEqual(settings);
    expect((await f.service.load('account-a', 'project-a')).selectedFile).toBe('stable.txt');
  });

  it.each(['replacement', 'deleted', 'root-changed'] as const)('C08 refuses to overwrite a %s owner during compensation', async change => {
    const f = await fixture();
    const before = await f.readMap();
    const stage = f.ports.stage;
    let replacement: ContextMapRecord | null = null;
    f.ports.stage = async (...args) => {
      const tx = await stage(...args);
      return { ...tx, commit: async () => {
        if (change === 'deleted') await f.service.deleteMap('account-a', 'project-a', before.id);
        else {
          const current = await f.readMap();
          const next = buildProjectContextTreeFromSiyuanIndex(current.tree, f.index().entries);
          const state = await f.service.saveTree('account-a', { ...next, ...(change === 'root-changed' ? { rootDir: 'C:/replacement' } : {}), summary: 'New owner' }, { mapId: current.id, expectedUpdatedAt: current.updatedAt, select: false });
          replacement = state.maps.find(map => map.id === current.id)!;
        }
        throw new Error('C08 commit rejected');
      } };
    };
    await expect(f.updater.refresh(f.signal)).rejects.toThrow('rollback_needs_review');
    const after = await f.readMap();
    if (change === 'deleted') expect(after.status).toBe('deleted');
    else expect(after).toEqual(replacement);
  });

  it('C08 restores the exact prior source/entity/provenance snapshot and preserves a newer selection', async () => {
    const f = await fixture();
    const before = await f.readMap();
    const graph = async () => ({ sources: await database.context_sources.toArray(), entities: await database.context_entities.toArray(), edges: await database.context_edges.toArray(), provenance: await database.context_provenance.toArray() });
    const original = await graph();
    const restore = await f.service.captureMapRestore('account-a', 'project-a', before.id, before.updatedAt);
    const saved = await f.ports.saveTree(before, buildProjectContextTreeFromSiyuanIndex(before.tree, f.index().entries));
    await f.service.selectFile('account-a', 'project-a', 'stable.txt');
    const settings = await database.settings.toArray();
    await restore(saved.updatedAt);
    expect(await graph()).toEqual(original);
    expect(await database.settings.toArray()).toEqual(settings);
    expect((await f.readMap()).updatedAt).toBeGreaterThan(saved.updatedAt);
    await expect(restore(saved.updatedAt)).rejects.toThrow('map_changed');
  });

  it('C08 restores last-good graph and search when cancellation follows the owned graph save', async () => {
    const f = await fixture();
    const before = await f.readMap();
    const documents = structuredClone([...native.documents]);
    const controller = new AbortController();
    const save = f.ports.saveTree;
    f.ports.saveTree = async (...args) => { const saved = await save(...args); controller.abort(); return saved; };
    await expect(f.updater.refresh(controller.signal)).rejects.toThrow('scope_changed');
    expect((await f.readMap()).tree).toEqual(before.tree);
    expect([...native.documents]).toEqual(documents);
    expect(native.calls.filter(call => call.command === 'context_search_finish_refresh').at(-1)?.request.commit).toBe(false);
  });

  it.each(['account', 'project', 'revision', 'missing'] as const)('C08 cannot capture rollback for a foreign or changed %s', async change => {
    const f = await fixture();
    const map = await f.readMap();
    await expect(f.service.captureMapRestore(change === 'account' ? 'foreign' : 'account-a', change === 'project' ? 'foreign' : 'project-a', change === 'missing' ? 'absent' : map.id, change === 'revision' ? map.updatedAt - 1 : map.updatedAt)).rejects.toThrow();
    expect(await f.readMap()).toEqual(map);
  });

  it.each(['abort', 'load-failure', 'replacement'] as const)('C08 commit receipt restores last-good graph after post-commit %s before save returns', async mode => {
    const f = await fixture();
    const before = await f.readMap();
    const documents = structuredClone([...native.documents]);
    f.files.set('new-after-commit.txt', { body: 'Owned changed revision', modified: 900 });
    const controller = new AbortController();
    let replacement: ContextMapRecord | null = null;
    if (mode === 'replacement') {
      const stage = f.ports.stage;
      f.ports.stage = async (...args) => {
        const tx = await stage(...args);
        return { ...tx, abort: async () => {
          const current = await f.readMap();
          const state = await f.service.saveTree('account-a', {
            ...buildProjectContextTreeFromSiyuanIndex(current.tree, f.index().entries), summary: 'Replacement owner',
          }, { mapId: current.id, expectedUpdatedAt: current.updatedAt, select: false });
          replacement = state.maps.find(map => map.id === current.id)!;
          await tx.abort();
        } };
      };
    }
    let committed = false;
    let failRead = true;
    const updating = () => {
      if (committed) return;
      let transaction = Dexie.currentTransaction!;
      while (transaction.parent) transaction = transaction.parent;
      transaction.on('complete', () => {
        committed = true;
        if (mode === 'abort') controller.abort();
      });
    };
    const reading = (row: ContextMapRow) => {
      if (mode !== 'abort' && committed && failRead) { failRead = false; throw new Error('C08 post-commit read failed'); }
      return row;
    };
    database.context_maps.hook('updating', updating);
    database.context_maps.hook('reading', reading);
    let outcome: unknown;
    try { await f.updater.refresh(controller.signal); } catch (error) { outcome = error; }
    finally {
      database.context_maps.hook('updating').unsubscribe(updating);
      database.context_maps.hook('reading').unsubscribe(reading);
    }
    expect(committed).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    const after = await f.readMap();
    console.log('C08_COMMIT_ACK_JOIN', JSON.stringify({ mode, committed, error: String(outcome), before: before.tree.nodes.map(n => n.id), after: after.tree.nodes.map(n => n.id) }));
    if (mode === 'replacement') {
      expect(String(outcome)).toContain('rollback_needs_review');
      expect(after).toEqual(replacement);
    } else expect(after.tree).toEqual(before.tree);
    expect([...native.documents]).toEqual(documents);
  });

  it.each([false, true])('C08 emits one immutable exact receipt only after a successful graph commit (signal=%s)', async signalEnabled => {
    const f = await fixture();
    const map = await f.readMap();
    const receipt = vi.fn();
    const saved = await f.service.saveTree('account-a', buildProjectContextTreeFromSiyuanIndex(map.tree, f.index().entries), {
      mapId: map.id, expectedUpdatedAt: map.updatedAt, requireExisting: true, select: false,
      ...(signalEnabled ? { signal: new AbortController().signal } : {}), onCommitted: receipt,
    });
    expect(receipt).toHaveBeenCalledOnce();
    const value = receipt.mock.calls[0]![0];
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).toEqual({ accountId: 'account-a', projectId: 'project-a', mapId: map.id,
      updatedAt: saved.maps.find(candidate => candidate.id === map.id)!.updatedAt,
      knowledgeRevision: (await database.context_maps.get(map.id))!.knowledgeRevision });
  });

  it('C08 does not issue a commit receipt for a rolled-back graph write', async () => {
    const f = await fixture();
    const map = await f.readMap();
    const receipt = vi.fn();
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    database.context_entities.hook('updating', abort);
    try {
      await expect(f.service.saveTree('account-a', buildProjectContextTreeFromSiyuanIndex(map.tree, f.index().entries), {
        mapId: map.id, expectedUpdatedAt: map.updatedAt, requireExisting: true, select: false,
        signal: controller.signal, onCommitted: receipt,
      })).rejects.toThrow();
    } finally { database.context_entities.hook('updating').unsubscribe(abort); }
    expect(receipt).not.toHaveBeenCalled();
    expect(await f.readMap()).toEqual(map);
  });

});
