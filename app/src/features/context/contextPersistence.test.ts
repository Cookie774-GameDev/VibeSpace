import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createContextPersistenceService } from './contextPersistence';
import {
  contextMapCollectionKey,
  contextSelectedFileKey,
  contextStorageKey,
  type ContextMapRecord,
  type ProjectContextTree,
} from './tree';
import { contextSelectionSettingKey } from './migration';
import { createContextGraphRepository } from './repository';
import type { ContextGraphSnapshotV2 } from './contracts';

function treeFixture(rootDir = 'C:\\Projects\\Example', generatedAt = 1_000): ProjectContextTree {
  return {
    version: 1,
    projectId: 'project-1',
    rootDir,
    generatedAt,
    model: 'local-fallback',
    fileCount: 1,
    totalBytes: 128,
    summary: 'Project knowledge.',
    nodes: [
      {
        id: 'area-docs',
        title: 'Documentation',
        kind: 'area',
        summary: 'Project documentation.',
        children: [
          {
            id: 'file-readme',
            title: 'README.md',
            kind: 'file',
            summary: 'Project readme.',
            path: 'README.md',
            modifiedAt: generatedAt,
          },
        ],
      },
    ],
    recommendedEntryPoints: ['README.md'],
  };
}

function legacyMap(id = 'map-legacy'): ContextMapRecord {
  const tree = treeFixture();
  return {
    id,
    projectId: tree.projectId,
    rootDir: tree.rootDir,
    name: 'Legacy Context Map',
    status: 'active',
    createdAt: tree.generatedAt,
    updatedAt: tree.generatedAt,
    tree,
  };
}

let database: JarvisDexie;
let databaseName: string;

beforeEach(async () => {
  localStorage.clear();
  databaseName = uniqueTestDbName('context-persistence');
  database = createJarvisDb(databaseName, TEST_INDEXED_DB);
  await database.open();
});

afterEach(async () => {
  localStorage.clear();
  database.close();
  const cleanup = new Dexie(databaseName, TEST_INDEXED_DB);
  await cleanup.delete();
});

