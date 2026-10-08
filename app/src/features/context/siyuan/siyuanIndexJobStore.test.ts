import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveAndReplaceSiyuanIndexJob,
  archiveAndRestartSiyuanSummaryJobForCloud,
  archiveSiyuanSummaryJobForCloudRestart,
  canResumeSiyuanIndexJob,
  accountForSiyuanRendererOfflineTime,
  checkpointSiyuanIndexJob,
  checkpointSiyuanSummaryBatchNode,
  createSiyuanIndexJob,
  readSiyuanIndexEntries,
  readSiyuanIndexFrontier,
  readSiyuanIndexJob,
  readSiyuanIndexJobArchive,
  readSiyuanSummaryUsage,
  reconcileSiyuanIndexEntries,
  replaceSiyuanIndexEntries,
  replaceSiyuanIndexJob,
  resumeSiyuanSummaryJobWithSameCloudRoute,
  setSiyuanIndexJobStartupDisposition,
  siyuanIndexJobScope,
  updateSiyuanIndexJobStatus,
  retryCompletedSiyuanSourceIndex,
} from './siyuanIndexJobStore';

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('vibespace-siyuan-index-jobs');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database_delete_blocked'));
  });
}

describe('explicit completed-graph source retry', () => {
  beforeEach(resetDatabase);
  async function seed() {
    const job = { ...createSiyuanIndexJob({ accountId: 'retry-account', projectId: 'retry-project',
      mapId: 'retry-map', canonicalRoot: 'C:/owned', policyFingerprint: 'retry-policy', now: 100 }),
      phase: 'completed' as const, status: 'cancelled' as const, cursor: 1, frontierLength: 1,
      indexed: 1, createdNodes: 1, reconciledAt: 100, summarized: 1, summaryEligible: 1,
      inputTokens: 3, outputTokens: 2, totalTokens: 5 };
    await checkpointSiyuanIndexJob({ job, appendedEntries: [{ nodeId: 'owned-node', parentNodeId: null,
      title: 'owned.txt', kind: 'file', relativePath: 'owned.txt', sourcePointer: 'C:/owned/owned.txt',
      summary: 'Saved summary', sizeBytes: 42, modifiedAt: 1 }], summaryUsage: {
        nodeId: 'owned-node', sourceModifiedAt: 1, sourceSizeBytes: 42, providerId: 'synthetic',
        connectionId: 'synthetic', modelId: 'synthetic', inputTokens: 3, outputTokens: 2,
        totalTokens: 5, provenance: 'reported', completedAt: 100,
      } });
    return job;
  }

  it('changes only explicit retry job state while preserving saved entries and another scope', async () => {
    const job = await seed();
    const entries = await readSiyuanIndexEntries(job.projectId, job.mapId);
    const usage = await readSiyuanSummaryUsage(job.projectId, job.mapId);
    const other = { ...job, mapId: 'other-map', scope: siyuanIndexJobScope(job.projectId, 'other-map') };
    await checkpointSiyuanIndexJob({ job: other });
    const expectedOther = await readSiyuanIndexJob(other.projectId, other.mapId);
    const retried = await retryCompletedSiyuanSourceIndex(job, { signal: new AbortController().signal, assertCurrent() {}, now: 100 });
    expect(retried).toMatchObject({ status: 'completed', phase: 'completed', updatedAt: 101, completedAt: 101 });
    expect(await readSiyuanIndexEntries(job.projectId, job.mapId)).toEqual(entries);
    expect(await readSiyuanSummaryUsage(job.projectId, job.mapId)).toEqual(usage);
    expect(await readSiyuanIndexJob(other.projectId, other.mapId)).toEqual(expectedOther);
    await expect(retryCompletedSiyuanSourceIndex(job, { signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow(/checkpoint_changed/);
  });

  it.each(['updatedAt', 'startedAt', 'accountId', 'mapId', 'canonicalRoot', 'policyFingerprint'] as const)(
    'refuses a mismatched expected %s', async (field) => {
      const job = await seed();
      const expected = { ...job, [field]: typeof job[field] === 'number' ? Number(job[field]) + 1 : 'foreign' };
      const before = await readSiyuanIndexJob(job.projectId, job.mapId);
      await expect(retryCompletedSiyuanSourceIndex(expected, { signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
      expect(await readSiyuanIndexJob(job.projectId, job.mapId)).toEqual(before);
    },
  );

  it('rolls back when live authority fails immediately after the put is queued', async () => {
    const job = await seed();
    const before = await readSiyuanIndexJob(job.projectId, job.mapId);
    let checks = 0;
    await expect(retryCompletedSiyuanSourceIndex(job, { signal: new AbortController().signal,
      assertCurrent() { if (++checks === 5) throw new Error('scope revoked'); },
    })).rejects.toThrow('scope revoked');
    expect(await readSiyuanIndexJob(job.projectId, job.mapId)).toEqual(before);
  });

  it('aborts the actual transaction on a lease signal after queuing its write', async () => {
    const job = await seed();
    const before = await readSiyuanIndexJob(job.projectId, job.mapId);
    const controller = new AbortController();
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
      const result = original.call(this, value, key);
      if (this.name === 'jobs') controller.abort('account ABA');
      return result;
    });
    try {
      await expect(retryCompletedSiyuanSourceIndex(job, { signal: controller.signal, assertCurrent() {} })).rejects.toBeDefined();
    } finally { put.mockRestore(); }
    expect(await readSiyuanIndexJob(job.projectId, job.mapId)).toEqual(before);
  });
});

describe('durable SiYuan index jobs', () => {
  beforeEach(resetDatabase);

  it('atomically restores the directory frontier, cursor, counts, and entries', async () => {
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/Users/viper',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/Users/viper',
      relativePath: '',
      parentNodeId: null,
    });
    const appendedDirectories = [
      {
        path: 'C:/Users/viper/Documents',
        relativePath: 'Documents',
        parentNodeId: 'path:Documents',
      },
    ];
    await checkpointSiyuanIndexJob({
      job: {
        ...job,
        cursor: 1,
        frontierLength: 2,
        indexed: 2,
        updatedAt: 200,
      },
      appendedDirectories,
      appendedEntries: [
        {
          nodeId: 'path:Documents',
          parentNodeId: null,
          title: 'Documents',
          kind: 'area',
          relativePath: 'Documents',
          sourcePointer: 'C:/Users/viper/Documents',
          summary: null,
          sizeBytes: null,
          modifiedAt: null,
        },
        {
          nodeId: 'path:note.txt',
          parentNodeId: null,
          title: 'note.txt',
          kind: 'file',
          relativePath: 'note.txt',
          sourcePointer: 'C:/Users/viper/note.txt',
          summary: null,
          sizeBytes: 12,
          modifiedAt: 10,
        },
      ],
    });

    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      cursor: 1,
      frontierLength: 2,
      indexed: 2,
    });
    expect(await readSiyuanIndexFrontier('project-1', 'map-1')).toEqual([
      { path: 'C:/Users/viper', relativePath: '', parentNodeId: null },
      appendedDirectories[0],
    ]);
    expect(
      (await readSiyuanIndexEntries('project-1', 'map-1')).map((entry) => entry.nodeId),
    ).toEqual(expect.arrayContaining(['path:Documents', 'path:note.txt']));
  });

  it('replays idempotently without duplicating entries', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    const entry = {
      nodeId: 'path:a.txt',
      parentNodeId: null,
      title: 'a.txt',
      kind: 'file' as const,
      relativePath: 'a.txt',
      sourcePointer: 'C:/root/a.txt',
      summary: null,
      sizeBytes: 1,
      modifiedAt: 1,
    };
    await checkpointSiyuanIndexJob({ job: { ...job, indexed: 1 }, appendedEntries: [entry] });
    await checkpointSiyuanIndexJob({ job: { ...job, indexed: 1 }, appendedEntries: [entry] });
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toEqual([entry]);
  });

  it('atomically replaces the durable entry snapshot during reconciliation', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job: { ...job, indexed: 1 },
      appendedEntries: [
        {
          nodeId: 'old',
          parentNodeId: null,
          title: 'old.txt',
          kind: 'file',
          relativePath: 'old.txt',
          sourcePointer: 'C:/root/old.txt',
          summary: null,
          sizeBytes: 1,
          modifiedAt: 1,
        },
      ],
    });
    const replacement = {
      nodeId: 'new',
      parentNodeId: null,
      title: 'new.txt',
      kind: 'file' as const,
      relativePath: 'new.txt',
      sourcePointer: 'C:/root/new.txt',
      summary: null,
      sizeBytes: 2,
      modifiedAt: 2,
    };
    const reconciledJob = { ...job, indexed: 1, excluded: 2, reconciledAt: 500 };
    await replaceSiyuanIndexEntries('project-1', 'map-1', [replacement], reconciledJob);
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toEqual([replacement]);
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      indexed: 1,
      excluded: 2,
      reconciledAt: 500,
    });
  });

  it('atomically preserves a pause that wins the reconciliation replacement race', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    const paused = await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', 200);
    const incoming = {
      ...job,
      phase: 'creating_nodes' as const,
      status: 'running' as const,
      indexed: 1,
      reconciledAt: 300,
      updatedAt: 300,
    };
    const persisted = await replaceSiyuanIndexEntries('project-1', 'map-1', [], incoming);
    expect(persisted).toMatchObject({
      status: 'paused',
      phase: paused!.phase,
      updatedAt: 200,
      completedAt: null,
    });
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'paused',
      phase: paused!.phase,
      updatedAt: 200,
    });
  });

  it('atomically reconciles only changed and removed entries while preserving a winning pause', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    const unchanged = {
      nodeId: 'unchanged',
      parentNodeId: null,
      title: 'unchanged.txt',
      kind: 'file' as const,
      relativePath: 'unchanged.txt',
      sourcePointer: 'C:/root/unchanged.txt',
      summary: 'Completed summary',
      summaryState: 'completed' as const,
      sizeBytes: 1,
      modifiedAt: 1,
    };
    const removed = { ...unchanged, nodeId: 'removed', relativePath: 'removed.txt' };
    await checkpointSiyuanIndexJob({
      job: {
        ...job,
        indexed: 2,
        summarized: 1,
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        tokenProvenance: 'reported',
      },
      appendedEntries: [unchanged, removed],
      summaryUsage: {
        nodeId: unchanged.nodeId,
        sourceModifiedAt: unchanged.modifiedAt,
        sourceSizeBytes: unchanged.sizeBytes,
        providerId: 'deepseek',
        connectionId: 'deepseek-api',
        modelId: 'deepseek-chat',
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        provenance: 'reported',
        completedAt: 150,
      },
    });
    const paused = await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', 200);
    const changed = {
      ...unchanged,
      nodeId: 'changed',
      relativePath: 'changed.txt',
      sizeBytes: 3,
      modifiedAt: 3,
    };
    const incoming = {
      ...job,
      phase: 'creating_nodes' as const,
      status: 'running' as const,
      indexed: 2,
      summarized: 1,
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      tokenProvenance: 'reported' as const,
      reconciledAt: 300,
      updatedAt: 300,
    };
    const persisted = await reconcileSiyuanIndexEntries(
      'project-1',
      'map-1',
      [changed],
      ['removed'],
      incoming,
    );
    expect(persisted).toMatchObject({ status: 'paused', updatedAt: 200 });
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toEqual(
      expect.arrayContaining([unchanged, changed]),
    );
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toHaveLength(2);
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'paused',
      phase: paused!.phase,
      updatedAt: 200,
    });
    expect(await readSiyuanSummaryUsage('project-1', 'map-1')).toEqual([
      expect.objectContaining({ nodeId: 'unchanged', totalTokens: 3 }),
    ]);
  });

  it('rejects reconciliation scope mismatch before changing any store', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await expect(
      reconcileSiyuanIndexEntries('project-1', 'map-1', [], [], {
        ...job,
        scope: siyuanIndexJobScope('project-2', 'map-2'),
        projectId: 'project-2',
        mapId: 'map-2',
      }),
    ).rejects.toThrow('siyuan_index_reconciliation_scope_mismatch');
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      scope: job.scope,
      projectId: 'project-1',
      mapId: 'map-1',
      status: 'running',
      pendingNativeNodeIds: [],
    });
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toEqual([]);
    expect(await readSiyuanIndexJob('project-2', 'map-2')).toBeNull();
  });

  it('archives the last safe checkpoint before an explicit restart from source', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job: { ...job, indexed: 1, frontierLength: 2, updatedAt: 150 },
      appendedEntries: [
        {
          nodeId: 'old',
          parentNodeId: null,
          title: 'old.txt',
          kind: 'file',
          relativePath: 'old.txt',
          sourcePointer: 'C:/root/old.txt',
          summary: null,
          sizeBytes: 1,
          modifiedAt: 1,
        },
      ],
      appendedDirectories: [{ path: 'C:/root/src', relativePath: 'src', parentNodeId: 'root' }],
      summaryUsage: {
        nodeId: 'old',
        sourceModifiedAt: 1,
        sourceSizeBytes: 1,
        providerId: 'local',
        connectionId: 'ollama',
        modelId: 'llama3.2:latest',
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
        provenance: 'reported',
        completedAt: 150,
      },
    });
    const restarted = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-b',
      now: 200,
    });
    await archiveAndReplaceSiyuanIndexJob(
      restarted,
      { path: 'C:/root', relativePath: '', parentNodeId: null },
      200,
    );
    expect(await readSiyuanIndexEntries('project-1', 'map-1')).toEqual([]);
    expect(await readSiyuanIndexJobArchive('project-1', 'map-1')).toMatchObject({
      archivedAt: 200,
      job: { indexed: 1, policyFingerprint: 'policy-a' },
      entries: [expect.objectContaining({ nodeId: 'old' })],
      frontier: [
        expect.objectContaining({ relativePath: '' }),
        expect.objectContaining({ relativePath: 'src' }),
      ],
      summaryUsage: [
        expect.objectContaining({ nodeId: 'old', sourceSizeBytes: 1, totalTokens: 6 }),
      ],
    });
    expect(await readSiyuanIndexFrontier('project-1', 'map-1')).toEqual([
      { path: 'C:/root', relativePath: '', parentNodeId: null },
    ]);
    expect(await readSiyuanSummaryUsage('project-1', 'map-1')).toEqual([]);
  });

  it('keeps separate token batches for distinct source revisions with the same mtime', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    for (const sourceSizeBytes of [10, 11]) {
      await checkpointSiyuanIndexJob({
        job,
        summaryUsage: {
          nodeId: 'same-file',
          sourceModifiedAt: 123,
          sourceSizeBytes,
          providerId: 'local',
          connectionId: 'ollama',
          modelId: 'llama3.2:latest',
          inputTokens: sourceSizeBytes,
          outputTokens: 1,
          totalTokens: sourceSizeBytes + 1,
          provenance: 'estimated',
          completedAt: sourceSizeBytes,
        },
      });
    }
    expect(await readSiyuanSummaryUsage('project-1', 'map-1')).toHaveLength(2);
  });

  it('archives and atomically repins only a zero-work local-unavailable summary job', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'local_model_unavailable' as const,
      summaryProviderId: 'ollama',
      summaryConnectionId: 'ollama-local',
      summaryModelId: 'llama3.2:latest',
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    const restarted = await archiveAndRestartSiyuanSummaryJobForCloud(
      'project-1',
      'map-1',
      { providerId: 'deepseek', connectionId: 'deepseek-api', modelId: 'deepseek-chat' },
      200,
    );
    expect(restarted).toMatchObject({
      status: 'running',
      pauseReason: null,
      phase: 'summarizing',
      summaryProviderId: 'deepseek',
      summaryConnectionId: 'deepseek-api',
      summaryModelId: 'deepseek-chat',
      tokenProvenance: 'none',
      updatedAt: 200,
    });
    expect(await readSiyuanIndexJobArchive('project-1', 'map-1')).toMatchObject({
      archivedAt: 200,
      job: {
        status: 'paused',
        pauseReason: 'local_model_unavailable',
        summaryProviderId: 'ollama',
      },
    });

    const partialCloudJob = {
      ...restarted,
      status: 'paused' as const,
      pauseReason: 'cloud_approval_required' as const,
      summarized: 1,
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      tokenProvenance: 'estimated' as const,
    };
    await checkpointSiyuanIndexJob({
      job: partialCloudJob,
      appendedEntries: [
        {
          nodeId: 'cloud-summary',
          parentNodeId: null,
          title: 'cloud.ts',
          kind: 'file',
          relativePath: 'cloud.ts',
          sourcePointer: 'C:/root/cloud.ts',
          summary: 'New cloud summary.',
          summaryState: 'completed',
          sizeBytes: 20,
          modifiedAt: 2,
        },
      ],
      summaryUsage: {
        nodeId: 'cloud-summary',
        sourceModifiedAt: 2,
        sourceSizeBytes: 20,
        providerId: 'deepseek',
        connectionId: 'deepseek-api',
        modelId: 'deepseek-chat',
        effort: 'high',
        effortProvenance: 'requested',
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
        provenance: 'estimated',
        completedAt: 250,
      },
    });
    const cleanupSnapshot = await archiveSiyuanSummaryJobForCloudRestart('project-1', 'map-1', 300);
    expect(cleanupSnapshot).toMatchObject({
      archivedAt: 300,
      job: { summarized: 1, summaryProviderId: 'deepseek' },
      entries: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'cloud-summary', summaryState: 'completed' }),
      ]),
      summaryUsage: [expect.objectContaining({ nodeId: 'cloud-summary', totalTokens: 6 })],
    });
    expect(await readSiyuanIndexJobArchive('project-1', 'map-1')).toMatchObject({
      archivedAt: 200,
      job: {
        summarized: 0,
        pauseReason: 'local_model_unavailable',
        summaryProviderId: 'ollama',
      },
      summaryUsage: [],
    });
  });

  it('archives partial local summaries and restarts only summary work on an exact cloud route', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'user' as const,
      indexed: 2,
      createdNodes: 2,
      summaryEligible: 2,
      summarized: 1,
      skipped: 1,
      failed: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      tokenProvenance: 'estimated' as const,
      summaryProviderId: 'ollama',
      summaryConnectionId: 'ollama-local',
      summaryModelId: 'llama3.2:latest',
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'completed-file',
          parentNodeId: null,
          title: 'completed.ts',
          kind: 'file',
          relativePath: 'completed.ts',
          sourcePointer: 'C:/root/completed.ts',
          summary: 'Generated locally.',
          summaryState: 'completed',
          sizeBytes: 10,
          modifiedAt: 1,
        },
        {
          nodeId: 'skipped-file',
          parentNodeId: null,
          title: 'skipped.ts',
          kind: 'file',
          relativePath: 'skipped.ts',
          sourcePointer: 'C:/root/skipped.ts',
          summary: null,
          summaryState: 'skipped',
          sizeBytes: 20,
          modifiedAt: 2,
        },
      ],
      summaryUsage: {
        nodeId: 'completed-file',
        sourceModifiedAt: 1,
        sourceSizeBytes: 10,
        providerId: 'ollama',
        connectionId: 'ollama-local',
        modelId: 'llama3.2:latest',
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        provenance: 'estimated',
        completedAt: 150,
      },
    });

    const restarted = await archiveAndRestartSiyuanSummaryJobForCloud(
      'project-1',
      'map-1',
      {
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        effort: 'high',
      },
      200,
    );

    expect(restarted).toMatchObject({
      status: 'running',
      phase: 'summarizing',
      indexed: 2,
      createdNodes: 2,
      summaryEligible: 2,
      summarized: 0,
      skipped: 0,
      failed: 0,
      totalTokens: 0,
      tokenProvenance: 'none',
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high',
    });
    const resetEntries = await readSiyuanIndexEntries('project-1', 'map-1');
    expect(resetEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'completed-file', summary: null }),
        expect.objectContaining({ nodeId: 'skipped-file', summary: null }),
      ]),
    );
    expect(resetEntries.every((entry) => !Object.hasOwn(entry, 'summaryState'))).toBe(true);
    expect(await readSiyuanSummaryUsage('project-1', 'map-1')).toEqual([]);
    expect(await readSiyuanIndexJobArchive('project-1', 'map-1')).toMatchObject({
      job: { summarized: 1, summaryProviderId: 'ollama' },
      entries: expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'completed-file',
          summary: 'Generated locally.',
          summaryState: 'completed',
        }),
      ]),
      summaryUsage: [expect.objectContaining({ modelId: 'llama3.2:latest' })],
    });
  });

  it('accepts the fail-closed cloud approval pause for archive and exact restart', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'cloud_approval_required' as const,
      indexed: 2,
      createdNodes: 2,
      summaryEligible: 1,
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high' as const,
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });

    const archive = await archiveSiyuanSummaryJobForCloudRestart('project-1', 'map-1', 150);
    expect(archive).toMatchObject({
      archivedAt: 150,
      job: {
        status: 'paused',
        pauseReason: 'cloud_approval_required',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      },
    });

    const restarted = await archiveAndRestartSiyuanSummaryJobForCloud(
      'project-1',
      'map-1',
      {
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        effort: 'high',
      },
      200,
    );
    expect(restarted).toMatchObject({
      status: 'running',
      phase: 'summarizing',
      pauseReason: null,
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high',
    });
    expect(await readSiyuanIndexJobArchive('project-1', 'map-1')).toMatchObject({
      archivedAt: 150,
      job: {
        status: 'paused',
        pauseReason: 'cloud_approval_required',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      },
    });
  });

  it('resumes an exact paused summary route without clearing completed work or usage history', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'user' as const,
      indexed: 2,
      createdNodes: 2,
      summaryEligible: 2,
      summarized: 1,
      skipped: 1,
      failed: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      tokenProvenance: 'estimated' as const,
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high' as const,
      pausedMs: 25,
      updatedAt: 150,
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'completed-file',
          parentNodeId: null,
          title: 'completed.ts',
          kind: 'file',
          relativePath: 'completed.ts',
          sourcePointer: 'C:/root/completed.ts',
          summary: 'Already summarized.',
          summaryState: 'completed',
          sizeBytes: 10,
          modifiedAt: 1,
        },
      ],
      summaryUsage: {
        nodeId: 'completed-file',
        sourceModifiedAt: 1,
        sourceSizeBytes: 10,
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        effort: 'high',
        effortProvenance: 'requested',
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        provenance: 'estimated',
        completedAt: 150,
      },
    });

    const resumed = await resumeSiyuanSummaryJobWithSameCloudRoute(
      'project-1',
      'map-1',
      {
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        effort: 'high',
      },
      200,
    );

    expect(resumed).toMatchObject({
      status: 'running',
      phase: 'summarizing',
      pauseReason: null,
      summarized: 1,
      skipped: 1,
      failed: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      tokenProvenance: 'estimated',
      pausedMs: 75,
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high',
    });
    await expect(readSiyuanIndexEntries('project-1', 'map-1')).resolves.toEqual([
      expect.objectContaining({
        nodeId: 'completed-file',
        summary: 'Already summarized.',
        summaryState: 'completed',
      }),
    ]);
    await expect(readSiyuanSummaryUsage('project-1', 'map-1')).resolves.toEqual([
      expect.objectContaining({
        nodeId: 'completed-file',
        totalTokens: 10,
        provenance: 'estimated',
      }),
    ]);
  });

  it.each([
    [{ providerId: 'other' }, 'siyuan_cloud_summary_resume_identity_mismatch'],
    [{ connectionId: 'other' }, 'siyuan_cloud_summary_resume_identity_mismatch'],
    [{ modelId: 'other' }, 'siyuan_cloud_summary_resume_identity_mismatch'],
    [{ effort: 'low' }, 'siyuan_cloud_summary_resume_identity_mismatch'],
  ] as const)('rejects same-route resume identity drift %o', async (override, error) => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'user' as const,
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high' as const,
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });

    await expect(
      resumeSiyuanSummaryJobWithSameCloudRoute('project-1', 'map-1', {
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        effort: 'high',
        ...override,
      }),
    ).rejects.toThrow(error);
  });

  it.each(['running', 'cancelled'] as const)(
    'rejects same-route summary resume from unsafe %s state',
    async (status) => {
      const job = {
        ...createSiyuanIndexJob({
          projectId: 'project-1',
          mapId: 'map-1',
          canonicalRoot: 'C:/root',
          policyFingerprint: 'policy-a',
          now: 100,
        }),
        phase: 'summarizing' as const,
        status,
        pauseReason: status === 'running' ? null : ('user' as const),
        summaryProviderId: 'opencode',
        summaryConnectionId: 'opencode-cli',
        summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        summaryEffort: 'high' as const,
      };
      await replaceSiyuanIndexJob(job, {
        path: 'C:/root',
        relativePath: '',
        parentNodeId: null,
      });

      await expect(
        resumeSiyuanSummaryJobWithSameCloudRoute('project-1', 'map-1', {
          providerId: 'opencode',
          connectionId: 'opencode-cli',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          effort: 'high',
        }),
      ).rejects.toThrow('siyuan_cloud_summary_resume_not_safe');
    },
  );

  it('keeps an estimated aggregate conservative when a reported batch is appended', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      phase: 'summarizing' as const,
      summaryEligible: 2,
      summarized: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      tokenProvenance: 'estimated' as const,
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high' as const,
      updatedAt: 150,
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'reported-file',
          parentNodeId: null,
          title: 'reported.ts',
          kind: 'file',
          relativePath: 'reported.ts',
          sourcePointer: 'C:/root/reported.ts',
          summary: null,
          sizeBytes: 20,
          modifiedAt: 2,
        },
      ],
    });

    const updated = await checkpointSiyuanSummaryBatchNode({
      projectId: 'project-1',
      mapId: 'map-1',
      entry: {
        nodeId: 'reported-file',
        parentNodeId: null,
        title: 'reported.ts',
        kind: 'file',
        relativePath: 'reported.ts',
        sourcePointer: 'C:/root/reported.ts',
        summary: 'Provider-reported summary.',
        summaryState: 'completed',
        sizeBytes: 20,
        modifiedAt: 2,
      },
      batchUsage: {
        batchId: 'reported-batch',
        requestId: 'request-reported',
        sessionId: 'session-reported',
        nodeCount: 1,
        policyFingerprint: 'policy-a',
        lane: 0,
        attempt: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheProvenance: 'unavailable',
        costUsd: null,
        costProvenance: 'unavailable',
        dispatchedAt: 180,
        durationMs: 20,
        nodeId: 'reported-file',
        sourceModifiedAt: 2,
        sourceSizeBytes: 20,
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        effort: 'high',
        effortProvenance: 'requested',
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        provenance: 'reported',
        completedAt: 200,
      },
      now: 200,
    });

    expect(updated).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      tokenProvenance: 'estimated',
    });
    await expect(readSiyuanSummaryUsage('project-1', 'map-1')).resolves.toEqual([
      expect.objectContaining({
        batchId: 'reported-batch',
        totalTokens: 7,
        provenance: 'reported',
      }),
    ]);
  });

  it('rejects an estimated batch from entering a provider-reported aggregate', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      phase: 'summarizing' as const,
      summaryEligible: 2,
      summarized: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      tokenProvenance: 'reported' as const,
      summaryProviderId: 'opencode',
      summaryConnectionId: 'opencode-cli',
      summaryModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      summaryEffort: 'high' as const,
      updatedAt: 150,
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'estimated-file',
          parentNodeId: null,
          title: 'estimated.ts',
          kind: 'file',
          relativePath: 'estimated.ts',
          sourcePointer: 'C:/root/estimated.ts',
          summary: null,
          sizeBytes: 20,
          modifiedAt: 2,
        },
      ],
    });

    await expect(
      checkpointSiyuanSummaryBatchNode({
        projectId: 'project-1',
        mapId: 'map-1',
        entry: {
          nodeId: 'estimated-file',
          parentNodeId: null,
          title: 'estimated.ts',
          kind: 'file',
          relativePath: 'estimated.ts',
          sourcePointer: 'C:/root/estimated.ts',
          summary: 'Estimated summary.',
          summaryState: 'completed',
          sizeBytes: 20,
          modifiedAt: 2,
        },
        batchUsage: {
          batchId: 'estimated-batch',
          requestId: 'request-estimated',
          sessionId: 'session-estimated',
          nodeCount: 1,
          policyFingerprint: 'policy-a',
          lane: 0,
          attempt: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheProvenance: 'unavailable',
          costUsd: null,
          costProvenance: 'unavailable',
          dispatchedAt: 180,
          durationMs: 20,
          nodeId: 'estimated-file',
          sourceModifiedAt: 2,
          sourceSizeBytes: 20,
          providerId: 'opencode',
          connectionId: 'opencode-cli',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          effort: 'high',
          effortProvenance: 'requested',
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          provenance: 'estimated',
          completedAt: 200,
        },
        now: 200,
      }),
    ).rejects.toThrow('siyuan_summary_token_provenance_mismatch');
    await expect(readSiyuanSummaryUsage('project-1', 'map-1')).resolves.toEqual([]);
    await expect(readSiyuanIndexJob('project-1', 'map-1')).resolves.toMatchObject({
      summarized: 1,
      totalTokens: 10,
      tokenProvenance: 'reported',
    });
  });

  it.each(['running', 'cancelled'] as const)(
    'rejects unsafe %s jobs from both cloud archive operations',
    async (status) => {
      const job = {
        ...createSiyuanIndexJob({
          projectId: 'project-1',
          mapId: 'map-1',
          canonicalRoot: 'C:/root',
          policyFingerprint: 'policy-a',
        }),
        phase: 'summarizing' as const,
        status,
        pauseReason: status === 'running' ? null : ('cloud_approval_required' as const),
      };
      await replaceSiyuanIndexJob(job, {
        path: 'C:/root',
        relativePath: '',
        parentNodeId: null,
      });

      await expect(archiveSiyuanSummaryJobForCloudRestart('project-1', 'map-1')).rejects.toThrow(
        'siyuan_cloud_summary_restart_not_safe',
      );
      await expect(
        archiveAndRestartSiyuanSummaryJobForCloud('project-1', 'map-1', {
          providerId: 'opencode',
          connectionId: 'opencode-cli',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          effort: 'high',
        }),
      ).rejects.toThrow('siyuan_cloud_summary_restart_not_safe');
    },
  );

  it('refuses a partial-summary route switch until the running job is paused', async () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
      phase: 'summarizing' as const,
      summarized: 1,
      totalTokens: 10,
    };
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await expect(
      archiveAndRestartSiyuanSummaryJobForCloud('project-1', 'map-1', {
        providerId: 'opencode',
        connectionId: 'opencode-cli',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      }),
    ).rejects.toThrow('siyuan_cloud_summary_restart_not_safe');
  });

  it('durably records startup auto-resume and clears it on manual lifecycle changes', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await setSiyuanIndexJobStartupDisposition('project-1', 'map-1', 'auto_resumed', 200);
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      startupDisposition: 'auto_resumed',
      startupDispositionAt: 200,
      updatedAt: 100,
    });
    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', 300);
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'paused',
      startupDisposition: null,
      startupDispositionAt: null,
    });
  });

  it('never overwrites a concurrent pause while stamping startup metadata', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await Promise.all([
      setSiyuanIndexJobStartupDisposition('project-1', 'map-1', 'auto_resumed', 200),
      updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', 210),
    ]);
    expect((await readSiyuanIndexJob('project-1', 'map-1'))?.status).toBe('paused');
  });

  it('marks only a still-running startup job as needing repair', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await setSiyuanIndexJobStartupDisposition('project-1', 'map-1', 'needs_repair', 200);
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'failed',
      startupDisposition: 'needs_repair',
      startupDispositionAt: 200,
      updatedAt: 200,
    });
    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', 300);
    await setSiyuanIndexJobStartupDisposition('project-1', 'map-1', 'needs_repair', 400);
    expect((await readSiyuanIndexJob('project-1', 'map-1'))?.status).toBe('paused');
  });

  it('rejects a stale startup repair after an explicit retry clears that attempt', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    await setSiyuanIndexJobStartupDisposition('project-1', 'map-1', 'auto_resumed', 200);
    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'running', 300);

    await setSiyuanIndexJobStartupDisposition('project-1', 'map-1', 'needs_repair', 400, {
      disposition: 'auto_resumed',
      dispositionAt: 200,
    });

    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'running',
      startupDisposition: null,
      startupDispositionAt: null,
      updatedAt: 300,
    });
  });

  it('normalizes legacy or malformed pause reasons without losing the checkpoint', async () => {
    const legacy = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
      status: 'paused' as const,
      pauseReason: 'forged_reason' as never,
    };
    await replaceSiyuanIndexJob(legacy, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'paused',
      pauseReason: null,
    });
  });

  it('auto-resumes only matching running authority and preserves pause or cancellation', async () => {
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });
    expect(
      canResumeSiyuanIndexJob(job, {
        accountId: 'account-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
    ).toBe(true);
    expect(
      canResumeSiyuanIndexJob(job, {
        accountId: 'account-1',
        canonicalRoot: 'c:\\ROOT',
        policyFingerprint: 'policy-a',
      }),
    ).toBe(true);
    expect(
      canResumeSiyuanIndexJob(job, {
        accountId: 'account-1',
        canonicalRoot: 'C:/different',
        policyFingerprint: 'policy-a',
      }),
    ).toBe(false);
    expect(
      canResumeSiyuanIndexJob(job, {
        accountId: 'account-2',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
    ).toBe(false);
    const paused = await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused');
    expect(paused?.status).toBe('paused');
    expect(
      canResumeSiyuanIndexJob(paused!, {
        accountId: 'account-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
      }),
    ).toBe(false);
    await checkpointSiyuanIndexJob({
      job: { ...job, indexed: 99, updatedAt: Date.now() },
    });
    expect((await readSiyuanIndexJob('project-1', 'map-1'))?.status).toBe('paused');
    const resumed = await updateSiyuanIndexJobStatus('project-1', 'map-1', 'running');
    expect(resumed?.status).toBe('running');
  });

  it('does not let a stale worker overwrite an explicit pause or cancellation at completion', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });

    const pausedAt = Date.now();
    const paused = await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', pausedAt);
    await checkpointSiyuanIndexJob({
      job: { ...job, phase: 'completed', status: 'completed', completedAt: Date.now() },
    });
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'paused',
      phase: paused!.phase,
      completedAt: null,
      updatedAt: pausedAt,
    });

    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'cancelled');
    await checkpointSiyuanIndexJob({
      job: { ...job, phase: 'completed', status: 'completed', completedAt: Date.now() },
    });
    expect(await readSiyuanIndexJob('project-1', 'map-1')).toMatchObject({
      status: 'cancelled',
      phase: paused!.phase,
      completedAt: null,
    });
  });

  it('persists paused time so elapsed work and ETA ignore intentional pauses', async () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 100,
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/root',
      relativePath: '',
      parentNodeId: null,
    });

    await updateSiyuanIndexJobStatus('project-1', 'map-1', 'paused', 200);
    const resumed = await updateSiyuanIndexJobStatus('project-1', 'map-1', 'running', 500);

    expect(resumed?.pausedMs).toBe(300);
  });

  it('excludes only the pre-renderer offline gap from elapsed work', () => {
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      updatedAt: 200,
      rateSamples: [{ at: 200, processed: 40 }],
    };

    expect(accountForSiyuanRendererOfflineTime(job, 1_200, 1_500)).toMatchObject({
      pausedMs: 1_000,
      updatedAt: 1_500,
      rateSamples: [],
    });
  });

  it('does not classify current-renderer work or clock rollback as offline time', () => {
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy-a',
      now: 1_000,
    });
    expect(accountForSiyuanRendererOfflineTime(job, 500, 1_500).pausedMs).toBe(0);
    expect(accountForSiyuanRendererOfflineTime(job, 900, 1_500).pausedMs).toBe(0);
  });
});


