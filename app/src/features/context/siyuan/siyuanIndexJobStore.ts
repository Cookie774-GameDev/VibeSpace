import type { SiyuanSafeIndexEntry } from './siyuanSafeIndex';
import type { EffortLabel } from '@/lib/ai/catalog/modelVariants';
import { canonicalSiyuanAuthorityRoot } from './siyuanPathAuthority';

const DATABASE_NAME = 'vibespace-siyuan-index-jobs';
const DATABASE_VERSION = 3;
const JOB_STORE = 'jobs';
const ENTRY_STORE = 'entries';
const FRONTIER_STORE = 'frontier';
const SUMMARY_USAGE_STORE = 'summary_usage';
const ARCHIVE_STORE = 'archives';
const SCOPE_INDEX = 'scope';

export type SiyuanIndexJobStatus = 'running' | 'paused' | 'cancelled' | 'failed' | 'completed';

export type SiyuanIndexJobPhase =
  | 'discovering'
  | 'creating_nodes'
  | 'summarizing'
  | 'reconciling'
  | 'completed';

export interface SiyuanIndexDirectory {
  path: string;
  relativePath: string;
  parentNodeId: string | null;
}

export interface SiyuanIndexJobRecord {
  schemaVersion: 1;
  scope: string;
  accountId: string | null;
  projectId: string;
  mapId: string;
  canonicalRoot: string;
  policyFingerprint: string;
  phase: SiyuanIndexJobPhase;
  status: SiyuanIndexJobStatus;
  pauseReason: 'user' | 'local_model_unavailable' | 'cloud_approval_required' | null;
  cursor: number;
  frontierLength: number;
  indexed: number;
  excluded: number;
  unreadable: number;
  summarized: number;
  summaryEligible: number;
  createdNodes: number;
  failed: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenProvenance: 'reported' | 'estimated' | 'none';
  summaryProviderId: string | null;
  summaryConnectionId: string | null;
  summaryModelId: string | null;
  summaryEffort?: EffortLabel | null;
  phaseStartedAt: number;
  rateSamples: Array<{ at: number; processed: number }>;
  discoverySamples: Array<{
    at: number;
    processed: number;
    frontierRemaining: number;
    discovered: number;
  }>;
  estimatedPercent: number | null;
  estimatedEtaSeconds: number | null;
  reconciledAt: number | null;
  pendingNativeNodeIds: string[];
  startupDisposition: 'auto_resumed' | 'needs_repair' | null;
  startupDispositionAt: number | null;
  pausedMs: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface StoredEntry extends SiyuanSafeIndexEntry {
  key: string;
  scope: string;
}

interface StoredDirectory extends SiyuanIndexDirectory {
  key: string;
  scope: string;
  position: number;
}

export interface SiyuanIndexCheckpoint {
  job: SiyuanIndexJobRecord;
  appendedEntries?: readonly SiyuanSafeIndexEntry[];
  appendedDirectories?: readonly SiyuanIndexDirectory[];
  summaryUsage?: SiyuanSummaryUsageBatch;
}

export interface SiyuanSummaryUsageBatch {
  /** Present for the new multi-file executor; one aggregate receipt per batch. */
  batchId?: string;
  requestId?: string;
  sessionId?: string;
  nodeCount?: number;
  policyFingerprint?: string;
  lane?: number;
  attempt?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheProvenance?: 'reported' | 'unavailable';
  costUsd?: number | null;
  costProvenance?: 'reported' | 'unavailable';
  dispatchedAt?: number;
  durationMs?: number;
  nodeId: string;
  sourceModifiedAt: number | null;
  sourceSizeBytes: number | null;
  providerId: string;
  connectionId: string;
  modelId: string;
  effort?: EffortLabel;
  effortProvenance?: 'requested';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  provenance: 'reported' | 'estimated';
  completedAt: number;
}

export interface SiyuanIndexJobArchive {
  scope: string;
  archivedAt: number;
  job: SiyuanIndexJobRecord;
  entries: SiyuanSafeIndexEntry[];
  frontier: SiyuanIndexDirectory[];
  summaryUsage: SiyuanSummaryUsageBatch[];
}

interface StoredSummaryUsage extends SiyuanSummaryUsageBatch {
  key: string;
  scope: string;
}

export async function checkpointSiyuanSummaryBatchNode(input: {
  projectId: string;
  mapId: string;
  entry: SiyuanSafeIndexEntry;
  batchUsage?: SiyuanSummaryUsageBatch;
  now?: number;
}): Promise<SiyuanIndexJobRecord> {
  const database = await openDatabase();
  if (!database) throw new Error('siyuan_index_job_storage_unavailable');
  const scope = siyuanIndexJobScope(input.projectId, input.mapId);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('siyuan_summary_batch_now_invalid');
  if (input.entry.summaryState !== 'completed' || !input.entry.summary?.trim()) {
    throw new Error('siyuan_summary_batch_entry_invalid');
  }
  try {
    const transaction = database.transaction(
      [JOB_STORE, ENTRY_STORE, SUMMARY_USAGE_STORE],
      'readwrite',
    );
    const done = transactionDone(transaction);
    const jobStore = transaction.objectStore(JOB_STORE);
    const entryStore = transaction.objectStore(ENTRY_STORE);
    const usageStore = transaction.objectStore(SUMMARY_USAGE_STORE);
    const current = (await requestResult(jobStore.get(scope))) as SiyuanIndexJobRecord | undefined;
    if (!current) throw new Error('siyuan_index_job_not_found');
    if (current.status === 'paused') throw new Error('siyuan_index_paused');
    if (current.status === 'cancelled') throw new Error('siyuan_index_cancelled');
    if (current.status !== 'running' || current.phase !== 'summarizing') {
      throw new Error('siyuan_summary_batch_job_state_invalid');
    }
    if (now < current.updatedAt) throw new Error('siyuan_summary_batch_clock_regression');
    const storedEntry = (await requestResult(
      entryStore.get(entryKey(scope, input.entry.nodeId)),
    )) as StoredEntry | undefined;
    const isNewCompletion = storedEntry?.summaryState !== 'completed';
    let addInput = 0;
    let addOutput = 0;
    let addTotal = 0;
    let nextProvenance = current.tokenProvenance;
    if (input.batchUsage) {
      if (!input.batchUsage.batchId) throw new Error('siyuan_summary_batch_id_missing');
      if (!input.batchUsage.requestId?.trim() || !input.batchUsage.sessionId?.trim()) {
        throw new Error('siyuan_summary_batch_completion_evidence_missing');
      }
      if (input.batchUsage.policyFingerprint !== current.policyFingerprint) {
        throw new Error('siyuan_summary_batch_policy_mismatch');
      }
      if (
        input.batchUsage.providerId !== current.summaryProviderId ||
        input.batchUsage.connectionId !== current.summaryConnectionId ||
        input.batchUsage.modelId !== current.summaryModelId ||
        (input.batchUsage.effort ?? 'minimal') !== (current.summaryEffort ?? 'minimal')
      ) {
        throw new Error('siyuan_summary_model_identity_mismatch');
      }
      for (const [field, value] of [
        ['input_tokens', input.batchUsage.inputTokens],
        ['output_tokens', input.batchUsage.outputTokens],
        ['total_tokens', input.batchUsage.totalTokens],
        ['node_count', input.batchUsage.nodeCount],
        ['lane', input.batchUsage.lane],
        ['attempt', input.batchUsage.attempt],
        ['cache_read_tokens', input.batchUsage.cacheReadTokens],
        ['cache_write_tokens', input.batchUsage.cacheWriteTokens],
        ['dispatched_at', input.batchUsage.dispatchedAt],
        ['duration_ms', input.batchUsage.durationMs],
        ['completed_at', input.batchUsage.completedAt],
      ] as const) {
        if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
          throw new Error(`siyuan_summary_batch_${field}_invalid`);
        }
      }
      if (
        input.batchUsage.nodeCount === 0 ||
        input.batchUsage.lane! > 4 ||
        !['reported', 'estimated'].includes(input.batchUsage.provenance) ||
        !['reported', 'unavailable'].includes(input.batchUsage.cacheProvenance ?? '') ||
        !['reported', 'unavailable'].includes(input.batchUsage.costProvenance ?? '') ||
        (input.batchUsage.cacheProvenance === 'unavailable' &&
          (input.batchUsage.cacheReadTokens !== 0 || input.batchUsage.cacheWriteTokens !== 0)) ||
        (input.batchUsage.costProvenance === 'reported') !==
          (typeof input.batchUsage.costUsd === 'number' &&
            Number.isFinite(input.batchUsage.costUsd) &&
            input.batchUsage.costUsd >= 0) ||
        input.batchUsage.dispatchedAt! > input.batchUsage.completedAt ||
        input.batchUsage.completedAt > now ||
        input.batchUsage.durationMs !==
          input.batchUsage.completedAt - input.batchUsage.dispatchedAt!
      ) {
        throw new Error('siyuan_summary_batch_usage_metadata_invalid');
      }
      const usageKey = `${scope}\u0000batch\u0000${input.batchUsage.batchId}`;
      const existingUsage = (await requestResult(usageStore.get(usageKey))) as
        | StoredSummaryUsage
        | undefined;
      if (!existingUsage) {
        addInput = input.batchUsage.inputTokens;
        addOutput = input.batchUsage.outputTokens;
        addTotal = input.batchUsage.totalTokens;
        if (addInput + addOutput !== addTotal) {
          throw new Error('siyuan_summary_batch_total_tokens_invalid');
        }
        if (current.tokenProvenance === 'reported' && input.batchUsage.provenance === 'estimated') {
          throw new Error('siyuan_summary_token_provenance_mismatch');
        }
        nextProvenance =
          current.tokenProvenance === 'estimated' ? 'estimated' : input.batchUsage.provenance;
        usageStore.put({
          ...input.batchUsage,
          key: usageKey,
          scope,
        } satisfies StoredSummaryUsage);
      }
    }
    const nextInput = current.inputTokens + addInput;
    const nextOutput = current.outputTokens + addOutput;
    const nextTotal = current.totalTokens + addTotal;
    if (![nextInput, nextOutput, nextTotal].every(Number.isSafeInteger)) {
      throw new Error('siyuan_summary_batch_usage_overflow');
    }
    const updated: SiyuanIndexJobRecord = {
      ...current,
      summarized: current.summarized + (isNewCompletion ? 1 : 0),
      failed: Math.max(
        0,
        current.failed - (isNewCompletion && storedEntry?.summaryState === 'failed' ? 1 : 0),
      ),
      inputTokens: nextInput,
      outputTokens: nextOutput,
      totalTokens: nextTotal,
      tokenProvenance: nextProvenance,
      updatedAt: Math.max(current.updatedAt, now),
      rateSamples: isNewCompletion
        ? [...current.rateSamples, { at: now, processed: current.summarized + 1 }].slice(-20)
        : current.rateSamples,
      estimatedPercent: Math.max(
        current.estimatedPercent ?? 0,
        current.summaryEligible > 0
          ? 90 + ((current.summarized + (isNewCompletion ? 1 : 0)) / current.summaryEligible) * 8
          : 90,
      ),
    };
    entryStore.put({
      ...input.entry,
      key: entryKey(scope, input.entry.nodeId),
      scope,
    } satisfies StoredEntry);
    jobStore.put(updated);
    await done;
    return updated;
  } finally {
    database.close();
  }
}