describe('production Context persistence service', () => {
  it('preserves physical file size and mtime separately from entity timestamps on save and reopen', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const tree = treeFixture();
    const file = tree.nodes[0]!.children![0]!;
    file.sizeBytes = 128;
    file.modifiedAt = 12;
    await service.saveTree('account-1', tree, { mapId: 'map-source-metadata' });
    const reopened = createContextPersistenceService(database, localStorage);
    const state = await reopened.load('account-1', 'project-1');
    const restored = state.maps[0]!.tree.nodes[0]!.children![0]!;
    expect(restored).toMatchObject({ sizeBytes: 128, modifiedAt: 12 });
    const entity = await database.context_entities.get(restored.id);
    expect(entity!.updatedAt).toBeGreaterThanOrEqual(entity!.createdAt);
    expect(entity).toMatchObject({ sourceSizeBytes: 128, sourceModifiedAt: 12 });
  });

  it('refreshes a background map without stealing selection and clears only its own opt-in on deletion', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const first = await service.saveTree('account-1', treeFixture(), { mapId: 'map-first' });
    await service.saveTree('account-1', treeFixture('C:/Other'), { mapId: 'map-selected' });
    const before = first.maps.find((map) => map.id === 'map-first')!;
    const refreshed = await service.saveTree('account-1', { ...before.tree, generatedAt: Date.now() + 1 }, {
      mapId: before.id, expectedUpdatedAt: before.updatedAt, requireExisting: true, select: false,
    });
    expect(refreshed.selectedMapId).toBe('map-selected');
    await database.settings.bulkPut([
      { key: 'auto-own', value: { kind: 'context-auto-update-v1', accountId: 'account-1', projectId: 'project-1', mapId: 'map-first', enabled: true }, updated_at: 1 },
      { key: 'auto-peer', value: { kind: 'context-auto-update-v1', accountId: 'account-1', projectId: 'project-1', mapId: 'map-selected', enabled: true }, updated_at: 1 },
      { key: 'auto-foreign', value: { kind: 'context-auto-update-v1', accountId: 'account-2', projectId: 'project-1', mapId: 'map-first', enabled: true }, updated_at: 1 },
    ]);
    await service.deleteMap('account-1', 'project-1', 'map-first');
    expect(await database.settings.get('auto-own')).toBeUndefined();
    expect(await database.settings.get('auto-peer')).toBeDefined(); expect(await database.settings.get('auto-foreign')).toBeDefined();
    await service.restoreMap('account-1', 'project-1', 'map-first');
    expect(await database.settings.get('auto-own')).toBeUndefined();
  });
  it('migrates legacy state once, publishes the validated V2 projection, and retains rollback data', async () => {
    const legacy = legacyMap();
    const collectionKey = contextMapCollectionKey('project-1');
    const treeKey = contextStorageKey('project-1');
    const fileKey = contextSelectedFileKey('project-1');
    localStorage.setItem(
      collectionKey,
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        selectedMapId: legacy.id,
        maps: [legacy],
      }),
    );
    localStorage.setItem(treeKey, JSON.stringify(legacy.tree));
    localStorage.setItem(fileKey, 'C:\\Projects\\Example\\README.md');
    const publish = vi.fn();
    const service = createContextPersistenceService(database, localStorage, publish);

    const first = await service.initialize('account-1', 'project-1');
    const second = await service.initialize('account-1', 'project-1');

    expect(first).toMatchObject({
      accountId: 'account-1',
      projectId: 'project-1',
      selectedMapId: 'map-legacy',
      selectedFile: 'README.md',
      maps: [
        {
          id: 'map-legacy',
          rootDir: 'C:\\Projects\\Example',
          tree: { nodes: [{ children: [{ path: 'README.md' }] }] },
        },
      ],
      migration: { state: 'migrated', legacyRetained: true },
    });
    expect(second.migration.state).toBe('already_migrated');
    expect(publish).toHaveBeenCalled();
    expect(Object.isFrozen(first.maps)).toBe(true);
    expect(localStorage.getItem(collectionKey)).not.toBeNull();
    expect(localStorage.getItem(treeKey)).not.toBeNull();
    expect(localStorage.getItem(fileKey)).not.toBeNull();
    await expect(database.context_migration_backups.count()).resolves.toBe(1);
  });

  it('publishes scoped recovery choices when migration quarantines malformed legacy records', async () => {
    const valid = legacyMap('map-valid');
    localStorage.setItem(
      contextMapCollectionKey('project-1'),
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        selectedMapId: valid.id,
        maps: [
          valid,
          {
            ...legacyMap('map-corrupt'),
            tree: { version: 1, nodes: 'not-an-array' },
          },
        ],
      }),
    );
    const service = createContextPersistenceService(database, localStorage);

    const state = await service.initialize('account-1', 'project-1');

    expect(state.recovery).toEqual({
      issueCount: 1,
      options: [
        {
          id: 'retry',
          label: 'Retry recovery',
          description: 'Validate the preserved source again and retry the migration.',
        },
        {
          id: 'restore_backup',
          label: 'Restore backup',
          description: 'Restore the preserved pre-migration backup.',
        },
        {
          id: 'export_then_discard',
          label: 'Export then discard',
          description: 'Export quarantined records before discarding their local copies.',
        },
      ],
    });
  });

  it('shows runtime quarantine recovery only inside the owning project scope', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    await service.initialize('account-1', 'project-2');
    const projectOne = await service.saveTree('account-1', treeFixture());
    const projectTwo = await service.saveTree('account-1', {
      ...treeFixture('C:\\Projects\\Other'),
      projectId: 'project-2',
    });
    await database.context_maps.update(projectTwo.selectedMapId!, { name: '' });

    const projectOneState = await service.load('account-1', 'project-1');
    const projectTwoState = await service.load('account-1', 'project-2');

    expect(projectOneState.recovery).toBeNull();
    expect(projectOneState.maps.map(({ id }) => id)).toEqual([projectOne.selectedMapId]);
    expect(projectTwoState.recovery).toMatchObject({
      issueCount: 1,
      options: [{ id: 'retry' }, { id: 'restore_backup' }, { id: 'export_then_discard' }],
    });
    expect(projectTwoState.maps).toEqual([]);
  });

  it('saves a generated tree directly to Dexie without creating large localStorage records', async () => {
    const publish = vi.fn();
    const service = createContextPersistenceService(database, localStorage, publish);
    await service.initialize('account-1', 'project-1');

    const state = await service.saveTree('account-1', treeFixture());
    const mapId = state.selectedMapId!;

    expect(state).toMatchObject({
      selectedMapId: mapId,
      maps: [
        {
          id: mapId,
          status: 'active',
          tree: { summary: 'Project knowledge.' },
        },
      ],
    });
    expect(localStorage.getItem(contextMapCollectionKey('project-1'))).toBeNull();
    expect(localStorage.getItem(contextStorageKey('project-1'))).toBeNull();
    await expect(database.context_maps.count()).resolves.toBe(1);
    await expect(database.context_entities.count()).resolves.toBe(2);
    await expect(database.context_sources.toArray()).resolves.toMatchObject([
      { mapId, status: 'ready', lastVerifiedAt: 1_000 },
    ]);
    await expect(database.context_provenance.toArray()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mapId, parser: 'context-tree-v2-persistence' }),
      ]),
    );
    await expect(
      database.settings.get(contextSelectionSettingKey('account-1', 'project-1')),
    ).resolves.toMatchObject({
      value: { selectedMapId: mapId },
    });
  });

  it('projects validated GitHub identity and source status for honest workspace badges', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const saved = await service.saveTree('account-1', treeFixture());
    const mapId = saved.selectedMapId!;
    const repository = createContextGraphRepository(database);
    const snapshot = await repository.getSnapshot('account-1', mapId);
    expect(snapshot).not.toBeNull();
    const next = structuredClone(snapshot!) as ContextGraphSnapshotV2;
    next.map.knowledgeRevision += 1;
    next.map.updatedAt += 1;
    next.map.statistics.staleSourceCount = 1;
    next.sources[0] = {
      ...next.sources[0]!,
      kind: 'github_repository',
      label: 'octo/vibespace',
      status: 'stale',
      localRoot: undefined,
      github: {
        installationId: 'installation-1',
        owner: 'octo',
        repository: 'vibespace',
        selectedRef: 'main',
        resolvedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        visibility: 'private',
      },
      lastIndexedAt: 1_000,
      updatedAt: next.sources[0]!.updatedAt + 1,
    };
    next.provenance = next.provenance.map((entry) => ({
      ...entry,
      sourceKind: 'github_repository',
    }));
    await repository.putSnapshot('account-1', next, {
      expectedKnowledgeRevision: snapshot!.map.knowledgeRevision,
    });

    const loaded = await service.load('account-1', 'project-1');
    expect(loaded.maps[0]).toMatchObject({
      sourceType: 'github_repository',
      sourceLabel: 'octo/vibespace',
      sourceStatus: 'stale',
      branchRef: 'main',
      github: {
        owner: 'octo',
        repository: 'vibespace',
        resolvedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        visibility: 'private',
      },
      lastIndexedAt: 1_000,
    });
    expect(loaded.maps[0]?.github).not.toHaveProperty('installationId');
  });

  it('persists file selection and soft deletion while keeping source graph evidence', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const saved = await service.saveTree('account-1', treeFixture());
    const mapId = saved.selectedMapId!;

    const selected = await service.selectFile(
      'account-1',
      'project-1',
      'C:\\Projects\\Example\\README.md',
    );
    expect(selected).toMatchObject({ selectedMapId: mapId, selectedFile: 'README.md' });

    const deleted = await service.deleteMap('account-1', 'project-1', mapId);
    expect(deleted).toMatchObject({
      selectedMapId: null,
      selectedFile: null,
      maps: [{ id: mapId, status: 'deleted' }],
    });
    await expect(service.selectMap('account-1', 'project-1', mapId)).rejects.toThrow(
      /map_missing/u,
    );
    await expect(database.context_entities.where('mapId').equals(mapId).count()).resolves.toBe(2);
    await expect(database.context_provenance.where('mapId').equals(mapId).count()).resolves.toBe(3);

    const restored = await service.restoreMap('account-1', 'project-1', mapId);
    expect(restored).toMatchObject({
      selectedMapId: mapId,
      maps: [{ id: mapId, status: 'active' }],
    });
    await expect(database.context_entities.where('mapId').equals(mapId).count()).resolves.toBe(2);
    await expect(database.context_provenance.where('mapId').equals(mapId).count()).resolves.toBe(3);
  });

  it('fails closed when restoring a map across scope or beyond the active-map limit', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const saved = await service.saveTree('account-1', treeFixture());
    const deletedId = saved.selectedMapId!;
    await service.deleteMap('account-1', 'project-1', deletedId);
    await expect(service.restoreMap('account-1', 'project-2', deletedId)).rejects.toThrow(
      /map_missing/u,
    );

    for (let index = 0; index < 5; index += 1) {
      await service.saveTree('account-1', {
        ...treeFixture(),
        rootDir: `C:\\Projects\\Active-${index}`,
        generatedAt: 2_000 + index,
      });
    }
    await expect(service.restoreMap('account-1', 'project-1', deletedId)).rejects.toThrow(
      /active_limit/u,
    );
  });

  it('fails closed across account/project boundaries', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const saved = await service.saveTree('account-1', treeFixture());
    await expect(service.deleteMap('account-2', 'project-1', saved.selectedMapId!)).rejects.toThrow(
      /map_missing/u,
    );
    await expect(service.selectFile('account-1', 'project-2', 'README.md')).rejects.toThrow(
      /selected_file_missing/u,
    );
  });

  it('ignores another account’s claimed legacy bytes while still loading its isolated V2 scope', async () => {
    const legacy = legacyMap();
    localStorage.setItem(
      contextMapCollectionKey('project-1'),
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        selectedMapId: legacy.id,
        maps: [legacy],
      }),
    );
    const service = createContextPersistenceService(database, localStorage);
    const accountOne = await service.initialize('account-1', 'project-1');
    const accountTwo = await service.initialize('account-2', 'project-1');

    expect(accountOne.maps).toHaveLength(1);
    expect(accountTwo).toMatchObject({
      accountId: 'account-2',
      maps: [],
      migration: { state: 'foreign_legacy_ignored' },
    });
    await expect(
      database.context_maps.where('accountId').equals('account-2').count(),
    ).resolves.toBe(0);
  });

  it('uses scope-bound generated ids and rejects explicit cross-project map collisions', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    await service.initialize('account-1', 'project-2');
    await service.initialize('account-2', 'project-1');

    const accountOne = await service.saveTree('account-1', treeFixture());
    const accountTwo = await service.saveTree('account-2', treeFixture());
    expect(accountOne.selectedMapId).not.toBe(accountTwo.selectedMapId);

    const projectTwoTree = {
      ...treeFixture('C:\\Projects\\Second', 2_000),
      projectId: 'project-2',
    };
    await expect(
      service.saveTree('account-1', projectTwoTree, {
        mapId: accountOne.selectedMapId!,
      }),
    ).rejects.toThrow(/map_scope_conflict/u);
    await expect(database.context_maps.count()).resolves.toBe(2);
  });

  it('refuses an update-only save when the selected persisted map no longer exists', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');

    await expect(
      service.saveTree('account-1', treeFixture(), {
        mapId: 'missing-map',
        requireExisting: true,
      }),
    ).rejects.toThrow(/map_missing/u);
    await expect(database.context_maps.count()).resolves.toBe(0);

    const saved = await service.saveTree('account-1', treeFixture());
    await expect(
      service.saveTree(
        'account-1',
        { ...treeFixture(), summary: 'stale overwrite' },
        {
          mapId: saved.selectedMapId!,
          requireExisting: true,
          expectedUpdatedAt: 0,
        },
      ),
    ).rejects.toThrow(/map_changed/u);
    await expect(service.load('account-1', 'project-1')).resolves.toMatchObject({
      maps: [{ tree: { summary: 'Project knowledge.' } }],
    });
  });
});

