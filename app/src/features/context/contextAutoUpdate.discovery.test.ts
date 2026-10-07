import { describe, expect, it, vi } from 'vitest';
import {
  createContextAutoUpdater,
  type ContextAutoUpdatePorts,
  type ContextAutoUpdateSetting,
} from './contextAutoUpdate';
import {
  buildProjectContextTreeFromSiyuanIndex,
  scanSiyuanFilesystemIndex,
} from './siyuan/siyuanSafeIndex';
import type { ContextMapRecord } from './tree';
const native = vi.hoisted(() => ({ error: '' as string | undefined, missing: false }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, request: { paths: string[]; root: string }) => {
    if (command !== 'fs_list_dirs_strict') throw new Error(`unexpected ${command}`);
    return request.paths.map((path) =>
      native.error
        ? { path, entries: null, error: native.error }
        : {
            path,
            error: null,
            entries: native.missing
              ? []
              : [
                  {
                    name: 'dispatch.txt',
                    path: `${request.root}/dispatch.txt`,
                    isDir: false,
                    size: 43,
                    modifiedMs: 200,
                  },
                ],
          },
    );
  },
}));
function fixture() {
  native.missing = false;
  let now = 1_000;
  let map: ContextMapRecord = {
    id: 'map-a',
    name: 'Fixture',
    projectId: 'project-a',
    status: 'active',
    rootDir: 'C:/fixture',
    createdAt: 1,
    updatedAt: 1,
    tree: {
      version: 1,
      projectId: 'project-a',
      rootDir: 'C:/fixture',
      generatedAt: 1,
      model: 'siyuan',
      fileCount: 1,
      totalBytes: 42,
      summary: '',
      nodes: [
        {
          id: 'map-a:path:dispatch.txt',
          kind: 'file',
          title: 'dispatch.txt',
          path: 'dispatch.txt',
          summary: '',
          sizeBytes: 42,
          modifiedAt: 100,
        },
      ],
    },
  };
  let setting: ContextAutoUpdateSetting = {
    kind: 'context-auto-update-v1',
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    mapId: 'map-a',
    enabled: true,
    consentRevision: 1,
    fingerprint: 'fixture',
    indexIdentityVersion: 1,
    lastSuccessAt: 1,
    baseline: [
      {
        id: 'path:dispatch.txt',
        kind: 'file',
        title: 'dispatch.txt',
        path: 'dispatch.txt',
        size: 42,
        modified: 100,
      },
    ],
  };
  const transaction = { commit: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const ports: ContextAutoUpdatePorts = {
    readMap: async () => map,
    readSetting: async () => setting,
    active: () => true,
    fingerprint: () => 'fixture',
    now: () => now,
    scan: (record, signal) =>
      scanSiyuanFilesystemIndex(
        record,
        { mode: 'none', selectedPaths: [], selectedExtensions: [] },
        { signal },
      ),
    stage: vi.fn(async () => transaction),
    sync: async (record, index) =>
      buildProjectContextTreeFromSiyuanIndex(record.tree, index.entries),
    saveTree: async (record, tree) => (map = { ...record, tree, updatedAt: now }),
    saveSetting: vi.fn(async (value) => {
      setting = value;
    }),
  };
  return {
    updater: createContextAutoUpdater(ports),
    ports,
    transaction,
    signal: new AbortController().signal,
    setting: () => setting,
    map: () => map,
    advance: () => {
      now += 2_000;
    },
  };
}
describe('strict native listing to automatic refresh', () => {
  it.each(['io: sharing violation', 'io: Permission denied', 'outside_root'])(
    'preserves last-good metadata and index on native %s, then recovers after a complete scan',
    async (error) => {
      const f = fixture();
      native.error = error;
      await expect(f.updater.tick(f.signal)).rejects.toThrow('fs_list_dirs_strict:');
      expect(f.ports.stage).not.toHaveBeenCalled();
      expect(f.ports.saveSetting).not.toHaveBeenCalled();
      expect(f.setting().baseline?.[0]?.size).toBe(42);
      expect(f.setting().lastSuccessAt).toBe(1);
      expect(f.map().tree.fileCount).toBe(1);
      native.error = undefined;
      expect(await f.updater.tick(f.signal)).toBe('waiting');
      f.advance();
      expect(await f.updater.tick(f.signal)).toBe('updated');
      expect(f.transaction.commit).toHaveBeenCalledOnce();
      expect(f.setting().baseline?.[0]).toMatchObject({ size: 43, modified: 200 });
    },
  );
  it('permits a genuine complete deletion while rejecting failed directory discovery', async () => {
    const f = fixture();
    native.error = 'not_found';
    await expect(f.updater.tick(f.signal)).rejects.toThrow('discovery_incomplete');
    expect(f.ports.stage).not.toHaveBeenCalled();
    native.error = undefined;
    native.missing = true;
    expect(await f.updater.tick(f.signal)).toBe('waiting');
    f.advance();
    expect(await f.updater.tick(f.signal)).toBe('updated');
    expect(f.ports.stage).toHaveBeenCalledWith(
      expect.anything(),
      [],
      ['map-a:path:dispatch.txt'],
      f.signal,
      undefined,
    );
  });
});
