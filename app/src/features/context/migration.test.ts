import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import {
  contextMapCollectionKey,
  contextSelectedFileKey,
  contextStorageKey,
  type ContextMapRecord,
  type ProjectContextTree,
} from './tree';
import { contextSelectionSettingKey, migrateContextV1ForAccount } from './migration';

function treeFixture(
  rootDir = 'C:\\Projects\\Example',
  generatedAt = 1_000,
  projectId: string | null = 'project-1',
): ProjectContextTree {
  return {
    version: 1,
    projectId,
    rootDir,
    generatedAt,
    model: 'local-fallback',
    fileCount: 2,
    totalBytes: 512,
    summary: 'Legacy project knowledge.',
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
          {
            id: 'note-plan',
            title: 'Plan',
            kind: 'note',
            summary: 'Implementation plan.',
            path: 'docs/plan.md',
            modifiedAt: generatedAt,
          },
        ],
      },
    ],
    recommendedEntryPoints: ['README.md'],
  };
}

function mapFixture(
  id: string,
  status: ContextMapRecord['status'],
  rootDir = 'C:\\Projects\\Example',
  generatedAt = 1_000,
  projectId: string | null = 'project-1',
): ContextMapRecord {
  return {
    id,
    projectId,
    rootDir,
    filePath: `${rootDir}\\context_map.json`,
    name: `${id} name`,
    status,
    createdAt: generatedAt,
    updatedAt: generatedAt + 10,
    tree: treeFixture(rootDir, generatedAt, projectId),
  };
}

function seedCollection(
  storage: Storage,
  maps: ContextMapRecord[],
  selectedMapId = maps[0]?.id,
  projectId: string | null = 'project-1',
): void {
  storage.setItem(
    contextMapCollectionKey(projectId),
    JSON.stringify({
      version: 1,
      projectId,
      selectedMapId: selectedMapId ?? null,
      maps,
    }),
  );
}

let database: JarvisDexie;
let databaseName: string;

beforeEach(async () => {
  localStorage.clear();
  databaseName = uniqueTestDbName('context-v1-migration');
  database = createJarvisDb(databaseName, TEST_INDEXED_DB);
  await database.open();
});

afterEach(async () => {
  localStorage.clear();
  database.close();
  const cleanup = new Dexie(databaseName, TEST_INDEXED_DB);
  await cleanup.delete();
});

