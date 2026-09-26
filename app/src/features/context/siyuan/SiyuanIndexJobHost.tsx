import * as React from 'react';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { ensureContextPersistence } from '../contextPersistence';
import type { ContextMapRecord } from '../tree';
import { productionSiyuanContextMaps } from '../siyuanContextMapIntegration';
import { devConsole } from '@/features/dev-console';
import {
  listSiyuanIndexJobs,
  readSiyuanIndexJob,
  setSiyuanIndexJobStartupDisposition,
  type SiyuanIndexJobRecord,
} from './siyuanIndexJobStore';
import { createDurableSiyuanIndexJobControl } from './siyuanSafeIndex';
import { readSiyuanMapManifest, type SiyuanMapManifest } from './siyuanMapManifest';
import { canResumeSiyuanMapJob } from './siyuanSurfaceAvailability';

const DEFAULT_STARTUP_RETRY_MS = 2_000;
const DEFAULT_STARTUP_ATTEMPTS = 4;

export function siyuanResumeFailureReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'siyuan_resume_failed';
}

export async function retryRunningSiyuanJob<T>(options: {
  run: () => Promise<T>;
  isRunning: () => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number) => void;
}): Promise<T> {
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_STARTUP_ATTEMPTS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_STARTUP_RETRY_MS);
  const waitForRetry = async (milliseconds: number) => {
    if (!options.signal) {
      await sleep(milliseconds);
      return;
    }
    if (options.signal.aborted) throw new Error('siyuan_index_cancelled');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('siyuan_index_cancelled'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      void sleep(milliseconds)
        .then(resolve, reject)
        .finally(() => {
          options.signal?.removeEventListener('abort', onAbort);
        });
    });
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
    try {
      return await options.run();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || options.signal?.aborted || !(await options.isRunning())) {
        throw error;
      }
      options.onRetry?.(error, attempt);
      await waitForRetry(retryDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function runSiyuanStartupResume<T>(options: {
  projectId: string;
  mapId: string;
  run: () => Promise<T>;
  isRunning: () => Promise<boolean>;
  shouldMarkNeedsRepair?: () => Promise<boolean>;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  maxAttempts?: number;
  markDisposition?: typeof setSiyuanIndexJobStartupDisposition;
}): Promise<T> {
  const markDisposition = options.markDisposition ?? setSiyuanIndexJobStartupDisposition;
  const startupAttempt = await markDisposition(options.projectId, options.mapId, 'auto_resumed');
  try {
    return await retryRunningSiyuanJob({
      run: options.run,
      isRunning: options.isRunning,
      signal: options.signal,
      onRetry: options.onRetry,
      sleep: options.sleep,
      retryDelayMs: options.retryDelayMs,
      maxAttempts: options.maxAttempts,
    });
  } catch (error) {
    const shouldMarkNeedsRepair = options.shouldMarkNeedsRepair ?? options.isRunning;
    if (!options.signal?.aborted && (await shouldMarkNeedsRepair())) {
      await markDisposition(
        options.projectId,
        options.mapId,
        'needs_repair',
        Date.now(),
        startupAttempt?.startupDisposition === 'auto_resumed' &&
          startupAttempt.startupDispositionAt !== null
          ? {
              disposition: 'auto_resumed',
              dispositionAt: startupAttempt.startupDispositionAt,
            }
          : undefined,
      );
    }
    throw error;
  }
}

export function resumableSiyuanMaps(input: {
  accountId: string;
  projectId: string;
  jobs: readonly SiyuanIndexJobRecord[];
  maps: readonly ContextMapRecord[];
  manifestForMap: (map: ContextMapRecord) => SiyuanMapManifest | null;
}): ContextMapRecord[] {
  return classifySiyuanStartupMaps(input).resumable;
}

export function classifySiyuanStartupMaps(input: {
  accountId: string;
  projectId: string;
  jobs: readonly SiyuanIndexJobRecord[];
  maps: readonly ContextMapRecord[];
  manifestForMap: (map: ContextMapRecord) => SiyuanMapManifest | null;
}): { resumable: ContextMapRecord[]; needsRepair: ContextMapRecord[] } {
  const byId = new Map(input.maps.map((map) => [map.id, map]));
  const resumable: ContextMapRecord[] = [];
  const needsRepair: ContextMapRecord[] = [];
  for (const job of input.jobs) {
    if (
      job.projectId !== input.projectId ||
      job.status !== 'running' ||
      job.phase === 'completed' ||
      job.accountId !== input.accountId
    ) {
      continue;
    }
    const map = byId.get(job.mapId);
    if (!map || map.status !== 'active' || map.sourceType === 'github_repository') continue;
    const manifest = input.manifestForMap(map);
    if (canResumeSiyuanMapJob(map, manifest, job, input.accountId)) resumable.push(map);
    else needsRepair.push(map);
  }
  return { resumable, needsRepair };
}

export function SiyuanIndexJobHost() {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? null);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);

  React.useEffect(() => {
    if (
      !accountId ||
      !workspaceId ||
      !projectId ||
      typeof window === 'undefined' ||
      !('__TAURI_INTERNALS__' in window)
    ) {
      return;
    }
    let disposed = false;
    const controllers: AbortController[] = [];
    void Promise.all([ensureContextPersistence(projectId), listSiyuanIndexJobs(projectId)])
      .then(async ([persistence, jobs]) => {
        if (disposed || persistence.accountId !== accountId) return;
        const classified = classifySiyuanStartupMaps({
          accountId,
          projectId,
          jobs,
          maps: persistence.maps,
          manifestForMap: (map) => readSiyuanMapManifest(projectId, map.id),
        });
        await Promise.all(
          classified.needsRepair.map((map) =>
            setSiyuanIndexJobStartupDisposition(projectId, map.id, 'needs_repair'),
          ),
        );
        await Promise.allSettled(
          classified.resumable.map(async (map) => {
            const controller = new AbortController();
            controllers.push(controller);
            try {
              await runSiyuanStartupResume({
                projectId,
                mapId: map.id,
                signal: controller.signal,
                run: () =>
                  productionSiyuanContextMaps.sync(projectId, map, {
                    accountId,
                    workspaceId,
                    signal: controller.signal,
                    control: createDurableSiyuanIndexJobControl(projectId, map.id),
                  }),
                isRunning: async () =>
                  (await readSiyuanIndexJob(projectId, map.id))?.status === 'running',
                shouldMarkNeedsRepair: async () => {
                  const status = (await readSiyuanIndexJob(projectId, map.id))?.status;
                  return status === 'running' || status === 'failed';
                },
                onRetry: (error, attempt) =>
                  devConsole.log({
                    channel: 'ai',
                    level: 'warn',
                    message: 'SiYuan Context Map resume retry scheduled',
                    detail: {
                      mapId: map.id,
                      attempt,
                      reason: siyuanResumeFailureReason(error),
                    },
                  }),
              });
            } catch (error) {
              if (!controller.signal.aborted) {
                devConsole.log({
                  channel: 'ai',
                  level: 'error',
                  message: 'SiYuan Context Map resume needs repair',
                  detail: {
                    mapId: map.id,
                    reason: siyuanResumeFailureReason(error),
                  },
                });
              }
              throw error;
            }
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      controllers.forEach((controller) => controller.abort('siyuan_job_host_scope_changed'));
    };
  }, [accountId, projectId, workspaceId]);

  return null;
}
