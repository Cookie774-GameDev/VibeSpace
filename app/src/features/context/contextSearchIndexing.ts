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
const MAX_BATCH_DOCUMENTS = 8;
const MAX_MAP_DOCUMENTS = 1_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const SAFE_HASH = /^sha256:[a-f0-9]{64}$/u;

export interface ContextSearchIndexNode {
  id: string;
  kind: string;
  title: string;
  path?: string;
  modifiedAt?: number;
  children?: readonly ContextSearchIndexNode[];
}

export interface ContextSearchIndexMap {
  id: string;
  projectId: string | null;
  rootDir: string;
  status: 'active' | 'deleted';
  updatedAt: number;
  sourceType?: string;
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

function candidatesFor(map: ContextSearchIndexMap): Candidate[] {
  if (
    map.status !== 'active' ||
    !SAFE_ID.test(map.id) ||
    !map.rootDir ||
    !/^(?:[A-Za-z]:[\\/]|\/)/u.test(map.rootDir) ||
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
    .filter((node) => node.kind === 'file')
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
      return {
        node,
        relativePath: node.path,
        absolutePath: absolutePath(map.rootDir, node.path),
      };
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

async function documentFor(
  map: ContextSearchIndexMap,
  candidate: Candidate,
  dependencies: Required<Pick<Dependencies, 'stat' | 'read' | 'hash'>>,
  signal?: AbortSignal,
): Promise<ContextSearchDocumentInput> {
  abortIfNeeded(signal);
  const access = { root: map.rootDir, strictProjectBoundary: true };
  const before = await dependencies.stat(candidate.absolutePath, true, access);
  abortIfNeeded(signal);
  if (
    !before.ok ||
    before.kind !== 'file' ||
    !Number.isSafeInteger(before.size) ||
    (before.size ?? -1) < 0 ||
    (before.size ?? 0) > MAX_FILE_BYTES ||
    !rawHash(before)
  ) {
    return fail('source_invalid');
  }
  const read = await dependencies.read(candidate.absolutePath, MAX_FILE_BYTES + 1, access);
  abortIfNeeded(signal);
  if (!read.ok || read.content.includes('\uFFFD')) return fail('source_invalid');
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
  if (!decision.allowed) return fail('source_denied');
  const computedHash = await dependencies.hash(read.content);
  abortIfNeeded(signal);
  const after = await dependencies.stat(candidate.absolutePath, true, access);
  abortIfNeeded(signal);
  if (
    !after.ok ||
    after.kind !== 'file' ||
    after.size !== before.size ||
    after.modifiedMs !== before.modifiedMs ||
    rawHash(after) !== rawHash(before) ||
    computedHash !== rawHash(before)
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

  const cleanup = async (accountId: string, mapId: string, documentIds: readonly string[]) => {
    await port.deleteDocuments(accountId, mapId, documentIds);
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
          await port.deleteDocuments(accountId, map.id, documentIds);
        }
        const initial = await port.status(accountId, map.id);
        if (initial.documentCount !== 0 || initial.needsRebuild) fail('not_empty');
        let batch: ContextSearchDocumentInput[] = [];
        let batchBytes = 0;
        let affected = 0;
        const flush = async () => {
          if (batch.length === 0) return;
          abortIfNeeded(signal);
          const result = await port.replaceDocuments(accountId, map.id, batch);
          if (result.affectedDocuments !== batch.length) fail('mutation_failed');
          affected += batch.length;
          batch = [];
          batchBytes = 0;
        };
        for (const candidate of candidates) {
          const document = await documentFor(map, candidate, dependencies, signal);
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
        if (
          affected !== candidates.length ||
          final.documentCount !== candidates.length ||
          final.needsRebuild
        ) {
          fail('count_mismatch');
        }
        return Object.freeze({
          mapId: map.id,
          documentCount: candidates.length,
          bodyBytes,
          status: 'ready' as const,
        });
      } catch (error) {
        await cleanup(accountId, map.id, documentIds).catch(() => fail('cleanup_failed'));
        throw error;
      }
    });

  const populationPort: ContextSearchIndexPopulationPort = {
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
