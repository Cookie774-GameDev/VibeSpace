import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ProductionSiyuanRlmPort,
  SiyuanManagedBlockAppendInput,
  SiyuanManagedDocumentCreateInput,
  SiyuanManagedDocumentCreateUnderParentInput,
} from './siyuanRlmProduction';
import {
  assertSiyuanCloudApprovalPreflightReady,
  clearArchivedSiyuanSummaryDocuments,
  createSiyuanContextMapIntegration,
  recoverPendingSiyuanFileBlock,
} from './siyuanContextMapIntegration';
import type { ContextMapRecord } from './tree';
import {
  createSiyuanMapManifest,
  readSiyuanMapManifest,
  updateSiyuanMapManifest,
  writeSiyuanMapManifest,
} from './siyuan/siyuanMapManifest';
import {
  clearSiyuanNodeBindings,
  readSiyuanLegacyCleanupReceipts,
  readSiyuanNodeBindings,
  writeSiyuanNodeBindings,
} from './siyuan/siyuanBindingStore';
import { createSiyuanIndexJobControl } from './siyuan/siyuanSafeIndex';
import { siyuanIndexPolicyFingerprint } from './siyuan/siyuanSafeIndex';
import {
  checkpointSiyuanIndexJob,
  createSiyuanIndexJob,
  readSiyuanIndexEntries,
  readSiyuanIndexJob,
  replaceSiyuanIndexJob,
} from './siyuan/siyuanIndexJobStore';
import { useAuthStore } from '@/stores/auth';
import { siyuanOverallProgressPercent } from './siyuan/siyuanProgress';
import * as indexJobStore from './siyuan/siyuanIndexJobStore';

function map(): ContextMapRecord {
  return {
    id: 'map-1',
    projectId: 'project-1',
    rootDir: 'C:\\Work\\Example',
    name: 'Example Context Map',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    tree: {
      version: 1,
      projectId: 'project-1',
      rootDir: 'C:\\Work\\Example',
      generatedAt: 2,
      model: 'local-structural',
      fileCount: 1,
      totalBytes: 42,
      summary: 'A small project.',
      nodes: [
        {
          id: 'root',
          title: 'Example',
          kind: 'root',
          summary: 'Root',
          children: [
            {
              id: 'file',
              title: 'index.ts',
              kind: 'file',
              summary: 'Entry point',
              path: 'index.ts',
            },
          ],
        },
      ],
    },
  };
}

function port(existing: { markdown: string } | null = null): ProductionSiyuanRlmPort {
  let sequence = 0;
  let documents = existing
    ? [{ id: 'doc-1', notebookId: 'notebook-1', path: '/old', markdown: existing.markdown }]
    : [];
  return {
    searchBlocks: vi.fn(async () => []),
    getBlock: vi.fn(async (_projectId, id) => {
      const found = documents.find((document) => document.id === id);
      if (!found) throw new Error('missing');
      return found;
    }),
    listInboundBacklinks: vi.fn(async () => []),
    readManagedDocument: vi.fn(
      async (_projectId, lookup) =>
        documents.find((document) => document.markdown.includes(lookup.marker)) ?? null,
    ),
    createManagedDocument: vi.fn(async (_projectId, path, markdown) => {
      sequence += 1;
      const document = { id: `created-${sequence}`, notebookId: 'notebook-1', path, markdown };
      documents.push(document);
      return document;
    }),
    updateManagedDocument: vi.fn(async (_projectId, id, _expected, markdown) => {
      documents = documents.map((document) =>
        document.id === id ? { ...document, markdown } : document,
      );
      return documents.find((document) => document.id === id)!;
    }),
    deleteManagedDocument: vi.fn(async (_projectId, id) => {
      documents = documents.filter((document) => document.id !== id);
    }),
    createManagedSnapshot: vi.fn(),
    stopActive: vi.fn(),
  };
}

async function seedPendingNativeFileRecovery(record: ContextMapRecord) {
  const policy = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
  const job = {
    ...createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: record.id,
      canonicalRoot: record.rootDir,
      policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []),
    }),
    phase: 'creating_nodes' as const,
    status: 'running' as const,
    indexed: 2,
    reconciledAt: Date.now() + 60_000,
    pendingNativeNodeIds: ['path:index.ts'],
  };
  await replaceSiyuanIndexJob(job, {
    path: record.rootDir,
    relativePath: '',
    parentNodeId: null,
  });
  await checkpointSiyuanIndexJob({
    job,
    appendedEntries: [
      {
        nodeId: 'path:src',
        parentNodeId: null,
        title: 'src',
        kind: 'area',
        relativePath: 'src',
        sourcePointer: `${record.rootDir}\\src`,
        summary: null,
        sizeBytes: null,
        modifiedAt: 2,
      },
      {
        nodeId: 'path:index.ts',
        parentNodeId: 'path:src',
        title: 'index.ts',
        kind: 'file',
        relativePath: 'src\\index.ts',
        sourcePointer: `${record.rootDir}\\src\\index.ts`,
        summary: null,
        sizeBytes: 43,
        modifiedAt: 3,
      },
    ],
  });
  writeSiyuanMapManifest(createSiyuanMapManifest(record, 'project-1', policy));
  return policy;
}