describe('Context Map v1 migration', () => {
  it('backs up exact legacy values, preserves map/deleted/selection state, and retains legacy data', async () => {
    const active = mapFixture('map-active', 'active');
    const deleted = mapFixture('map-deleted', 'deleted', 'C:\\Projects\\Archive', 2_000);
    seedCollection(localStorage, [active, deleted], active.id);
    localStorage.setItem(contextStorageKey('project-1'), JSON.stringify(active.tree));
    localStorage.setItem(contextSelectedFileKey('project-1'), 'C:\\Projects\\Example\\README.md');
    const original = {
      collection: localStorage.getItem(contextMapCollectionKey('project-1')),
      tree: localStorage.getItem(contextStorageKey('project-1')),
      selectedFile: localStorage.getItem(contextSelectedFileKey('project-1')),
    };

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result).toMatchObject({
      state: 'migrated',
      expectedMapCount: 2,
      migratedMapCount: 2,
      selectedMapId: 'map-active',
      quarantinedCount: 0,
      legacyRetained: true,
      idRemaps: {},
    });
    await expect(database.context_maps.orderBy('id').toArray()).resolves.toMatchObject([
      {
        id: 'map-active',
        accountId: 'account-1',
        status: 'active',
        sourceIds: ['map-active:source'],
        knowledgeRevision: 1,
      },
      {
        id: 'map-deleted',
        accountId: 'account-1',
        status: 'deleted',
        sourceIds: ['map-deleted:source'],
        knowledgeRevision: 1,
      },
    ]);
    const migratedSource = await database.context_sources.get('map-active:source');
    expect(migratedSource).toMatchObject({
      status: 'stale',
      lastIndexedAt: 1_000,
    });
    expect(migratedSource).not.toHaveProperty('lastVerifiedAt');
    await expect(database.context_edges.where('mapId').equals('map-active').count()).resolves.toBe(
      2,
    );
    await expect(
      database.settings.get(contextSelectionSettingKey('account-1', 'project-1')),
    ).resolves.toMatchObject({
      value: {
        version: 2,
        accountId: 'account-1',
        projectId: 'project-1',
        selectedMapId: 'map-active',
        selectedFile: { mapId: 'map-active', relativePath: 'README.md' },
      },
    });

    const backups = await database.context_migration_backups.toArray();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      status: 'verified',
      expectedMapCount: 2,
      migratedMapCount: 2,
      migratedMapIds: ['map-active', 'map-deleted'],
      rollbackAvailable: true,
      verifiedAt: 5_000,
    });
    expect(backups[0]?.legacyValues).toEqual({
      [contextMapCollectionKey('project-1')]: original.collection,
      [contextStorageKey('project-1')]: original.tree,
      [contextSelectedFileKey('project-1')]: original.selectedFile,
    });
    expect(localStorage.getItem(contextMapCollectionKey('project-1'))).toBe(original.collection);
    expect(localStorage.getItem(contextStorageKey('project-1'))).toBe(original.tree);
    expect(localStorage.getItem(contextSelectedFileKey('project-1'))).toBe(original.selectedFile);
  });

  it('is idempotent and resumes from the exact verified backup marker', async () => {
    seedCollection(localStorage, [mapFixture('map-active', 'active')]);

    const first = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });
    const second = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 6_000,
    });

    expect(first.state).toBe('migrated');
    expect(second).toMatchObject({
      state: 'already_migrated',
      backupId: first.backupId,
      migratedMapCount: 1,
    });
    await expect(database.context_migration_backups.count()).resolves.toBe(1);
    await expect(database.context_maps.count()).resolves.toBe(1);
    await expect(database.context_entities.count()).resolves.toBe(3);

    const migrated = await database.context_maps.get('map-active');
    if (!migrated) throw new Error('Expected migrated map.');
    await database.context_maps.delete('map-active');
    await database.context_maps.put({ ...migrated, id: 'unrelated-map' });

    const repaired = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 7_000,
    });
    expect(repaired.state).toBe('migrated');
    await expect(database.context_maps.get('map-active')).resolves.toBeDefined();
  });

  it('repairs a verified marker with contradictory expected and migrated counts', async () => {
    seedCollection(localStorage, [mapFixture('map-active', 'active')]);
    const first = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });
    if (!first.backupId) throw new Error('Expected a migration backup.');
    await database.context_migration_backups.update(first.backupId, {
      expectedMapCount: 2,
    });

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: 'project-1',
        now: () => 6_000,
      }),
    ).resolves.toMatchObject({
      state: 'migrated',
      expectedMapCount: 1,
      migratedMapCount: 1,
    });
    await expect(database.context_migration_backups.get(first.backupId)).resolves.toMatchObject({
      status: 'verified',
      expectedMapCount: 1,
      migratedMapCount: 1,
      migratedMapIds: ['map-active'],
    });
  });

  it('quarantines malformed maps while migrating and verifying valid maps', async () => {
    const valid = mapFixture('map-valid', 'active');
    seedCollection(localStorage, [
      valid,
      {
        ...mapFixture('map-corrupt', 'active'),
        tree: { version: 1, nodes: 'not-an-array' },
      } as unknown as ContextMapRecord,
    ]);

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result).toMatchObject({
      state: 'migrated_with_quarantine',
      expectedMapCount: 1,
      migratedMapCount: 1,
      quarantinedCount: 1,
    });
    await expect(database.context_maps.get('map-valid')).resolves.toBeDefined();
    await expect(database.context_maps.get('map-corrupt')).resolves.toBeUndefined();
    await expect(database.context_quarantine.toArray()).resolves.toMatchObject([
      {
        accountId: 'account-1',
        recordKind: 'map',
        reason: 'legacy_map_invalid',
        recoveryOptions: ['retry', 'restore_backup', 'export_then_discard'],
      },
    ]);
  });

  it('falls back to the legacy selected tree when the collection is corrupt', async () => {
    const legacyTree = treeFixture();
    localStorage.setItem(contextMapCollectionKey('project-1'), '{bad-json');
    localStorage.setItem(contextStorageKey('project-1'), JSON.stringify(legacyTree));

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result.state).toBe('migrated_with_quarantine');
    expect(result.migratedMapCount).toBe(1);
    await expect(database.context_quarantine.toArray()).resolves.toMatchObject([
      { recordKind: 'legacy_collection', reason: 'legacy_collection_json_invalid' },
    ]);
    const maps = await database.context_maps.toArray();
    expect(maps).toHaveLength(1);
    expect(maps[0]?.name).toBe('Example Context Map');
  });

  it('preserves a distinct legacy selected tree alongside valid collection maps', async () => {
    seedCollection(localStorage, [mapFixture('map-active', 'active')]);
    localStorage.setItem(
      contextStorageKey('project-1'),
      JSON.stringify(treeFixture('C:\\Projects\\Separate', 3_000)),
    );

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result.migratedMapCount).toBe(2);
    await expect(
      database.context_maps.where('accountId').equals('account-1').toArray(),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'map-active' }),
        expect.objectContaining({ name: 'Separate Context Map' }),
      ]),
    );
  });

  it('claims retained legacy data once and rejects sequential cross-account disclosure', async () => {
    seedCollection(localStorage, [mapFixture('map-shared', 'active')]);
    await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-2',
        projectId: 'project-1',
        now: () => 6_000,
      }),
    ).rejects.toThrow('context_migration_legacy_claimed_by_another_account');
    await expect(database.context_maps.count()).resolves.toBe(1);
    await expect(database.context_maps.get('map-shared')).resolves.toMatchObject({
      accountId: 'account-1',
    });
  });

  it('atomically rejects one of two concurrent accounts claiming the same legacy payload', async () => {
    seedCollection(localStorage, [mapFixture('map-shared', 'active')]);
    const results = await Promise.allSettled(
      ['account-1', 'account-2'].map((accountId, index) =>
        migrateContextV1ForAccount({
          database,
          storage: localStorage,
          accountId,
          projectId: 'project-1',
          now: () => 5_000 + index,
        }),
      ),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status === 'rejected') {
      expect(String(rejected.reason)).toContain('context_migration_legacy_claimed_by_another_account');
    }
    await expect(database.context_maps.count()).resolves.toBe(1);
    await expect(database.context_migration_backups.count()).resolves.toBe(1);
  });

  it('rejects changed retained legacy bytes instead of silently migrating them again', async () => {
    seedCollection(localStorage, [mapFixture('map-shared', 'active')]);
    await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });
    seedCollection(localStorage, [
      mapFixture('map-shared', 'active', 'C:\\Projects\\Different', 2_000),
    ]);

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: 'project-1',
        now: () => 6_000,
      }),
    ).rejects.toThrow('context_migration_legacy_payload_changed');
    await expect(database.context_maps.count()).resolves.toBe(1);
    await expect(database.context_sources.get('map-shared:source')).resolves.toMatchObject({
      localRoot: 'C:\\Projects\\Example',
    });
  });

  it('keeps remapped ids isolated across three projects in the same account', async () => {
    for (const [index, projectId] of ['project-1', 'project-2', 'project-3'].entries()) {
      seedCollection(
        localStorage,
        [mapFixture('map-shared', 'active', 'C:\\Projects\\Example', 1_000, projectId)],
        'map-shared',
        projectId,
      );
      const result = await migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId,
        now: () => 5_000 + index,
      });
      expect(result.quarantinedCount).toBe(0);
      expect(result.migratedMapCount).toBe(1);
      const restarted = await migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId,
        now: () => 6_000 + index,
      });
      expect(restarted).toMatchObject({
        state: 'already_migrated',
        idRemaps: result.idRemaps,
      });
    }

    const maps = await database.context_maps.where('accountId').equals('account-1').toArray();
    expect(maps).toHaveLength(3);
    expect(new Set(maps.map(({ id }) => id)).size).toBe(3);
    expect(new Set(maps.map(({ projectId }) => projectId))).toEqual(
      new Set(['project-1', 'project-2', 'project-3']),
    );
  });

  it('migrates one duplicate legacy map id and quarantines the duplicate', async () => {
    seedCollection(localStorage, [
      mapFixture('map-duplicate', 'active'),
      mapFixture('map-duplicate', 'deleted'),
    ]);

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result).toMatchObject({
      state: 'migrated_with_quarantine',
      expectedMapCount: 1,
      migratedMapCount: 1,
      quarantinedCount: 1,
    });
    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: 'project-1',
        now: () => 6_000,
      }),
    ).resolves.toMatchObject({
      state: 'already_migrated',
      quarantinedCount: 1,
    });
    await expect(database.context_maps.count()).resolves.toBe(1);
    await expect(database.context_quarantine.toArray()).resolves.toMatchObject([
      {
        mapId: 'map-duplicate',
        reason: 'legacy_map_id_duplicate',
      },
    ]);
    await expect(database.context_migration_backups.toArray()).resolves.toMatchObject([
      {
        migratedMapIds: ['map-duplicate'],
        expectedMapCount: 1,
        migratedMapCount: 1,
      },
    ]);
  });

  it('rejects the reserved project sentinel instead of aliasing null-project legacy data', async () => {
    seedCollection(
      localStorage,
      [mapFixture('map-default', 'active', 'C:\\Projects\\Default', 1_000, null)],
      'map-default',
      null,
    );

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: '__default__',
        now: () => 5_000,
      }),
    ).rejects.toThrow('context_migration_identity_invalid');
    await expect(database.context_migration_backups.count()).resolves.toBe(0);
    await expect(database.context_maps.count()).resolves.toBe(0);

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: null,
        now: () => 5_001,
      }),
    ).resolves.toMatchObject({
      state: 'migrated',
      migratedMapCount: 1,
    });
  });

  it('leaves the marker prepared and retries after an operational write failure', async () => {
    seedCollection(localStorage, [mapFixture('map-retry', 'active')]);
    const put = vi
      .spyOn(database.context_maps, 'put')
      .mockRejectedValueOnce(new Error('transient IndexedDB failure'));

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: 'project-1',
        now: () => 5_000,
      }),
    ).rejects.toThrow('transient IndexedDB failure');
    put.mockRestore();

    await expect(database.context_migration_backups.toArray()).resolves.toMatchObject([
      {
        status: 'prepared',
        migratedMapIds: [],
      },
    ]);
    await expect(database.context_quarantine.count()).resolves.toBe(0);

    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: 'project-1',
        now: () => 6_000,
      }),
    ).resolves.toMatchObject({
      state: 'migrated',
      migratedMapCount: 1,
    });
    await expect(database.context_migration_backups.toArray()).resolves.toMatchObject([
      {
        status: 'verified',
        migratedMapIds: ['map-retry'],
      },
    ]);
  });

  it('quarantines an outside-root selected file instead of persisting it', async () => {
    seedCollection(localStorage, [mapFixture('map-active', 'active')]);
    localStorage.setItem(contextSelectedFileKey('project-1'), 'C:\\Private\\secrets.txt');

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result.state).toBe('migrated_with_quarantine');
    const selection = await database.settings.get(
      contextSelectionSettingKey('account-1', 'project-1'),
    );
    expect(selection?.value).not.toHaveProperty('selectedFile');
    await expect(
      database.context_quarantine.where('recordKind').equals('legacy_selected_file').count(),
    ).resolves.toBe(1);
    expect(localStorage.getItem(contextSelectedFileKey('project-1'))).toBe(
      'C:\\Private\\secrets.txt',
    );
  });

  it('accepts a drive root without weakening path containment', async () => {
    seedCollection(localStorage, [mapFixture('map-root', 'active', 'C:\\')]);
    localStorage.setItem(contextSelectedFileKey('project-1'), 'C:\\README.md');

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result.state).toBe('migrated');
    await expect(database.context_sources.get('map-root:source')).resolves.toMatchObject({
      localRoot: 'C:\\',
    });
  });

  it('quarantines an orphan selected file when no map can own it', async () => {
    localStorage.setItem(contextSelectedFileKey('project-1'), 'README.md');

    const result = await migrateContextV1ForAccount({
      database,
      storage: localStorage,
      accountId: 'account-1',
      projectId: 'project-1',
      now: () => 5_000,
    });

    expect(result).toMatchObject({
      state: 'migrated_with_quarantine',
      migratedMapCount: 0,
      quarantinedCount: 1,
    });
    await expect(database.context_quarantine.toArray()).resolves.toMatchObject([
      {
        recordKind: 'legacy_selected_file',
        reason: 'legacy_selected_file_map_missing',
      },
    ]);
  });

  it('returns a no-data result without creating a marker', async () => {
    await expect(
      migrateContextV1ForAccount({
        database,
        storage: localStorage,
        accountId: 'account-1',
        projectId: 'project-1',
        now: () => 5_000,
      }),
    ).resolves.toMatchObject({
      state: 'no_legacy_data',
      migratedMapCount: 0,
      legacyRetained: true,
    });
    await expect(database.context_migration_backups.count()).resolves.toBe(0);
  });
});

