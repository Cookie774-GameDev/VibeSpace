import { applySecretPolicy } from '@/lib/security/secretDetector';
import {
  listDirectoriesStrict,
  listDirectory,
  statProjectPath,
  type FsBatchListResult,
  type FsEntry,
  type FsListResult,
  type FsPathStatResult,
} from '@/lib/fs';
import {
  assertContextLocalFilePath,
  contextLocalFileRelativePath,
  contextLocalFileScopeFingerprint,
  readContextLocalFileScope,
  type ContextLocalFileScopeV1,
} from '../contextLocalFileScope';
import type { ContextMapRecord, ContextTreeNode, ProjectContextTree } from '../tree';
import type { SiyuanSummaryPolicy } from './siyuanMapManifest';
import {
  canResumeSiyuanIndexJob,
  checkpointSiyuanIndexJob,
  createSiyuanIndexJob,
  readSiyuanIndexEntries,
  readSiyuanIndexFrontier,
  readSiyuanIndexJob,
  repairEmptySiyuanDiscoveryCheckpoint,
  replaceSiyuanIndexJob,
  type SiyuanIndexDirectory,
  type SiyuanIndexJobRecord,
} from './siyuanIndexJobStore';
import { canonicalSiyuanAuthorityRoot, normalizeSiyuanFilesystemPath } from './siyuanPathAuthority';
import { estimateSiyuanDiscoveryProgress } from './siyuanProgress';

export interface SiyuanSafeIndexEntry {
  nodeId: string;
  parentNodeId: string | null;
  title: string;
  kind: ContextTreeNode['kind'];
  relativePath: string | null;
  sourcePointer: string | null;
  summary: string | null;
  sizeBytes: number | null;
  modifiedAt: number | null;
  summaryState?: 'completed' | 'skipped' | 'failed';
}

export interface SiyuanSafeIndex {
  entries: SiyuanSafeIndexEntry[];
  excluded: number;
  unreadable: number;
  summarized: number;
}

export function projectSiyuanMapForContextSearch(map: ContextMapRecord): ContextMapRecord {
  const readableRoot = normalizeSiyuanFilesystemPath(map.rootDir);
  if (readableRoot === map.rootDir && readableRoot === map.tree.rootDir) return map;
  return {
    ...map,
    rootDir: readableRoot,
    tree: {
      ...map.tree,
      rootDir: readableRoot,
    },
  };
}

export function buildProjectContextTreeFromSiyuanIndex(
  seed: ProjectContextTree,
  entries: readonly SiyuanSafeIndexEntry[],
): ProjectContextTree {
  const nodesById = new Map<string, ContextTreeNode>();
  for (const entry of entries) {
    if (nodesById.has(entry.nodeId)) throw new Error('siyuan_index_tree_duplicate_node');
    nodesById.set(entry.nodeId, {
      id: entry.nodeId,
      title: entry.title,
      kind: entry.kind,
      summary: entry.summary ?? '',
      ...(entry.relativePath ? { path: entry.relativePath } : {}),
      ...(entry.sizeBytes !== null ? { sizeBytes: entry.sizeBytes } : {}),
      ...(entry.modifiedAt !== null ? { modifiedAt: entry.modifiedAt } : {}),
      ...(entry.kind === 'file' ? { contentIndexEligible: true } : {}),
    });
  }

  const roots: ContextTreeNode[] = [];
  for (const entry of entries) {
    const node = nodesById.get(entry.nodeId)!;
    if (!entry.parentNodeId) {
      roots.push(node);
      continue;
    }
    const parent = nodesById.get(entry.parentNodeId);
    if (!parent) throw new Error('siyuan_index_tree_parent_missing');
    parent.children = [...(parent.children ?? []), node];
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const assertAcyclic = (node: ContextTreeNode) => {
    if (visiting.has(node.id)) throw new Error('siyuan_index_tree_cycle');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const child of node.children ?? []) assertAcyclic(child);
    visiting.delete(node.id);
    visited.add(node.id);
  };
  for (const node of nodesById.values()) assertAcyclic(node);

  const fileEntries = entries.filter((entry) => entry.kind === 'file');
  const totalBytes = fileEntries.reduce(
    (total, entry) => total + Math.max(0, entry.sizeBytes ?? 0),
    0,
  );
  return {
    ...seed,
    model: 'siyuan-managed-v1',
    fileCount: fileEntries.length,
    totalBytes,
    summary: `SiYuan indexed ${fileEntries.length.toLocaleString()} files across ${entries.length.toLocaleString()} allowed source items.`,
    nodes: roots,
  };
}