describe('durable Context source readiness', () => {
  it('preserves pending/error across tree hydration and reopen, then publishes ready without changing entities or selection', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const seed = await service.saveTree('account-1', treeFixture(), {mapId:'pending', sourceStatus:'indexing'});
    const hydrated = await service.saveTree('account-1', {...treeFixture(), generatedAt: Date.now()+10}, {mapId:'pending', expectedUpdatedAt:seed.maps[0]!.updatedAt});
    expect(hydrated.maps[0]!.sourceStatus).toBe('indexing');
    await service.saveTree('account-1', treeFixture('C:/other'), {mapId:'other'});
    const ids = hydrated.maps[0]!.tree.nodes;
    const failed = await service.setSourceStatus('account-1','project-1','pending','error',hydrated.maps[0]!.updatedAt);
    const map = failed.maps.find(map=>map.id==='pending')!;
    expect(failed.selectedMapId).toBe('other');
    expect(map.tree.nodes).toEqual(ids);
    const reopened = createContextPersistenceService(database,localStorage);
    expect((await reopened.load('account-1','project-1')).maps.find(map=>map.id==='pending')!.sourceStatus).toBe('error');
    const ready = await reopened.setSourceStatus('account-1','project-1','pending','ready',map.updatedAt);
    expect(ready.maps.find(map=>map.id==='pending')!.sourceStatus).toBe('ready');
    expect(ready.selectedMapId).toBe('other');
    expect(ready.maps.find(map=>map.id==='pending')!.tree.nodes).toEqual(ids);
    await expect(service.setSourceStatus('account-1','project-1','pending','error',map.updatedAt)).rejects.toThrow('map_changed');
  });
  it('rejects foreign and deleted scopes and aborts an in-flight readiness transaction atomically', async () => {
    const service = createContextPersistenceService(database,localStorage);
    const state = await service.saveTree('account-1',treeFixture(),{mapId:'pending',sourceStatus:'indexing'});
    const map = state.maps[0]!;
    await expect(service.setSourceStatus('foreign','project-1',map.id,'ready',map.updatedAt)).rejects.toThrow();
    await expect(service.setSourceStatus('account-1','foreign',map.id,'ready',map.updatedAt)).rejects.toThrow();
    const controller = new AbortController();
    const hook = () => { controller.abort(); };
    database.context_sources.hook('updating',hook);
    await expect(service.setSourceStatus('account-1','project-1',map.id,'ready',map.updatedAt,controller.signal)).rejects.toThrow();
    database.context_sources.hook('updating').unsubscribe(hook);
    const after = (await service.load('account-1','project-1')).maps[0]!;
    expect(after.sourceStatus).toBe('indexing'); expect(after.updatedAt).toBe(map.updatedAt);
    await service.deleteMap('account-1','project-1',map.id);
    await expect(service.setSourceStatus('account-1','project-1',map.id,'ready',map.updatedAt)).rejects.toThrow('map_missing');
  });
});

