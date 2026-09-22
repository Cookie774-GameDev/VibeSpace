import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContextMapRecord } from '../tree';
import { scanSiyuanFilesystemIndex, siyuanIndexPolicyFingerprint } from './siyuanSafeIndex';
import * as jobs from './siyuanIndexJobStore';
const root = 'C:/Users/viper/VibeSpace-Evidence';
const verbatim = String.raw`\\?\C:\Users\viper\VibeSpace-Evidence`;
const policy = { mode: 'all' as const, selectedExtensions: ['md'], selectedPaths: [] };
const authority = { accountId: 'account-1', projectId: 'project-1', mapId: 'map-1' };
const record: ContextMapRecord = {
  id: authority.mapId,
  projectId: authority.projectId,
  rootDir: verbatim,
  name: 'Evidence',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  tree: {
    version: 1,
    projectId: authority.projectId,
    rootDir: verbatim,
    generatedAt: 1,
    model: 'siyuan-metadata-index-v1',
    fileCount: 0,
    totalBytes: 0,
    summary: '',
    nodes: [],
  },
};
async function seed(overrides: Partial<jobs.SiyuanIndexJobRecord> = {}) {
  const job = {
    ...jobs.createSiyuanIndexJob({
      ...authority,
      canonicalRoot: root,
      policyFingerprint: siyuanIndexPolicyFingerprint(root, policy, []),
      now: 100,
    }),
    canonicalRoot: verbatim,
    ...overrides,
  };
  await jobs.replaceSiyuanIndexJob(job, {
    path: job.canonicalRoot,
    relativePath: '',
    parentNodeId: null,
  });
  return job;
}
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('vibespace-siyuan-index-jobs');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database_delete_blocked'));
  });
});
describe('SiYuan matching-policy checkpoint path repair', () => {
  it('repairs the saved verbatim frontier even when the policy fingerprint already matches', async () => {
    const before = await seed();
    const result = await scanSiyuanFilesystemIndex(record, policy, {
      durableJob: authority,
      listBatch: async (paths, options) => {
        expect(paths).toEqual([root]);
        expect(options).toEqual({ root, strictProjectBoundary: true });
        return [
          {
            ok: true,
            path: root,
            entries: [{ name: 'README.md', path: `${root}/README.md`, isDir: false, size: 12 }],
          },
        ];
      },
    });
    expect(result.entries.map((e) => e.relativePath)).toEqual(['README.md']);
    expect(await jobs.readSiyuanIndexFrontier(authority.projectId, authority.mapId)).toEqual([
      { path: root, relativePath: '', parentNodeId: null },
    ]);
    expect(await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId)).toMatchObject({
      canonicalRoot: root,
      policyFingerprint: before.policyFingerprint,
      mapId: before.mapId,
      accountId: before.accountId,
      startedAt: 100,
      indexed: 1,
      phase: 'creating_nodes',
    });
  });
  it('rejects a foreign account without rewriting its malformed checkpoint', async () => {
    await seed({ accountId: 'other-account', policyFingerprint: '{"different":"policy"}' });
    const before = await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId);
    await expect(
      scanSiyuanFilesystemIndex(record, policy, { durableJob: authority }),
    ).rejects.toThrow();
    expect(await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId)).toEqual(before);
  });
  it('rejects a changed summary policy rather than treating it as a path migration', async () => {
    const payload = JSON.parse(siyuanIndexPolicyFingerprint(root, policy, []));
    payload.root = '/?/c:/users/viper/vibespace-evidence';
    payload.summaryMode = 'none';
    await seed({ policyFingerprint: JSON.stringify(payload) });
    const before = await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId);
    await expect(
      scanSiyuanFilesystemIndex(record, policy, { durableJob: authority }),
    ).rejects.toThrow();
    expect(await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId)).toEqual(before);
  });
  it('does not rewrite an aborted checkpoint', async () => {
    const payload = JSON.parse(siyuanIndexPolicyFingerprint(root, policy, []));
    payload.root = '/?/c:/users/viper/vibespace-evidence';
    await seed({ policyFingerprint: JSON.stringify(payload) });
    const before = await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId);
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanSiyuanFilesystemIndex(record, policy, {
        durableJob: authority,
        signal: controller.signal,
      }),
    ).rejects.toThrow('siyuan_index_cancelled');
    expect(await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId)).toEqual(before);
  });
  it.each(['paused', 'cancelled', 'completed'] as const)(
    'does not repair or resume a %s job',
    async (status) => {
      await seed({ status });
      const before = await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId);
      await expect(
        scanSiyuanFilesystemIndex(record, policy, { durableJob: authority }),
      ).rejects.toThrow();
      expect(await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId)).toEqual(before);
    },
  );
});
describe('SiYuan atomic empty-checkpoint repair guardrails', () => {
  it.each(['paused', 'cancelled', 'completed'] as const)(
    'rejects concurrent %s without reviving the job',
    async (status) => {
      const before = await seed();
      await jobs.updateSiyuanIndexJobStatus(authority.projectId, authority.mapId, status, 200);
      const current = await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId);
      await expect(
        jobs.repairEmptySiyuanDiscoveryCheckpoint(before, root, before.policyFingerprint),
      ).rejects.toThrow('siyuan_index_checkpoint_changed');
      expect(await jobs.readSiyuanIndexJob(authority.projectId, authority.mapId)).toEqual(current);
      expect(
        (await jobs.readSiyuanIndexFrontier(authority.projectId, authority.mapId))[0]?.path,
      ).toBe(verbatim);
    },
  );
  it('refuses concurrent source progress without clearing entries', async () => {
    const before = await seed();
    const entry = {
      nodeId: 'path:README.md',
      parentNodeId: null,
      title: 'README.md',
      kind: 'file' as const,
      relativePath: 'README.md',
      sourcePointer: `${root}/README.md`,
      summary: null,
      sizeBytes: 12,
      modifiedAt: 100,
    };
    await jobs.checkpointSiyuanIndexJob({
      job: { ...before, indexed: 1, updatedAt: 200 },
      appendedEntries: [entry],
    });
    await expect(
      jobs.repairEmptySiyuanDiscoveryCheckpoint(before, root, before.policyFingerprint),
    ).rejects.toThrow('siyuan_index_checkpoint_changed');
    expect(await jobs.readSiyuanIndexEntries(authority.projectId, authority.mapId)).toEqual([
      entry,
    ]);
  });
  it('refuses unaccounted entries even when all saved counters say zero', async () => {
    const before = await seed();
    const entry = {
      nodeId: 'path:README.md',
      parentNodeId: null,
      title: 'README.md',
      kind: 'file' as const,
      relativePath: 'README.md',
      sourcePointer: `${root}/README.md`,
      summary: null,
      sizeBytes: 12,
      modifiedAt: 100,
    };
    await jobs.checkpointSiyuanIndexJob({ job: before, appendedEntries: [entry] });
    await expect(
      jobs.repairEmptySiyuanDiscoveryCheckpoint(before, root, before.policyFingerprint),
    ).rejects.toThrow('siyuan_index_checkpoint_changed');
    expect(await jobs.readSiyuanIndexEntries(authority.projectId, authority.mapId)).toEqual([
      entry,
    ]);
  });
  it('rejects another source root and preserves other map scopes', async () => {
    const before = await seed();
    const other = {
      ...before,
      mapId: 'map-2',
      scope: jobs.siyuanIndexJobScope(authority.projectId, 'map-2'),
    };
    await jobs.replaceSiyuanIndexJob(other, {
      path: verbatim,
      relativePath: '',
      parentNodeId: null,
    });
    await expect(
      jobs.repairEmptySiyuanDiscoveryCheckpoint(before, 'D:/Other', before.policyFingerprint),
    ).rejects.toThrow('siyuan_index_resume_authority_mismatch');
    await jobs.repairEmptySiyuanDiscoveryCheckpoint(before, root, before.policyFingerprint);
    expect((await jobs.readSiyuanIndexJob(authority.projectId, 'map-2'))?.canonicalRoot).toBe(
      verbatim,
    );
    expect((await jobs.readSiyuanIndexFrontier(authority.projectId, 'map-2'))[0]?.path).toBe(
      verbatim,
    );
  });
});
