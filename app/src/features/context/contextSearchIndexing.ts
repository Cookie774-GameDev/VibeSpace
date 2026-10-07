import { assertContextLocalFilePath, contextLocalFileScopeFingerprint, readContextLocalFileScope, type ContextLocalFileScopeV1 } from './contextLocalFileScope';
import {
  readTextFileSample,
  sha256Text,
  statProjectPath,
  type FsPathStatResult,
  type FsReadResult,
} from '@/lib/fs';
import { classifyJarvisSource } from '@/lib/jarvis/sourcePolicy';
import {
  createTauriContextSearchIndexPort,
  type ContextSearchDocumentInput,
  type ContextSearchIndexPort,
} from './contextSearchPipeline';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BATCH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_DOCUMENTS = 64;
const MAX_DELETE_BATCH_DOCUMENTS = 1_000;
// Bodies remain bounded to 64 documents/4MiB per mutation at this map scale.
const MAX_MAP_DOCUMENTS = 100_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const SAFE_HASH = /^sha256:[a-f0-9]{64}$/u;

export interface ContextSearchIndexNode {
  id: string;
  kind: string;
  title: string;
  path?: string;
  modifiedAt?: number;
  contentIndexEligible?: boolean;
  children?: readonly ContextSearchIndexNode[];
}

export interface ContextSearchIndexMap {
  id: string;
  projectId: string | null;
  rootDir: string;
  status: 'active' | 'deleted';
  updatedAt: number;
  sourceType?: string;
  localFileScope?: ContextLocalFileScopeV1;
  tree: { nodes: readonly ContextSearchIndexNode[] };
}

export interface ContextSearchIndexReceipt {
  mapId: string;
  documentCount: number;
  bodyBytes: number;
  status: 'ready' | 'already_populated';
}

interface Dependencies {
  port?: ContextSearchIndexPort;
  stat?: (
    path: string,
    includeSha256: boolean,
    options: { root?: string | null; strictProjectBoundary?: boolean },
  ) => Promise<FsPathStatResult>;
  read?: (
    path: string,
    maxBytes: number,
    options: { root?: string | null; strictProjectBoundary?: boolean },
  ) => Promise<FsReadResult>;
  hash?: (content: string) => Promise<`sha256:${string}`>;
}

export interface ContextSearchIndexPopulationPort {
  stageChangedMap(accountId: string, map: ContextSearchIndexMap,
    changedIds: readonly string[], deletedIds: readonly string[], signal?: AbortSignal,
    options?: { reconcileMembership: true }): Promise<{
      commit(): Promise<void>; abort(): Promise<void>;
    }>;
  populateCreatedMap(
    accountId: string,
    map: ContextSearchIndexMap,
    signal?: AbortSignal,
  ): Promise<ContextSearchIndexReceipt>;
  repairEmptyMap(
    accountId: string,
    map: ContextSearchIndexMap,
    signal?: AbortSignal,
  ): Promise<ContextSearchIndexReceipt>;
}

interface Candidate {
  node: ContextSearchIndexNode;
  relativePath: string;
  absolutePath: string;
}

let populationTail: Promise<void> = Promise.resolve();

function fail(code: string): never {
  throw new Error(`context_search_index_${code}`);
}

function failSource(candidate: Candidate, reason: string): never {
  throw new Error(`context_search_index_source_invalid:${candidate.relativePath}:${reason}`);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
}

function validRelativePath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 1_000 ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(path)
  ) {
    return false;
  }
  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':') &&
        !/[. ]$/u.test(segment),
    );
}