export function resetSiyuanSummaryEntry(entry: SiyuanSafeIndexEntry): SiyuanSafeIndexEntry {
  const { summaryState: _summaryState, ...withoutSummaryState } = entry;
  return { ...withoutSummaryState, summary: null };
}

function normalizeSiyuanPauseReason(value: unknown): SiyuanIndexJobRecord['pauseReason'] {
  return value === 'user' ||
    value === 'local_model_unavailable' ||
    value === 'cloud_approval_required'
    ? value
    : null;
}

function isSafeCloudSummaryRestartPauseReason(
  reason: SiyuanIndexJobRecord['pauseReason'],
): boolean {
  return (
    reason === 'user' ||
    reason === 'local_model_unavailable' ||
    reason === 'cloud_approval_required'
  );
}

export function siyuanIndexJobScope(projectId: string, mapId: string): string {
  return `${projectId}\u0000${mapId}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('siyuan_index_job_request_failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('siyuan_index_job_transaction_aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('siyuan_index_job_transaction_failed'));
  });
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(JOB_STORE)) {
      database.createObjectStore(JOB_STORE, { keyPath: 'scope' });
    }
    if (!database.objectStoreNames.contains(ARCHIVE_STORE)) {
      database.createObjectStore(ARCHIVE_STORE, { keyPath: 'scope' });
    }
    for (const name of [ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE]) {
      const store = database.objectStoreNames.contains(name)
        ? request.transaction!.objectStore(name)
        : database.createObjectStore(name, { keyPath: 'key' });
      if (!store.indexNames.contains(SCOPE_INDEX)) {
        store.createIndex(SCOPE_INDEX, 'scope', { unique: false });
      }
    }
  };
  return requestResult(request);
}

function entryKey(scope: string, nodeId: string): string {
  return `${scope}\u0000${nodeId}`;
}

function frontierKey(scope: string, position: number): string {
  return `${scope}\u0000${position.toString().padStart(12, '0')}`;
}

async function clearScopeInTransaction(
  transaction: IDBTransaction,
  storeName: string,
  scope: string,
): Promise<void> {
  const store = transaction.objectStore(storeName);
  const request = store.index(SCOPE_INDEX).openKeyCursor(IDBKeyRange.only(scope));
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('siyuan_index_scope_clear_failed'));
  });
}

export function createSiyuanIndexJob(input: {
  accountId?: string | null;
  projectId: string;
  mapId: string;
  canonicalRoot: string;
  policyFingerprint: string;
  now?: number;
}): SiyuanIndexJobRecord {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: 1,
    scope: siyuanIndexJobScope(input.projectId, input.mapId),
    accountId: input.accountId ?? null,
    projectId: input.projectId,
    mapId: input.mapId,
    canonicalRoot: input.canonicalRoot,
    policyFingerprint: input.policyFingerprint,
    phase: 'discovering',
    status: 'running',
    pauseReason: null,
    cursor: 0,
    frontierLength: 1,
    indexed: 0,
    excluded: 0,
    unreadable: 0,
    summarized: 0,
    summaryEligible: 0,
    createdNodes: 0,
    failed: 0,
    skipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenProvenance: 'none',
    summaryProviderId: null,
    summaryConnectionId: null,
    summaryModelId: null,
    phaseStartedAt: now,
    rateSamples: [{ at: now, processed: 0 }],
    discoverySamples: [],
    estimatedPercent: null,
    estimatedEtaSeconds: null,
    reconciledAt: null,
    pendingNativeNodeIds: [],
    startupDisposition: null,
    startupDispositionAt: null,
    pausedMs: 0,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

export function accountForSiyuanRendererOfflineTime(
  job: SiyuanIndexJobRecord,
  rendererStartedAt: number,
  now = Date.now(),
): SiyuanIndexJobRecord {
  const offlineBoundary = Math.min(now, rendererStartedAt);
  const offlineMs = Math.max(0, offlineBoundary - job.updatedAt);
  return {
    ...job,
    pausedMs: job.pausedMs + offlineMs,
    updatedAt: now,
    rateSamples: offlineMs > 0 ? [] : job.rateSamples,
  };
}

export async function replaceSiyuanIndexJob(
  job: SiyuanIndexJobRecord,
  initialDirectory: SiyuanIndexDirectory,
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(
      [JOB_STORE, ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE],
      'readwrite',
    );
    await Promise.all([
      clearScopeInTransaction(transaction, ENTRY_STORE, job.scope),
      clearScopeInTransaction(transaction, FRONTIER_STORE, job.scope),
      clearScopeInTransaction(transaction, SUMMARY_USAGE_STORE, job.scope),
    ]);
    transaction.objectStore(JOB_STORE).put(job);
    transaction.objectStore(FRONTIER_STORE).put({
      ...initialDirectory,
      key: frontierKey(job.scope, 0),
      scope: job.scope,
      position: 0,
    } satisfies StoredDirectory);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

/** Repair only an unchanged, empty discovery checkpoint; never clear indexed evidence. */
export async function repairEmptySiyuanDiscoveryCheckpoint(
  expected: SiyuanIndexJobRecord,
  canonicalRoot: string,
  policyFingerprint: string,
  signal?: AbortSignal,
): Promise<SiyuanIndexJobRecord> {
  if (signal?.aborted) throw new Error('siyuan_index_cancelled');
  const scope = siyuanIndexJobScope(expected.projectId, expected.mapId);
  if (
    expected.scope !== scope ||
    canonicalSiyuanAuthorityRoot(expected.canonicalRoot) !==
      canonicalSiyuanAuthorityRoot(canonicalRoot)
  ) {
    throw new Error('siyuan_index_resume_authority_mismatch');
  }
  const database = await openDatabase();
  if (!database) throw new Error('siyuan_index_job_storage_unavailable');
  const transaction = database.transaction(
    [JOB_STORE, ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE],
    'readwrite',
  );
  const done = transactionDone(transaction);
  try {
    const [stored, frontier, entryCount, usageCount] = await Promise.all([
      requestResult(transaction.objectStore(JOB_STORE).get(scope)),
      requestResult(transaction.objectStore(FRONTIER_STORE).index(SCOPE_INDEX).getAll(scope)),
      requestResult(transaction.objectStore(ENTRY_STORE).index(SCOPE_INDEX).count(scope)),
      requestResult(transaction.objectStore(SUMMARY_USAGE_STORE).index(SCOPE_INDEX).count(scope)),
    ]);
    if (signal?.aborted) throw new Error('siyuan_index_cancelled');
    const current = stored as SiyuanIndexJobRecord | undefined;
    const directories = frontier as StoredDirectory[];
    const initial = directories[0];
    const unchanged =
      current &&
      (
        [
          'schemaVersion',
          'scope',
          'accountId',
          'projectId',
          'mapId',
          'canonicalRoot',
          'policyFingerprint',
          'updatedAt',
          'status',
        ] as const
      ).every((key) => current[key] === expected[key]);
    const empty =
      current &&
      (
        [
          'cursor',
          'indexed',
          'excluded',
          'unreadable',
          'createdNodes',
          'summarized',
          'summaryEligible',
          'failed',
          'skipped',
          'inputTokens',
          'outputTokens',
          'totalTokens',
        ] as const
      ).every((key) => current[key] === 0);
    if (
      !unchanged ||
      !empty ||
      current.status !== 'running' ||
      current.phase !== 'discovering' ||
      current.frontierLength !== 1 ||
      (current.pendingNativeNodeIds?.length ?? 0) !== 0 ||
      entryCount !== 0 ||
      usageCount !== 0 ||
      directories.length !== 1 ||
      !initial ||
      initial.position !== 0 ||
      initial.relativePath !== '' ||
      initial.parentNodeId !== null ||
      canonicalSiyuanAuthorityRoot(initial.path) !== canonicalSiyuanAuthorityRoot(canonicalRoot)
    ) {
      throw new Error('siyuan_index_checkpoint_changed');
    }
    const repaired = {
      ...current,
      canonicalRoot,
      policyFingerprint,
      updatedAt: Math.max(current.updatedAt, Date.now()),
    };
    transaction.objectStore(JOB_STORE).put(repaired);
    transaction.objectStore(FRONTIER_STORE).put({ ...initial, path: canonicalRoot });
    await done;
    return repaired;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* The transaction may already have completed. */
    }
    await done.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

export async function archiveAndReplaceSiyuanIndexJob(
  job: SiyuanIndexJobRecord,
  initialDirectory: SiyuanIndexDirectory,
  now = Date.now(),
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(
      [JOB_STORE, ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE, ARCHIVE_STORE],
      'readwrite',
    );
    const [currentJob, storedEntries, storedFrontier, storedUsage] = await Promise.all([
      requestResult(transaction.objectStore(JOB_STORE).get(job.scope)),
      requestResult(transaction.objectStore(ENTRY_STORE).index(SCOPE_INDEX).getAll(job.scope)),
      requestResult(transaction.objectStore(FRONTIER_STORE).index(SCOPE_INDEX).getAll(job.scope)),
      requestResult(
        transaction.objectStore(SUMMARY_USAGE_STORE).index(SCOPE_INDEX).getAll(job.scope),
      ),
    ]);
    if (currentJob) {
      transaction.objectStore(ARCHIVE_STORE).put({
        scope: job.scope,
        archivedAt: now,
        job: currentJob as SiyuanIndexJobRecord,
        entries: (storedEntries as StoredEntry[]).map(
          ({ key: _key, scope: _scope, ...entry }) => entry,
        ),
        frontier: (storedFrontier as StoredDirectory[])
          .sort((left, right) => left.position - right.position)
          .map(({ key: _key, scope: _scope, position: _position, ...directory }) => directory),
        summaryUsage: (storedUsage as StoredSummaryUsage[]).map(
          ({ key: _key, scope: _scope, ...usage }) => usage,
        ),
      } satisfies SiyuanIndexJobArchive);
    }
    await Promise.all([
      clearScopeInTransaction(transaction, ENTRY_STORE, job.scope),
      clearScopeInTransaction(transaction, FRONTIER_STORE, job.scope),
      clearScopeInTransaction(transaction, SUMMARY_USAGE_STORE, job.scope),
    ]);
    transaction.objectStore(JOB_STORE).put(job);
    transaction.objectStore(FRONTIER_STORE).put({
      ...initialDirectory,
      key: frontierKey(job.scope, 0),
      scope: job.scope,
      position: 0,
    } satisfies StoredDirectory);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function archiveAndRestartSiyuanSummaryJobForCloud(
  projectId: string,
  mapId: string,
  identity: Readonly<{
    providerId: string;
    connectionId: string;
    modelId: string;
    effort?: EffortLabel;
  }>,
  now = Date.now(),
): Promise<SiyuanIndexJobRecord> {
  if (
    !identity.providerId ||
    !identity.connectionId ||
    !identity.modelId ||
    identity.providerId === 'ollama' ||
    identity.providerId === 'local'
  ) {
    throw new Error('siyuan_cloud_summary_identity_invalid');
  }
  const database = await openDatabase();
  if (!database) throw new Error('siyuan_index_job_storage_unavailable');
  try {
    const scope = siyuanIndexJobScope(projectId, mapId);
    const transaction = database.transaction(
      [JOB_STORE, ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE, ARCHIVE_STORE],
      'readwrite',
    );
    const [storedJob, storedEntries, storedFrontier, storedUsage, storedArchive] =
      await Promise.all([
        requestResult(transaction.objectStore(JOB_STORE).get(scope)),
        requestResult(transaction.objectStore(ENTRY_STORE).index(SCOPE_INDEX).getAll(scope)),
        requestResult(transaction.objectStore(FRONTIER_STORE).index(SCOPE_INDEX).getAll(scope)),
        requestResult(
          transaction.objectStore(SUMMARY_USAGE_STORE).index(SCOPE_INDEX).getAll(scope),
        ),
        requestResult(transaction.objectStore(ARCHIVE_STORE).get(scope)),
      ]);
    const job = storedJob as SiyuanIndexJobRecord | undefined;
    if (!job) throw new Error('siyuan_index_job_missing');
    if (
      job.status !== 'paused' ||
      job.phase !== 'summarizing' ||
      !isSafeCloudSummaryRestartPauseReason(job.pauseReason)
    ) {
      throw new Error('siyuan_cloud_summary_restart_not_safe');
    }
    if (!storedArchive) {
      transaction.objectStore(ARCHIVE_STORE).put({
        scope,
        archivedAt: now,
        job,
        entries: (storedEntries as StoredEntry[]).map(
          ({ key: _key, scope: _scope, ...entry }) => entry,
        ),
        frontier: (storedFrontier as StoredDirectory[])
          .sort((left, right) => left.position - right.position)
          .map(({ key: _key, scope: _scope, position: _position, ...directory }) => directory),
        summaryUsage: (storedUsage as StoredSummaryUsage[]).map(
          ({ key: _key, scope: _scope, ...usage }) => usage,
        ),
      } satisfies SiyuanIndexJobArchive);
    }
    await clearScopeInTransaction(transaction, SUMMARY_USAGE_STORE, scope);
    for (const stored of storedEntries as StoredEntry[]) {
      const { key, scope: entryScope, ...entry } = stored;
      transaction.objectStore(ENTRY_STORE).put({
        ...resetSiyuanSummaryEntry(entry),
        key,
        scope: entryScope,
      } satisfies StoredEntry);
    }
    const restarted: SiyuanIndexJobRecord = {
      ...job,
      status: 'running',
      pauseReason: null,
      phase: 'summarizing',
      summaryProviderId: identity.providerId,
      summaryConnectionId: identity.connectionId,
      summaryModelId: identity.modelId,
      summaryEffort: identity.effort ?? 'auto',
      summarized: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenProvenance: 'none',
      startupDisposition: null,
      startupDispositionAt: null,
      phaseStartedAt: now,
      rateSamples: [{ at: now, processed: 0 }],
      updatedAt: now,
      completedAt: null,
    };
    transaction.objectStore(JOB_STORE).put(restarted);
    await transactionDone(transaction);
    return restarted;
  } finally {
    database.close();
  }
}

export async function resumeSiyuanSummaryJobWithSameCloudRoute(
  projectId: string,
  mapId: string,
  identity: Readonly<{
    providerId: string;
    connectionId: string;
    modelId: string;
    effort?: EffortLabel;
  }>,
  now = Date.now(),
): Promise<SiyuanIndexJobRecord> {
  const database = await openDatabase();
  if (!database) throw new Error('siyuan_index_job_storage_unavailable');
  try {
    const scope = siyuanIndexJobScope(projectId, mapId);
    const transaction = database.transaction([JOB_STORE], 'readwrite');
    const store = transaction.objectStore(JOB_STORE);
    const job = (await requestResult(store.get(scope))) as SiyuanIndexJobRecord | undefined;
    if (
      !job ||
      job.status !== 'paused' ||
      job.phase !== 'summarizing' ||
      !isSafeCloudSummaryRestartPauseReason(job.pauseReason)
    ) {
      throw new Error('siyuan_cloud_summary_resume_not_safe');
    }
    if (
      job.summaryProviderId !== identity.providerId ||
      job.summaryConnectionId !== identity.connectionId ||
      job.summaryModelId !== identity.modelId ||
      (job.summaryEffort ?? 'auto') !== (identity.effort ?? 'auto')
    ) {
      throw new Error('siyuan_cloud_summary_resume_identity_mismatch');
    }
    if (!Number.isSafeInteger(now) || now < job.updatedAt) {
      throw new Error('siyuan_summary_batch_clock_regression');
    }
    const resumed: SiyuanIndexJobRecord = {
      ...job,
      status: 'running',
      pauseReason: null,
      startupDisposition: null,
      startupDispositionAt: null,
      phaseStartedAt: now,
      pausedMs: job.pausedMs + Math.max(0, now - job.updatedAt),
      estimatedEtaSeconds: null,
      updatedAt: now,
      completedAt: null,
    };
    store.put(resumed);
    await transactionDone(transaction);
    return resumed;
  } finally {
    database.close();
  }
}

export async function archiveSiyuanSummaryJobForCloudRestart(
  projectId: string,
  mapId: string,
  now = Date.now(),
): Promise<SiyuanIndexJobArchive> {
  const database = await openDatabase();
  if (!database) throw new Error('siyuan_index_job_storage_unavailable');
  try {
    const scope = siyuanIndexJobScope(projectId, mapId);
    const transaction = database.transaction(
      [JOB_STORE, ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE, ARCHIVE_STORE],
      'readwrite',
    );
    const [storedJob, storedEntries, storedFrontier, storedUsage, storedArchive] =
      await Promise.all([
        requestResult(transaction.objectStore(JOB_STORE).get(scope)),
        requestResult(transaction.objectStore(ENTRY_STORE).index(SCOPE_INDEX).getAll(scope)),
        requestResult(transaction.objectStore(FRONTIER_STORE).index(SCOPE_INDEX).getAll(scope)),
        requestResult(
          transaction.objectStore(SUMMARY_USAGE_STORE).index(SCOPE_INDEX).getAll(scope),
        ),
        requestResult(transaction.objectStore(ARCHIVE_STORE).get(scope)),
      ]);
    const job = storedJob as SiyuanIndexJobRecord | undefined;
    if (
      !job ||
      job.status !== 'paused' ||
      job.phase !== 'summarizing' ||
      !isSafeCloudSummaryRestartPauseReason(job.pauseReason)
    ) {
      throw new Error('siyuan_cloud_summary_restart_not_safe');
    }
    const cleanupSnapshot: SiyuanIndexJobArchive = {
      scope,
      archivedAt: now,
      job: { ...job, pendingNativeNodeIds: job.pendingNativeNodeIds ?? [] },
      entries: (storedEntries as StoredEntry[]).map(
        ({ key: _key, scope: _scope, ...entry }) => entry,
      ),
      frontier: (storedFrontier as StoredDirectory[])
        .sort((left, right) => left.position - right.position)
        .map(({ key: _key, scope: _scope, position: _position, ...directory }) => directory),
      summaryUsage: (storedUsage as StoredSummaryUsage[]).map(
        ({ key: _key, scope: _scope, ...usage }) => usage,
      ),
    };
    if (!storedArchive) transaction.objectStore(ARCHIVE_STORE).put(cleanupSnapshot);
    await transactionDone(transaction);
    return cleanupSnapshot;
  } finally {
    database.close();
  }
}

export async function readSiyuanIndexJobArchive(
  projectId: string,
  mapId: string,
): Promise<SiyuanIndexJobArchive | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(ARCHIVE_STORE, 'readonly');
    const archive = await requestResult(
      transaction.objectStore(ARCHIVE_STORE).get(siyuanIndexJobScope(projectId, mapId)),
    );
    await transactionDone(transaction);
    const stored = archive as SiyuanIndexJobArchive | undefined;
    return stored
      ? {
          ...stored,
          job: {
            ...stored.job,
            pendingNativeNodeIds: stored.job.pendingNativeNodeIds ?? [],
          },
        }
      : null;
  } finally {
    database.close();
  }
}

export async function readSiyuanIndexJob(
  projectId: string,
  mapId: string,
): Promise<SiyuanIndexJobRecord | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(JOB_STORE, 'readonly');
    const result = await requestResult(
      transaction.objectStore(JOB_STORE).get(siyuanIndexJobScope(projectId, mapId)),
    );
    await transactionDone(transaction);
    const stored = result as (SiyuanIndexJobRecord & Partial<SiyuanIndexJobRecord>) | undefined;
    if (!stored) return null;
    const legacyDiscoveryCompletion = stored.createdNodes === undefined && stored.indexed > 0;
    return {
      ...stored,
      accountId: stored.accountId ?? null,
      phase: legacyDiscoveryCompletion ? 'creating_nodes' : stored.phase,
      status: legacyDiscoveryCompletion ? 'running' : stored.status,
      pauseReason: normalizeSiyuanPauseReason(stored.pauseReason),
      createdNodes: stored.createdNodes ?? 0,
      summaryEligible: stored.summaryEligible ?? 0,
      failed: stored.failed ?? 0,
      skipped: stored.skipped ?? 0,
      inputTokens: stored.inputTokens ?? 0,
      outputTokens: stored.outputTokens ?? 0,
      totalTokens: stored.totalTokens ?? 0,
      tokenProvenance: stored.tokenProvenance ?? 'none',
      summaryProviderId: stored.summaryProviderId ?? null,
      summaryConnectionId: stored.summaryConnectionId ?? null,
      summaryModelId: stored.summaryModelId ?? null,
      summaryEffort: stored.summaryEffort ?? null,
      phaseStartedAt: stored.phaseStartedAt ?? stored.updatedAt,
      rateSamples: stored.rateSamples ?? [],
      discoverySamples: stored.discoverySamples ?? [],
      estimatedPercent: stored.estimatedPercent ?? null,
      estimatedEtaSeconds: stored.estimatedEtaSeconds ?? null,
      reconciledAt: stored.reconciledAt ?? null,
      pendingNativeNodeIds: stored.pendingNativeNodeIds ?? [],
      startupDisposition: stored.startupDisposition ?? null,
      startupDispositionAt: stored.startupDispositionAt ?? null,
      pausedMs: stored.pausedMs ?? 0,
      completedAt: legacyDiscoveryCompletion ? null : stored.completedAt,
    };
  } finally {
    database.close();
  }
}

export async function listSiyuanIndexJobs(projectId?: string): Promise<SiyuanIndexJobRecord[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(JOB_STORE, 'readonly');
    const records = (await requestResult(transaction.objectStore(JOB_STORE).getAll())) as Array<
      SiyuanIndexJobRecord & Partial<SiyuanIndexJobRecord>
    >;
    await transactionDone(transaction);
    return records
      .filter((stored) => !projectId || stored.projectId === projectId)
      .map((stored) => ({
        ...stored,
        accountId: stored.accountId ?? null,
        pauseReason: normalizeSiyuanPauseReason(stored.pauseReason),
        createdNodes: stored.createdNodes ?? 0,
        summaryEligible: stored.summaryEligible ?? 0,
        failed: stored.failed ?? 0,
        skipped: stored.skipped ?? 0,
        inputTokens: stored.inputTokens ?? 0,
        outputTokens: stored.outputTokens ?? 0,
        totalTokens: stored.totalTokens ?? 0,
        tokenProvenance: stored.tokenProvenance ?? 'none',
        summaryProviderId: stored.summaryProviderId ?? null,
        summaryConnectionId: stored.summaryConnectionId ?? null,
        summaryModelId: stored.summaryModelId ?? null,
        summaryEffort: stored.summaryEffort ?? null,
        phaseStartedAt: stored.phaseStartedAt ?? stored.updatedAt,
        rateSamples: stored.rateSamples ?? [],
        discoverySamples: stored.discoverySamples ?? [],
        estimatedPercent: stored.estimatedPercent ?? null,
        estimatedEtaSeconds: stored.estimatedEtaSeconds ?? null,
        reconciledAt: stored.reconciledAt ?? null,
        pendingNativeNodeIds: stored.pendingNativeNodeIds ?? [],
        startupDisposition: stored.startupDisposition ?? null,
        startupDispositionAt: stored.startupDispositionAt ?? null,
        pausedMs: stored.pausedMs ?? 0,
        completedAt: stored.completedAt ?? null,
      }));
  } finally {
    database.close();
  }
}

export async function readSiyuanIndexFrontier(
  projectId: string,
  mapId: string,
): Promise<SiyuanIndexDirectory[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(FRONTIER_STORE, 'readonly');
    const records = (await requestResult(
      transaction
        .objectStore(FRONTIER_STORE)
        .index(SCOPE_INDEX)
        .getAll(siyuanIndexJobScope(projectId, mapId)),
    )) as StoredDirectory[];
    await transactionDone(transaction);
    return records
      .sort((left, right) => left.position - right.position)
      .map(({ path, relativePath, parentNodeId }) => ({ path, relativePath, parentNodeId }));
  } finally {
    database.close();
  }
}

export async function readSiyuanIndexEntries(
  projectId: string,
  mapId: string,
): Promise<SiyuanSafeIndexEntry[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(ENTRY_STORE, 'readonly');
    const records = (await requestResult(
      transaction
        .objectStore(ENTRY_STORE)
        .index(SCOPE_INDEX)
        .getAll(siyuanIndexJobScope(projectId, mapId)),
    )) as StoredEntry[];
    await transactionDone(transaction);
    return records.map(({ key: _key, scope: _scope, ...entry }) => entry);
  } finally {
    database.close();
  }
}

export async function readSiyuanSummaryUsage(
  projectId: string,
  mapId: string,
): Promise<SiyuanSummaryUsageBatch[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(SUMMARY_USAGE_STORE, 'readonly');
    const records = (await requestResult(
      transaction
        .objectStore(SUMMARY_USAGE_STORE)
        .index(SCOPE_INDEX)
        .getAll(siyuanIndexJobScope(projectId, mapId)),
    )) as StoredSummaryUsage[];
    await transactionDone(transaction);
    return records
      .sort((left, right) => left.completedAt - right.completedAt)
      .map(({ key: _key, scope: _scope, ...batch }) => batch);
  } finally {
    database.close();
  }
}

export async function replaceSiyuanIndexEntries(
  projectId: string,
  mapId: string,
  entries: readonly SiyuanSafeIndexEntry[],
  job?: SiyuanIndexJobRecord,
): Promise<SiyuanIndexJobRecord | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(
      job ? [ENTRY_STORE, JOB_STORE] : ENTRY_STORE,
      'readwrite',
    );
    const persistedJob = job
      ? protectSiyuanJobLifecycle(
          (await requestResult(
            transaction.objectStore(JOB_STORE).get(siyuanIndexJobScope(projectId, mapId)),
          )) as SiyuanIndexJobRecord | undefined,
          job,
        )
      : null;
    await clearScopeInTransaction(transaction, ENTRY_STORE, siyuanIndexJobScope(projectId, mapId));
    const store = transaction.objectStore(ENTRY_STORE);
    const scope = siyuanIndexJobScope(projectId, mapId);
    for (const entry of entries) {
      store.put({ ...entry, key: entryKey(scope, entry.nodeId), scope } satisfies StoredEntry);
    }
    if (persistedJob) transaction.objectStore(JOB_STORE).put(persistedJob);
    await transactionDone(transaction);
    return persistedJob;
  } finally {
    database.close();
  }
}

export async function reconcileSiyuanIndexEntries(
  projectId: string,
  mapId: string,
  upsertedEntries: readonly SiyuanSafeIndexEntry[],
  removedNodeIds: readonly string[],
  job: SiyuanIndexJobRecord,
): Promise<SiyuanIndexJobRecord | null> {
  const scope = siyuanIndexJobScope(projectId, mapId);
  if (job.scope !== scope || job.projectId !== projectId || job.mapId !== mapId) {
    throw new Error('siyuan_index_reconciliation_scope_mismatch');
  }
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction([ENTRY_STORE, JOB_STORE], 'readwrite');
    const persistedJob = protectSiyuanJobLifecycle(
      (await requestResult(transaction.objectStore(JOB_STORE).get(scope))) as
        | SiyuanIndexJobRecord
        | undefined,
      job,
    );
    const store = transaction.objectStore(ENTRY_STORE);
    for (const nodeId of new Set(removedNodeIds)) {
      store.delete(entryKey(scope, nodeId));
    }
    for (const entry of upsertedEntries) {
      store.put({ ...entry, key: entryKey(scope, entry.nodeId), scope } satisfies StoredEntry);
    }
    transaction.objectStore(JOB_STORE).put(persistedJob);
    await transactionDone(transaction);
    return persistedJob;
  } finally {
    database.close();
  }
}

function protectSiyuanJobLifecycle(
  current: SiyuanIndexJobRecord | null | undefined,
  incoming: SiyuanIndexJobRecord,
): SiyuanIndexJobRecord {
  if (
    !current ||
    !['paused', 'cancelled'].includes(current.status) ||
    current.status === incoming.status
  ) {
    return incoming;
  }
  return {
    ...incoming,
    status: current.status,
    pauseReason: current.pauseReason,
    phase: current.phase,
    pausedMs: current.pausedMs,
    phaseStartedAt: current.phaseStartedAt,
    rateSamples: current.rateSamples,
    discoverySamples: current.discoverySamples,
    estimatedPercent: current.estimatedPercent,
    estimatedEtaSeconds: current.estimatedEtaSeconds,
    reconciledAt: current.reconciledAt,
    updatedAt: current.updatedAt,
    completedAt: current.completedAt,
  };
}

export async function checkpointSiyuanIndexJob(
  checkpoint: SiyuanIndexCheckpoint,
  options: Readonly<{ forceStatus?: boolean }> = {},
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(
      [JOB_STORE, ENTRY_STORE, FRONTIER_STORE, SUMMARY_USAGE_STORE],
      'readwrite',
    );
    const jobStore = transaction.objectStore(JOB_STORE);
    const current = options.forceStatus
      ? null
      : ((await requestResult(jobStore.get(checkpoint.job.scope))) as
          | SiyuanIndexJobRecord
          | undefined);
    const job = options.forceStatus
      ? checkpoint.job
      : protectSiyuanJobLifecycle(current, checkpoint.job);
    jobStore.put(job);
    const entryStore = transaction.objectStore(ENTRY_STORE);
    for (const entry of checkpoint.appendedEntries ?? []) {
      entryStore.put({
        ...entry,
        key: entryKey(job.scope, entry.nodeId),
        scope: job.scope,
      } satisfies StoredEntry);
    }
    const frontierStore = transaction.objectStore(FRONTIER_STORE);
    const firstPosition = job.frontierLength - (checkpoint.appendedDirectories?.length ?? 0);
    for (const [offset, directory] of (checkpoint.appendedDirectories ?? []).entries()) {
      const position = firstPosition + offset;
      frontierStore.put({
        ...directory,
        key: frontierKey(job.scope, position),
        scope: job.scope,
        position,
      } satisfies StoredDirectory);
    }
    if (checkpoint.summaryUsage) {
      const usage = checkpoint.summaryUsage;
      transaction.objectStore(SUMMARY_USAGE_STORE).put({
        ...usage,
        key: `${job.scope}\u0000${usage.nodeId}\u0000${usage.sourceModifiedAt ?? 'none'}\u0000${usage.sourceSizeBytes ?? 'none'}`,
        scope: job.scope,
      } satisfies StoredSummaryUsage);
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function updateSiyuanIndexJobStatus(
  projectId: string,
  mapId: string,
  status: SiyuanIndexJobStatus,
  now = Date.now(),
): Promise<SiyuanIndexJobRecord | null> {
  const job = await readSiyuanIndexJob(projectId, mapId);
  if (!job) return null;
  const updated: SiyuanIndexJobRecord = {
    ...job,
    status,
    pauseReason: status === 'paused' ? 'user' : null,
    phase: status === 'completed' ? 'completed' : job.phase,
    pausedMs:
      status === 'running' && job.status === 'paused'
        ? job.pausedMs + Math.max(0, now - job.updatedAt)
        : job.pausedMs,
    updatedAt: now,
    completedAt: status === 'completed' ? now : null,
    startupDisposition: null,
    startupDispositionAt: null,
  };
  await checkpointSiyuanIndexJob({ job: updated }, { forceStatus: true });
  return updated;
}

export async function setSiyuanIndexJobStartupDisposition(
  projectId: string,
  mapId: string,
  disposition: NonNullable<SiyuanIndexJobRecord['startupDisposition']>,
  now = Date.now(),
  expected?: {
    disposition: NonNullable<SiyuanIndexJobRecord['startupDisposition']>;
    dispositionAt: number;
  },
): Promise<SiyuanIndexJobRecord | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(JOB_STORE, 'readwrite');
    const store = transaction.objectStore(JOB_STORE);
    const job = (await requestResult(store.get(siyuanIndexJobScope(projectId, mapId)))) as
      | SiyuanIndexJobRecord
      | undefined;
    if (!job) {
      await transactionDone(transaction);
      return null;
    }
    if (
      expected &&
      (job.startupDisposition !== expected.disposition ||
        job.startupDispositionAt !== expected.dispositionAt)
    ) {
      await transactionDone(transaction);
      return job;
    }
    const updated: SiyuanIndexJobRecord = {
      ...job,
      status: disposition === 'needs_repair' && job.status === 'running' ? 'failed' : job.status,
      startupDisposition: disposition,
      startupDispositionAt: now,
      updatedAt: disposition === 'needs_repair' ? Math.max(job.updatedAt, now) : job.updatedAt,
    };
    store.put(updated);
    await transactionDone(transaction);
    return updated;
  } finally {
    database.close();
  }
}

export function canResumeSiyuanIndexJob(
  job: SiyuanIndexJobRecord,
  authority: {
    accountId: string | null;
    canonicalRoot: string;
    policyFingerprint: string;
  },
): boolean {
  return (
    job.schemaVersion === 1 &&
    job.status === 'running' &&
    job.accountId === authority.accountId &&
    canonicalSiyuanAuthorityRoot(job.canonicalRoot) ===
      canonicalSiyuanAuthorityRoot(authority.canonicalRoot) &&
    job.policyFingerprint === authority.policyFingerprint
  );
}