it('rolls back seed and hydrated tree writes when their live owner aborts during persistence',async()=>{
 const service=createContextPersistenceService(database,localStorage);
 const controller=new AbortController();
 const hook=()=>{controller.abort();};database.context_maps.hook('creating',hook);
 await expect(service.saveTree('account-1',treeFixture(),{mapId:'aborted-seed',sourceStatus:'indexing',signal:controller.signal})).rejects.toThrow();
 database.context_maps.hook('creating').unsubscribe(hook);
 expect((await service.load('account-1','project-1')).maps).toEqual([]);
 const state=await service.saveTree('account-1',treeFixture(),{mapId:'pending',sourceStatus:'indexing'});
 const next=new AbortController();const update=()=>{next.abort();};database.context_entities.hook('updating',update);
 await expect(service.saveTree('account-1',{...treeFixture(),generatedAt:Date.now()+100}, {mapId:'pending',expectedUpdatedAt:state.maps[0]!.updatedAt,signal:next.signal})).rejects.toThrow();
 database.context_entities.hook('updating').unsubscribe(update);
 expect((await service.load('account-1','project-1')).maps[0]).toEqual(state.maps[0]);
});

it('advances the persisted version even when hydration occurs within the same clock tick',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(2_000);
 try {
  const service=createContextPersistenceService(database,localStorage);
  const first=await service.saveTree('account-1',treeFixture(),{mapId:'same-clock',sourceStatus:'indexing'});
  const previous=first.maps[0]!;
  const next=await service.saveTree('account-1',treeFixture(),{mapId:previous.id,expectedUpdatedAt:previous.updatedAt});
  expect(next.maps[0]!.updatedAt).toBeGreaterThan(previous.updatedAt);
  await expect(service.setSourceStatus('account-1','project-1',previous.id,'ready',previous.updatedAt)).rejects.toThrow('map_changed');
 } finally {clock.mockRestore();}
});