describe('N11 legacy file migration admission', () => {
  it('does not silently convert an ambiguous local-file row into a folder grant', async () => {
    const map={...mapFixture('map-old-file','active'),sourceType:'local_file' as const};
    seedCollection(localStorage,[map]);
    const key=contextMapCollectionKey('project-1');const before=localStorage.getItem(key);
    await migrateContextV1ForAccount({database,storage:localStorage,accountId:'account-1',projectId:'project-1'});
    const sources=await database.context_sources.toArray();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({kind:'local_file',localFile:map.rootDir});
    expect((sources[0] as {localFileScope?:unknown}).localFileScope).toBeUndefined();
    expect(localStorage.getItem(key)).toBe(before);
  });
});

describe('N11 explicitly scoped legacy-format recovery', () => {
  it('retains an explicit versioned file scope instead of discarding it on migration', async () => {
    const root='/owned/docs';
    const map={...mapFixture('map-scoped-file','active',root),sourceType:'local_file' as const,
      localFileScope:{version:1 as const,rootDir:root,filePath:root+'/README.md'}};
    map.tree.nodes=[{id:'file-readme',kind:'file',title:'README.md',path:'README.md',summary:'',createdAt:1000,modifiedAt:1000}];
    map.tree.fileCount=1;
    seedCollection(localStorage,[map]);
    const key=contextMapCollectionKey('project-1');const before=localStorage.getItem(key);
    await migrateContextV1ForAccount({database,storage:localStorage,accountId:'account-1',projectId:'project-1'});
    expect((await database.context_sources.toArray())[0]).toMatchObject({kind:'local_file',localFile:root+'/README.md',localFileScope:map.localFileScope});
    expect(localStorage.getItem(key)).toBe(before);
  });
});

describe('N11 standalone legacy-tree recovery', () => {
  it.each([false,true])('preserves standalone local-file intent (versioned scope=%s)',async explicit=>{
    const root='/owned/docs';const scope={version:1 as const,rootDir:root,filePath:root+'/README.md'};
    const tree={...treeFixture(root),sourceType:'local_file' as const,...(explicit?{localFileScope:scope}:{}),nodes:[{id:'file-readme',kind:'file' as const,title:'README.md',path:'README.md',summary:''}],fileCount:1};
    const key=contextStorageKey('project-1');const bytes=JSON.stringify(tree);localStorage.setItem(key,bytes);
    await migrateContextV1ForAccount({database,storage:localStorage,accountId:'account-1',projectId:'project-1'});
    const source=(await database.context_sources.toArray())[0];
    expect(source?.kind).toBe('local_file');
    if(explicit)expect(source).toMatchObject({localFile:scope.filePath,localFileScope:scope});
    else expect(source).toMatchObject({status:'permission_required',localFile:root});
    expect(localStorage.getItem(key)).toBe(bytes);
  });
});
