import { describe, expect, it } from 'vitest';
import { createSiyuanIndexJob } from './siyuanIndexJobStore';
import { createSiyuanMapManifest, updateSiyuanMapManifest } from './siyuanMapManifest';
import { siyuanIndexPolicyFingerprint } from './siyuanSafeIndex';
import { canOpenPartialSiyuanSurface, canResumeSiyuanMapJob } from './siyuanSurfaceAvailability';
import type { ContextMapRecord } from '../tree';

function record(status: ContextMapRecord['status'] = 'active'): ContextMapRecord {
  return {
    id: 'map-1',
    projectId: 'project-1',
    rootDir: 'C:/root',
    name: 'Map',
    status,
    createdAt: 1,
    updatedAt: 1,
    tree: {
      version: 1,
      projectId: 'project-1',
      rootDir: 'C:/root',
      generatedAt: 1,
      model: 'siyuan-managed-v1',
      fileCount: 1,
      totalBytes: 1,
      summary: '',
      nodes: [],
    },
  };
}

function partialManifest(status: 'indexing' | 'paused' | 'error' = 'indexing') {
  return updateSiyuanMapManifest(createSiyuanMapManifest(record(), 'project-1'), {
    notebookId: 'notebook-1',
    rootDocumentId: 'document-1',
    status,
  });
}

function partialJob(status: 'running' | 'paused' | 'failed' = 'running') {
  return {
    ...createSiyuanIndexJob({
      accountId: 'account-1',
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: siyuanIndexPolicyFingerprint(
        'C:/root',
        partialManifest().summaryPolicy,
        partialManifest().sourcePolicy.excludedPaths,
      ),
    }),
    status,
    createdNodes: 1,
  };
}

describe('partial SiYuan surface availability', () => {
  it('opens an actively indexing graph as soon as structural nodes exist', () => {
    expect(
      canOpenPartialSiyuanSurface(record(), partialManifest(), partialJob(), 'account-1'),
    ).toBe(true);
  });

  it('keeps paused and failed partial graphs inspectable', () => {
    expect(
      canOpenPartialSiyuanSurface(
        record(),
        partialManifest('paused'),
        partialJob('paused'),
        'account-1',
      ),
    ).toBe(true);
    expect(
      canOpenPartialSiyuanSurface(
        record(),
        partialManifest('error'),
        partialJob('failed'),
        'account-1',
      ),
    ).toBe(true);
  });

  it('rejects missing identities, empty indexes, scope mismatches, and recycled maps', () => {
    expect(
      canOpenPartialSiyuanSurface(record(), partialManifest(), partialJob(), 'account-1'),
    ).toBe(true);
    expect(
      canOpenPartialSiyuanSurface(
        record(),
        updateSiyuanMapManifest(partialManifest(), { rootDocumentId: null }),
        partialJob(),
        'account-1',
      ),
    ).toBe(false);
    expect(
      canOpenPartialSiyuanSurface(
        record(),
        partialManifest(),
        { ...partialJob(), createdNodes: 0 },
        'account-1',
      ),
    ).toBe(false);
    expect(
      canOpenPartialSiyuanSurface(
        record(),
        partialManifest(),
        { ...partialJob(), mapId: 'map-2' },
        'account-1',
      ),
    ).toBe(false);
    expect(
      canOpenPartialSiyuanSurface(record('deleted'), partialManifest(), partialJob(), 'account-1'),
    ).toBe(false);
  });

  it('rejects stale source, policy, and account authority', () => {
    expect(
      canOpenPartialSiyuanSurface(
        { ...record(), rootDir: 'C:/other' },
        partialManifest(),
        partialJob(),
        'account-1',
      ),
    ).toBe(false);
    expect(
      canOpenPartialSiyuanSurface(
        record(),
        partialManifest(),
        { ...partialJob(), policyFingerprint: 'wrong' },
        'account-1',
      ),
    ).toBe(false);
    expect(
      canOpenPartialSiyuanSurface(record(), partialManifest(), partialJob(), 'account-2'),
    ).toBe(false);
  });

  it('authorizes automatic resume only for an exact running map scope', () => {
    expect(canResumeSiyuanMapJob(record(), partialManifest(), partialJob(), 'account-1')).toBe(
      true,
    );
    expect(
      canResumeSiyuanMapJob(
        record(),
        partialManifest(),
        { ...partialJob(), canonicalRoot: 'C:/other' },
        'account-1',
      ),
    ).toBe(false);
    expect(
      canResumeSiyuanMapJob(record(), partialManifest(), partialJob('paused'), 'account-1'),
    ).toBe(false);
  });
});

describe('N11 single-file surface authority',()=>{
  it('refuses legacy file scope and a checkpoint for another selected file',()=>{
    const scoped={...record(),sourceType:'local_file' as const,localFileScope:{version:1 as const,rootDir:'C:/root',filePath:'C:/root/selected.txt'}};
    const manifest=partialManifest();
    const matching={...partialJob(),policyFingerprint:siyuanIndexPolicyFingerprint(scoped.rootDir,manifest.summaryPolicy,manifest.sourcePolicy.excludedPaths,scoped.localFileScope)};
    expect(canOpenPartialSiyuanSurface(scoped,manifest,matching,'account-1')).toBe(true);
    expect(canOpenPartialSiyuanSurface({...scoped,localFileScope:undefined},manifest,matching,'account-1')).toBe(false);
    expect(canOpenPartialSiyuanSurface({...scoped,localFileScope:{...scoped.localFileScope,filePath:'C:/root/sibling.txt'}},manifest,matching,'account-1')).toBe(false);
  });
});