describe('SiYuan Context Map integration', () => {
  it('refreshes a completed map without consuming its saved cloud summary approval or running models', async () => {
    const record = { ...map(), id: 'map-auto-no-model' };
    const policy = { mode: 'all' as const, selectedExtensions: [], selectedPaths: [] };
    const base = createSiyuanIndexJob({ accountId: 'account-1', projectId: 'project-1', mapId: record.id,
      canonicalRoot: record.rootDir, policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []) });
    await replaceSiyuanIndexJob(base, { path: record.rootDir, relativePath: '', parentNodeId: null });
    await checkpointSiyuanIndexJob({ job: { ...base, status: 'completed', phase: 'completed', completedAt: 10,
      reconciledAt: 10, summaryProviderId: 'cloud-unavailable', summaryConnectionId: 'missing', summaryModelId: 'missing-model' } });
    writeSiyuanMapManifest(updateSiyuanMapManifest(createSiyuanMapManifest(record, 'project-1', policy), { status: 'ready' }));
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const result = await createSiyuanContextMapIntegration(port()).sync('project-1', record, {
        accountId: 'account-1', automaticRefresh: true, forceReconcile: true,
        preScannedIndex: { entries: [{ nodeId: 'path:new.txt', parentNodeId: null, title: 'new.txt', kind: 'file',
          relativePath: 'new.txt', sourcePointer: `${record.rootDir}\\new.txt`, summary: null, sizeBytes: 2, modifiedAt: 20 }],
          excluded: 0, unreadable: 0, summarized: 0 },
      });
      expect(result.manifest).toMatchObject({ status: 'ready', summaryPolicy: { mode: 'all' }, counts: { indexed: 1 } });
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({ status: 'completed', inputTokens: 0, outputTokens: 0 });
    } finally {
      if (previousInternals === undefined) delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
    }
  });
  beforeEach(async () => {
    localStorage.clear();
    await clearSiyuanNodeBindings('project-1', 'map-1');
  });

  it('rejects a user pause or abort after approval reconciliation', () => {
    const ready = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: 'map-preflight-ready',
        canonicalRoot: 'C:/Work/Example',
        policyFingerprint: 'policy',
      }),
      status: 'paused' as const,
      phase: 'summarizing' as const,
      pauseReason: 'cloud_approval_required' as const,
    };
    expect(() => assertSiyuanCloudApprovalPreflightReady(ready)).not.toThrow();
    expect(() =>
      assertSiyuanCloudApprovalPreflightReady({ ...ready, pauseReason: 'user' }),
    ).toThrow('siyuan_cloud_summary_approval_reconcile_interrupted');
    const controller = new AbortController();
    controller.abort('user_cancelled');
    expect(() => assertSiyuanCloudApprovalPreflightReady(ready, controller.signal)).toThrow(
      'siyuan_cloud_summary_approval_reconcile_interrupted',
    );
  });

  it.each([
    { edited: false, committedError: false },
    { edited: true, committedError: false },
    { edited: false, committedError: true },
    { edited: false, committedError: 'different' },
  ])('repairs only an unedited legacy metadata root (%j)', async ({ edited, committedError }) => {
    const nativePort = port();
    const record = map();
    const initial = await createSiyuanContextMapIntegration(nativePort).sync('project-1', record);
    const legacy = {
      ...record.tree,
      model: 'siyuan-metadata-index-v1',
      fileCount: 0,
      totalBytes: 0,
      nodes: [],
    };
    const payload = btoa(JSON.stringify(legacy))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const markdown =
      initial.document.markdown
        .replace(/payload=[A-Za-z0-9_-]+/, 'payload=' + payload)
        .replace('Files: 1 · Bytes: 42', 'Files: 0 · Bytes: 0')
        .replace('-->\n', '-->\n{: id="20260909004655-l454w1s" updated="20260909004655"}\n\n') +
      (edited ? '\nUser note: preserve me.\n' : '');
    await nativePort.updateManagedDocument(
      'project-1',
      initial.document.id,
      initial.document.markdown,
      markdown,
      initial.document.id,
    );
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: record.id,
      canonicalRoot: record.rootDir,
      policyFingerprint: 'legacy',
    });
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'path:index.ts',
          parentNodeId: null,
          title: 'index.ts',
          kind: 'file',
          relativePath: 'index.ts',
          sourcePointer: record.rootDir + '/index.ts',
          summary: null,
          sizeBytes: 42,
          modifiedAt: 2,
        },
      ],
    });
    vi.mocked(nativePort.updateManagedDocument).mockClear();
    if (committedError) {
      const update = vi.mocked(nativePort.updateManagedDocument).getMockImplementation()!;
      vi.mocked(nativePort.updateManagedDocument).mockImplementationOnce(async (...args) => {
        await update(...args);
        if (committedError === 'different') {
          await update(args[0], args[1], args[3], args[3] + '\nUser edit.\n', args[4]);
        }
        throw new Error('concurrent_native_readback');
      });
    }
    const reading = createSiyuanContextMapIntegration(nativePort).read('project-1', record);
    if (committedError === 'different') {
      await expect(reading).rejects.toThrow('concurrent_native_readback');
      return;
    }
    const reopened = await reading;
    if (edited) {
      expect(reopened?.document.markdown).toBe(markdown);
      expect(nativePort.updateManagedDocument).not.toHaveBeenCalled();
    } else {
      expect(reopened?.tree.fileCount).toBe(1);
      expect(reopened?.document.markdown).toContain('Files: 1 · Bytes: 42');
      expect(nativePort.updateManagedDocument).toHaveBeenCalledOnce();
    }
  });

  it('reopens the durable root when child hits crowd it out of bounded search', async () => {
    const nativePort = port();
    const record = map();
    const initial = await createSiyuanContextMapIntegration(nativePort).sync('project-1', record);
    vi.mocked(nativePort.readManagedDocument).mockResolvedValue(null);
    const reopened = await createSiyuanContextMapIntegration(nativePort).read('project-1', record);
    expect(reopened?.document.id).toBe(initial.document.id);
    expect(reopened?.tree.fileCount).toBe(1);
  });

  it('rejects a durable root that moved to another notebook', async () => {
    const nativePort = port();
    const record = map();
    const initial = await createSiyuanContextMapIntegration(nativePort).sync('project-1', record);
    vi.mocked(nativePort.getBlock).mockResolvedValue({
      ...initial.document,
      notebookId: 'foreign',
    });
    vi.mocked(nativePort.readManagedDocument).mockResolvedValue(null);
    expect(
      await createSiyuanContextMapIntegration(nativePort).read('project-1', record),
    ).toBeNull();
  });

  it('persists a durable pause before aborting a possibly hung active sync', () => {
    const source = readFileSync(
      resolve('src/features/context/siyuanContextMapIntegration.ts'),
      'utf8',
    );
    const pauseStart = source.indexOf('async pause(projectId: string, mapId: string)');
    const pauseEnd = source.indexOf('async retire(', pauseStart);
    const pause = source.slice(pauseStart, pauseEnd);
    const abort = pause.indexOf("syncControllers.get(key)?.abort('siyuan_index_paused')");
    const durablePause = pause.indexOf(
      "await updateSiyuanIndexJobStatus(exactProjectId, exactMapId, 'paused')",
    );
    expect(abort).toBeGreaterThan(-1);
    expect(durablePause).toBeGreaterThan(-1);
    expect(durablePause).toBeLessThan(abort);
    expect(pause).not.toContain('await synchronizing.get(key)?.catch');
  });

  it('accounts for renderer-offline time before discovery can overwrite the checkpoint', () => {
    const source = readFileSync(
      resolve('src/features/context/siyuanContextMapIntegration.ts'),
      'utf8',
    );
    const integrationStart = source.indexOf('const syncNativeNodeDocuments');
    const accountIndex = source.indexOf('accountForSiyuanRendererOfflineTime(', integrationStart);
    const scanIndex = source.indexOf('scanSiyuanFilesystemIndex(', integrationStart);
    expect(accountIndex).toBeGreaterThan(integrationStart);
    expect(accountIndex).toBeLessThan(scanIndex);
  });

  it('publishes the ready manifest before the durable job is marked completed', () => {
    const source = readFileSync(
      resolve('src/features/context/siyuanContextMapIntegration.ts'),
      'utf8',
    );
    const integrationStart = source.indexOf('const syncNativeNodeDocuments');
    const readyManifest = source.indexOf('const readyManifest', integrationStart);
    const publishReady = source.indexOf('writeSiyuanMapManifest(readyManifest)', readyManifest);
    const completeJob = source.indexOf("status: 'completed'", readyManifest);
    expect(publishReady).toBeGreaterThan(readyManifest);
    expect(publishReady).toBeLessThan(completeJob);
  });

  it('prewarms the shared project runtime once without blocking map creation', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    await Promise.all([integration.prewarm('project-1'), integration.prewarm('project-1')]);
    expect(nativePort.searchBlocks).toHaveBeenCalledTimes(1);
  });

  it('removes archived summaries in place before an exact model restart', async () => {
    const record = map();
    const manifest = updateSiyuanMapManifest(
      createSiyuanMapManifest(record, 'project-1'),
      { notebookId: 'notebook-1', rootDocumentId: 'root-document' },
      100,
    );
    writeSiyuanMapManifest(manifest);
    await writeSiyuanNodeBindings('project-1', 'map-1', { 'file-node': 'doc-1' });
    const nativePort = port({
      markdown:
        '<!-- vibespace-context-node:v1 map=map-1 node=file-node -->\n# index.ts\n\n## Summary\n\nGenerated locally.\n',
    });
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: record.rootDir,
        policyFingerprint: 'policy-a',
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'user' as const,
      summarized: 1,
    };
    const progress = vi.fn();

    await clearArchivedSiyuanSummaryDocuments(
      'project-1',
      'map-1',
      {
        scope: job.scope,
        archivedAt: 200,
        job,
        entries: [
          {
            nodeId: 'file-node',
            parentNodeId: null,
            title: 'index.ts',
            kind: 'file',
            relativePath: 'index.ts',
            sourcePointer: `${record.rootDir}\\index.ts`,
            summary: 'Generated locally.',
            summaryState: 'completed',
            sizeBytes: 42,
            modifiedAt: 1,
          },
        ],
        frontier: [],
        summaryUsage: [],
      },
      nativePort,
      { onProgress: progress },
    );

    expect(nativePort.updateManagedDocument).toHaveBeenCalledOnce();
    expect(vi.mocked(nativePort.updateManagedDocument).mock.calls[0]?.[1]).toBe('doc-1');
    expect(vi.mocked(nativePort.updateManagedDocument).mock.calls[0]?.[3]).not.toContain(
      '## Summary',
    );
    expect(nativePort.createManagedDocument).not.toHaveBeenCalled();
    expect(nativePort.deleteManagedDocument).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([
      [{ phase: 'validating', completed: 1, total: 1 }],
      [{ phase: 'rewriting', completed: 1, total: 1 }],
    ]);
  });

  it('times out a stalled native summary rewrite without repinning the durable job', async () => {
    const record = map();
    writeSiyuanMapManifest(
      updateSiyuanMapManifest(
        createSiyuanMapManifest(record, 'project-1'),
        { notebookId: 'notebook-1', rootDocumentId: 'root-document' },
        100,
      ),
    );
    await writeSiyuanNodeBindings('project-1', 'map-1', { 'file-node': 'doc-stalled' });
    const nativePort = port();
    vi.mocked(nativePort.getBlock).mockImplementationOnce(() => new Promise(() => undefined));
    const job = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: record.rootDir,
        policyFingerprint: 'policy-a',
      }),
      phase: 'summarizing' as const,
      status: 'paused' as const,
      pauseReason: 'user' as const,
      summarized: 1,
    };

    await expect(
      clearArchivedSiyuanSummaryDocuments(
        'project-1',
        'map-1',
        {
          scope: job.scope,
          archivedAt: 200,
          job,
          entries: [
            {
              nodeId: 'file-node',
              parentNodeId: null,
              title: 'index.ts',
              kind: 'file',
              relativePath: 'index.ts',
              sourcePointer: `${record.rootDir}\\index.ts`,
              summary: 'Generated locally.',
              summaryState: 'completed',
              sizeBytes: 42,
              modifiedAt: 1,
            },
          ],
          frontier: [],
          summaryUsage: [],
        },
        nativePort,
        { operationTimeoutMs: 5 },
      ),
    ).rejects.toThrow('siyuan_summary_native_operation_timeout:read:1');
    expect(nativePort.updateManagedDocument).not.toHaveBeenCalled();
  });

  it('fails closed when a summarized node has lost its structural parent binding', async () => {
    const record = map();
    writeSiyuanMapManifest(
      updateSiyuanMapManifest(
        createSiyuanMapManifest(record, 'project-1'),
        { notebookId: 'notebook-1', rootDocumentId: 'root-document' },
        100,
      ),
    );
    await writeSiyuanNodeBindings('project-1', 'map-1', { 'file-node': 'doc-1' });
    const nativePort = port({
      markdown:
        '<!-- vibespace-context-node:v1 map=map-1 node=file-node -->\n# index.ts\n\n## Summary\n\nGenerated locally.\n',
    });
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: record.rootDir,
      policyFingerprint: 'policy-a',
    });

    await expect(
      clearArchivedSiyuanSummaryDocuments(
        'project-1',
        'map-1',
        {
          scope: job.scope,
          archivedAt: 200,
          job,
          entries: [
            {
              nodeId: 'file-node',
              parentNodeId: 'missing-parent',
              title: 'index.ts',
              kind: 'file',
              relativePath: 'index.ts',
              sourcePointer: `${record.rootDir}\\index.ts`,
              summary: 'Generated locally.',
              summaryState: 'completed',
              sizeBytes: 42,
              modifiedAt: 1,
            },
          ],
          frontier: [],
          summaryUsage: [],
        },
        nativePort,
      ),
    ).rejects.toThrow('siyuan_summary_parent_binding_missing');
    expect(nativePort.updateManagedDocument).not.toHaveBeenCalled();
  });

  it('uses an isolated production queue so a timeout cannot poison shared RLM work', () => {
    const source = readFileSync(
      resolve('src/features/context/siyuanContextMapIntegration.ts'),
      'utf8',
    );
    expect(source).toContain('port: ProductionSiyuanRlmPort = createProductionSiyuanRlmPort()');
    expect(source).not.toContain('port: ProductionSiyuanRlmPort = getProductionSiyuanRlmPort()');
  });

  it('fails closed before rewriting when an archived summary binding is not authoritative', async () => {
    const record = map();
    writeSiyuanMapManifest(
      updateSiyuanMapManifest(
        createSiyuanMapManifest(record, 'project-1'),
        { notebookId: 'notebook-1', rootDocumentId: 'root-document' },
        100,
      ),
    );
    await writeSiyuanNodeBindings('project-1', 'map-1', { 'file-node': 'doc-1' });
    const nativePort = port({ markdown: '<!-- unrelated -->\n# Other document\n' });
    const job = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: record.rootDir,
      policyFingerprint: 'policy-a',
    });
    await expect(
      clearArchivedSiyuanSummaryDocuments(
        'project-1',
        'map-1',
        {
          scope: job.scope,
          archivedAt: 200,
          job,
          entries: [
            {
              nodeId: 'file-node',
              parentNodeId: null,
              title: 'index.ts',
              kind: 'file',
              relativePath: 'index.ts',
              sourcePointer: `${record.rootDir}\\index.ts`,
              summary: 'Generated locally.',
              summaryState: 'completed',
              sizeBytes: 42,
              modifiedAt: 1,
            },
          ],
          frontier: [],
          summaryUsage: [],
        },
        nativePort,
      ),
    ).rejects.toThrow('siyuan_summary_binding_authority_mismatch');
    expect(nativePort.updateManagedDocument).not.toHaveBeenCalled();
  });

  it('creates a managed SiYuan document containing the real Context tree', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const result = await integration.sync('project-1', map());
    expect(result.document.id).toBe('created-1');
    expect(result.tree.nodes[0]?.children?.[0]?.path).toBe('index.ts');
    expect(result.tree.nodes[0]?.children?.[0]?.id).toBe('file');
    expect(nativePort.createManagedDocument).toHaveBeenCalledTimes(3);
    const markdown = vi.mocked(nativePort.createManagedDocument).mock.calls[0]?.[2] ?? '';
    expect(markdown).toContain('vibespace-context-map:v1 map=map-1');
    expect(markdown).toMatch(/payload=[A-Za-z0-9_-]+/u);
    expect(markdown).not.toContain('index.ts');
    expect(markdown).not.toContain('apiKey');
    expect(nativePort.readManagedDocument).toHaveBeenCalledTimes(1);
    expect(result.manifest?.nodeBindings).toEqual({ root: 'created-2' });
    expect(result.manifest?.summaryModel).toEqual({
      kind: 'local',
      modelId: 'local-structural',
    });
    const nodeBodies = vi
      .mocked(nativePort.createManagedDocument)
      .mock.calls.slice(1)
      .map((call) => call[2]);
    expect(nodeBodies[0]).toContain('vibespace-context-node:v1 map=map-1 node=root');
    expect(nodeBodies[1]).toContain('Parent: ((created-2 "Parent"))');
    expect(nodeBodies[1]).toContain('# index.ts');
  });

  it('updates the exact owned document instead of creating a duplicate', async () => {
    const nativePort = port({ markdown: '<!-- vibespace-context-map:v1 map=map-1 -->\nold' });
    const integration = createSiyuanContextMapIntegration(nativePort);
    await integration.sync('project-1', map());
    expect(nativePort.updateManagedDocument).toHaveBeenCalledOnce();
    expect(nativePort.createManagedDocument).toHaveBeenCalledTimes(2);
  });

  it('recovers an uncheckpointed native node after an interrupted create', async () => {
    const nativePort = port();
    const originalCreate = vi.mocked(nativePort.createManagedDocument).getMockImplementation()!;
    let nodeCreateAttempts = 0;
    vi.mocked(nativePort.createManagedDocument).mockImplementation(
      async (projectId, path, markdown) => {
        if (markdown.includes('vibespace-context-node:v1')) {
          nodeCreateAttempts += 1;
          if (nodeCreateAttempts === 1) {
            const recovered = await originalCreate(projectId, path, markdown);
            throw new Error(`interrupted_after_create:${recovered.id}`);
          }
        }
        return originalCreate(projectId, path, markdown);
      },
    );

    const result = await createSiyuanContextMapIntegration(nativePort).sync('project-1', map());

    expect(result.manifest?.counts.indexed).toBe(2);
    expect(nativePort.readManagedDocument).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ query: 'root' }),
    );
  });

  it('checkpoints each completed native node before a later create fails', async () => {
    const nativePort = port();
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/Work/Example',
      policyFingerprint: 'policy',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/Work/Example',
      relativePath: '',
      parentNodeId: null,
    });
    const originalCreate = vi.mocked(nativePort.createManagedDocument).getMockImplementation()!;
    vi.mocked(nativePort.createManagedDocument).mockImplementation(
      async (projectId, path, markdown) => {
        if (markdown.includes('vibespace-context-node:v1 map=map-1 node=file')) {
          throw new Error('simulated_file_create_failure');
        }
        return originalCreate(projectId, path, markdown);
      },
    );

    await expect(
      createSiyuanContextMapIntegration(nativePort).sync('project-1', map()),
    ).rejects.toThrow('simulated_file_create_failure');

    expect(await readSiyuanNodeBindings('project-1', 'map-1')).toMatchObject({
      root: 'created-2',
    });
    expect(readSiyuanMapManifest('project-1', 'map-1')).toMatchObject({
      notebookId: 'notebook-1',
      rootDocumentId: 'created-1',
      status: 'error',
    });
    expect((await readSiyuanIndexJob('project-1', 'map-1'))?.status).toBe('failed');
  });

  it('overlaps a bounded group of idempotent native node creates', async () => {
    const nativePort = port();
    const originalCreate = vi.mocked(nativePort.createManagedDocument).getMockImplementation()!;
    let activeNodeCreates = 0;
    let peakNodeCreates = 0;
    vi.mocked(nativePort.createManagedDocument).mockImplementation(
      async (projectId, path, markdown) => {
        if (markdown.includes('vibespace-context-node:v1')) {
          activeNodeCreates += 1;
          peakNodeCreates = Math.max(peakNodeCreates, activeNodeCreates);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
          activeNodeCreates -= 1;
        }
        return originalCreate(projectId, path, markdown);
      },
    );
    const record = map();
    const root = record.tree.nodes[0]!;
    const siblings = Array.from({ length: 15 }, (_, index) => ({
      id: `area-${index}`,
      title: `area-${index}`,
      kind: 'area' as const,
      summary: '',
      children: [],
    }));
    const wideRecord: ContextMapRecord = {
      ...record,
      tree: {
        ...record.tree,
        fileCount: siblings.length,
        nodes: [{ ...root, children: siblings }],
      },
    };

    await createSiyuanContextMapIntegration(nativePort).sync('project-1', wideRecord);

    expect(peakNodeCreates).toBeGreaterThan(1);
    expect(peakNodeCreates).toBeLessThanOrEqual(8);
    expect(nativePort.createManagedDocument).toHaveBeenCalledTimes(17);
  });

  it('uses bounded managed-document batches when the production port provides them', async () => {
    const nativePort = port();
    let sequence = 100;
    nativePort.createManagedDocuments = vi.fn(
      async (_projectId, inputs: readonly SiyuanManagedDocumentCreateInput[]) =>
        inputs.map((input) => ({
          ok: true as const,
          document: {
            id: `batch-${(sequence += 1)}`,
            notebookId: 'notebook-1',
            path: input.path,
            markdown: input.markdown,
          },
        })),
    );
    const record = map();
    const root = record.tree.nodes[0]!;
    const siblings = Array.from({ length: 10 }, (_, index) => ({
      id: `batch-area-${index}`,
      title: `batch-area-${index}`,
      kind: 'area' as const,
      summary: '',
      children: [],
    }));
    const wideRecord: ContextMapRecord = {
      ...record,
      tree: {
        ...record.tree,
        fileCount: siblings.length,
        nodes: [{ ...root, children: siblings }],
      },
    };

    const result = await createSiyuanContextMapIntegration(nativePort).sync(
      'project-1',
      wideRecord,
    );

    const batches = vi.mocked(nativePort.createManagedDocuments).mock.calls;
    expect(batches.map((call) => call[1].length)).toEqual([1, 4, 4, 2]);
    expect(batches.every((call) => call[1].length <= 4)).toBe(true);
    expect(result.manifest?.counts.indexed).toBe(11);
    expect(nativePort.createManagedDocument).toHaveBeenCalledOnce();
  });

  it('appends file nodes in bounded ordered SiYuan block batches', async () => {
    const nativePort = port();
    let sequence = 0;
    nativePort.appendManagedBlocks = vi.fn(async (_projectId, _mapRootId, inputs) =>
      inputs.map(() => `block-${(sequence += 1)}`),
    );
    const record = map();
    const root = record.tree.nodes[0]!;
    const siblings = Array.from({ length: 129 }, (_, index) => ({
      id: `batch-file-${index}`,
      title: `batch-file-${index}.txt`,
      kind: 'file' as const,
      summary: '',
      path: `batch-file-${index}.txt`,
    }));
    const wideRecord: ContextMapRecord = {
      ...record,
      tree: {
        ...record.tree,
        fileCount: siblings.length,
        nodes: [{ ...root, children: siblings }],
      },
    };

    const result = await createSiyuanContextMapIntegration(nativePort).sync(
      'project-1',
      wideRecord,
    );

    const batches = vi.mocked(nativePort.appendManagedBlocks).mock.calls;
    expect(batches.map((call) => call[2].length)).toEqual([64, 64, 1]);
    expect(
      batches
        .flatMap((call) => call[2])
        .every((input) => input.markdown.includes('vibespace-context-node:v1')),
    ).toBe(true);
    expect(new Set(batches.flatMap((call) => call[2].map((input) => input.parentId)))).toEqual(
      new Set(['created-2']),
    );
    expect(result.manifest?.counts.indexed).toBe(130);
    expect(nativePort.createManagedDocument).toHaveBeenCalledTimes(2);
  });

  it('keeps root-level files document-backed across a map-root metadata refresh', async () => {
    const nativePort = port();
    nativePort.appendManagedBlocks = vi.fn(async () => ['volatile-root-file-block']);
    const originalGetBlock = nativePort.getBlock;
    let rootFileDocument:
      | { id: string; notebookId: string; path: string; markdown: string }
      | undefined;
    nativePort.getBlock = vi.fn(async (projectId, id) => {
      if (rootFileDocument && id === rootFileDocument.id) return rootFileDocument;
      return originalGetBlock(projectId, id);
    });
    nativePort.createManagedDocumentUnderParent = vi.fn(async (_projectId, mapRootId, input) => {
      expect(mapRootId).toBe('created-1');
      expect(input).toEqual({
        parentId: 'created-1',
        path: expect.stringContaining('map-root-file-stability-created-1'),
        markdown: expect.stringContaining(
          'vibespace-context-node:v1 map=map-root-file-stability node=path%3Aindex.ts',
        ),
        marker: 'vibespace-context-node:v1 map=map-root-file-stability node=path%3Aindex.ts',
      });
      rootFileDocument = {
        id: 'stable-root-file-document',
        notebookId: 'notebook-1',
        path: '/created-1/stable-root-file-document.sy',
        markdown: input.markdown,
      };
      return rootFileDocument;
    });
    const seeded = map();
    const seedRecord: ContextMapRecord = {
      ...seeded,
      id: 'map-root-file-stability',
      tree: {
        ...seeded.tree,
        fileCount: 0,
        totalBytes: 0,
        nodes: [],
      },
    };
    const hydratedRecord: ContextMapRecord = {
      ...seedRecord,
      updatedAt: 3,
      tree: {
        ...seedRecord.tree,
        generatedAt: 3,
        fileCount: 1,
        totalBytes: 43,
        nodes: [
          {
            id: 'path:index.ts',
            title: 'index.ts',
            kind: 'file',
            summary: 'Root-level entry point',
            path: 'index.ts',
          },
        ],
      },
    };
    const list = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      entries: [
        {
          name: 'index.ts',
          path: `${seedRecord.rootDir}\\index.ts`,
          isDir: false,
          size: 43,
          modifiedMs: 3,
        },
      ],
    }));
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const integration = createSiyuanContextMapIntegration(nativePort);
      await expect(
        integration.sync('project-1', seedRecord, {
          accountId: 'account-1',
          summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
          list,
        }),
      ).resolves.toMatchObject({
        manifest: { status: 'ready' },
        tree: { fileCount: 1, totalBytes: 43 },
      });
      expect((await nativePort.getBlock('project-1', 'created-1')).markdown).toContain(
        'Files: 1 · Bytes: 43',
      );

      expect(nativePort.appendManagedBlocks).not.toHaveBeenCalled();
      expect(await readSiyuanNodeBindings('project-1', seedRecord.id)).toEqual({
        'path:index.ts': 'stable-root-file-document',
      });
      await expect(
        integration.sync('project-1', hydratedRecord, {
          accountId: 'account-1',
          summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
          list,
        }),
      ).resolves.toMatchObject({ manifest: { status: 'ready' } });
      expect(nativePort.updateManagedDocument).toHaveBeenCalledWith(
        'project-1',
        'created-1',
        expect.any(String),
        expect.stringContaining('payload='),
        'created-1',
      );
      expect(nativePort.createManagedDocument).toHaveBeenCalledOnce();
      expect(nativePort.createManagedDocumentUnderParent).toHaveBeenCalledOnce();
      expect(await nativePort.getBlock('project-1', 'stable-root-file-document')).toMatchObject({
        id: 'stable-root-file-document',
        path: '/created-1/stable-root-file-document.sy',
      });
      expect(await readSiyuanNodeBindings('project-1', seedRecord.id)).toEqual({
        'path:index.ts': 'stable-root-file-document',
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('migrates a live legacy root-file block to a crash-safe child document', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const seedRecord = {
      ...map(),
      id: 'map-legacy-root-file',
      tree: { ...map().tree, fileCount: 0, totalBytes: 0, nodes: [] },
    };
    const initial = await integration.sync('project-1', seedRecord);
    const activeRoot = {
      ...initial.document,
      id: '20260830010000-maproot',
      path: '/20260830010000-notebk1/20260830010000-maproot.sy',
    };
    const legacy = {
      id: '20260830010001-oldblok',
      notebookId: activeRoot.notebookId,
      path: activeRoot.path,
      markdown:
        '**index.ts** · `vibespace-context-node:v1 map=map-legacy-root-file node=legacy-root-file`',
    };
    let replacement: { id: string; notebookId: string; path: string; markdown: string } | undefined;
    const originalUpdate = nativePort.updateManagedDocument;
    vi.mocked(nativePort.readManagedDocument).mockResolvedValue(activeRoot);
    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => {
      if (id === activeRoot.id) return activeRoot;
      if (id === legacy.id) return legacy;
      if (id === replacement?.id) return replacement;
      throw 'siyuan_block_not_found';
    });
    vi.mocked(nativePort.updateManagedDocument).mockImplementation(
      async (projectId, id, expected, markdown, mapRootId) => {
        if (id === activeRoot.id) return { ...activeRoot, markdown };
        return originalUpdate(projectId, id, expected, markdown, mapRootId);
      },
    );
    nativePort.createManagedDocumentUnderParent = vi.fn(async (_projectId, mapRootId, input) => {
      expect(mapRootId).toBe(activeRoot.id);
      expect(input).toEqual(
        expect.objectContaining({
          parentId: activeRoot.id,
          path: expect.stringContaining(activeRoot.id),
          marker: 'vibespace-context-node:v1 map=map-legacy-root-file node=legacy-root-file',
        }),
      );
      replacement ??= {
        id: '20260830010002-newdoc1',
        notebookId: activeRoot.notebookId,
        path: '/20260830010000-notebk1/20260830010000-maproot/20260830010002-newdoc1.sy',
        markdown: input.markdown,
      };
      if (vi.mocked(nativePort.createManagedDocumentUnderParent!).mock.calls.length === 1) {
        // The native child exists, but the renderer loses the response before
        // it can durably replace the old binding.
        throw 'siyuan_transport_unavailable';
      }
      return replacement;
    });
    vi.mocked(nativePort.deleteManagedDocument).mockImplementation(async (_projectId, id) => {
      expect(id).toBe(legacy.id);
      expect(await readSiyuanNodeBindings('project-1', seedRecord.id)).toEqual({
        'legacy-root-file': replacement?.id,
      });
      if (vi.mocked(nativePort.deleteManagedDocument).mock.calls.length === 1) {
        // The binding swap committed, but native cleanup lost transport.
        throw 'siyuan_transport_unavailable';
      }
    });
    await writeSiyuanNodeBindings('project-1', seedRecord.id, {
      'legacy-root-file': legacy.id,
    });
    writeSiyuanMapManifest(
      updateSiyuanMapManifest(readSiyuanMapManifest('project-1', seedRecord.id)!, {
        rootDocumentId: activeRoot.id,
        nodeBindings: {},
      }),
    );
    const hydratedRecord: ContextMapRecord = {
      ...seedRecord,
      updatedAt: 3,
      tree: {
        ...seedRecord.tree,
        generatedAt: 3,
        fileCount: 1,
        totalBytes: 43,
        nodes: [
          {
            id: 'legacy-root-file',
            title: 'index.ts',
            kind: 'file',
            summary: 'Root entry point',
            path: 'index.ts',
          },
        ],
      },
    };

    await expect(integration.sync('project-1', hydratedRecord)).rejects.toBe(
      'siyuan_transport_unavailable',
    );
    expect(await readSiyuanNodeBindings('project-1', seedRecord.id)).toEqual({
      'legacy-root-file': legacy.id,
    });
    expect(nativePort.deleteManagedDocument).not.toHaveBeenCalled();

    await expect(integration.sync('project-1', hydratedRecord)).rejects.toBe(
      'siyuan_transport_unavailable',
    );
    expect(await readSiyuanNodeBindings('project-1', seedRecord.id)).toEqual({
      'legacy-root-file': replacement?.id,
    });
    expect(await readSiyuanLegacyCleanupReceipts('project-1', seedRecord.id)).toEqual([
      expect.objectContaining({
        nodeId: 'legacy-root-file',
        legacyDocumentId: legacy.id,
        mapRootId: activeRoot.id,
      }),
    ]);

    await expect(integration.sync('project-1', hydratedRecord)).resolves.toMatchObject({
      manifest: { status: 'ready' },
    });

    expect(nativePort.createManagedDocumentUnderParent).toHaveBeenCalledTimes(2);
    expect(nativePort.deleteManagedDocument).toHaveBeenCalledTimes(2);
    expect(nativePort.deleteManagedDocument).toHaveBeenLastCalledWith(
      'project-1',
      legacy.id,
      legacy.markdown,
      activeRoot.id,
    );
    expect(await readSiyuanNodeBindings('project-1', seedRecord.id)).toEqual({
      'legacy-root-file': replacement?.id,
    });
    expect(await readSiyuanLegacyCleanupReceipts('project-1', seedRecord.id)).toEqual([]);
  });

  it('durably checkpoints every file batch before native append and clears it after binding', async () => {
    const record = { ...map(), id: 'map-batch-checkpoint' };
    const nativePort = port();
    let sequence = 0;
    const pendingSizes: number[] = [];
    nativePort.appendManagedBlocks = vi.fn(async (_projectId, _mapRootId, inputs) => {
      pendingSizes.push(
        (await readSiyuanIndexJob('project-1', record.id))?.pendingNativeNodeIds.length ?? 0,
      );
      return inputs.map(() => `block-${(sequence += 1)}`);
    });
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
        accountId: 'account-1',
        summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        list: async (path) => ({
          ok: true,
          path,
          entries:
            path === record.rootDir.replaceAll('\\', '/')
              ? [
                  {
                    name: 'src',
                    path: `${record.rootDir}\\src`,
                    isDir: true,
                    modifiedMs: 1,
                  },
                ]
              : Array.from({ length: 70 }, (_, index) => ({
                  name: `file-${index}.txt`,
                  path: `${record.rootDir}\\src\\file-${index}.txt`,
                  isDir: false,
                  size: 10,
                  modifiedMs: index + 1,
                })),
        }),
      });

      expect(pendingSizes).toEqual([64, 6]);
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'completed',
        pendingNativeNodeIds: [],
        createdNodes: 71,
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('keeps every deep D-drive folder and file when native documents cannot nest past seven path segments', async () => {
    const record = { ...map(), id: 'map-deep-d-drive', rootDir: 'D:\\DeepProject' };
    const documents = new Map<
      string,
      { id: string; notebookId: string; path: string; markdown: string }
    >();
    const root = {
      id: '20260923190000-root001',
      notebookId: '20260923180000-book001',
      path: '/20260923180000-base001/20260923190000-root001.sy',
      markdown: '',
    };
    documents.set(root.id, root);
    let sequence = 0;
    const nativePort = port();
    nativePort.createManagedDocument = vi.fn(async (_projectId, _path, markdown) => {
      const created = { ...root, markdown };
      documents.set(root.id, created);
      return created;
    });
    nativePort.readManagedDocument = vi.fn(
      async (_projectId, lookup) =>
        [...documents.values()].find((document) => document.markdown.includes(lookup.marker)) ??
        null,
    );
    nativePort.getBlock = vi.fn(async (_projectId, id) => {
      const found = documents.get(id);
      if (!found) throw new Error('siyuan_block_not_found');
      return found;
    });
    nativePort.updateManagedDocument = vi.fn(async (_projectId, id, _expected, markdown) => {
      const current = documents.get(id)!;
      const updated = { ...current, markdown };
      documents.set(id, updated);
      return updated;
    });
    nativePort.createManagedDocumentsUnderParents = vi.fn(
      async (
        _projectId,
        _mapRootId,
        inputs: readonly SiyuanManagedDocumentCreateUnderParentInput[],
      ) =>
        inputs.map((input: SiyuanManagedDocumentCreateUnderParentInput) => {
          const parent = documents.get(input.parentId)!;
          const id = `20260923190001-${String(++sequence).padStart(7, '0')}`;
          const path = `${parent.path.slice(0, -3)}/${id}.sy`;
          if (path.slice(1, -3).split('/').length > 7) {
            return {
              ok: false as const,
              error: new Error(`native_depth_exceeded:${input.marker}:${path}`),
            };
          }
          const document = { id, notebookId: root.notebookId, path, markdown: input.markdown };
          documents.set(id, document);
          return { ok: true as const, document };
        }),
    );
    nativePort.appendManagedBlocks = vi.fn(
      async (_projectId, _rootId, inputs: readonly SiyuanManagedBlockAppendInput[]) =>
        inputs.map(
          (_input: SiyuanManagedBlockAppendInput, index: number) =>
            `20260923190002-${String(index + 1).padStart(7, '0')}`,
        ),
    );
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const synced = await createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
        summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        list: async (path) => {
          const depth = (path.replaceAll('\\', '/').match(/level-\d+/gu) ?? []).length;
          return {
            ok: true,
            path,
            entries:
              depth < 7
                ? [
                    {
                      name: `level-${depth + 1}`,
                      path: `${path}\\level-${depth + 1}`,
                      isDir: true,
                      modifiedMs: 1,
                    },
                  ]
                : [
                    {
                      name: 'leaf.ts',
                      path: `${path}\\leaf.ts`,
                      isDir: false,
                      size: 42,
                      modifiedMs: 2,
                    },
                  ],
          };
        },
      });
      const bindings = await readSiyuanNodeBindings('project-1', record.id);
      expect(synced.manifest?.status).toBe('ready');
      expect(synced.tree.fileCount).toBe(1);
      expect(Object.keys(bindings)).toHaveLength(8);
      expect(nativePort.createManagedDocumentsUnderParents).toHaveBeenCalled();
      expect(
        [...documents.values()].every(
          (document) => document.path.slice(1, -3).split('/').length <= 7,
        ),
      ).toBe(true);
      expect(nativePort.appendManagedBlocks).toHaveBeenCalledWith('project-1', root.id, [
        expect.objectContaining({
          parentId: bindings['path:level-1/level-2/level-3/level-4/level-5/level-6/level-7'],
        }),
      ]);
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('finishes and reopens a D-drive map whose complete tree exceeds one SiYuan root block', async () => {
    const record = { ...map(), id: 'map-large-d-drive', rootDir: 'D:\\LargeProject' };
    const nativePort = port();
    let nextBlock = 0;
    nativePort.appendManagedBlocks = vi.fn(async (_projectId, _rootId, inputs) =>
      inputs.map(() => `block-${++nextBlock}`),
    );
    const names = Array.from(
      { length: 1_200 },
      (_, index) => `file-${index}-${'x'.repeat(450)}.txt`,
    );
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const integration = createSiyuanContextMapIntegration(nativePort);
      const completed = await integration.sync('project-1', record, {
        summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        list: async (path) => ({
          ok: true,
          path,
          entries:
            path.replaceAll('\\', '/') === record.rootDir.replaceAll('\\', '/')
              ? [{ name: 'src', path: `${record.rootDir}\\src`, isDir: true, modifiedMs: 1 }]
              : names.map((name) => ({
                  name,
                  path: `${record.rootDir}\\src\\${name}`,
                  isDir: false,
                  size: 1,
                  modifiedMs: 2,
                })),
        }),
      });
      expect(completed.manifest?.status).toBe('ready');
      expect(completed.tree.fileCount).toBe(names.length);
      expect(completed.document.markdown).toContain('index=v1');
      expect(completed.document.markdown).not.toContain('payload=');

      const reopened = await integration.read('project-1', record);
      expect(reopened?.tree.fileCount).toBe(names.length);
      expect(reopened?.tree.nodes[0]?.children).toHaveLength(names.length);
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('re-appends a pending file only when the exact parent proves the marker was never committed', async () => {
    const record = { ...map(), id: 'map-batch-preflight-rejected' };
    const policy = await seedPendingNativeFileRecovery(record);
    const nativePort = port();
    nativePort.appendManagedBlocks = vi.fn(async () => ['recovered-block']);
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await expect(
        createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
          accountId: 'account-1',
          summaryPolicy: policy,
        }),
      ).resolves.toMatchObject({ manifest: { status: 'ready' } });
      expect(nativePort.appendManagedBlocks).toHaveBeenCalledOnce();
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'completed',
        pendingNativeNodeIds: [],
        createdNodes: 2,
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('recovers a committed split-batch prefix and appends only its uncommitted suffix', async () => {
    const record = { ...map(), id: 'map-partial-native-batch' };
    const policy = await seedPendingNativeFileRecovery(record);
    const job = (await readSiyuanIndexJob('project-1', record.id))!;
    await checkpointSiyuanIndexJob({
      job: { ...job, indexed: 3, pendingNativeNodeIds: ['path:index.ts', 'path:second.ts'] },
      appendedEntries: [
        {
          nodeId: 'path:second.ts',
          parentNodeId: 'path:src',
          title: 'second.ts',
          kind: 'file',
          relativePath: 'src/second.ts',
          sourcePointer: `${record.rootDir}\\src\\second.ts`,
          summary: null,
          sizeBytes: 20,
          modifiedAt: 4,
        },
      ],
    });
    const nativePort = port();
    const originalGetBlock = nativePort.getBlock;
    let committed: Awaited<ReturnType<ProductionSiyuanRlmPort['getBlock']>> | null = null;
    nativePort.getBlock = vi.fn(async (projectId, id) => {
      if (id === 'committed-prefix' && committed) return committed;
      const document = await originalGetBlock(projectId, id);
      if (!document.markdown.includes('node=path%3Asrc')) return document;
      const markdown = `**index.ts** · Parent: ((${id} "Parent")) · \`vibespace-context-node:v1 map=${record.id} node=path%3Aindex.ts\``;
      committed = { ...document, id: 'committed-prefix', markdown };
      return { ...document, markdown: `${document.markdown}\n${markdown}` };
    });
    nativePort.searchBlocks = vi.fn(async () =>
      committed
        ? [
            {
              id: committed.id,
              notebookId: committed.notebookId,
              path: committed.path,
              content: '',
            },
          ]
        : [],
    );
    nativePort.appendManagedBlocks = vi.fn(async () => ['new-suffix']);
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
        accountId: 'account-1',
        summaryPolicy: policy,
      });
      expect(nativePort.appendManagedBlocks).toHaveBeenCalledOnce();
      const appended = vi.mocked(nativePort.appendManagedBlocks).mock.calls[0]![2];
      expect(appended).toHaveLength(1);
      expect(appended[0]!.markdown).toContain('node=path%3Asecond.ts');
      expect(appended[0]!.markdown).not.toContain('node=path%3Aindex.ts');
      expect(await readSiyuanNodeBindings('project-1', record.id)).toMatchObject({
        'path:index.ts': 'committed-prefix',
        'path:second.ts': 'new-suffix',
      });
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'completed',
        createdNodes: 3,
        pendingNativeNodeIds: [],
      });
    } finally {
      if (previousInternals === undefined)
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      else (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
    }
  });

  it('uses the exact parent receipt before an unavailable global marker search on retry', async () => {
    const record = { ...map(), id: 'map-batch-parent-receipt-first' };
    const policy = await seedPendingNativeFileRecovery(record);
    const nativePort = port();
    nativePort.appendManagedBlocks = vi.fn(async () => ['recovered-block']);
    vi.mocked(nativePort.readManagedDocument).mockImplementation(async (_projectId, lookup) => {
      if (lookup.marker.includes('vibespace-context-node:v1')) {
        throw new Error('siyuan_marker_search_unavailable');
      }
      return null;
    });
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await expect(
        createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
          accountId: 'account-1',
          summaryPolicy: policy,
        }),
      ).resolves.toMatchObject({ manifest: { status: 'ready' } });
      expect(nativePort.appendManagedBlocks).toHaveBeenCalledOnce();
      expect(nativePort.readManagedDocument).not.toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ marker: expect.stringContaining('vibespace-context-node:v1') }),
      );
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'completed',
        pendingNativeNodeIds: [],
        createdNodes: 2,
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('never re-appends a pending file when post-crash marker recovery is stale', async () => {
    const record = { ...map(), id: 'map-batch-crash-stale-search' };
    const policy = await seedPendingNativeFileRecovery(record);
    const nativePort = port();
    nativePort.appendManagedBlocks = vi.fn(async () => ['duplicate-block']);
    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => ({
      id,
      notebookId: 'notebook-1',
      path: '/map-root',
      markdown: 'vibespace-context-node:v1 map=map-batch-crash-stale-search node=path%3Aindex.ts',
    }));
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await expect(
        createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
          accountId: 'account-1',
          summaryPolicy: policy,
        }),
      ).rejects.toThrow('siyuan_native_block_recovery_inconclusive');
      expect(nativePort.appendManagedBlocks).not.toHaveBeenCalled();
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        pendingNativeNodeIds: ['path:index.ts'],
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('recovers an exact child block and removes identical task-created duplicates', async () => {
    const nativePort = port();
    const mapId = 'map-recover-child';
    const marker = `vibespace-context-node:v1 map=${mapId} node=path%3Aindex.ts`;
    const parent = {
      id: 'parent-doc', notebookId: 'notebook-1', path: '/root/parent-doc.sy', markdown: marker,
    };
    const markdown = `**index.ts** · Parent: ((parent-doc "Parent")) · \`${marker}\``;
    const blocks = [
      { id: 'block-old', notebookId: 'notebook-1', path: parent.path, markdown: `${markdown}\n{: id="block-old" updated="20260923205033"}` },
      { id: 'block-new', notebookId: 'notebook-1', path: parent.path, markdown: `${markdown}\n{: id="block-new" updated="20260923205102"}` },
    ];
    vi.mocked(nativePort.searchBlocks).mockResolvedValue([
      { id: parent.id, notebookId: parent.notebookId, path: parent.path, content: '' },
      ...blocks.map(({ id, notebookId, path }) => ({ id, notebookId, path, content: '' })),
    ]);
    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => {
      const block = blocks.find((candidate) => candidate.id === id);
      if (!block) throw new Error('missing');
      return block;
    });
    const entry = {
      nodeId: 'path:index.ts', parentNodeId: 'path:src', title: 'index.ts',
      kind: 'file' as const, relativePath: 'src/index.ts', sourcePointer: 'C:/Work/Example/src/index.ts',
      summary: null, sizeBytes: 43, modifiedAt: 3,
    };
    await expect(recoverPendingSiyuanFileBlock(
      nativePort, 'project-1', 'root-doc', mapId, entry, parent,
    )).resolves.toBe('block-new');
    expect(nativePort.deleteManagedDocument).toHaveBeenCalledWith(
      'project-1', 'block-old', blocks[0]!.markdown, 'root-doc',
    );
    expect(nativePort.readManagedDocument).not.toHaveBeenCalled();
  });

  it('rejects child blocks with the same marker but different content', async () => {
    const nativePort = port();
    const mapId = 'map-batch-crash-duplicate-markers';
    const marker = `vibespace-context-node:v1 map=${mapId} node=path%3Aindex.ts`;
    const parent = { id: 'parent-doc', notebookId: 'notebook-1', path: '/map-root', markdown: marker };
    vi.mocked(nativePort.searchBlocks).mockResolvedValue([
      { id: 'block-a', notebookId: 'notebook-1', path: '/map-root', content: '' },
      { id: 'block-b', notebookId: 'notebook-1', path: '/map-root', content: '' },
    ]);
    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => ({
      id,
      notebookId: 'notebook-1',
      path: '/map-root',
      markdown: `${id} Parent: ((parent-doc "Parent")) ${marker}`,
    }));
    const entry = {
      nodeId: 'path:index.ts', parentNodeId: 'path:src', title: 'index.ts',
      kind: 'file' as const, relativePath: 'src/index.ts', sourcePointer: 'C:/Work/Example/src/index.ts',
      summary: null, sizeBytes: 43, modifiedAt: 3,
    };
    await expect(recoverPendingSiyuanFileBlock(
      nativePort, 'project-1', 'root-doc', mapId, entry, parent,
    )).rejects.toThrow('siyuan_managed_block_ambiguous');
    expect(nativePort.deleteManagedDocument).not.toHaveBeenCalled();
  });

  it('repairs duplicate owned documents deterministically before updating SiYuan', async () => {
    const owned = '<!-- vibespace-context-map:v1 map=map-1 -->\nold';
    let documents = [
      { id: 'doc-b', notebookId: 'notebook-1', path: '/b', markdown: owned },
      { id: 'doc-a', notebookId: 'notebook-1', path: '/a', markdown: owned },
    ];
    const nativePort = port();
    vi.mocked(nativePort.readManagedDocument).mockImplementation(async () => {
      if (documents.length > 1) throw new Error('siyuan_managed_document_ambiguous');
      return documents[0] ?? null;
    });
    vi.mocked(nativePort.searchBlocks).mockResolvedValue(
      documents.map((document) => ({ id: document.id })) as never,
    );
    vi.mocked(nativePort.getBlock).mockImplementation(
      async (_projectId, id) => documents.find((document) => document.id === id)!,
    );
    vi.mocked(nativePort.deleteManagedDocument).mockImplementation(async (_projectId, id) => {
      documents = documents.filter((document) => document.id !== id);
    });
    vi.mocked(nativePort.updateManagedDocument).mockImplementation(
      async (_projectId, id, _expected, markdown) => {
        documents = documents.map((document) =>
          document.id === id ? { ...document, markdown } : document,
        );
        return documents.find((document) => document.id === id)!;
      },
    );

    const result = await createSiyuanContextMapIntegration(nativePort).sync('project-1', map());

    expect(result.document.id).toBe('doc-a');
    expect(nativePort.deleteManagedDocument).toHaveBeenCalledWith(
      'project-1',
      'doc-b',
      owned,
      'doc-b',
    );
    expect(nativePort.updateManagedDocument).toHaveBeenCalledWith(
      'project-1',
      'doc-a',
      owned,
      expect.stringContaining('payload='),
      'doc-a',
    );
  });

  it('recovers the canonical duplicate root before resuming persisted child bindings', async () => {
    const record = map();
    record.tree.fileCount = 12;
    record.tree.nodes[0]!.children = Array.from({ length: 12 }, (_value, index) => ({
      id: `file-${index + 1}`,
      title: `file-${index + 1}.ts`,
      kind: 'file' as const,
      summary: `File ${index + 1}`,
      path: `file-${index + 1}.ts`,
    }));
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const initial = await integration.sync('project-1', record);
    const cachedDuplicate = { ...initial.document, path: '/maps/duplicate.sy' };
    // The binding authority, not lexical ID order, identifies the safe root.
    const canonical = { ...initial.document, id: 'zz-canonical', path: '/maps/canonical.sy' };
    const boundNodes = [
      'root',
      ...Array.from({ length: 6 }, (_value, index) => `file-${index + 1}`),
    ].map((nodeId) => ({
      id: `bound-${nodeId}`,
      notebookId: canonical.notebookId,
      path: `/maps/canonical/nodes/${nodeId}.sy`,
      markdown: `<!-- vibespace-context-node:v1 map=map-1 node=${nodeId} -->\nold ${nodeId}`,
    }));
    let documents = [cachedDuplicate, canonical, ...boundNodes];

    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => {
      const document = documents.find((candidate) => candidate.id === id);
      if (!document) throw new Error('siyuan_block_not_found');
      return document;
    });
    vi.mocked(nativePort.readManagedDocument).mockImplementation(async (_projectId, lookup) => {
      const matches = documents.filter((document) => document.markdown.includes(lookup.marker));
      if (matches.length > 1) throw new Error('siyuan_managed_document_ambiguous');
      return matches[0] ?? null;
    });
    vi.mocked(nativePort.searchBlocks).mockResolvedValue([
      { id: cachedDuplicate.id },
      { id: canonical.id },
    ] as never);
    vi.mocked(nativePort.deleteManagedDocument).mockImplementation(async (_projectId, id) => {
      documents = documents.filter((document) => document.id !== id);
    });
    nativePort.appendManagedBlocks = vi.fn(
      async (_projectId, mapRootId, blocks: readonly SiyuanManagedBlockAppendInput[]) => {
        if (mapRootId !== canonical.id) throw new Error('siyuan_response_type_mismatch');
        return blocks.map((_block, index) => `block-new-${index + 1}`);
      },
    );

    await clearSiyuanNodeBindings('project-1', record.id);
    await writeSiyuanNodeBindings(
      'project-1',
      record.id,
      Object.fromEntries(
        ['root', ...Array.from({ length: 6 }, (_value, index) => `file-${index + 1}`)].map(
          (nodeId) => [nodeId, `bound-${nodeId}`],
        ),
      ),
    );
    const interrupted = updateSiyuanMapManifest(readSiyuanMapManifest('project-1', record.id)!, {
      rootDocumentId: cachedDuplicate.id,
      status: 'error',
      nodeBindings: {},
    });
    writeSiyuanMapManifest(interrupted);

    const recovered = await integration.sync('project-1', record);

    expect(recovered.document.id).toBe(canonical.id);
    expect(nativePort.deleteManagedDocument).toHaveBeenCalledWith(
      'project-1',
      cachedDuplicate.id,
      cachedDuplicate.markdown,
      cachedDuplicate.id,
    );
    expect(nativePort.appendManagedBlocks).toHaveBeenCalledTimes(1);
    expect(nativePort.appendManagedBlocks).toHaveBeenCalledWith(
      'project-1',
      canonical.id,
      expect.arrayContaining([expect.objectContaining({ parentId: 'bound-root' })]),
    );
    expect(vi.mocked(nativePort.appendManagedBlocks).mock.calls[0]?.[2]).toHaveLength(6);
    expect(Object.keys(await readSiyuanNodeBindings('project-1', record.id))).toHaveLength(13);
    expect(recovered.manifest?.counts.indexed).toBe(13);
  });

  it('recreates a persisted directory binding outside the active native map root before appending files', async () => {
    const record = map();
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const initial = await integration.sync('project-1', record);
    const activeRoot = {
      ...initial.document,
      id: '20260828182841-tbwq3n7',
      path: '/20260823111108-g8hllha/20260828182841-tbwq3n7.sy',
    };
    const staleDirectory = {
      id: '20260828182841-kqutnsy',
      notebookId: activeRoot.notebookId,
      path: '/20260823111108-g8hllha/20260827200803-5gqj8rz/20260827200805-v5vbmhu/20260828182841-kqutnsy.sy',
      markdown: '<!-- vibespace-context-node:v1 map=map-1 node=root -->\nold root',
    };
    const recreatedDirectory = {
      ...staleDirectory,
      id: '20260829050000-newroot',
      path: '/20260823111108-g8hllha/20260828182841-tbwq3n7/20260829050000-newroot.sy',
    };

    vi.mocked(nativePort.readManagedDocument).mockResolvedValue(activeRoot);
    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => {
      if (id === activeRoot.id) return activeRoot;
      if (id === staleDirectory.id) return staleDirectory;
      if (id === recreatedDirectory.id) return recreatedDirectory;
      throw new Error('siyuan_block_not_found');
    });
    nativePort.createManagedDocumentsUnderParents = vi.fn(async (_projectId, mapRootId, inputs) => {
      expect(mapRootId).toBe(activeRoot.id);
      expect(inputs).toEqual([
        expect.objectContaining({
          parentId: activeRoot.id,
          path: expect.stringContaining(activeRoot.id),
          marker: 'vibespace-context-node:v1 map=map-1 node=root',
        }),
      ]);
      return [{ ok: true as const, document: recreatedDirectory }];
    });
    nativePort.appendManagedBlocks = vi.fn(
      async (_projectId, mapRootId, blocks: readonly SiyuanManagedBlockAppendInput[]) => {
        expect(mapRootId).toBe(activeRoot.id);
        expect(blocks).toEqual([expect.objectContaining({ parentId: recreatedDirectory.id })]);
        return ['20260829050001-fileblk'];
      },
    );
    await clearSiyuanNodeBindings('project-1', record.id);
    await writeSiyuanNodeBindings('project-1', record.id, { root: staleDirectory.id });
    writeSiyuanMapManifest(
      updateSiyuanMapManifest(readSiyuanMapManifest('project-1', record.id)!, {
        rootDocumentId: activeRoot.id,
        status: 'error',
        nodeBindings: {},
      }),
    );

    const recovered = await integration.sync('project-1', record);

    expect(nativePort.createManagedDocument).toHaveBeenCalledTimes(3);
    expect(nativePort.createManagedDocumentsUnderParents).toHaveBeenCalledTimes(1);
    expect(nativePort.appendManagedBlocks).toHaveBeenCalledTimes(1);
    expect(nativePort.deleteManagedDocument).not.toHaveBeenCalledWith(
      'project-1',
      staleDirectory.id,
      expect.anything(),
      expect.anything(),
    );
    expect(await readSiyuanNodeBindings('project-1', record.id)).toEqual({
      root: recreatedDirectory.id,
      file: '20260829050001-fileblk',
    });
    expect(recovered.manifest?.counts.indexed).toBe(2);
  });

  it('recreates a persisted binding when native Tauri returns a primitive not-found code', async () => {
    const record = map();
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const initial = await integration.sync('project-1', record);
    const activeRoot = {
      ...initial.document,
      id: '20260829185633-tr5c9hp',
      path: '/20260823111108-g8hllha/20260829185633-tr5c9hp.sy',
    };
    const missingDirectoryId = '20260829185638-zb7y4ex';
    const recreatedDirectory = {
      id: '20260829190600-repair1',
      notebookId: activeRoot.notebookId,
      path: '/20260823111108-g8hllha/20260829185633-tr5c9hp/20260829190600-repair1.sy',
      markdown: '<!-- vibespace-context-node:v1 map=map-1 node=root -->\nnew root',
    };
    let missingCode = 'siyuan_response_type_mismatch';

    vi.mocked(nativePort.readManagedDocument).mockResolvedValue(activeRoot);
    vi.mocked(nativePort.getBlock).mockImplementation(async (_projectId, id) => {
      if (id === activeRoot.id) return activeRoot;
      if (id === missingDirectoryId) throw missingCode;
      if (id === recreatedDirectory.id) return recreatedDirectory;
      throw new Error('siyuan_block_not_found');
    });
    nativePort.createManagedDocumentsUnderParents = vi.fn(async (_projectId, mapRootId, inputs) => {
      expect(mapRootId).toBe(activeRoot.id);
      expect(inputs).toEqual([
        expect.objectContaining({
          parentId: activeRoot.id,
          marker: 'vibespace-context-node:v1 map=map-1 node=root',
        }),
      ]);
      return [{ ok: true as const, document: recreatedDirectory }];
    });
    nativePort.appendManagedBlocks = vi.fn(async (_projectId, mapRootId, blocks) => {
      expect(mapRootId).toBe(activeRoot.id);
      expect(blocks).toEqual([expect.objectContaining({ parentId: recreatedDirectory.id })]);
      return ['20260829190601-fileblk'];
    });
    await clearSiyuanNodeBindings('project-1', record.id);
    await writeSiyuanNodeBindings('project-1', record.id, { root: missingDirectoryId });
    writeSiyuanMapManifest(
      updateSiyuanMapManifest(readSiyuanMapManifest('project-1', record.id)!, {
        rootDocumentId: activeRoot.id,
        status: 'error',
        nodeBindings: {},
      }),
    );

    await expect(integration.sync('project-1', record)).rejects.toBe(
      'siyuan_response_type_mismatch',
    );
    expect(await readSiyuanNodeBindings('project-1', record.id)).toEqual({
      root: missingDirectoryId,
    });
    expect(nativePort.createManagedDocumentsUnderParents).not.toHaveBeenCalled();

    missingCode = 'siyuan_block_not_found';
    const recovered = await integration.sync('project-1', record);

    expect(nativePort.createManagedDocumentsUnderParents).toHaveBeenCalledTimes(1);
    expect(nativePort.deleteManagedDocument).not.toHaveBeenCalledWith(
      'project-1',
      missingDirectoryId,
      expect.anything(),
      expect.anything(),
    );
    expect(await readSiyuanNodeBindings('project-1', record.id)).toEqual({
      root: recreatedDirectory.id,
      file: '20260829190601-fileblk',
    });
    expect(recovered.manifest?.counts.indexed).toBe(2);
  });

  it('treats the old unversioned graph body as needing an in-place SiYuan refresh', async () => {
    const nativePort = port({ markdown: '<!-- vibespace-context-map:v1 map=map-1 -->\nold' });
    const integration = createSiyuanContextMapIntegration(nativePort);
    expect(await integration.read('project-1', map())).toBeNull();
  });

  it('keeps the canonical SiYuan root payload authoritative over presentation child blocks', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const created = await integration.sync('project-1', map());
    const changed = created.document.markdown.replace('**index.ts**', '**renamed.ts**');
    vi.mocked(nativePort.readManagedDocument).mockResolvedValue({
      ...created.document,
      markdown: changed,
    });
    const snapshot = await integration.read('project-1', map());
    expect(snapshot?.tree.nodes[0]?.children?.[0]?.title).toBe('index.ts');
  });

  it('round-trips a Jarvis-managed graph edit through the canonical SiYuan payload', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const changed = map();
    changed.tree.nodes[0]!.children![0]!.title = 'renamed.ts';
    await integration.sync('project-1', changed);
    const snapshot = await integration.read('project-1', changed);
    expect(snapshot?.tree.nodes[0]?.children?.[0]?.title).toBe('renamed.ts');
  });

  it('retires only owned SiYuan index documents and leaves original source pointers untouched', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const record = map();
    await integration.sync('project-1', record);
    const job = createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: record.id,
      canonicalRoot: 'C:/Work/Example',
      policyFingerprint: 'policy',
    });
    await replaceSiyuanIndexJob(job, {
      path: 'C:/Work/Example',
      relativePath: '',
      parentNodeId: null,
    });
    await integration.retire('project-1', record);

    expect(nativePort.deleteManagedDocument).toHaveBeenCalledTimes(3);
    expect(readSiyuanMapManifest('project-1', 'map-1')).toMatchObject({
      status: 'recycled',
      rootDocumentId: null,
      nodeBindings: {},
      counts: { indexed: 0 },
    });
    expect(record.rootDir).toBe('C:\\Work\\Example');
    expect((await readSiyuanIndexJob('project-1', record.id))?.status).toBe('paused');
  });

  it('keeps restore recoverable when native retirement fails after deleting one document', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const record = map();
    await integration.sync('project-1', record);
    const originalDelete = vi.mocked(nativePort.deleteManagedDocument).getMockImplementation()!;
    let deletions = 0;
    vi.mocked(nativePort.deleteManagedDocument).mockImplementation(
      async (projectId, id, expectedMarkdown) => {
        deletions += 1;
        if (deletions === 2) throw new Error('simulated_retire_failure');
        return originalDelete(projectId, id, expectedMarkdown, record.id);
      },
    );

    await expect(integration.retire('project-1', record)).rejects.toThrow(
      'simulated_retire_failure',
    );
    expect(await readSiyuanNodeBindings('project-1', record.id)).not.toEqual({});
    expect(readSiyuanMapManifest('project-1', record.id)).toMatchObject({
      status: 'recycled',
      rootDocumentId: expect.any(String),
    });

    vi.mocked(nativePort.deleteManagedDocument).mockImplementation(originalDelete);
    const restored = await integration.sync('project-1', record);
    expect(restored.manifest?.status).toBe('ready');
    expect(restored.manifest?.counts.indexed).toBe(2);
    expect(await readSiyuanNodeBindings('project-1', record.id)).toEqual(
      expect.objectContaining({ root: expect.any(String), file: expect.any(String) }),
    );
  });

  it('reconciles a deleted source entry without rewriting unchanged native nodes', async () => {
    const nativePort = port();
    const integration = createSiyuanContextMapIntegration(nativePort);
    const changed = map();
    await integration.sync('project-1', changed);
    changed.tree.nodes[0]!.children = [];
    changed.tree.fileCount = 0;
    await integration.sync('project-1', changed);

    expect(nativePort.deleteManagedDocument).toHaveBeenCalledWith(
      'project-1',
      'created-3',
      expect.stringContaining('vibespace-context-node:v1 map=map-1 node=file'),
      expect.any(String),
    );
  });

  it('keeps a cancelled index resumable instead of publishing a false ready state', async () => {
    const nativePort = port();
    const control = createSiyuanIndexJobControl();
    control.cancel();
    await expect(
      createSiyuanContextMapIntegration(nativePort).sync('project-1', map(), { control }),
    ).rejects.toThrow('siyuan_index_cancelled');
    expect(readSiyuanMapManifest('project-1', 'map-1')?.status).toBe('paused');
  });

  it('pauses both the durable job and manifest when no registered local summary model exists', async () => {
    const record = { ...map(), id: 'map-local-unavailable' };
    const policy = { mode: 'all' as const, selectedExtensions: [], selectedPaths: [] };
    const job = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: record.id,
        canonicalRoot: record.rootDir,
        policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []),
      }),
      phase: 'creating_nodes' as const,
      indexed: 1,
    };
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'file',
          parentNodeId: null,
          title: 'index.ts',
          kind: 'file',
          relativePath: 'index.ts',
          sourcePointer: `${record.rootDir}\\index.ts`,
          summary: null,
          sizeBytes: 42,
          modifiedAt: 2,
        },
      ],
    });
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const previousModel = useAuthStore.getState().defaultLocalModel;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useAuthStore.setState({ defaultLocalModel: '' });
    try {
      await expect(
        createSiyuanContextMapIntegration(port()).sync('project-1', record, {
          accountId: 'account-1',
          summaryPolicy: policy,
          list: async (path) => ({
            ok: true,
            path,
            entries: [
              {
                name: 'index.ts',
                path: `${record.rootDir}\\index.ts`,
                isDir: false,
                size: 42,
                modifiedMs: 2,
              },
            ],
          }),
        }),
      ).rejects.toThrow('local_model_unavailable');
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        phase: 'summarizing',
        status: 'paused',
        pauseReason: 'local_model_unavailable',
        indexed: 1,
        summarized: 0,
        totalTokens: 0,
      });
      expect(readSiyuanMapManifest('project-1', record.id)?.status).toBe('paused');
    } finally {
      useAuthStore.setState({ defaultLocalModel: previousModel });
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('skips bound structural batches on summary resume but still creates a missing binding', async () => {
    const record = { ...map(), id: 'map-summary-structural-resume' };
    const policy = { mode: 'all' as const, selectedExtensions: [], selectedPaths: [] };
    const fingerprint = siyuanIndexPolicyFingerprint(record.rootDir, policy, []);
    const indexedEntries = Array.from({ length: 2 }, (_, index) => ({
      nodeId: `path:file-${index}.ts`,
      parentNodeId: null,
      title: `file-${index}.ts`,
      kind: 'file' as const,
      relativePath: `file-${index}.ts`,
      sourcePointer: `${record.rootDir}\\file-${index}.ts`,
      summary: null,
      sizeBytes: index + 1,
      modifiedAt: index + 1,
    }));
    const job = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: record.id,
        canonicalRoot: record.rootDir,
        policyFingerprint: fingerprint,
      }),
      phase: 'summarizing' as const,
      status: 'running' as const,
      indexed: indexedEntries.length,
      createdNodes: indexedEntries.length - 1,
      summaryProviderId: 'deepseek',
      summaryConnectionId: 'deepseek-api',
      summaryModelId: 'deepseek-chat',
      summaryEffort: 'high' as const,
    };
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({ job, appendedEntries: indexedEntries });
    await writeSiyuanNodeBindings('project-1', record.id, {
      [indexedEntries[0]!.nodeId]: 'bound-doc',
    });
    writeSiyuanMapManifest(createSiyuanMapManifest(record, 'project-1', policy));

    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const nativePort = port();
    const durableControl = createSiyuanIndexJobControl();
    const checkpoint = vi.fn((signal?: AbortSignal) => durableControl.checkpoint(signal));
    const control = {
      get state() {
        return durableControl.state;
      },
      pause: () => durableControl.pause(),
      resume: () => durableControl.resume(),
      cancel: () => durableControl.cancel(),
      checkpoint,
    };
    try {
      await expect(
        createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          summaryPolicy: policy,
          control,
          list: async (path) => ({
            ok: true,
            path,
            entries: indexedEntries.map((entry) => ({
              name: entry.title,
              path: entry.sourcePointer!,
              isDir: false,
              size: entry.sizeBytes,
              modifiedMs: entry.modifiedAt,
            })),
          }),
        }),
      ).rejects.toThrow('siyuan_cloud_summary_approval_required');

      const nodeCreates = vi
        .mocked(nativePort.createManagedDocument)
        .mock.calls.filter((call) => call[1].includes('/Nodes/'));
      expect(nodeCreates).toHaveLength(1);
      expect(nodeCreates[0]?.[1]).toContain('file-1');
      expect(nativePort.getBlock).not.toHaveBeenCalled();
      expect(nativePort.updateManagedDocument).not.toHaveBeenCalled();
      expect(checkpoint).toHaveBeenCalledTimes(5);
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it.each([
    ['missing approval', null],
    [
      'changed approval route',
      {
        providerId: 'openai',
        connectionId: 'openai-api',
        modelId: 'gpt-5-mini',
        sourceRoot: 'C:\\Work\\Example',
        summaryPolicyFingerprint: 'placeholder',
        eligibleFileCount: 1,
        eligibleSourceBytes: 42,
        estimatedMaxSentBytes: 48 * 1024,
        privacyAcknowledged: true as const,
        approvedAt: 10,
      },
    ],
  ])('fails closed for a cloud-pinned job with %s', async (_label, approval) => {
    const record = { ...map(), id: `map-cloud-${approval ? 'changed' : 'missing'}` };
    const policy = { mode: 'all' as const, selectedExtensions: [], selectedPaths: [] };
    const fingerprint = siyuanIndexPolicyFingerprint(record.rootDir, policy, []);
    const job = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: record.id,
        canonicalRoot: record.rootDir,
        policyFingerprint: fingerprint,
      }),
      phase: 'creating_nodes' as const,
      indexed: 1,
      summaryProviderId: 'deepseek',
      summaryConnectionId: 'deepseek-api',
      summaryModelId: 'deepseek-chat',
    };
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'file',
          parentNodeId: null,
          title: 'index.ts',
          kind: 'file',
          relativePath: 'index.ts',
          sourcePointer: `${record.rootDir}\\index.ts`,
          summary: null,
          sizeBytes: 42,
          modifiedAt: 2,
        },
      ],
    });
    let manifest = createSiyuanMapManifest(record, 'project-1', policy);
    if (approval) {
      manifest = updateSiyuanMapManifest(manifest, {
        cloudSummaryApproval: { ...approval, summaryPolicyFingerprint: fingerprint },
      });
    }
    writeSiyuanMapManifest(manifest);
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await expect(
        createSiyuanContextMapIntegration(port()).sync('project-1', record, {
          accountId: 'account-1',
          summaryPolicy: policy,
          list: async (path) => ({
            ok: true,
            path,
            entries: [
              {
                name: 'index.ts',
                path: `${record.rootDir}\\index.ts`,
                isDir: false,
                size: 42,
                modifiedMs: 2,
              },
            ],
          }),
        }),
      ).rejects.toThrow(/siyuan_cloud_summary_(?:approval_required|restart_required)/u);
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'paused',
        pauseReason: 'cloud_approval_required',
        summarized: 0,
        totalTokens: 0,
      });
      expect(readSiyuanMapManifest('project-1', record.id)?.status).toBe('paused');
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it.each(['explicit', 'saved-unpinned', 'saved-local-pin'] as const)(
    'refreshes and pauses %s cloud selection before any summary dispatch',
    async (selection) => {
      const record = { ...map(), id: `map-approval-preflight-${selection}` };
      if (selection !== 'explicit') {
        const { writeSiyuanSummaryRoutePreference } =
          await import('./siyuan/siyuanSummaryRoutePreference');
        writeSiyuanSummaryRoutePreference(localStorage, 'account-1', 'project-1', record.id, {
          providerId: 'opencode-go',
          connectionId: 'opencode-go-selected',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          effort: 'high',
        });
      }
      const policy = { mode: 'all' as const, selectedExtensions: [], selectedPaths: [] };
      const fingerprint = siyuanIndexPolicyFingerprint(record.rootDir, policy, []);
      const job = {
        ...createSiyuanIndexJob({
          accountId: 'account-1',
          projectId: 'project-1',
          mapId: record.id,
          canonicalRoot: record.rootDir,
          policyFingerprint: fingerprint,
        }),
        phase: 'summarizing' as const,
        status: 'running' as const,
        indexed: 1,
        summaryProviderId:
          selection === 'explicit' ? 'deepseek' : selection === 'saved-local-pin' ? 'ollama' : null,
        summaryConnectionId:
          selection === 'explicit'
            ? 'deepseek-api'
            : selection === 'saved-local-pin'
              ? 'ollama-local'
              : null,
        summaryModelId:
          selection === 'explicit'
            ? 'deepseek-chat'
            : selection === 'saved-local-pin'
              ? 'llama3.2'
              : null,
        summaryEffort: 'high' as const,
      };
      await replaceSiyuanIndexJob(job, {
        path: record.rootDir,
        relativePath: '',
        parentNodeId: null,
      });
      await checkpointSiyuanIndexJob({
        job,
        appendedEntries: [
          {
            nodeId: 'path:index.ts',
            parentNodeId: null,
            title: 'index.ts',
            kind: 'file',
            relativePath: 'index.ts',
            sourcePointer: `${record.rootDir}\\index.ts`,
            summary: null,
            sizeBytes: 42,
            modifiedAt: 2,
          },
        ],
      });
      writeSiyuanMapManifest(createSiyuanMapManifest(record, 'project-1', policy));
      const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      try {
        await expect(
          createSiyuanContextMapIntegration(port()).sync('project-1', record, {
            accountId: 'account-1',
            workspaceId: 'workspace-1',
            summaryPolicy: policy,
            forceReconcile: true,
            approvalPreflight: selection === 'explicit',
            list: async (path) => ({
              ok: true,
              path,
              entries: [
                {
                  name: 'index.ts',
                  path: `${record.rootDir}\\index.ts`,
                  isDir: false,
                  size: 43,
                  modifiedMs: 3,
                },
              ],
            }),
          }),
        ).rejects.toThrow('siyuan_cloud_summary_scope_ready');
        expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
          status: 'paused',
          phase: 'summarizing',
          pauseReason: 'cloud_approval_required',
          summarized: 0,
          totalTokens: 0,
        });
        expect(await readSiyuanIndexEntries('project-1', record.id)).toEqual([
          expect.objectContaining({ relativePath: 'index.ts', sizeBytes: 43, modifiedAt: 3 }),
        ]);
        expect(readSiyuanMapManifest('project-1', record.id)?.status).toBe('paused');
      } finally {
        if (previousInternals === undefined) {
          delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
        } else {
          (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
        }
      }
    },
  );

  it('rebuilds a restored map but pauses before local model identity or inference', async () => {
    const record = { ...map(), id: 'map-restored-no-implicit-model' };
    const policy = { mode: 'all' as const, selectedExtensions: [], selectedPaths: [] };
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await expect(
        createSiyuanContextMapIntegration(port()).sync('project-1', record, {
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          summaryPolicy: policy,
          pauseBeforeSummaries: true,
          list: async (path) => ({
            ok: true,
            path,
            entries: [
              {
                name: 'restored.ts',
                path: `${record.rootDir}\\restored.ts`,
                isDir: false,
                size: 42,
                modifiedMs: 2,
              },
            ],
          }),
        }),
      ).rejects.toThrow('siyuan_summary_paused_before_run');
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'paused',
        phase: 'summarizing',
        pauseReason: 'user',
        summarized: 0,
        totalTokens: 0,
      });
      expect(await readSiyuanIndexEntries('project-1', record.id)).toEqual([
        expect.objectContaining({ relativePath: 'restored.ts', summary: null }),
      ]);
      expect(readSiyuanMapManifest('project-1', record.id)?.status).toBe('paused');
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('repairs a pending changed bound node after reconciliation restarts', async () => {
    const record = { ...map(), id: 'map-pending-bound-repair' };
    const policy = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
    const job = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: record.id,
        canonicalRoot: record.rootDir,
        policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []),
      }),
      phase: 'creating_nodes' as const,
      status: 'running' as const,
      indexed: 1,
      reconciledAt: Date.now() + 60_000,
      pendingNativeNodeIds: ['path:index.ts'],
    };
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'path:index.ts',
          parentNodeId: null,
          title: 'index.ts',
          kind: 'file',
          relativePath: 'index.ts',
          sourcePointer: `${record.rootDir}\\index.ts`,
          summary: null,
          sizeBytes: 43,
          modifiedAt: 3,
        },
      ],
    });
    writeSiyuanMapManifest(createSiyuanMapManifest(record, 'project-1', policy));
    const nativePort = port();
    const stale = await nativePort.createManagedDocument(
      'project-1',
      '/stale-bound',
      '<!-- vibespace-context-node:v1 map=map-pending-bound-repair node=path%3Aindex.ts -->\n# stale\n',
    );
    await writeSiyuanNodeBindings('project-1', record.id, {
      'path:index.ts': stale.id,
    });
    vi.mocked(nativePort.updateManagedDocument).mockClear();
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
        accountId: 'account-1',
        summaryPolicy: policy,
        list: async (path) => ({
          ok: true,
          path,
          entries: [
            {
              name: 'index.ts',
              path: `${record.rootDir}\\index.ts`,
              isDir: false,
              size: 43,
              modifiedMs: 3,
            },
          ],
        }),
      });
      expect(nativePort.updateManagedDocument).toHaveBeenCalledWith(
        'project-1',
        stale.id,
        expect.stringContaining('# stale'),
        expect.stringContaining('node=path%3Aindex.ts'),
        expect.any(String),
      );
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'completed',
        pendingNativeNodeIds: [],
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('reconciles added and deleted native files before publishing a resumed map ready', async () => {
    const record = { ...map(), id: 'map-native-reconcile' };
    const policy = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
    const job = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: record.id,
        canonicalRoot: record.rootDir,
        policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []),
      }),
      phase: 'creating_nodes' as const,
      indexed: 1,
      reconciledAt: Date.now() + 60_000,
    };
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'path:old.txt',
          parentNodeId: null,
          title: 'old.txt',
          kind: 'file',
          relativePath: 'old.txt',
          sourcePointer: `${record.rootDir}\\old.txt`,
          summary: null,
          sizeBytes: 1,
          modifiedAt: 1,
        },
      ],
    });
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const nativePort = port();
    await nativePort.createManagedDocument(
      'project-1',
      '/stale-old',
      '<!-- vibespace-context-node:v1 map=map-native-reconcile node=path%3Aold.txt -->\n# old.txt\n',
    );
    vi.mocked(nativePort.createManagedDocument).mockClear();
    const list = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      entries: [
        {
          name: 'new.txt',
          path: `${record.rootDir}\\new.txt`,
          isDir: false,
          size: 2,
          modifiedMs: 2,
        },
      ],
    }));
    try {
      const result = await createSiyuanContextMapIntegration(nativePort).sync('project-1', record, {
        accountId: 'account-1',
        summaryPolicy: policy,
        forceReconcile: true,
        list,
      });
      expect(result.manifest).toMatchObject({ status: 'ready', counts: { indexed: 1 } });
      expect((await readSiyuanIndexJob('project-1', record.id))?.status).toBe('completed');
      expect(await readSiyuanNodeBindings('project-1', record.id)).toEqual({
        'path:new.txt': expect.any(String),
      });
      expect(nativePort.createManagedDocument).not.toHaveBeenCalledWith(
        'project-1',
        expect.stringContaining('old.txt'),
        expect.any(String),
      );
      expect(nativePort.deleteManagedDocument).toHaveBeenCalledWith(
        'project-1',
        'created-1',
        expect.stringContaining('node=path%3Aold.txt'),
        expect.any(String),
      );
      expect(list).toHaveBeenCalledOnce();
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('keeps a brand-new native creation single-pass', async () => {
    const record = { ...map(), id: 'map-native-single-pass' };
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const list = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      entries: [
        {
          name: 'index.ts',
          path: `${record.rootDir}\\index.ts`,
          isDir: false,
          size: 42,
          modifiedMs: 2,
        },
      ],
    }));
    try {
      await createSiyuanContextMapIntegration(port()).sync('project-1', record, {
        accountId: 'account-1',
        summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
        list,
      });
      expect(list).toHaveBeenCalledOnce();
      const completed = (await readSiyuanIndexJob('project-1', record.id))!;
      expect(completed).toMatchObject({ status: 'completed', indexed: 1, createdNodes: 1, pendingNativeNodeIds: [] });
      expect(siyuanOverallProgressPercent(completed)).toBe(100);
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('pauses the authoritative active sync and prevents later native completion', async () => {
    const record = { ...map(), id: 'map-active-pause' };
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const integration = createSiyuanContextMapIntegration(port());
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    let releaseList!: () => void;
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    try {
      const running = integration
        .sync('project-1', record, {
          accountId: 'account-1',
          summaryPolicy: { mode: 'none', selectedExtensions: [], selectedPaths: [] },
          list: async (path) => {
            markListStarted();
            await listReleased;
            return { ok: true, path, entries: [] };
          },
        })
        .catch((error: unknown) => error);
      await listStarted;
      await integration.pause('project-1', record.id);
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        status: 'paused',
        pauseReason: 'user',
        completedAt: null,
      });
      expect(readSiyuanMapManifest('project-1', record.id)?.status).toBe('paused');
      releaseList();
      await expect(running).resolves.toMatchObject({ message: 'siyuan_index_cancelled' });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });

  it('reconciles already-processed directories after a discovery-phase restart', async () => {
    const record = { ...map(), id: 'map-discovery-resume' };
    const policy = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
    const job = {
      ...createSiyuanIndexJob({
        accountId: 'account-1',
        projectId: 'project-1',
        mapId: record.id,
        canonicalRoot: record.rootDir,
        policyFingerprint: siyuanIndexPolicyFingerprint(record.rootDir, policy, []),
        now: 1,
      }),
      cursor: 1,
      indexed: 1,
      updatedAt: 2,
    };
    await replaceSiyuanIndexJob(job, {
      path: record.rootDir,
      relativePath: '',
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job,
      appendedEntries: [
        {
          nodeId: 'path:old.txt',
          parentNodeId: null,
          title: 'old.txt',
          kind: 'file',
          relativePath: 'old.txt',
          sourcePointer: `${record.rootDir}\\old.txt`,
          summary: null,
          sizeBytes: 1,
          modifiedAt: 1,
        },
      ],
    });
    const previousInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      await createSiyuanContextMapIntegration(port()).sync('project-1', record, {
        accountId: 'account-1',
        summaryPolicy: policy,
        list: async (path) => ({
          ok: true,
          path,
          entries: [
            {
              name: 'new.txt',
              path: `${record.rootDir}\\new.txt`,
              isDir: false,
              size: 2,
              modifiedMs: 2,
            },
          ],
        }),
      });
      expect(await readSiyuanNodeBindings('project-1', record.id)).toEqual({
        'path:new.txt': expect.any(String),
      });
      expect(await readSiyuanIndexJob('project-1', record.id)).toMatchObject({
        phase: 'completed',
        indexed: 1,
        reconciledAt: expect.any(Number),
      });
    } finally {
      if (previousInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = previousInternals;
      }
    }
  });
});