export type SiyuanDirectoryLister = (
  path: string,
  options: { root: string; strictProjectBoundary: true },
) => Promise<FsListResult>;

export type SiyuanDirectoryBatchLister = (
  paths: readonly string[],
  options: { root: string; strictProjectBoundary: true },
) => Promise<FsBatchListResult>;

export interface SiyuanIndexJobControl {
  readonly state: 'running' | 'paused' | 'cancelled';
  pause(): void;
  resume(): void;
  cancel(): void;
  checkpoint(signal?: AbortSignal): Promise<void>;
}

function cancelledError(): Error {
  return new Error('siyuan_index_cancelled');
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createSiyuanIndexJobControl(): SiyuanIndexJobControl {
  let state: SiyuanIndexJobControl['state'] = 'running';
  const isCancelled = () => state === 'cancelled';
  let resumeWaiters: Array<() => void> = [];
  const release = () => {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
  };
  return Object.freeze({
    get state() {
      return state;
    },
    pause() {
      if (state === 'running') state = 'paused';
    },
    resume() {
      if (state !== 'paused') return;
      state = 'running';
      release();
    },
    cancel() {
      state = 'cancelled';
      release();
    },
    async checkpoint(signal?: AbortSignal) {
      if (isCancelled()) throw new Error('siyuan_index_cancelled');
      if (signal?.aborted) throw cancelledError();
      if (state === 'paused') {
        await new Promise<void>((resolve, reject) => {
          const onResume = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            resumeWaiters = resumeWaiters.filter((waiter) => waiter !== onResume);
            signal?.removeEventListener('abort', onAbort);
            reject(cancelledError());
          };
          resumeWaiters.push(onResume);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (isCancelled()) throw new Error('siyuan_index_cancelled');
      if (signal?.aborted) throw cancelledError();
    },
  });
}

export function createDurableSiyuanIndexJobControl(
  projectId: string,
  mapId: string,
): SiyuanIndexJobControl {
  let state: SiyuanIndexJobControl['state'] = 'running';
  return {
    get state() {
      return state;
    },
    pause() {
      state = 'paused';
    },
    resume() {
      state = 'running';
    },
    cancel() {
      state = 'cancelled';
    },
    async checkpoint(signal?: AbortSignal) {
      while (true) {
        if (signal?.aborted) throw cancelledError();
        const job = await readSiyuanIndexJob(projectId, mapId);
        if (!job || job.status === 'cancelled') {
          state = 'cancelled';
          throw new Error('siyuan_index_cancelled');
        }
        if (job.status === 'failed' || job.status === 'completed') {
          state = 'cancelled';
          throw cancelledError();
        }
        if (job.status !== 'paused') {
          state = 'running';
          return;
        }
        state = 'paused';
        await abortableDelay(250, signal);
      }
    },
  };
}

const EXCLUDED_SEGMENTS = new Set([
  '$recycle.bin',
  '.cache',
  '.aws',
  '.azure',
  '.claude',
  '.claude-provider',
  '.codex',
  '.docker',
  '.git',
  '.gnupg',
  '.hg',
  '.kube',
  '.npm',
  '.password-store',
  '.pnpm-store',
  '.pki',
  '.ssh',
  '.svn',
  'appdata/local/temp',
  'appdata/local/google/chrome',
  'appdata/local/microsoft/edge',
  'appdata/local/microsoft/credentials',
  'appdata/roaming/mozilla',
  'appdata/roaming/microsoft/credentials',
  'browser profiles',
  'build',
  'cache',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'target-codex-tests',
  'temp',
]);
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|auth(?:entication)?\.json|credentials?(?:\..*)?|id_(?:rsa|ecdsa|ed25519)|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:key|pem|p12|pfx))$/iu;
const MAX_ENTRIES = 500_000;
const DIRECTORY_SCAN_BATCH_SIZE = 64;
const DURABLE_CHECKPOINT_ITEM_INTERVAL = 250;

function canonical(value: string): string {
  return normalizeSiyuanFilesystemPath(value)
    .replace(/\/{2,}/gu, '/')
    .replace(/\/$/u, '');
}

function relativeSource(root: string, value: string | undefined): string | null {
  if (!value) return null;
  const base = canonical(root);
  const candidate = canonical(value);
  const combined =
    /^[A-Za-z]:\//u.test(candidate) || candidate.startsWith('/')
      ? candidate
      : `${base}/${candidate}`;
  const normalizedBase = base.toLocaleLowerCase('en-US');
  const normalized = combined.toLocaleLowerCase('en-US');
  if (normalized !== normalizedBase && !normalized.startsWith(`${normalizedBase}/`)) return null;
  const relative = combined.slice(base.length).replace(/^\//u, '');
  if (relative.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return relative;
}

function excludedPath(
  relativePath: string | null,
  title: string,
  customExclusions: readonly string[] = [],
): boolean {
  if (SECRET_FILE.test(title.trim())) return true;
  if (!relativePath) return false;
  const lower = relativePath.toLocaleLowerCase('en-US');
  return (
    [...EXCLUDED_SEGMENTS].some(
      (segment) =>
        lower === segment ||
        lower.startsWith(`${segment}/`) ||
        lower.endsWith(`/${segment}`) ||
        lower.includes(`/${segment}/`),
    ) ||
    customExclusions.some((selected) => {
      const exact = canonical(selected).replace(/^\.\//u, '').toLocaleLowerCase('en-US');
      return exact !== '' && (lower === exact || lower.startsWith(`${exact}/`));
    })
  );
}

function extension(value: string): string {
  const match = /\.([A-Za-z0-9_-]{1,32})$/u.exec(value);
  return match?.[1]?.toLocaleLowerCase('en-US') ?? '';
}

function normalizedCustomExclusions(root: string, values: readonly string[]): string[] {
  return values
    .map((value) => relativeSource(root, value) ?? canonical(value).replace(/^\.\//u, ''))
    .filter((value) => value !== '');
}

function normalizedSummaryPolicy(root: string, policy: SiyuanSummaryPolicy): SiyuanSummaryPolicy {
  return {
    ...policy,
    selectedPaths: policy.selectedPaths
      .map((value) => {
        const relative = relativeSource(root, value);
        if (relative === '') return '.';
        return relative ?? canonical(value).replace(/^\.\//u, '');
      })
      .filter((value) => value !== ''),
  };
}

function legacyNormalizedSummaryPolicy(
  root: string,
  policy: SiyuanSummaryPolicy,
): SiyuanSummaryPolicy {
  return {
    ...policy,
    selectedPaths: policy.selectedPaths
      .map((value) => relativeSource(root, value) ?? canonical(value).replace(/^\.\//u, ''))
      .filter((value) => value !== ''),
  };
}

function indexPolicyFingerprintPayload(
  root: string,
  policy: SiyuanSummaryPolicy,
  excludedPaths: readonly string[],
  schemaVersion: 1 | 2,
): string {
  return JSON.stringify({
    schemaVersion,
    root: canonical(root).toLocaleLowerCase('en-US'),
    summaryMode: policy.mode,
    selectedExtensions: [...policy.selectedExtensions].sort(),
    selectedPaths: [...policy.selectedPaths]
      .map((value) => canonical(value).toLocaleLowerCase('en-US'))
      .sort(),
    excludedPaths: normalizedCustomExclusions(root, excludedPaths)
      .map((value) => canonical(value).toLocaleLowerCase('en-US'))
      .sort(),
  });
}

export function siyuanIndexPolicyFingerprint(
  root: string,
  policy: SiyuanSummaryPolicy,
  excludedPaths: readonly string[],
  localFileScope?: ContextLocalFileScopeV1 | null,
): string {
  const normalizedPolicy = normalizedSummaryPolicy(root, policy);
  const folder = indexPolicyFingerprintPayload(root, normalizedPolicy, excludedPaths, 2);
  if (!localFileScope) return folder;
  return JSON.stringify({
    ...JSON.parse(folder),
    localFileScope: contextLocalFileScopeFingerprint({ sourceType: 'local_file', rootDir: root, localFileScope }),
  });
}

function legacySiyuanIndexPolicyFingerprint(
  root: string,
  policy: SiyuanSummaryPolicy,
  excludedPaths: readonly string[],
): string {
  return indexPolicyFingerprintPayload(
    root,
    legacyNormalizedSummaryPolicy(root, policy),
    excludedPaths,
    1,
  );
}

function fingerprintWithCanonicalRoot(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.root !== 'string') return null;
    // Change only the spelling of the root, never summary scope or exclusions.
    return JSON.stringify({ ...parsed, root: canonicalSiyuanAuthorityRoot(parsed.root) });
  } catch {
    return null;
  }
}

function isEmptyMalformedVerbatimDiscoveryCheckpoint(
  job: SiyuanIndexJobRecord,
  root: string,
): boolean {
  const storedRoot = job.canonicalRoot.replace(/\\/gu, '/');
  return (
    normalizeSiyuanFilesystemPath(storedRoot) !== storedRoot &&
    canonicalSiyuanAuthorityRoot(storedRoot) === canonicalSiyuanAuthorityRoot(root) &&
    job.phase === 'discovering' &&
    job.cursor === 0 &&
    job.frontierLength === 1 &&
    job.indexed === 0 &&
    job.createdNodes === 0 &&
    job.summarized === 0 &&
    job.summaryEligible === 0 &&
    job.inputTokens === 0 &&
    job.outputTokens === 0 &&
    job.totalTokens === 0 &&
    job.pendingNativeNodeIds.length === 0
  );
}

function summarySelected(
  node: ContextTreeNode,
  relativePath: string | null,
  policy: SiyuanSummaryPolicy,
): boolean {
  if (policy.mode === 'none') return false;
  if (policy.mode === 'all') return true;
  const ext = extension(node.title);
  if (ext && policy.selectedExtensions.includes(ext)) return true;
  return Boolean(
    relativePath &&
    policy.selectedPaths.some(
      (selected) =>
        selected === '.' ||
        relativePath === canonical(selected) ||
        relativePath.startsWith(`${canonical(selected)}/`),
    ),
  );
}

/** Admit only the selected-file entry, including retained/pre-scanned checkpoints. */
export function assertSiyuanLocalFileEntries(
  record: ContextMapRecord,
  entries: readonly SiyuanSafeIndexEntry[],
): void {
  if (!readContextLocalFileScope(record)) return;
  try {
    if (entries.length > 1) throw new Error('multiple_file_entries');
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.parentNodeId !== null || !entry.relativePath ||
          /[\\/]/u.test(entry.relativePath) || !entry.sourcePointer) throw new Error('invalid_file_entry');
      assertContextLocalFilePath(record, `${record.rootDir.replace(/[\\/]$/u, '')}/${entry.relativePath}`);
      assertContextLocalFilePath(record, entry.sourcePointer);
    }
  } catch { throw new Error('siyuan_local_file_checkpoint_scope_invalid'); }
}

export function buildSiyuanSafeIndex(
  record: ContextMapRecord,
  policy: SiyuanSummaryPolicy,
  customExclusions: readonly string[] = [],
): SiyuanSafeIndex {
  const fileScope = readContextLocalFileScope(record);
  const entries: SiyuanSafeIndexEntry[] = [];
  const exclusions = normalizedCustomExclusions(record.rootDir, customExclusions);
  const summaryPolicy = normalizedSummaryPolicy(record.rootDir, policy);
  let excluded = 0;
  let summarized = 0;
  const walk = (nodes: readonly ContextTreeNode[], parentNodeId: string | null): void => {
    for (const node of nodes) {
      if (entries.length >= MAX_ENTRIES) throw new Error('siyuan_safe_index_entry_limit');
      if (fileScope && node.kind === 'root' &&
          (!node.path || node.path === '.' || canonical(node.path) === canonical(record.rootDir))) {
        walk(node.children ?? [], null);
        continue;
      }
      const relativePath = relativeSource(record.rootDir, node.path);
      if (fileScope) {
        if (node.kind !== 'file' || !relativePath) throw new Error('context_local_file_path_denied');
        assertContextLocalFilePath(record, `${fileScope.rootDir.replace(/\/$/u, '')}/${relativePath}`);
      }
      if (
        (node.path && relativePath === null) ||
        excludedPath(relativePath, node.title, exclusions)
      ) {
        excluded += 1;
        continue;
      }
      const summaryResult = summarySelected(node, relativePath, summaryPolicy)
        ? applySecretPolicy(node.summary ?? '', 'exclude')
        : null;
      const summary =
        summaryResult?.decision === 'allowed' ? summaryResult.text?.trim() || null : null;
      if (summary) summarized += 1;
      entries.push(
        Object.freeze({
          nodeId: node.id,
          parentNodeId,
          title: node.title
            .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
            .trim()
            .slice(0, 500),
          kind: node.kind,
          relativePath,
          sourcePointer:
            relativePath === null ? null : `${canonical(record.rootDir)}/${relativePath}`,
          summary,
          sizeBytes: Number.isSafeInteger(node.sizeBytes) ? (node.sizeBytes ?? null) : null,
          modifiedAt: Number.isSafeInteger(node.modifiedAt) ? (node.modifiedAt ?? null) : null,
        }),
      );
      if (node.children?.length) walk(node.children, node.id);
    }
  };
  walk(record.tree.nodes, null);
  assertSiyuanLocalFileEntries(record, entries);
  return Object.freeze({
    entries: Object.freeze(entries) as SiyuanSafeIndexEntry[],
    excluded,
    unreadable: 0,
    summarized,
  });
}

function entryKind(entry: FsEntry): ContextTreeNode['kind'] {
  return entry.isDir ? 'area' : 'file';
}

function existingSummaries(record: ContextMapRecord): Map<string, string> {
  const summaries = new Map<string, string>();
  const visit = (nodes: readonly ContextTreeNode[]) => {
    for (const node of nodes) {
      const relative = relativeSource(record.rootDir, node.path);
      if (relative !== null && node.summary.trim()) {
        summaries.set(canonical(relative).toLocaleLowerCase('en-US'), node.summary);
      }
      if (node.children?.length) visit(node.children);
    }
  };
  visit(record.tree.nodes);
  return summaries;
}

/**
 * Builds the complete allowed metadata tree independently of the bounded
 * content sampler. The native list command enforces the selected root and
 * rejects links/reparse points; this function never reads or mutates content.
 */
export async function scanSiyuanFilesystemIndex(
  record: ContextMapRecord,
  policy: SiyuanSummaryPolicy,
  options: Readonly<{
    signal?: AbortSignal;
    control?: SiyuanIndexJobControl;
    onProgress?: (
      counts: Readonly<{ indexed: number; excluded: number; unreadable: number }>,
    ) => void;
    list?: SiyuanDirectoryLister;
    listBatch?: SiyuanDirectoryBatchLister;
    stat?: (path: string, includeSha256: boolean, options: { root: string; strictProjectBoundary: true }) => Promise<FsPathStatResult>;
    excludedPaths?: readonly string[];
    durableJob?: Readonly<{ accountId: string | null; projectId: string; mapId: string }>;
  }> = {},
): Promise<SiyuanSafeIndex> {
  if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
  const fileScope = readContextLocalFileScope(record);
  const root = fileScope?.rootDir ?? canonical(record.rootDir);
  const list: SiyuanDirectoryLister = fileScope ? async (path) => {
    readContextLocalFileScope({ ...record, rootDir: path });
    const stat = await (options.stat ?? statProjectPath)(fileScope.filePath, false, {
      root: fileScope.rootDir, strictProjectBoundary: true,
    });
    if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
    if (!stat.ok) throw new Error(`siyuan_local_file_unavailable:${stat.error.code}`);
    if (stat.kind !== 'file') throw new Error('siyuan_local_file_not_a_file');
    assertContextLocalFilePath(record, stat.path);
    return { ok: true, path: root, entries: [{
      name: contextLocalFileRelativePath(record)!, path: fileScope.filePath,
      isDir: false, size: stat.size, modifiedMs: stat.modifiedMs,
    }] };
  } : options.list ?? listDirectory;
  const listBatch = fileScope ? null : options.listBatch ?? (options.list ? null : listDirectoriesStrict);
  const summaries = existingSummaries(record);
  const exclusions = normalizedCustomExclusions(root, options.excludedPaths ?? []);
  const summaryPolicy = normalizedSummaryPolicy(root, policy);
  let entries: SiyuanSafeIndexEntry[] = [];
  let queue: SiyuanIndexDirectory[] = [{ path: root, relativePath: '', parentNodeId: null }];
  let cursor = 0;
  let excluded = 0;
  let unreadable = 0;
  let summarized = 0;
  let durableRecord: SiyuanIndexJobRecord | null = null;
  const assertFileEntries = () => assertSiyuanLocalFileEntries(record, entries);

  if (options.durableJob) {
    const { accountId, projectId, mapId } = options.durableJob;
    const policyFingerprint = siyuanIndexPolicyFingerprint(
      root,
      policy,
      options.excludedPaths ?? [],
      fileScope,
    );
    const legacyPolicyFingerprint = legacySiyuanIndexPolicyFingerprint(
      root,
      policy,
      options.excludedPaths ?? [],
    );
    let existing = await readSiyuanIndexJob(projectId, mapId);
    if (fileScope && existing && existing.policyFingerprint !== policyFingerprint) {
      throw new Error('siyuan_index_resume_authority_mismatch');
    }
    if (existing && existing.accountId === null && accountId !== null) {
      existing = { ...existing, accountId, updatedAt: Date.now() };
      await checkpointSiyuanIndexJob({ job: existing });
    }
    if (
      existing &&
      existing.accountId === accountId &&
      existing.projectId === projectId &&
      existing.mapId === mapId &&
      existing.status === 'running' &&
      isEmptyMalformedVerbatimDiscoveryCheckpoint(existing, root) &&
      [policyFingerprint, legacyPolicyFingerprint].includes(
        fingerprintWithCanonicalRoot(existing.policyFingerprint) ?? '',
      )
    ) {
      // Re-read and compare inside one transaction; retain all identities and
      // refuse cancellation, concurrent progress, or changed policy/authority.
      existing = await repairEmptySiyuanDiscoveryCheckpoint(
        existing,
        root,
        policyFingerprint,
        options.signal,
      );
    }
    if (existing?.policyFingerprint === legacyPolicyFingerprint) {
      existing = { ...existing, policyFingerprint, updatedAt: Date.now() };
      await checkpointSiyuanIndexJob({ job: existing });
    }
    if (existing && existing.phase !== 'discovering') {
      if (
        existing.accountId !== accountId ||
        canonicalSiyuanAuthorityRoot(existing.canonicalRoot) !==
          canonicalSiyuanAuthorityRoot(root) ||
        existing.policyFingerprint !== policyFingerprint
      ) {
        throw new Error('siyuan_index_resume_authority_mismatch');
      }
      entries = await readSiyuanIndexEntries(projectId, mapId);
      assertFileEntries();
      return Object.freeze({
        entries: Object.freeze(entries) as SiyuanSafeIndexEntry[],
        excluded: existing.excluded,
        unreadable: existing.unreadable,
        summarized: existing.summarized,
      });
    }
    if (existing) {
      if (
        !canResumeSiyuanIndexJob(existing, { accountId, canonicalRoot: root, policyFingerprint })
      ) {
        throw new Error(`siyuan_index_not_resumable:${existing.status}`);
      }
      durableRecord = existing;
      [queue, entries] = await Promise.all([
        readSiyuanIndexFrontier(projectId, mapId),
        readSiyuanIndexEntries(projectId, mapId),
      ]);
      assertFileEntries();
      if (fileScope) {
        try {
          if (queue.length !== 1 || queue[0]!.relativePath !== '' || queue[0]!.parentNodeId !== null) {
            throw new Error('invalid_file_frontier');
          }
          readContextLocalFileScope({ ...record, rootDir: queue[0]!.path });
        } catch { throw new Error('siyuan_local_file_checkpoint_scope_invalid'); }
      }
      if (queue.length !== existing.frontierLength || entries.length !== existing.indexed) {
        throw new Error('siyuan_index_checkpoint_inconsistent');
      }
      cursor = existing.cursor;
      excluded = existing.excluded;
      unreadable = existing.unreadable;
      summarized = existing.summarized;
    } else {
      durableRecord = createSiyuanIndexJob({
        accountId,
        projectId,
        mapId,
        canonicalRoot: root,
        policyFingerprint,
      });
      await replaceSiyuanIndexJob(durableRecord, queue[0]);
    }
  }

  const knownEntryNodeIds = new Set(entries.map((entry) => entry.nodeId));
  const knownDirectoryPaths = new Set(
    queue.map((directory) => canonical(directory.path).toLocaleLowerCase('en-US')),
  );

  while (cursor < queue.length) {
    await options.control?.checkpoint(options.signal);
    if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
    const directories = queue.slice(cursor, cursor + DIRECTORY_SCAN_BATCH_SIZE);
    const batchResults = listBatch
      ? await listBatch(
          directories.map((directory) => directory.path),
          { root, strictProjectBoundary: true },
        )
      : await Promise.all(
          directories.map((directory) =>
            list(directory.path, { root, strictProjectBoundary: true }),
          ),
        );
    if (batchResults.length !== directories.length) {
      throw new Error('siyuan_index_batch_incomplete');
    }
    const listings = directories.map((directory, index) => ({
      directory,
      result: batchResults[index]!,
    }));
    const batchEntries: SiyuanSafeIndexEntry[] = [];
    const batchDirectories: SiyuanIndexDirectory[] = [];
    let processedSinceCheckpoint = 0;
    const checkpointOversizedBatch = async () => {
      if (!durableRecord || processedSinceCheckpoint < DURABLE_CHECKPOINT_ITEM_INTERVAL) return;
      const checkpointedAt = Date.now();
      durableRecord = {
        ...durableRecord,
        frontierLength: queue.length,
        indexed: entries.length,
        summarized,
        updatedAt: checkpointedAt,
      };
      await checkpointSiyuanIndexJob({
        job: durableRecord,
        appendedEntries: batchEntries.splice(0),
        appendedDirectories: batchDirectories.splice(0),
      });
      processedSinceCheckpoint = 0;
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
    };
    for (const { directory, result } of listings) {
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      if (!result.ok) {
        unreadable += 1;
        options.onProgress?.({ indexed: entries.length, excluded, unreadable });
        continue;
      }
      const children = [...result.entries].sort((left, right) =>
        left.name.localeCompare(right.name, 'en-US'),
      );
      for (const child of children) {
        if (entries.length >= MAX_ENTRIES) throw new Error('siyuan_safe_index_entry_limit');
        processedSinceCheckpoint += 1;
        const relativePath = relativeSource(root, child.path);
        if (relativePath === null || excludedPath(relativePath, child.name, exclusions)) {
          excluded += 1;
          await checkpointOversizedBatch();
          continue;
        }
        const nodeId = `path:${canonical(relativePath)}`;
        if (knownEntryNodeIds.has(nodeId)) {
          await checkpointOversizedBatch();
          continue;
        }
        const summaryCandidate = summaries.get(canonical(relativePath).toLocaleLowerCase('en-US'));
        const summaryNode: ContextTreeNode = {
          id: nodeId,
          title: child.name,
          kind: entryKind(child),
          summary: summaryCandidate ?? '',
          path: child.path,
        };
        const summaryResult = summarySelected(summaryNode, relativePath, summaryPolicy)
          ? applySecretPolicy(summaryCandidate ?? '', 'exclude')
          : null;
        const summary =
          summaryResult?.decision === 'allowed' ? summaryResult.text?.trim() || null : null;
        if (summary) summarized += 1;
        const indexedEntry: SiyuanSafeIndexEntry = {
          nodeId,
          parentNodeId: directory.parentNodeId,
          title: child.name
            .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
            .trim()
            .slice(0, 500),
          kind: entryKind(child),
          relativePath,
          sourcePointer: child.path,
          summary,
          sizeBytes: Number.isSafeInteger(child.size) ? (child.size ?? null) : null,
          modifiedAt: Number.isSafeInteger(child.modifiedMs) ? (child.modifiedMs ?? null) : null,
        };
        entries.push(indexedEntry);
        knownEntryNodeIds.add(nodeId);
        batchEntries.push(indexedEntry);
        if (child.isDir) {
          const queuedDirectory = { path: child.path, relativePath, parentNodeId: nodeId };
          const directoryKey = canonical(queuedDirectory.path).toLocaleLowerCase('en-US');
          if (!knownDirectoryPaths.has(directoryKey)) {
            knownDirectoryPaths.add(directoryKey);
            queue.push(queuedDirectory);
            batchDirectories.push(queuedDirectory);
          }
        }
        await checkpointOversizedBatch();
      }
      options.onProgress?.({ indexed: entries.length, excluded, unreadable });
    }
    cursor += directories.length;
    if (durableRecord) {
      const sampledAt = Date.now();
      const estimate = estimateSiyuanDiscoveryProgress({
        previous: {
          determinate: durableRecord.estimatedPercent !== null,
          approximatePercent:
            durableRecord.estimatedPercent === null
              ? null
              : Math.min(99, durableRecord.estimatedPercent * 4),
          etaSeconds: durableRecord.estimatedEtaSeconds,
          ratePerSecond: null,
          samples: durableRecord.discoverySamples,
        },
        sample: {
          at: sampledAt,
          processed: cursor,
          frontierRemaining: Math.max(0, queue.length - cursor),
          discovered: entries.length,
        },
      });
      durableRecord = {
        ...durableRecord,
        cursor,
        frontierLength: queue.length,
        indexed: entries.length,
        excluded,
        unreadable,
        summarized,
        updatedAt: sampledAt,
        rateSamples: [...durableRecord.rateSamples, { at: sampledAt, processed: cursor }].slice(
          -20,
        ),
        discoverySamples: [...estimate.samples],
        estimatedPercent:
          estimate.approximatePercent === null
            ? durableRecord.estimatedPercent
            : Math.max(
                durableRecord.estimatedPercent ?? 0,
                Math.min(24.75, estimate.approximatePercent * 0.25),
              ),
        estimatedEtaSeconds: estimate.etaSeconds,
      };
      await checkpointSiyuanIndexJob({
        job: durableRecord,
        appendedEntries: batchEntries,
        appendedDirectories: batchDirectories,
      });
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }

  if (durableRecord) {
    const completedDiscoveryAt = Date.now();
    durableRecord = {
      ...durableRecord,
      phase: 'creating_nodes',
      status: 'running',
      cursor,
      frontierLength: queue.length,
      indexed: entries.length,
      excluded,
      unreadable,
      summarized,
      updatedAt: completedDiscoveryAt,
      completedAt: null,
      phaseStartedAt: completedDiscoveryAt,
      rateSamples: [{ at: completedDiscoveryAt, processed: 0 }],
      estimatedPercent: Math.max(durableRecord.estimatedPercent ?? 0, 25),
      estimatedEtaSeconds: null,
    };
    await checkpointSiyuanIndexJob({ job: durableRecord });
  }

  return Object.freeze({
    entries: Object.freeze(entries) as SiyuanSafeIndexEntry[],
    excluded,
    unreadable,
    summarized,
  });
}