describe('atomic guarded completion checkpoint',()=>{
  beforeEach(resetDatabase);
  async function seedGuarded() {
    const job={...createSiyuanIndexJob({accountId:'guard-account',projectId:'guard-project',mapId:'guard-map',canonicalRoot:'C:/guarded',policyFingerprint:'guard-policy',now:100}),
      phase:'creating_nodes' as const,cursor:1,frontierLength:1,indexed:1,createdNodes:1};
    await checkpointSiyuanIndexJob({job});return (await readSiyuanIndexJob(job.projectId,job.mapId))!;
  }
  function terminal(job:Awaited<ReturnType<typeof seedGuarded>>) {
    return {...job,status:'completed' as const,phase:'completed' as const,reconciledAt:200,completedAt:200,updatedAt:200,estimatedPercent:100};
  }
  it('commits a matching row and captures its expected data before awaits',async()=>{
    const expected=await seedGuarded();const expectedCopy=structuredClone(expected);
    const completion=checkpointSiyuanIndexJob({job:terminal(expected)},{expectedCurrent:expected,signal:new AbortController().signal});
    expected.startedAt++;
    await completion;
    expect(await readSiyuanIndexJob(expected.projectId,expected.mapId)).toEqual(terminal(expectedCopy));
  });
  it.each(['generation','pending','count','effort','paused','missing','aborted'] as const)('rejects %s without any partial derivative or job writes',async drift=>{
    const expected=await seedGuarded();const controller=new AbortController();const changed={...expected};
    if(drift==='generation')changed.startedAt++;
    if(drift==='pending')changed.pendingNativeNodeIds=['unacknowledged'];
    if(drift==='count')changed.createdNodes=0;
    if(drift==='effort')changed.summaryEffort='high';
    if(drift==='paused')changed.status='paused';
    if(drift==='missing')await resetDatabase();
    else await checkpointSiyuanIndexJob({job:changed},{forceStatus:true});
    if(drift==='aborted')controller.abort('guard-revoked');
    const before=await readSiyuanIndexJob(expected.projectId,expected.mapId);
    await expect(checkpointSiyuanIndexJob({job:terminal(expected),
      appendedEntries:[{nodeId:'never-written',parentNodeId:null,title:'never.txt',kind:'file',relativePath:'never.txt',sourcePointer:'C:/guarded/never.txt',summary:null,sizeBytes:4,modifiedAt:1}],
      appendedDirectories:[{path:'C:/guarded/never',relativePath:'never',parentNodeId:null}],
      summaryUsage:{nodeId:'never-written',sourceModifiedAt:1,sourceSizeBytes:4,providerId:'fixture',connectionId:'fixture',modelId:'fixture',inputTokens:1,outputTokens:1,totalTokens:2,provenance:'reported',completedAt:200},
    },{expectedCurrent:expected,signal:controller.signal})).rejects.toThrow();
    expect(await readSiyuanIndexJob(expected.projectId,expected.mapId)).toEqual(before);
    expect(await readSiyuanIndexEntries(expected.projectId,expected.mapId)).toEqual([]);
    expect(await readSiyuanIndexFrontier(expected.projectId,expected.mapId)).toEqual([]);
    expect(await readSiyuanSummaryUsage(expected.projectId,expected.mapId)).toEqual([]);
  });
  it('rolls back when cancellation follows the queued guarded put',async()=>{
    const expected=await seedGuarded();const controller=new AbortController();const original=IDBObjectStore.prototype.put;
    const put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
      const result=original.call(this,value,key);
      if(this.name==='jobs' && value?.phase==='completed')controller.abort('after-put');
      return result;
    });
    try {
      await expect(checkpointSiyuanIndexJob({job:terminal(expected)},{expectedCurrent:expected,signal:controller.signal})).rejects.toThrow();
      expect(await readSiyuanIndexJob(expected.projectId,expected.mapId)).toEqual(expected);
    } finally {put.mockRestore();}
  });
});
