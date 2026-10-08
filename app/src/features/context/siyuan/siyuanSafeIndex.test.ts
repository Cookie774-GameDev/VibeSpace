import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextMapRecord } from '../tree';
import {
  buildProjectContextTreeFromSiyuanIndex,
  buildSiyuanSafeIndex,
  createDurableSiyuanIndexJobControl,
  createSiyuanIndexJobControl,
  projectSiyuanMapForContextSearch,
  scanSiyuanFilesystemIndex,
  siyuanIndexPolicyFingerprint,
  type SiyuanIndexJobGeneration,
} from './siyuanSafeIndex';
import {
  checkpointSiyuanIndexJob,
  createSiyuanIndexJob,
  readSiyuanIndexEntries,
  readSiyuanIndexJob,
  replaceSiyuanIndexJob,
  updateSiyuanIndexJobStatus,
} from './siyuanIndexJobStore';

async function resetDurableJobs(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('vibespace-siyuan-index-jobs');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database_delete_blocked'));
  });
}

function map(): ContextMapRecord {
  return {
    id: 'map-1',
    projectId: 'project-1',
    rootDir: 'C:\\Users\\viper',
    name: 'Viper',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    tree: {
      version: 1,
      projectId: 'project-1',
      rootDir: 'C:\\Users\\viper',
      generatedAt: 1,
      model: 'local-structural',
      fileCount: 4,
      totalBytes: 4,
      summary: '',
      nodes: [
        {
          id: 'docs',
          title: 'Documents',
          kind: 'area',
          summary: 'Documents folder',
          path: 'Documents',
          children: [
            {
              id: 'safe',
              title: 'notes.md',
              kind: 'file',
              summary: 'Useful notes',
              path: 'Documents/notes.md',
            },
            {
              id: 'secret',
              title: '.env',
              kind: 'file',
              summary: 'API_KEY=secret-value',
              path: 'Documents/.env',
            },
            {
              id: 'outside',
              title: 'outside.txt',
              kind: 'file',
              summary: 'Outside',
              path: 'D:\\outside.txt',
            },
          ],
        },
      ],
    },
  };
}

