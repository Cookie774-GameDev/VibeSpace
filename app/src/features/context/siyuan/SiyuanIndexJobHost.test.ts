import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ContextMapRecord } from '../tree';
import { createSiyuanIndexJob } from './siyuanIndexJobStore';
import { createSiyuanMapManifest } from './siyuanMapManifest';
import { siyuanIndexPolicyFingerprint } from './siyuanSafeIndex';
import {
  classifySiyuanStartupMaps,
  resumableSiyuanMaps,
  retryRunningSiyuanJob,
  runSiyuanStartupResume,
  siyuanResumeFailureReason,
} from './SiyuanIndexJobHost';

function map(id: string, status: ContextMapRecord['status'] = 'active'): ContextMapRecord {
  return {
    id,
    projectId: 'project-1',
    rootDir: 'C:/root',
    name: id,
    status,
    createdAt: 1,
    updatedAt: 1,
    sourceType: 'local_folder',
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

function manifestFor(mapRecord: ContextMapRecord) {
  return createSiyuanMapManifest(mapRecord, 'project-1');
}

function runningJob(mapRecord: ContextMapRecord) {
  const manifest = manifestFor(mapRecord);
  return createSiyuanIndexJob({
    accountId: 'account-1',
    projectId: 'project-1',
    mapId: mapRecord.id,
    canonicalRoot: mapRecord.rootDir,
    policyFingerprint: siyuanIndexPolicyFingerprint(
      mapRecord.rootDir,
      manifest.summaryPolicy,
      manifest.sourcePolicy.excludedPaths,
    ),
  });
}

describe('SiYuan durable startup host', () => {
  it('keeps native string rejection reasons in checkpoint repair diagnostics', () => {
    expect(siyuanResumeFailureReason('siyuan_document_create_failed')).toBe(
      'siyuan_document_create_failed',
    );
    expect(siyuanResumeFailureReason(new Error('siyuan_parent_missing'))).toBe(
      'siyuan_parent_missing',
    );
    expect(siyuanResumeFailureReason(null)).toBe('siyuan_resume_failed');
  });
  it('threads the active workspace into automatic summary resume authority', () => {
    const source = readFileSync(
      resolve('src/features/context/siyuan/SiyuanIndexJobHost.tsx'),
      'utf8',
    );
    expect(source).toContain('const workspaceId = useAuthStore((state) => state.workspaceId)');
    expect(source).toContain('!workspaceId ||');
    expect(source).toContain('workspaceId,');
    expect(source).toContain('}, [accountId, projectId, workspaceId]);');
  });

  it('retries a transient startup failure while the durable job remains running', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('siyuan_runtime_unavailable'))
      .mockResolvedValue('ready');
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryRunningSiyuanJob({
        run,
        isRunning: async () => true,
        sleep,
        retryDelayMs: 25,
        maxAttempts: 2,
      }),
    ).resolves.toBe('ready');
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('does not retry after the durable job stops running', async () => {
    const run = vi.fn(async () => {
      throw new Error('siyuan_runtime_unavailable');
    });
    await expect(
      retryRunningSiyuanJob({
        run,
        isRunning: async () => false,
        sleep: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('siyuan_runtime_unavailable');
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not start work for an already aborted host scope', async () => {
    const controller = new AbortController();
    controller.abort('scope_changed');
    const run = vi.fn(async () => 'unexpected');
    await expect(
      retryRunningSiyuanJob({
        run,
        isRunning: async () => true,
        signal: controller.signal,
      }),
    ).rejects.toThrow('siyuan_index_cancelled');
    expect(run).not.toHaveBeenCalled();
  });

  it('leaves a retry delay immediately when the host scope is aborted', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      throw new Error('siyuan_runtime_unavailable');
    });
    const sleepingForever = vi.fn(() => new Promise<void>(() => undefined));
    const pending = retryRunningSiyuanJob({
      run,
      isRunning: async () => true,
      sleep: sleepingForever,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(sleepingForever).toHaveBeenCalledOnce());
    controller.abort('scope_changed');

    await expect(pending).rejects.toThrow('siyuan_index_cancelled');
    expect(run).toHaveBeenCalledOnce();
  });

  it('durably marks auto-resume before work and repair after exhausted retries', async () => {
    const dispositions: string[] = [];
    let status: 'running' | 'failed' = 'running';
    const markDisposition = vi.fn(async (_projectId, _mapId, disposition) => {
      dispositions.push(disposition);
      if (disposition === 'needs_repair') status = 'failed';
      return null;
    });
    await expect(
      runSiyuanStartupResume({
        projectId: 'project-1',
        mapId: 'map-1',
        run: async () => {
          throw new Error('siyuan_runtime_unavailable');
        },
        isRunning: async () => status === 'running',
        markDisposition,
        sleep: async () => undefined,
        retryDelayMs: 0,
        maxAttempts: 1,
      }),
    ).rejects.toThrow('siyuan_runtime_unavailable');
    expect(dispositions).toEqual(['auto_resumed', 'needs_repair']);
    expect(status).toBe('failed');
  });

  it('marks repair when integration fails the job before startup retry unwinds', async () => {
    const dispositions: string[] = [];
    let status: 'running' | 'failed' = 'running';
    await expect(
      runSiyuanStartupResume({
        projectId: 'project-1',
        mapId: 'map-1',
        run: async () => {
          status = 'failed';
          throw new Error('siyuan_native_block_recovery_inconclusive');
        },
        isRunning: async () => status === 'running',
        shouldMarkNeedsRepair: async () => status === 'running' || status === 'failed',
        markDisposition: async (_projectId, _mapId, disposition) => {
          dispositions.push(disposition);
          return null;
        },
        maxAttempts: 1,
      }),
    ).rejects.toThrow('siyuan_native_block_recovery_inconclusive');

    expect(status).toBe('failed');
    expect(dispositions).toEqual(['auto_resumed', 'needs_repair']);
  });

  it('binds an exhausted startup repair to the exact auto-resume attempt', async () => {
    const expectedGuards: unknown[] = [];
    const started = {
      ...createSiyuanIndexJob({
        projectId: 'project-1',
        mapId: 'map-1',
        canonicalRoot: 'C:/root',
        policyFingerprint: 'policy-a',
        now: 100,
      }),
      startupDisposition: 'auto_resumed' as const,
      startupDispositionAt: 200,
    };
    await expect(
      runSiyuanStartupResume({
        projectId: 'project-1',
        mapId: 'map-1',
        run: async () => {
          throw new Error('siyuan_runtime_unavailable');
        },
        isRunning: async () => true,
        markDisposition: async (_projectId, _mapId, disposition, _now, expected) => {
          if (disposition === 'auto_resumed') return started;
          expectedGuards.push(expected);
          return started;
        },
        maxAttempts: 1,
      }),
    ).rejects.toThrow('siyuan_runtime_unavailable');

    expect(expectedGuards).toEqual([
      { disposition: 'auto_resumed', dispositionAt: 200 },
    ]);
  });

  it('resumes only matching-account active local maps with running jobs', () => {
    const maps = [map('map-1'), map('map-2'), map('map-3')];
    const running = runningJob(maps[0]!);
    const otherAccount = { ...running, mapId: 'map-2', accountId: 'account-2' };
    const paused = { ...running, mapId: 'map-3', status: 'paused' as const };
    expect(
      resumableSiyuanMaps({
        accountId: 'account-1',
        projectId: 'project-1',
        jobs: [running, otherAccount, paused],
        maps,
        manifestForMap: manifestFor,
      }).map((item) => item.id),
    ).toEqual(['map-1']);
  });

  it.each(['discovering', 'creating_nodes', 'summarizing', 'reconciling'] as const)(
    'selects an authority-matching running %s checkpoint for startup resume',
    (phase) => {
      const current = map(`map-${phase}`);
      const running = { ...runningJob(current), phase };

      expect(
        resumableSiyuanMaps({
          accountId: 'account-1',
          projectId: 'project-1',
          jobs: [running],
          maps: [current],
          manifestForMap: manifestFor,
        }).map((item) => item.id),
      ).toEqual([current.id]);
    },
  );

  it.each(['paused', 'cancelled', 'failed', 'completed'] as const)(
    'never auto-resumes a %s checkpoint in any phase',
    (status) => {
      const current = map(`map-${status}`);
      const durable = {
        ...runningJob(current),
        phase: status === 'completed' ? ('completed' as const) : ('creating_nodes' as const),
        status,
      };

      expect(
        resumableSiyuanMaps({
          accountId: 'account-1',
          projectId: 'project-1',
          jobs: [durable],
          maps: [current],
          manifestForMap: manifestFor,
        }),
      ).toEqual([]);
    },
  );

  it('never resumes recycled maps or cancelled jobs', () => {
    const deleted = map('map-1', 'deleted');
    const running = runningJob(map('map-1'));
    expect(
      resumableSiyuanMaps({
        accountId: 'account-1',
        projectId: 'project-1',
        jobs: [{ ...running, status: 'cancelled' }],
        maps: [deleted],
        manifestForMap: manifestFor,
      }),
    ).toEqual([]);
  });

  it('blocks stale root and policy jobs before startup sync is selected', () => {
    const current = map('map-1');
    const running = runningJob(current);
    expect(
      resumableSiyuanMaps({
        accountId: 'account-1',
        projectId: 'project-1',
        jobs: [{ ...running, canonicalRoot: 'C:/other' }],
        maps: [current],
        manifestForMap: manifestFor,
      }),
    ).toEqual([]);
    expect(
      resumableSiyuanMaps({
        accountId: 'account-1',
        projectId: 'project-1',
        jobs: [{ ...running, policyFingerprint: 'stale-policy' }],
        maps: [current],
        manifestForMap: manifestFor,
      }),
    ).toEqual([]);
  });

  it('classifies same-account stale authority for repair and leaves paused jobs untouched', () => {
    const current = map('map-1');
    const pausedMap = map('map-2');
    const running = runningJob(current);
    const paused = { ...runningJob(pausedMap), status: 'paused' as const };
    const result = classifySiyuanStartupMaps({
      accountId: 'account-1',
      projectId: 'project-1',
      jobs: [{ ...running, policyFingerprint: 'stale-policy' }, paused],
      maps: [current, pausedMap],
      manifestForMap: manifestFor,
    });
    expect(result.resumable).toEqual([]);
    expect(result.needsRepair.map((item) => item.id)).toEqual(['map-1']);
  });
});
