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