it('keeps successful nonlocal imports on their existing ready behavior',async()=>{
 const service=createContextPersistenceService(database,localStorage);
 const source={kind:'github_repository' as const,label:'Repository',branchRef:'main',github:{installationId:'installation-fixture',owner:'owner',repository:'repo',resolvedCommitSha:'a'.repeat(40),visibility:'public' as const}};
 const first=await service.saveTree('account-1',treeFixture(),{mapId:'repository',source,sourceStatus:'error'});
 const next=await service.saveTree('account-1',treeFixture(),{mapId:'repository',source,expectedUpdatedAt:first.maps[0]!.updatedAt});
 expect(next.maps[0]!.sourceStatus).toBe('ready');
});

describe('guarded evidence-link selection intent', () => {
  it('refuses a revoked navigation selection before mutation', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const first = await service.saveTree('account-1', treeFixture(), {
      mapId: 'map-A',
    });
    await service.saveTree('account-1', treeFixture('C:/Second'), {
      mapId: 'map-B',
    });
    const expectedKnowledgeRevision = (await database.context_maps.get(
      'map-A',
    ))!.knowledgeRevision;
    const expectedSelection = await database.settings.get(
      contextSelectionSettingKey('account-1', 'project-1'),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.selectMap('account-1', 'project-1', 'map-A', {
        signal: controller.signal,
        assertCurrent() {
          controller.signal.throwIfAborted();
        },
        expectedSelection,
        expectedKnowledgeRevision,
        expectedMapUpdatedAt: first.maps[0]!.updatedAt,
      }),
    ).rejects.toThrow();
    expect((await service.load('account-1', 'project-1')).selectedMapId).toBe(
      'map-B',
    );
  });

  it('does not overwrite a newer selection after a held old-map load', async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize('account-1', 'project-1');
    const first = await service.saveTree('account-1', treeFixture(), {
      mapId: 'map-A',
    });
    await service.saveTree('account-1', treeFixture('C:/Second'), {
      mapId: 'map-B',
    });
    const expectedKnowledgeRevision = (await database.context_maps.get(
      'map-A',
    ))!.knowledgeRevision;
    const key = contextSelectionSettingKey('account-1', 'project-1');
    const expectedSelection = await database.settings.get(key);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const get = database.settings.get.bind(database.settings);
    let firstGet = true;
    const spy = vi
      .spyOn(database.settings, 'get')
      .mockImplementation((lookup: string | Parameters<JarvisDexie['settings']['get']>[0]) =>
        (typeof lookup === 'string' ? get(lookup) : get(lookup)).then(async (value) => {
          if (typeof lookup === 'string' && lookup === key && firstGet) {
            firstGet = false;
            entered();
            await held;
          }
          return value;
        }),
      );
    const controller = new AbortController();
    const pending = service
      .selectMap('account-1', 'project-1', 'map-A', {
        signal: controller.signal,
        assertCurrent() {
          controller.signal.throwIfAborted();
        },
        expectedSelection,
        expectedKnowledgeRevision,
        expectedMapUpdatedAt: first.maps[0]!.updatedAt,
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    try {
      await reached;
      controller.abort();
      await service.selectMap('account-1', 'project-1', 'map-B');
      release();
      expect((await pending).ok).toBe(false);
      expect((await service.load('account-1', 'project-1')).selectedMapId).toBe(
        'map-B',
      );
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

async function guardedSelectionFixture() {
  const service = createContextPersistenceService(database, localStorage);
  await service.initialize('account-1', 'project-1');
  await service.saveTree('account-1', treeFixture(), { mapId: 'guard-map-A' });
  await service.saveTree('account-1', treeFixture('C:/Second'), {
    mapId: 'guard-map-B',
  });
  const row = await database.context_maps.get('guard-map-A');
  const controller = new AbortController();
  const guard = {
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
    expectedSelection: await database.settings.get(
      contextSelectionSettingKey('account-1', 'project-1'),
    ),
    expectedMapUpdatedAt: row!.updatedAt,
    expectedKnowledgeRevision: row!.knowledgeRevision,
  };
  return { service, controller, guard };
}
it('compares the actual selection row before a guarded citation write', async () => {
  const { service, guard } = await guardedSelectionFixture();
  await service.selectMap('account-1', 'project-1', 'guard-map-A');
  await expect(
    service.selectMap('account-1', 'project-1', 'guard-map-A', guard),
  ).rejects.toThrow('selection_changed');
});
it('rejects a newer map revision even when its timestamp is unchanged', async () => {
  const { service, guard } = await guardedSelectionFixture();
  await database.context_maps.update('guard-map-A', {
    knowledgeRevision: guard.expectedKnowledgeRevision + 1,
  });
  await expect(
    service.selectMap('account-1', 'project-1', 'guard-map-A', guard),
  ).rejects.toThrow('map_changed');
  expect((await service.load('account-1', 'project-1')).selectedMapId).toBe(
    'guard-map-B',
  );
});
it('aborts a successful selection put before commit and preserves the previous map', async () => {
  const { service, guard, controller } = await guardedSelectionFixture();
  const put = database.settings.put.bind(database.settings);
  const spy = vi.spyOn(database.settings, 'put').mockImplementation((...args) =>
    put(...args).then((result) => {
      controller.abort();
      return result;
    }),
  );
  try {
    await expect(
      service.selectMap('account-1', 'project-1', 'guard-map-A', guard),
    ).rejects.toThrow();
    expect((await service.load('account-1', 'project-1')).selectedMapId).toBe(
      'guard-map-B',
    );
  } finally {
    spy.mockRestore();
  }
});