describe('fresh integration completion receipt', () => {
  let previousInternals: unknown;
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({localUserId:'account-1', cloudSession:null, workspaceId:'workspace-1' as never, projectId:'project-1' as never});
    previousInternals=(window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__={};
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if(previousInternals===undefined)delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;
    else (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__=previousInternals;
  });
  function gate() {
    let resolve!:()=>void;
    return {promise:new Promise<void>(done=>{resolve=done;}),release:()=>resolve()};
  }
  const policy={mode:'none' as const,selectedExtensions:[],selectedPaths:[]};
  function oneFileOptions(record:ContextMapRecord) {
    return {accountId:'account-1',summaryPolicy:policy,list:vi.fn(async(path:string)=>({ok:true as const,path,entries:[{
      name:'one.txt',path:`${record.rootDir}/one.txt`,isDir:false,size:4,modifiedMs:1,
    }]}))};
  }

  it.each(['completed','failed','cancelled'] as const)('keeps pending native ACK below100 and handles %s without premature completion',async outcome=>{
    const record={...map(),id:`c06-ack-${outcome}`};const native=port();const integration=createSiyuanContextMapIntegration(native);
    const started=gate(),ack=gate(),controller=new AbortController();
    native.appendManagedBlocks=vi.fn(async()=>{started.release();await ack.promise;if(outcome==='failed')throw new Error('fixture_native_ack_failed');return ['nested-file-block'];});
    const running=integration.sync(record.projectId,record,{accountId:'account-1',summaryPolicy:policy,signal:controller.signal,list:async(path)=>({ok:true,path,entries:path===record.rootDir.replaceAll('\\','/')
      ? [{name:'src',path:`${record.rootDir}/src`,isDir:true,modifiedMs:1}]
      : [{name:'one.txt',path:`${record.rootDir}/src/one.txt`,isDir:false,size:4,modifiedMs:1}]})}).then(value=>({value,error:null}),error=>({value:null,error}));
    try {
      await started.promise;
      const held=(await readSiyuanIndexJob(record.projectId,record.id))!;
      expect(held.pendingNativeNodeIds).toHaveLength(1);
      expect(held.reconciledAt).toBeNull();
      expect(siyuanOverallProgressPercent(held)).not.toBe(100);
      if(outcome==='cancelled') {
        await indexJobStore.updateSiyuanIndexJobStatus(record.projectId,record.id,'cancelled');
        controller.abort('fixture_cancelled');
      }
      ack.release();const result=await running;const job=(await readSiyuanIndexJob(record.projectId,record.id))!;
      if(outcome==='completed') {
        expect(result.error).toBeNull();expect(job.pendingNativeNodeIds).toEqual([]);
        expect(siyuanOverallProgressPercent(job)).toBe(100);
      } else {
        expect(result.error).toBeTruthy();expect(job.status).toBe(outcome);
        expect(job.completedAt).toBeNull();expect(job.reconciledAt).toBeNull();
        expect(siyuanOverallProgressPercent(job)).not.toBe(100);
      }
    } finally {ack.release();await running;}
  });

  it('preserves genuine reconciliation time when a completed job is reused',async()=>{
    const record={...map(),id:'c06-reused'};const integration=createSiyuanContextMapIntegration(port());const options=oneFileOptions(record);
    await integration.sync(record.projectId,record,options);
    const first=(await readSiyuanIndexJob(record.projectId,record.id))!;
    expect(first.reconciledAt).not.toBeNull();
    await integration.sync(record.projectId,record,options);
    const reused=(await readSiyuanIndexJob(record.projectId,record.id))!;
    expect(options.list).toHaveBeenCalledOnce();expect(reused.reconciledAt).toBe(first.reconciledAt);
    expect(siyuanOverallProgressPercent(reused)).toBe(100);
  });

  it.each(['after-scan','before-completion'] as const)('refuses a replaced fresh job at %s',async boundary=>{
    const record={...map(),id:`c06-replaced-${boundary}`};const originalRead=indexJobStore.readSiyuanIndexJob;
    let replaced=false;let replacementStartedAt=0;
    vi.spyOn(indexJobStore,'readSiyuanIndexJob').mockImplementation(async(projectId,mapId)=>{
      const current=await originalRead(projectId,mapId);
      if(!replaced && mapId===record.id && current?.status==='running' && current.indexed===1 && current.createdNodes===(boundary==='after-scan'?0:1) && current.pendingNativeNodeIds.length===0) {
        replaced=true;replacementStartedAt=current.startedAt+1;
        const replacement={...current,startedAt:replacementStartedAt};
        await checkpointSiyuanIndexJob({job:replacement},{forceStatus:true});
        return replacement;
      }
      return current;
    });
    await expect(createSiyuanContextMapIntegration(port()).sync(record.projectId,record,oneFileOptions(record))).rejects.toThrow('siyuan_index_job_changed');
    const job=(await originalRead(record.projectId,record.id))!;
    expect(replaced).toBe(true);expect(job.startedAt).toBe(replacementStartedAt);
    expect(job.reconciledAt).toBeNull();expect(siyuanOverallProgressPercent(job)).not.toBe(100);
  });

  it.each(['pending','count','frontier','failed'] as const)('refuses final durable %s drift before fresh completion',async drift=>{
    const record={...map(),id:`c06-final-${drift}`};const originalRead=indexJobStore.readSiyuanIndexJob;let changed=false;
    vi.spyOn(indexJobStore,'readSiyuanIndexJob').mockImplementation(async(projectId,mapId)=>{
      const current=await originalRead(projectId,mapId);
      if(!changed && mapId===record.id && current?.status==='running' && current.createdNodes===1 && current.pendingNativeNodeIds.length===0) {
        changed=true;const next={...current};
        if(drift==='pending')next.pendingNativeNodeIds=['awaiting-native-ack'];
        if(drift==='count')next.createdNodes=0;
        if(drift==='frontier')next.frontierLength=current.cursor+1;
        if(drift==='failed')next.failed=1;
        await checkpointSiyuanIndexJob({job:next},{forceStatus:true});return next;
      }
      return current;
    });
    await expect(createSiyuanContextMapIntegration(port()).sync(record.projectId,record,oneFileOptions(record))).rejects.toThrow('siyuan_native_node_reconciliation_incomplete');
    const job=(await originalRead(record.projectId,record.id))!;
    expect(changed).toBe(true);expect(job.reconciledAt).toBeNull();expect(job.completedAt).toBeNull();
    expect(siyuanOverallProgressPercent(job)).not.toBe(100);
  });

  it.each(['generation','pending'] as const)('refuses %s replacement between final read and terminal checkpoint commit',async drift=>{
    const record={...map(),id:`c06-commit-${drift}`};const originalCheckpoint=indexJobStore.checkpointSiyuanIndexJob;
    let changed=false;let replacementStartedAt=0;
    vi.spyOn(indexJobStore,'checkpointSiyuanIndexJob').mockImplementation(async(checkpoint,options)=>{
      if(!changed && checkpoint.job.mapId===record.id && checkpoint.job.phase==='completed') {
        changed=true;const current=(await readSiyuanIndexJob(record.projectId,record.id))!;
        const replacement={...current};
        if(drift==='generation')replacement.startedAt++;
        else replacement.pendingNativeNodeIds=['new-pending-after-final-read'];
        replacementStartedAt=replacement.startedAt;
        await originalCheckpoint({job:replacement},{forceStatus:true});
      }
      return originalCheckpoint(checkpoint,options);
    });
    await expect(createSiyuanContextMapIntegration(port()).sync(record.projectId,record,oneFileOptions(record))).rejects.toThrow();
    const job=(await readSiyuanIndexJob(record.projectId,record.id))!;
    expect(changed).toBe(true);expect(job.startedAt).toBe(replacementStartedAt);
    if(drift==='pending')expect(job.pendingNativeNodeIds).toEqual(['new-pending-after-final-read']);
    expect(job.reconciledAt).toBeNull();expect(job.completedAt).toBeNull();
    expect(siyuanOverallProgressPercent(job)).not.toBe(100);
  });

  it('refuses cancellation during the final durable read before publication',async()=>{
    const record={...map(),id:'c06-final-read-abort'};const originalRead=indexJobStore.readSiyuanIndexJob;const controller=new AbortController();
    let interrupted=false;
    vi.spyOn(indexJobStore,'readSiyuanIndexJob').mockImplementation(async(projectId,mapId)=>{
      const current=await originalRead(projectId,mapId);
      if(!interrupted && mapId===record.id && current?.status==='running' && current.createdNodes===1 && current.pendingNativeNodeIds.length===0) {
        interrupted=true;controller.abort('fixture_final_read_revoked');
      }
      return current;
    });
    await expect(createSiyuanContextMapIntegration(port()).sync(record.projectId,record,{...oneFileOptions(record),signal:controller.signal})).rejects.toThrow();
    const job=(await originalRead(record.projectId,record.id))!;
    expect(interrupted).toBe(true);expect(job.reconciledAt).toBeNull();expect(job.completedAt).toBeNull();
    expect(siyuanOverallProgressPercent(job)).not.toBe(100);
    expect(readSiyuanMapManifest(record.projectId,record.id)?.status).not.toBe('ready');
  });
});