describe('SiYuan safe read-only index', () => {
  beforeEach(resetDurableJobs);

  it('projects the durable hierarchy and exact file count into the persisted Context tree', () => {
    const seed = map().tree;
    const tree = buildProjectContextTreeFromSiyuanIndex(seed, [
      {
        nodeId: 'area:src',
        parentNodeId: null,
        title: 'src',
        kind: 'area',
        relativePath: 'src',
        sourcePointer: 'C:/Users/viper/src',
        summary: null,
        sizeBytes: null,
        modifiedAt: 10,
      },
      {
        nodeId: 'file:src/index.ts',
        parentNodeId: 'area:src',
        title: 'index.ts',
        kind: 'file',
        relativePath: 'src/index.ts',
        sourcePointer: 'C:/Users/viper/src/index.ts',
        summary: 'Entry point',
        sizeBytes: 42,
        modifiedAt: 11,
      },
      {
        nodeId: 'file:README.md',
        parentNodeId: null,
        title: 'README.md',
        kind: 'file',
        relativePath: 'README.md',
        sourcePointer: 'C:/Users/viper/README.md',
        summary: null,
        sizeBytes: 8,
        modifiedAt: 12,
      },
    ]);

    expect(tree).toMatchObject({
      model: 'siyuan-managed-v1',
      fileCount: 2,
      totalBytes: 50,
      nodes: [
        {
          id: 'area:src',
          kind: 'area',
          children: [{ id: 'file:src/index.ts', kind: 'file', summary: 'Entry point' }],
        },
        { id: 'file:README.md', kind: 'file' },
      ],
    });
  });

  it('projects a picker verbatim drive root to the strict physical Context Search reader', () => {
    const persisted = map();
    persisted.rootDir = '\\\\?\\C:\\Users\\viper\\projects';
    persisted.tree.rootDir = persisted.rootDir;

    const projected = projectSiyuanMapForContextSearch(persisted);

    expect(projected.id).toBe(persisted.id);
    expect(projected.status).toBe('active');
    expect(projected.rootDir).toBe('C:/Users/viper/projects');
    expect(projected.tree.rootDir).toBe('C:/Users/viper/projects');
    expect(projected.tree.nodes).toBe(persisted.tree.nodes);
    expect(persisted.rootDir).toBe('\\\\?\\C:\\Users\\viper\\projects');
  });

  it('keeps source pointers inside the selected root and excludes credentials', () => {
    const index = buildSiyuanSafeIndex(map(), {
      mode: 'all',
      selectedExtensions: [],
      selectedPaths: [],
    });
    expect(index.entries.map((entry) => entry.nodeId)).toEqual(['docs', 'safe']);
    expect(index.entries[1]?.sourcePointer).toBe('C:/Users/viper/Documents/notes.md');
    expect(index.excluded).toBe(2);
  });

  it('maps every safe node while summarizing only the user-selected content', () => {
    const index = buildSiyuanSafeIndex(map(), {
      mode: 'selected',
      selectedExtensions: ['md'],
      selectedPaths: [],
    });
    expect(index.entries).toHaveLength(2);
    expect(index.entries.find((entry) => entry.nodeId === 'docs')?.summary).toBeNull();
    expect(index.entries.find((entry) => entry.nodeId === 'safe')?.summary).toBe('Useful notes');
    expect(index.summarized).toBe(1);
  });

  it('accepts an absolute selected summary folder inside the source root', () => {
    const index = buildSiyuanSafeIndex(map(), {
      mode: 'selected',
      selectedExtensions: [],
      selectedPaths: ['C:\\Users\\viper\\Documents'],
    });
    expect(index.entries.find((entry) => entry.nodeId === 'docs')?.summary).toBe(
      'Documents folder',
    );
    expect(index.entries.find((entry) => entry.nodeId === 'safe')?.summary).toBe('Useful notes');
    expect(index.summarized).toBe(2);
  });

  it('treats selecting the exact source root as all eligible content in that root', () => {
    const index = buildSiyuanSafeIndex(map(), {
      mode: 'selected',
      selectedExtensions: [],
      selectedPaths: ['C:\\Users\\viper'],
    });

    expect(index.entries.find((entry) => entry.nodeId === 'docs')?.summary).toBe(
      'Documents folder',
    );
    expect(index.entries.find((entry) => entry.nodeId === 'safe')?.summary).toBe('Useful notes');
    expect(index.summarized).toBe(2);
  });

  it('migrates a durable legacy root-summary fingerprint without restarting discovery', async () => {
    const legacyFingerprint = JSON.stringify({
      schemaVersion: 1,
      root: 'c:/users/viper',
      summaryMode: 'selected',
      selectedExtensions: [],
      selectedPaths: [],
      excludedPaths: [],
    });
    const legacy = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/Users/viper',
      policyFingerprint: legacyFingerprint,
      now: 100,
    });
    await replaceSiyuanIndexJob(legacy, {
      path: 'C:/Users/viper',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job: { ...legacy, phase: 'creating_nodes', updatedAt: 200 },
    });

    await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'selected', selectedExtensions: [], selectedPaths: ['C:\\Users\\viper'] },
      { durableJob: { accountId: null, projectId: 'project-1', mapId: 'map-1' } },
    );

    expect((await readSiyuanIndexJob('project-1', 'map-1'))?.policyFingerprint).toContain(
      '"schemaVersion":2',
    );
  });

  it('accepts Windows authority roots that differ only by slash and letter casing', async () => {
    const policy = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
    const existing = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'c:/users/VIPER',
      policyFingerprint: siyuanIndexPolicyFingerprint('C:/Users/viper', policy, []),
      now: 100,
    });
    await replaceSiyuanIndexJob(existing, {
      path: 'c:/users/VIPER',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job: { ...existing, phase: 'creating_nodes', updatedAt: 200 },
    });

    await expect(
      scanSiyuanFilesystemIndex(map(), policy, {
        durableJob: { accountId: null, projectId: 'project-1', mapId: 'map-1' },
      }),
    ).resolves.toBeDefined();
  });

  it('opens a picker verbatim drive root through the ordinary strict filesystem authority', async () => {
    const record = {
      ...map(),
      rootDir: '\\\\?\\C:\\Users\\viper\\Documents\\Projects',
      tree: {
        ...map().tree,
        rootDir: '\\\\?\\C:\\Users\\viper\\Documents\\Projects',
      },
    };
    const requestedBatches: Array<{
      paths: readonly string[];
      options: Readonly<{ root: string; strictProjectBoundary: true }>;
    }> = [];

    const index = await scanSiyuanFilesystemIndex(
      record,
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        listBatch: async (paths, options) => {
          requestedBatches.push({ paths: [...paths], options });
          return [
            {
              ok: true,
              path: paths[0]!,
              entries: [
                {
                  name: 'README.md',
                  path: 'C:/Users/viper/Documents/Projects/README.md',
                  isDir: false,
                  size: 12,
                  modifiedMs: 42,
                },
              ],
            },
          ];
        },
      },
    );

    expect(requestedBatches).toEqual([
      {
        paths: ['C:/Users/viper/Documents/Projects'],
        options: {
          root: 'C:/Users/viper/Documents/Projects',
          strictProjectBoundary: true,
        },
      },
    ]);
    expect(index.entries).toEqual([
      expect.objectContaining({
        nodeId: 'path:README.md',
        relativePath: 'README.md',
        sourcePointer: 'C:/Users/viper/Documents/Projects/README.md',
      }),
    ]);
    expect(
      siyuanIndexPolicyFingerprint(
        record.rootDir,
        {
          mode: 'none',
          selectedExtensions: [],
          selectedPaths: [],
        },
        [],
      ),
    ).toContain('"root":"c:/users/viper/documents/projects"');
  });

  it('repairs an empty durable discovery checkpoint written with the malformed verbatim root', async () => {
    const record = {
      ...map(),
      rootDir: '\\\\?\\C:\\Users\\viper\\Documents\\Projects',
      tree: {
        ...map().tree,
        rootDir: '\\\\?\\C:\\Users\\viper\\Documents\\Projects',
      },
    };
    const policy = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
    const malformedFingerprint = JSON.stringify({
      schemaVersion: 2,
      root: '/?/c:/users/viper/documents/projects',
      summaryMode: 'none',
      selectedExtensions: [],
      selectedPaths: [],
      excludedPaths: [],
    });
    const malformed = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: record.id,
      canonicalRoot: '/?/C:/Users/viper/Documents/Projects',
      policyFingerprint: malformedFingerprint,
      now: 100,
    });
    await replaceSiyuanIndexJob(malformed, {
      path: '/?/C:/Users/viper/Documents/Projects',
      relativePath: '',
      parentNodeId: null,
    });

    await expect(
      scanSiyuanFilesystemIndex(record, policy, {
        durableJob: { accountId: null, projectId: 'project-1', mapId: record.id },
        listBatch: async (paths) => paths.map((path) => ({ ok: true as const, path, entries: [] })),
      }),
    ).resolves.toMatchObject({ entries: [] });

    expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
      canonicalRoot: 'C:/Users/viper/Documents/Projects',
      policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []),
      cursor: 1,
      indexed: 0,
    });
  });

  it('maps structure without sending any summaries when the user chooses none', () => {
    const index = buildSiyuanSafeIndex(map(), {
      mode: 'none',
      selectedExtensions: ['md'],
      selectedPaths: ['Documents'],
    });
    expect(index.entries).toHaveLength(2);
    expect(index.entries.every((entry) => entry.summary === null)).toBe(true);
  });

  it('honors a user-reviewed absolute exclusion only inside the selected root', () => {
    const index = buildSiyuanSafeIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      ['C:\\Users\\viper\\Documents'],
    );
    expect(index.entries).toEqual([]);
    expect(index.excluded).toBe(1);
  });

  it('excludes credential-bearing configuration directories and token files by default', async () => {
    const index = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        list: async (path) => ({
          ok: true,
          path,
          entries:
            path === 'C:/Users/viper'
              ? [
                  { name: '.codex', path: 'C:/Users/viper/.codex', isDir: true },
                  { name: '.aws', path: 'C:/Users/viper/.aws', isDir: true },
                  { name: 'token.json', path: 'C:/Users/viper/token.json', isDir: false },
                  { name: 'Projects', path: 'C:/Users/viper/Projects', isDir: true },
                ]
              : [],
        }),
      },
    );
    expect(index.entries.map((entry) => entry.relativePath)).toEqual(['Projects']);
    expect(index.excluded).toBe(3);
  });

  it('walks nested filesystem metadata beyond the bounded content preview and fails safely', async () => {
    const listings = new Map<
      string,
      Array<{ name: string; path: string; isDir: boolean; size?: number }>
    >([
      [
        'C:/Users/viper',
        [
          { name: 'Documents', path: 'C:/Users/viper/Documents', isDir: true },
          { name: 'AppData', path: 'C:/Users/viper/AppData/Local/Google/Chrome', isDir: true },
          { name: 'Locked', path: 'C:/Users/viper/Locked', isDir: true },
        ],
      ],
      [
        'C:/Users/viper/Documents',
        [
          { name: '.env', path: 'C:/Users/viper/Documents/.env', isDir: false },
          { name: 'nested', path: 'C:/Users/viper/Documents/nested', isDir: true },
          { name: 'notes.md', path: 'C:/Users/viper/Documents/notes.md', isDir: false, size: 12 },
        ],
      ],
      [
        'C:/Users/viper/Documents/nested',
        [{ name: 'page.html', path: 'C:/Users/viper/Documents/nested/page.html', isDir: false }],
      ],
    ]);
    const progress: number[] = [];
    const index = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'selected', selectedExtensions: ['md', 'html'], selectedPaths: [] },
      {
        list: async (path) => {
          if (path === 'C:/Users/viper/Locked') {
            return { ok: false, path, error: { code: 'symlink_blocked' } };
          }
          return { ok: true, path, entries: listings.get(path) ?? [] };
        },
        onProgress: ({ indexed }) => progress.push(indexed),
      },
    );

    expect(index.entries.map((entry) => entry.relativePath)).toEqual([
      'Documents',
      'Locked',
      'Documents/nested',
      'Documents/notes.md',
      'Documents/nested/page.html',
    ]);
    expect(
      index.entries.find((entry) => entry.relativePath === 'Documents/notes.md')?.summary,
    ).toBe('Useful notes');
    expect(index.excluded).toBe(2);
    expect(index.unreadable).toBe(1);
    expect(progress.length).toBeGreaterThan(1);
  });

  it('pauses, resumes, and cancels cooperatively without losing the job identity', async () => {
    const control = createSiyuanIndexJobControl();
    control.pause();
    let continued = false;
    const waiting = control.checkpoint().then(() => {
      continued = true;
    });
    await Promise.resolve();
    expect(continued).toBe(false);
    control.resume();
    await waiting;
    expect(continued).toBe(true);
    control.cancel();
    await expect(control.checkpoint()).rejects.toThrow('siyuan_index_cancelled');
  });

  it('releases a paused in-memory checkpoint when its renderer signal aborts', async () => {
    const control = createSiyuanIndexJobControl();
    const controller = new AbortController();
    control.pause();
    const waiting = control.checkpoint(controller.signal);
    controller.abort('renderer_reload');
    await expect(waiting).rejects.toThrow('siyuan_index_cancelled');
  });

  it('enumerates independent directories with bounded concurrency', async () => {
    let active = 0;
    let maximum = 0;
    let releaseChildren!: () => void;
    const childrenReady = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    const index = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        list: async (path) => {
          if (path === 'C:/Users/viper') {
            return {
              ok: true,
              path,
              entries: [
                { name: 'One', path: 'C:/Users/viper/One', isDir: true },
                { name: 'Two', path: 'C:/Users/viper/Two', isDir: true },
              ],
            };
          }
          active += 1;
          maximum = Math.max(maximum, active);
          if (active === 2) releaseChildren();
          await childrenReady;
          active -= 1;
          return { ok: true, path, entries: [] };
        },
      },
    );
    expect(maximum).toBe(2);
    expect(index.entries.map((entry) => entry.relativePath)).toEqual(['One', 'Two']);
  });

  it('lists 129 nested directories through bounded ordered batches of 64', async () => {
    const root = 'C:/Users/viper';
    const directories = Array.from({ length: 129 }, (_, index) => ({
      name: `Dir-${String(index).padStart(3, '0')}`,
      path: `${root}/Dir-${String(index).padStart(3, '0')}`,
      isDir: true,
    }));
    const requestedBatches: string[][] = [];

    const index = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        listBatch: async (paths, options) => {
          expect(options).toEqual({ root, strictProjectBoundary: true });
          requestedBatches.push([...paths]);
          return paths.map((path) => ({
            ok: true as const,
            path,
            entries: path === root ? directories : [],
          }));
        },
      },
    );

    expect(requestedBatches.map((batch) => batch.length)).toEqual([1, 64, 64, 1]);
    expect(requestedBatches).toHaveLength(4);
    expect(requestedBatches.flat()).toHaveLength(130);
    expect(new Set(requestedBatches.flat()).size).toBe(130);
    expect(index.entries.map((entry) => entry.relativePath)).toEqual(
      directories.map((directory) => directory.name),
    );
  });

  it('skips excluded directories while unreadable siblings do not stop the batch', async () => {
    const root = 'C:/Users/viper';
    const requestedBatches: string[][] = [];
    const index = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        listBatch: async (paths) => {
          requestedBatches.push([...paths]);
          return paths.map((path) => {
            if (path === root) {
              return {
                ok: true as const,
                path,
                entries: [
                  { name: '.git', path: `${root}/.git`, isDir: true },
                  {
                    name: 'target-codex-tests',
                    path: `${root}/Allowed/target-codex-tests`,
                    isDir: true,
                  },
                  { name: 'Allowed', path: `${root}/Allowed`, isDir: true },
                  { name: 'Locked', path: `${root}/Locked`, isDir: true },
                  { name: 'Other', path: `${root}/Other`, isDir: true },
                ],
              };
            }
            if (path === `${root}/Locked`) {
              return {
                ok: false as const,
                path,
                error: { code: 'symlink_blocked' as const },
              };
            }
            return {
              ok: true as const,
              path,
              entries: [
                {
                  name: path.endsWith('/Allowed') ? 'notes.md' : 'image.png',
                  path: `${path}/${path.endsWith('/Allowed') ? 'notes.md' : 'image.png'}`,
                  isDir: false,
                },
              ],
            };
          });
        },
      },
    );

    expect(requestedBatches).toHaveLength(2);
    expect(requestedBatches.flat()).not.toContain(`${root}/.git`);
    expect(requestedBatches.flat()).not.toContain(`${root}/Allowed/target-codex-tests`);
    expect(index.excluded).toBe(2);
    expect(index.unreadable).toBe(1);
    expect(index.entries.map((entry) => entry.relativePath)).toEqual([
      'Allowed',
      'Locked',
      'Other',
      'Allowed/notes.md',
      'Other/image.png',
    ]);
  });

  it('stops before the next native batch when cancellation follows a completed batch', async () => {
    const root = 'C:/Users/viper';
    const directories = Array.from({ length: 65 }, (_, index) => ({
      name: `Dir-${String(index).padStart(2, '0')}`,
      path: `${root}/Dir-${String(index).padStart(2, '0')}`,
      isDir: true,
    }));
    const requestedBatches: string[][] = [];
    const indexedProgress: number[] = [];
    let checkpoints = 0;

    await expect(
      scanSiyuanFilesystemIndex(
        map(),
        { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        {
          control: {
            state: 'running',
            pause() {},
            resume() {},
            cancel() {},
            async checkpoint() {
              checkpoints += 1;
              if (checkpoints > 1) throw new Error('siyuan_index_cancelled');
            },
          },
          listBatch: async (paths) => {
            requestedBatches.push([...paths]);
            return paths.map((path) => ({
              ok: true as const,
              path,
              entries: path === root ? directories : [],
            }));
          },
          onProgress: ({ indexed }) => indexedProgress.push(indexed),
        },
      ),
    ).rejects.toThrow('siyuan_index_cancelled');

    expect(requestedBatches).toEqual([[root]]);
    expect(indexedProgress.at(-1)).toBe(65);
    expect(checkpoints).toBe(2);
  });

  it('does not advance a durable discovery cursor when a native batch fails globally', async () => {
    const durableJob = { accountId: null, projectId: 'project-1', mapId: 'map-1' };
    await expect(
      scanSiyuanFilesystemIndex(
        map(),
        { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        {
          durableJob,
          listBatch: async () => {
            throw new Error('fs_list_dirs_strict:root_not_found');
          },
        },
      ),
    ).rejects.toThrow('fs_list_dirs_strict:root_not_found');

    const failed = await readSiyuanIndexJob('project-1', 'map-1');
    expect(failed).toMatchObject({ cursor: 0, indexed: 0, frontierLength: 1 });

    const resumed = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        durableJob,
        listBatch: async (paths) =>
          paths.map((path) => ({
            ok: true as const,
            path,
            entries:
              path === 'C:/Users/viper'
                ? [
                    {
                      name: 'recovered.txt',
                      path: 'C:/Users/viper/recovered.txt',
                      isDir: false,
                    },
                  ]
                : [],
          })),
      },
    );
    expect(resumed.entries.map((entry) => entry.relativePath)).toEqual(['recovered.txt']);
  });

  it('indexes a synthetic source far beyond the 120-file content-preview limit', async () => {
    const files = Array.from({ length: 5_000 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `C:/Users/viper/large/file-${index}.txt`,
      isDir: false,
      size: index,
    }));
    const index = await scanSiyuanFilesystemIndex(
      { ...map(), rootDir: 'C:\\Users\\viper\\large' },
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      { list: async (path) => ({ ok: true, path, entries: files }) },
    );
    expect(index.entries).toHaveLength(5_000);
    expect(index.entries.at(-1)?.sourcePointer).toMatch(/file-\d+\.txt$/u);
  });

  it('durably checkpoints an oversized directory every 250 entries and resumes idempotently', async () => {
    const controller = new AbortController();
    const files = Array.from({ length: 600 }, (_, index) => {
      const sourcePath = `C:/Users/viper/large/file-${String(index).padStart(3, '0')}.txt`;
      return {
        name: `file-${String(index).padStart(3, '0')}.txt`,
        get path() {
          if (index === 249) controller.abort('renderer_shutdown_after_checkpoint');
          return sourcePath;
        },
        isDir: false,
        size: index,
      };
    });
    const durableJob = { accountId: null, projectId: 'project-1', mapId: 'map-1' };

    await expect(
      scanSiyuanFilesystemIndex(
        { ...map(), rootDir: 'C:\\Users\\viper\\large' },
        { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        {
          signal: controller.signal,
          durableJob,
          list: async (path) => ({ ok: true, path, entries: files }),
        },
      ),
    ).rejects.toThrow('siyuan_index_cancelled');

    const interrupted = await readSiyuanIndexJob('project-1', 'map-1');
    expect(interrupted).toMatchObject({ phase: 'discovering', cursor: 0, indexed: 250 });
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toHaveLength(250);

    const resumed = await scanSiyuanFilesystemIndex(
      { ...map(), rootDir: 'C:\\Users\\viper\\large' },
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        durableJob,
        list: async (path) => ({
          ok: true,
          path,
          entries: files.map((file, index) => ({
            name: file.name,
            path: `C:/Users/viper/large/file-${String(index).padStart(3, '0')}.txt`,
            isDir: false,
            size: index,
          })),
        }),
      },
    );
    expect(resumed.entries).toHaveLength(600);
    expect(new Set(resumed.entries.map((entry) => entry.nodeId)).size).toBe(600);
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toHaveLength(600);
  });

  it('resumes discovery from the last durable directory batch after renderer shutdown', async () => {
    const controller = new AbortController();
    let rootReads = 0;
    const list = async (path: string) => {
      if (path === 'C:/Users/viper') {
        rootReads += 1;
        return {
          ok: true as const,
          path,
          entries: [
            { name: 'One', path: 'C:/Users/viper/One', isDir: true },
            { name: 'Two', path: 'C:/Users/viper/Two', isDir: true },
          ],
        };
      }
      if (!controller.signal.aborted) controller.abort('renderer_shutdown');
      return {
        ok: true as const,
        path,
        entries: [{ name: `${path.slice(-3)}.txt`, path: `${path}/child.txt`, isDir: false }],
      };
    };
    const options = {
      list,
      signal: controller.signal,
      durableJob: { accountId: null, projectId: 'project-1', mapId: 'map-1' },
    };
    await expect(
      scanSiyuanFilesystemIndex(
        map(),
        { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        options,
      ),
    ).rejects.toThrow('siyuan_index_cancelled');

    const resumed = await scanSiyuanFilesystemIndex(
      map(),
      { mode: 'none', selectedExtensions: [], selectedPaths: [] },
      {
        list: async (path) => ({
          ok: true,
          path,
          entries:
            path === 'C:/Users/viper'
              ? []
              : [{ name: 'child.txt', path: `${path}/child.txt`, isDir: false }],
        }),
        durableJob: { accountId: null, projectId: 'project-1', mapId: 'map-1' },
      },
    );
    expect(rootReads).toBe(1);
    expect(resumed.entries.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining(['One', 'Two', 'One/child.txt', 'Two/child.txt']),
    );
  });

  it('follows durable pause, resume, and cancellation across an app-wide worker', async () => {
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/Users/viper',
      policyFingerprint: 'policy',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/Users/viper',
      relativePath: '',
      parentNodeId: null,
    });
    const control = createDurableSiyuanIndexJobControl('project-1', 'map-1');
    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused');
    let released = false;
    const waiting = control.checkpoint().then(() => {
      released = true;
    });
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
    expect(released).toBe(false);
    expect(control.state).toBe('paused');
    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'running');
    await waiting;
    expect(control.state).toBe('running');
    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'cancelled');
    await expect(control.checkpoint()).rejects.toThrow('siyuan_index_cancelled');
    expect(control.state).toBe('cancelled');
  });

  it('releases a durable paused checkpoint when its renderer signal aborts', async () => {
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: 'map-abort',
      canonicalRoot: 'C:/Users/viper',
      policyFingerprint: 'policy',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/Users/viper',
      relativePath: '',
      parentNodeId: null,
    });
    await updateSiyuanIndexJobStatus('project-1', 'map-abort', 'paused');
    const control = createDurableSiyuanIndexJobControl('project-1', 'map-abort');
    const controller = new AbortController();
    const waiting = control.checkpoint(controller.signal);
    controller.abort('renderer_reload');
    await expect(waiting).rejects.toThrow('siyuan_index_cancelled');
  });
});