function absolutePath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${relative.split('/').join(separator)}`;
}

function validAbsoluteRoot(root: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/u.test(root) || /^\\\\\?\\[A-Za-z]:[\\/]/u.test(root);
}

function candidatesFor(map: ContextSearchIndexMap): Candidate[] {
  readContextLocalFileScope(map);
  if (
    map.status !== 'active' ||
    !SAFE_ID.test(map.id) ||
    !map.rootDir ||
    !validAbsoluteRoot(map.rootDir) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(map.rootDir)
  ) {
    return fail('snapshot_invalid');
  }
  const flattened: ContextSearchIndexNode[] = [];
  const visit = (node: ContextSearchIndexNode) => {
    flattened.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of map.tree.nodes) visit(node);
  const candidates = flattened
    .filter((node) => node.kind === 'file' && node.contentIndexEligible !== false)
    .map((node): Candidate => {
      if (
        !SAFE_ID.test(node.id) ||
        typeof node.path !== 'string' ||
        !validRelativePath(node.path) ||
        typeof node.title !== 'string' ||
        node.title.length < 1 ||
        node.title.length > 1_000 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(node.title)
      ) {
        return fail('snapshot_invalid');
      }
      const path = absolutePath(map.rootDir, node.path);
      assertContextLocalFilePath(map, path);
      return { node, relativePath: node.path, absolutePath: path };
    })
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath, 'en-US') ||
        left.node.id.localeCompare(right.node.id, 'en-US'),
    );
  if (candidates.length > MAX_MAP_DOCUMENTS) return fail('snapshot_invalid');
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of candidates) {
    const pathKey = candidate.relativePath.toLocaleLowerCase('en-US');
    if (ids.has(candidate.node.id) || paths.has(pathKey)) return fail('snapshot_invalid');
    ids.add(candidate.node.id);
    paths.add(pathKey);
  }
  return candidates;
}

function rawHash(stat: FsPathStatResult): string | undefined {
  return stat.ok && typeof stat.sha256 === 'string' && SAFE_HASH.test(stat.sha256)
    ? stat.sha256
    : undefined;
}

function unsafePhysicalText(content: string): boolean {
  return (
    content.includes('\uFFFD') ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/u.test(content)
  );
}

async function documentFor(
  map: ContextSearchIndexMap,
  candidate: Candidate,
  dependencies: Required<Pick<Dependencies, 'stat' | 'read' | 'hash'>>,
  signal?: AbortSignal,
): Promise<ContextSearchDocumentInput | null> {
  abortIfNeeded(signal);
  const access = { root: map.rootDir, strictProjectBoundary: true };
  const fileScope = contextLocalFileScopeFingerprint(map);
  const assertScope = () => {
    assertContextLocalFilePath(map, candidate.absolutePath);
    if (contextLocalFileScopeFingerprint(map) !== fileScope) throw new Error('context_local_file_path_denied');
  };
  assertScope();
  // Metadata first avoids an entire pre-read hash pass, including for large
  // files whose bodies will never be indexed. Verify the read against the
  // native post-read hash and unchanged size/time before staging any bytes.
  const before = await dependencies.stat(candidate.absolutePath, false, access);
  abortIfNeeded(signal);
  assertScope();
  if (before.ok) assertContextLocalFilePath(map, before.path);
  if (
    !before.ok ||
    before.kind !== 'file' ||
    !Number.isSafeInteger(before.size) ||
    (before.size ?? -1) < 0
  ) {
    return failSource(candidate, !before.ok ? before.error.code : 'metadata');
  }
  // Large discovered files remain graph metadata, like binary/media files.
  // One bounded-out body must not erase the index for every readable sibling.
  if (before.size! > MAX_FILE_BYTES) return null;
  const read = await dependencies.read(candidate.absolutePath, MAX_FILE_BYTES + 1, access);
  abortIfNeeded(signal);
  assertScope();
  if (read.ok) assertContextLocalFilePath(map, read.path);
  if (!read.ok) return failSource(candidate, read.error.code);
  // Binary/media files still belong in the recursive Context graph. Keep the
  // structural node, but omit decoded bodies that are unsafe as physical text.
  if (unsafePhysicalText(read.content)) return null;
  const bytes = new TextEncoder().encode(read.content).byteLength;
  if (bytes > MAX_FILE_BYTES || bytes !== before.size) return fail('source_changed');
  const decision = classifyJarvisSource({
    path: candidate.absolutePath,
    root: map.rootDir,
    sizeBytes: bytes,
    channel: 'automatic_scan',
    kind: 'text',
    contentSample: read.content,
  });
  if (!decision.allowed) {
    // A discovered secret remains a structural node in the SiYuan graph, but
    // its body must never enter the model-searchable derivative index.
    if (decision.reason === 'secret_content' || decision.reason === 'secret_filename' ||
      decision.reason === 'credential_path') return null;
    return fail('source_denied');
  }
  const computedHash = await dependencies.hash(read.content);
  abortIfNeeded(signal);
  assertScope();
  const after = await dependencies.stat(candidate.absolutePath, true, access);
  abortIfNeeded(signal);
  assertScope();
  if (after.ok) assertContextLocalFilePath(map, after.path);
  if (
    !after.ok ||
    after.kind !== 'file' ||
    after.size !== before.size ||
    after.modifiedMs !== before.modifiedMs ||
    !rawHash(after) ||
    computedHash !== rawHash(after)
  ) {
    return fail('source_changed');
  }
  return Object.freeze({
    documentId: candidate.node.id,
    sourceId: candidate.node.id,
    title: candidate.node.title,
    path: candidate.relativePath,
    sourceType: 'local_file',
    body: read.content,
    tags: Object.freeze([]),
    properties: Object.freeze({}),
    updatedAt: Math.max(
      0,
      Math.floor(after.modifiedMs ?? candidate.node.modifiedAt ?? map.updatedAt),
    ),
    contentHash: computedHash.slice('sha256:'.length),
  });
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const prior = populationTail;
  let release!: () => void;
  populationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function createContextSearchIndexPopulationPort(
  input: Dependencies = {},
): ContextSearchIndexPopulationPort {
  const port = input.port ?? createTauriContextSearchIndexPort();
  const dependencies = {
    stat: input.stat ?? statProjectPath,
    read: input.read ?? readTextFileSample,
    hash: input.hash ?? sha256Text,
  };

  const deleteDocumentsBounded = async (
    accountId: string,
    mapId: string,
    documentIds: readonly string[],
  ) => {
    for (let offset = 0; offset < documentIds.length; offset += MAX_DELETE_BATCH_DOCUMENTS) {
      await port.deleteDocuments(
        accountId,
        mapId,
        documentIds.slice(offset, offset + MAX_DELETE_BATCH_DOCUMENTS),
      );
    }
  };

  const replaceDocumentsWithRetry = async (
    accountId: string,
    mapId: string,
    documents: readonly ContextSearchDocumentInput[],
    signal?: AbortSignal,
  ) => {
    for (let attempt = 0; ; attempt++) {
      abortIfNeeded(signal);
      try {
        return await port.replaceDocuments(accountId, mapId, documents);
      } catch (error) {
        // Windows can briefly deny a Tantivy segment while a merge closes it.
        // Replacement is idempotent by document ID; retry only that native
        // commit race, keeping every other failure and cancellation visible.
        const message = String(error);
        if (attempt >= 2 || !message.includes('context_search_commit:') ||
          !(/PermissionDenied|Access is denied/u.test(message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  };

  const cleanup = async (accountId: string, mapId: string, documentIds: readonly string[]) => {
    await deleteDocumentsBounded(accountId, mapId, documentIds);
    const status = await port.status(accountId, mapId);
    if (status.documentCount !== 0) fail('cleanup_failed');
  };

  const populate = async (
    accountId: string,
    map: ContextSearchIndexMap,
    signal?: AbortSignal,
  ): Promise<ContextSearchIndexReceipt> =>
    exclusive(async () => {
      abortIfNeeded(signal);
      if (!SAFE_ID.test(accountId)) fail('snapshot_invalid');
      const candidates = candidatesFor(map);
      const documentIds = candidates.map(({ node }) => node.id);
      let bodyBytes = 0;
      const existing = await port.status(accountId, map.id);
      if (existing.documentCount !== 0 || existing.needsRebuild) fail('not_empty');
      try {
        // This port is used for newly created maps and confirmed-empty repair.
        // Delete exact snapshot IDs first so retry is deterministic.
        if (documentIds.length > 0) {
          await deleteDocumentsBounded(accountId, map.id, documentIds);
        }
        const initial = await port.status(accountId, map.id);
        if (initial.documentCount !== 0 || initial.needsRebuild) fail('not_empty');
        let batch: ContextSearchDocumentInput[] = [];
        let batchBytes = 0;
        let affected = 0;
        const flush = async () => {
          if (batch.length === 0) return;
          abortIfNeeded(signal);
          const result = await replaceDocumentsWithRetry(accountId, map.id, batch, signal);
          if (result.affectedDocuments !== batch.length) fail('mutation_failed');
          affected += batch.length;
          batch = [];
          batchBytes = 0;
        };
        for (const candidate of candidates) {
          const document = await documentFor(map, candidate, dependencies, signal);
          if (!document) continue;
          const bytes = new TextEncoder().encode(document.body).byteLength;
          if (
            batch.length >= MAX_BATCH_DOCUMENTS ||
            (batch.length > 0 && batchBytes + bytes > MAX_BATCH_BODY_BYTES)
          ) {
            await flush();
          }
          batch.push(document);
          batchBytes += bytes;
          bodyBytes += bytes;
        }
        await flush();
        abortIfNeeded(signal);
        const final = await port.status(accountId, map.id);
        abortIfNeeded(signal);
        if (final.documentCount !== affected || final.needsRebuild) {
          fail('count_mismatch');
        }
        return Object.freeze({
          mapId: map.id,
          documentCount: affected,
          bodyBytes,
          status: 'ready' as const,
        });
      } catch (error) {
        await cleanup(accountId, map.id, documentIds).catch(() => fail('cleanup_failed'));
        throw error;
      }
    });

  const populationPort: ContextSearchIndexPopulationPort = {
    async stageChangedMap(accountId, map, changedIds, deletedIds, signal, options) {
      abortIfNeeded(signal);
      if (!SAFE_ID.test(accountId)) fail('snapshot_invalid');
      if (!port.beginRefresh || !port.stageRefresh || !port.finishRefresh) fail('atomic_refresh_unavailable');
      const changed = new Set(changedIds);
      const allCandidates = candidatesFor(map);
      const candidates = allCandidates.filter(({ node }) => changed.has(node.id));
      if (candidates.length !== changed.size || deletedIds.some((id) => !SAFE_ID.test(id))) fail('snapshot_invalid');
      if (options?.reconcileMembership && allCandidates.some(({ node }) => !changed.has(node.id)))
        fail('reconciliation_incomplete');
      const existing = await port.status(accountId, map.id);
      abortIfNeeded(signal);
      if (existing.needsRebuild) fail('rebuild_required');
      // A missing index must never be published with only its newest files.
      // Full changed coverage is safe, including the first files of an empty map.
      if (existing.documentCount === 0 && allCandidates.some(({ node }) => !changed.has(node.id)))
        fail('search_index_not_ready');
      const transactionId = await port.beginRefresh(accountId, map.id);
      let settled = false;
      const abort = async () => {
        if (settled) return;
        await port.finishRefresh!(accountId, map.id, transactionId, false);
        settled = true;
      };
      try {
        let documents: ContextSearchDocumentInput[] = [];
        let bytes = 0;
        let omitted: string[] = [];
        const flush = async () => {
          abortIfNeeded(signal);
          if (!documents.length && !omitted.length) return;
          await port.stageRefresh!(accountId, map.id, transactionId, documents, omitted);
          documents = []; omitted = []; bytes = 0;
        };
        for (const candidate of candidates) {
          const document = await documentFor(map, candidate, dependencies, signal);
          const size = document ? new TextEncoder().encode(document.body).byteLength : 0;
          if (documents.length + omitted.length >= MAX_BATCH_DOCUMENTS || bytes + size > MAX_BATCH_BODY_BYTES) await flush();
          if (document) { documents.push(document); bytes += size; }
          else omitted.push(candidate.node.id); // newly binary/secret bodies leave the searchable index
        }
        await flush();
        for (let offset = 0; offset < deletedIds.length; offset += MAX_DELETE_BATCH_DOCUMENTS) {
          abortIfNeeded(signal);
          await port.stageRefresh(accountId, map.id, transactionId, [], deletedIds.slice(offset, offset + MAX_DELETE_BATCH_DOCUMENTS));
        }
        if (options?.reconcileMembership) {
          abortIfNeeded(signal);
          await port.stageRefresh(
            accountId, map.id, transactionId, [], [], allCandidates.map(({ node }) => node.id),
          );
        }
        return {
          async commit() {
            abortIfNeeded(signal);
            if (settled) fail('refresh_settled');
            await port.finishRefresh!(accountId, map.id, transactionId, true);
            settled = true;
          },
          abort,
        };
      } catch (error) {
        try { await abort(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'context_search_refresh_abort_failed');
        }
        throw error;
      }
    },
    populateCreatedMap: populate,
    async repairEmptyMap(accountId, map, signal) {
      abortIfNeeded(signal);
      const status = await port.status(accountId, map.id);
      abortIfNeeded(signal);
      if (status.needsRebuild) fail('rebuild_required');
      if (status.documentCount !== 0) {
        return Object.freeze({
          mapId: map.id,
          documentCount: status.documentCount,
          bodyBytes: 0,
          status: 'already_populated' as const,
        });
      }
      return populate(accountId, map, signal);
    },
  };
  return Object.freeze(populationPort);
}