describe('new durable scan generation receipt', () => {
  beforeEach(resetDurableJobs);
  it('emits one immutable persisted generation only for a newly created durable job',async()=>{
    const record=map();const generations:SiyuanIndexJobGeneration[]=[];
    const list=vi.fn(async(path:string)=>{
      expect(generations).toHaveLength(1);
      const stored=(await readSiyuanIndexJob(record.projectId,record.id))!;
      expect(stored.startedAt).toBe(generations[0]!.startedAt);
      return {ok:true as const,path,entries:[{name:'one.txt',path:`${record.rootDir}/one.txt`,isDir:false,size:4,modifiedMs:1}]};
    });
    const options={durableJob:{accountId:null,projectId:record.projectId,mapId:record.id},list,
      onDurableJobCreated:(generation:SiyuanIndexJobGeneration)=>generations.push(generation)};
    const policy={mode:'none' as const,selectedExtensions:[],selectedPaths:[]};
    await scanSiyuanFilesystemIndex(record,policy,options);
    const captured=JSON.stringify(generations[0]);
    expect(Object.isFrozen(generations[0])).toBe(true);
    expect(Object.keys(generations[0]!).sort()).toEqual(['accountId','canonicalRoot','mapId','policyFingerprint','projectId','schemaVersion','scope','startedAt'].sort());
    await scanSiyuanFilesystemIndex(record,policy,options);
    expect(generations).toHaveLength(1);expect(JSON.stringify(generations[0])).toBe(captured);
    expect(list).toHaveBeenCalledOnce();
  });
  it('does not emit a durable generation for an ephemeral scan',async()=>{
    const created=vi.fn();
    await scanSiyuanFilesystemIndex(map(),{mode:'none',selectedExtensions:[],selectedPaths:[]},{
      onDurableJobCreated:created,list:async path=>({ok:true,path,entries:[]}),
    });
    expect(created).not.toHaveBeenCalled();
  });
  it('does not emit a generation or persist a job for a pre-aborted scan',async()=>{
    const created=vi.fn(),controller=new AbortController();controller.abort();
    await expect(scanSiyuanFilesystemIndex(map(),{mode:'none',selectedExtensions:[],selectedPaths:[]},{
      signal:controller.signal,onDurableJobCreated:created,
      durableJob:{accountId:null,projectId:'project-1',mapId:'map-1'},
      list:async path=>({ok:true,path,entries:[]}),
    })).rejects.toThrow('siyuan_index_cancelled');
    expect(created).not.toHaveBeenCalled();expect(await readSiyuanIndexJob('project-1','map-1')).toBeNull();
  });
});
