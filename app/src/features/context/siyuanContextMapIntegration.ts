import { devConsole } from '@/features/dev-console';
import {
  createProductionSiyuanRlmPort,
  getProductionSiyuanRlmPort,
  type ProductionSiyuanRlmPort,
  type SiyuanManagedDocument,
} from './siyuanRlmProduction';
import type { ContextMapRecord, ContextTreeNode } from './tree';
import type { ProjectContextTree } from './tree';
import {
  createSiyuanMapManifest,
  readSiyuanMapManifest,
  SIYUAN_MANIFEST_BINDING_CACHE_LIMIT,
  updateSiyuanMapManifest,
  writeSiyuanMapManifest,
  type SiyuanMapManifest,
  type SiyuanSourcePolicy,
  type SiyuanSummaryPolicy,
} from './siyuan/siyuanMapManifest';
import {
  clearSiyuanNodeBindings,
  deleteSiyuanLegacyCleanupReceipt,
  deleteSiyuanNodeBindings,
  readSiyuanLegacyCleanupReceipts,
  readSiyuanNodeBindings,
  swapSiyuanNodeBindingWithCleanup,
  writeSiyuanNodeBindings,
} from './siyuan/siyuanBindingStore';
import {
  buildSiyuanSafeIndex,
  buildProjectContextTreeFromSiyuanIndex,
  scanSiyuanFilesystemIndex,
  type SiyuanIndexJobControl,
  type SiyuanDirectoryLister,
  type SiyuanSafeIndexEntry,
} from './siyuan/siyuanSafeIndex';
import {
  accountForSiyuanRendererOfflineTime,
  checkpointSiyuanIndexJob,
  readSiyuanIndexEntries,
  readSiyuanIndexJob,
  reconcileSiyuanIndexEntries,
  updateSiyuanIndexJobStatus,
  type SiyuanIndexJobArchive,
  type SiyuanIndexJobRecord,
} from './siyuan/siyuanIndexJobStore';
import {
  approvedCloudSiyuanSummaryIdentity,
  generateSiyuanSummaryWithApprovedCloudModel,
  generateSiyuanSummaryWithRegisteredLocalModel,
  resolveSiyuanSummaryIdentityForJob,
  runSiyuanSummaryPipeline,
} from './siyuan/siyuanSummaryPipeline';

const MAX_MARKDOWN_BYTES = 900_000;
// SiYuan's official create-document endpoint is idempotent for a stable path,
// so a bounded group can safely overlap native HTTP work.  Checkpoint every
// fulfilled member before surfacing a sibling failure; replay then recovers
// the same paths without duplicating documents.
const SIYUAN_NODE_WRITE_CONCURRENCY = 4;
const SIYUAN_FILE_BLOCK_BATCH_LIMIT = 64;
const SIYUAN_FILE_BLOCK_BATCH_BYTES = 262_144;

function sameSiyuanEntryRevision(left: SiyuanSafeIndexEntry, right: SiyuanSafeIndexEntry): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.parentNodeId === right.parentNodeId &&
    left.title === right.title &&
    left.kind === right.kind &&
    left.relativePath === right.relativePath &&
    left.sourcePointer === right.sourcePointer &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt
  );
}

function safeText(value: string, max = 500): string {
  return value
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, max);
}

function slug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 80) || 'map'
  );
}

function stableNodeSlug(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${slug(value).slice(0, 52)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function nodeStagingPath(
  record: ContextMapRecord,
  rootDocument: SiyuanManagedDocument,
  entry: SiyuanSafeIndexEntry,
): string {
  return `/VibeSpace Context Staging/${slug(record.id)}-${slug(rootDocument.id)}/${stableNodeSlug(entry.nodeId)}`;
}

const SIYUAN_NATIVE_DOCUMENT_ID = /^\d{14}-[a-z0-9]{7}$/u;

function nativeSiyuanDocumentSegments(path: string): readonly string[] | null {
  if (!path.startsWith('/') || !path.endsWith('.sy')) return null;
  const segments = path.slice(1, -3).split('/');
  return segments.length > 0 && segments.every((segment) => SIYUAN_NATIVE_DOCUMENT_ID.test(segment))
    ? segments
    : null;
}

function isInsideNativeSiyuanRoot(
  rootDocument: SiyuanManagedDocument,
  document: SiyuanManagedDocument,
): boolean | null {
  const rootSegments = nativeSiyuanDocumentSegments(rootDocument.path);
  const documentSegments = nativeSiyuanDocumentSegments(document.path);
  if (!rootSegments || !documentSegments) return null;
  if (document.notebookId !== rootDocument.notebookId) return false;
  // A file binding is a block inside its parent document, so getBlock returns
  // the parent's .sy path even though the block ID differs from the document ID.
  if (document.id === rootDocument.id || document.path === rootDocument.path) return true;
  return (
    documentSegments.length > rootSegments.length &&
    rootSegments.every((segment, index) => documentSegments[index] === segment)
  );
}

function siyuanErrorCode(error: unknown): string | null {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : null;
}

function isSiyuanBlockNotFoundError(error: unknown): boolean {
  return siyuanErrorCode(error) === 'siyuan_block_not_found';
}

function marker(mapId: string): string {
  return `vibespace-context-map:v1 map=${safeText(mapId, 200)}`;
}

function nodeMarker(mapId: string, nodeId: string): string {
  return `vibespace-context-node:v1 map=${safeText(mapId, 200)} node=${encodeURIComponent(nodeId).slice(0, 500)}`;
}

function nodeDocumentMarkdown(
  mapId: string,
  entry: SiyuanSafeIndexEntry,
  parentDocumentId: string,
): string {
  const lines = [
    `<!-- ${nodeMarker(mapId, entry.nodeId)} -->`,
    `# ${safeText(entry.title)}`,
    '',
    `> Read-only VibeSpace source index · ${entry.kind}`,
    '',
    `Parent: ((${parentDocumentId} \"Parent\"))`,
  ];
  if (entry.relativePath) lines.push(`Path: \`${inlineText(entry.relativePath, 2_000)}\``);
  if (entry.sourcePointer)
    lines.push(`Evidence pointer: \`${inlineText(entry.sourcePointer, 4_000)}\``);
  if (entry.sizeBytes !== null) lines.push(`Size: ${entry.sizeBytes} bytes`);
  if (entry.modifiedAt !== null) lines.push(`Modified: ${entry.modifiedAt}`);
  if (entry.summary) lines.push('', '## Summary', '', safeText(entry.summary, 4_000));
  return `${lines.join('\n')}\n`;
}

function nodeFileBlockMarkdown(
  mapId: string,
  entry: SiyuanSafeIndexEntry,
  parentDocumentId: string,
): string {
  const fields = [
    `**${safeText(entry.title)}**`,
    'Read-only VibeSpace source index · file',
    `Parent: ((${parentDocumentId} "Parent"))`,
  ];
  if (entry.relativePath) fields.push(`Path: \`${inlineText(entry.relativePath, 2_000)}\``);
  if (entry.sourcePointer)
    fields.push(`Evidence pointer: \`${inlineText(entry.sourcePointer, 4_000)}\``);
  if (entry.sizeBytes !== null) fields.push(`Size: ${entry.sizeBytes} bytes`);
  if (entry.modifiedAt !== null) fields.push(`Modified: ${entry.modifiedAt}`);
  if (entry.summary) fields.push(`Summary: ${safeText(entry.summary, 4_000)}`);
  fields.push(`\`${nodeMarker(mapId, entry.nodeId)}\``);
  return fields.join(' · ');
}

function isDocumentBackedEntry(entry: SiyuanSafeIndexEntry): boolean {
  return entry.kind !== 'file' || entry.parentNodeId === null;
}

function isBlockBackedFileEntry(entry: SiyuanSafeIndexEntry): boolean {
  return entry.kind === 'file' && entry.parentNodeId !== null;
}

function nodeManagedMarkdown(
  mapId: string,
  entry: SiyuanSafeIndexEntry,
  parentDocumentId: string,
): string {
  return isBlockBackedFileEntry(entry)
    ? nodeFileBlockMarkdown(mapId, entry, parentDocumentId)
    : nodeDocumentMarkdown(mapId, entry, parentDocumentId);
}

export async function clearArchivedSiyuanSummaryDocuments(
  projectId: string,
  mapId: string,
  archive: SiyuanIndexJobArchive,
  port: ProductionSiyuanRlmPort = createProductionSiyuanRlmPort(),
  options: Readonly<{
    operationTimeoutMs?: number;
    onProgress?: (progress: {
      phase: 'validating' | 'rewriting';
      completed: number;
      total: number;
    }) => void;
  }> = {},
): Promise<void> {
  if (archive.job.projectId !== projectId || archive.job.mapId !== mapId) {
    throw new Error('siyuan_summary_archive_scope_mismatch');
  }
  const manifest = readSiyuanMapManifest(projectId, mapId);
  if (!manifest?.rootDocumentId) throw new Error('siyuan_summary_root_document_missing');
  const bindings = await readSiyuanNodeBindings(projectId, mapId);
  const summarizedEntries = archive.entries.filter((entry) => Boolean(entry.summary));
  const operationTimeoutMs = Math.max(1, options.operationTimeoutMs ?? 15_000);
  const boundedOperation = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = globalThis.setTimeout(
            () => reject(new Error(`siyuan_summary_native_operation_timeout:${label}`)),
            operationTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  };
  const reportProgress = (phase: 'validating' | 'rewriting', completed: number, total: number) => {
    options.onProgress?.({ phase, completed, total });
    if (completed === total || completed % 25 === 0) {
      devConsole.log({
        channel: 'ai',
        level: 'info',
        message: 'SiYuan cloud summary reset progress',
        detail: { projectId, mapId, phase, completed, total },
      });
    }
  };
  for (const entry of summarizedEntries) {
    if (!bindings[entry.nodeId]) throw new Error('siyuan_summary_binding_missing');
  }
  const rewrites: Array<{
    current: SiyuanManagedDocument;
    markdown: string;
  }> = [];
  for (const [index, entry] of summarizedEntries.entries()) {
    const documentId = bindings[entry.nodeId]!;
    const current = await boundedOperation(
      port.getBlock(projectId, documentId),
      `read:${index + 1}`,
    );
    if (!current.markdown.includes(nodeMarker(mapId, entry.nodeId))) {
      throw new Error('siyuan_summary_binding_authority_mismatch');
    }
    const parentDocumentId = entry.parentNodeId
      ? bindings[entry.parentNodeId]
      : manifest.rootDocumentId;
    if (!parentDocumentId) throw new Error('siyuan_summary_parent_binding_missing');
    const { summaryState: _summaryState, ...withoutSummaryState } = entry;
    const markdown = nodeManagedMarkdown(
      mapId,
      { ...withoutSummaryState, summary: null },
      parentDocumentId,
    );
    rewrites.push({ current, markdown });
    reportProgress('validating', index + 1, summarizedEntries.length);
  }
  for (const [index, { current, markdown }] of rewrites.entries()) {
    if (current.markdown !== markdown) {
      await boundedOperation(
        port.updateManagedDocument(
          projectId,
          current.id,
          current.markdown,
          markdown,
          manifest.rootDocumentId ?? current.id,
        ),
        `write:${index + 1}`,
      );
    }
    reportProgress('rewriting', index + 1, rewrites.length);
  }
}

function encodeTree(tree: ProjectContextTree): string {
  const bytes = new TextEncoder().encode(JSON.stringify(tree));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function decodeTree(value: string): ProjectContextTree {
  const padded = `${value.replace(/-/gu, '+').replace(/_/gu, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ProjectContextTree;
  if (
    !parsed ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.nodes) ||
    typeof parsed.rootDir !== 'string' ||
    typeof parsed.fileCount !== 'number'
  ) {
    throw new Error('siyuan_context_map_payload_invalid');
  }
  return parsed;
}

function inlineText(value: string, max = 500): string {
  return safeText(value, max).replace(/[*`]/gu, '');
}

function nodeId(value: string, recordId: string, index: number): string {
  try {
    const decoded = decodeURIComponent(value).trim();
    if (decoded) return decoded.slice(0, 500);
  } catch {
    // A manually damaged identity marker receives a deterministic local fallback.
  }
  return `${recordId}-siyuan-${index}`;
}

function contextMapMarkdown(record: ContextMapRecord): string {
  const payload = encodeTree(record.tree);
  const lines = [
    `<!-- ${marker(record.id)} payload=${payload} -->`,
    `# ${safeText(record.name)}`,
    '',
    '> VibeSpace-managed SiYuan map root. Native child documents are the searchable graph nodes.',
    '',
    safeText(record.tree.summary, 2_000),
    '',
    `> Files: ${record.tree.fileCount} · Bytes: ${record.tree.totalBytes} · Generated: ${record.tree.generatedAt}`,
  ];
  if (new TextEncoder().encode(lines.join('\n')).byteLength >= MAX_MARKDOWN_BYTES) {
    throw new Error('siyuan_context_map_requires_sharding');
  }
  return `${lines.join('\n')}\n`;
}

export interface SiyuanContextMapSnapshot {
  document: SiyuanManagedDocument;
  tree: ProjectContextTree;
  manifest?: SiyuanMapManifest;
}

export interface SiyuanContextMapSyncOptions {
  accountId?: string | null;
  workspaceId?: string | null;
  summaryPolicy?: Readonly<Partial<SiyuanSummaryPolicy>>;
  sourcePolicy?: Readonly<Partial<SiyuanSourcePolicy>>;
  signal?: AbortSignal;
  control?: SiyuanIndexJobControl;
  list?: SiyuanDirectoryLister;
  forceReconcile?: boolean;
  approvalPreflight?: boolean;
  /** Rebuild structure on restore, then require an explicit user resume before any model runs. */
  pauseBeforeSummaries?: boolean;
  onIndexProgress?: (
    counts: Readonly<{
      indexed: number;
      excluded: number;
      unreadable: number;
    }>,
  ) => void;
}

export function assertSiyuanCloudApprovalPreflightReady(
  job: SiyuanIndexJobRecord | null,
  signal?: AbortSignal,
): asserts job is SiyuanIndexJobRecord {
  if (
    signal?.aborted ||
    !job ||
    job.status !== 'paused' ||
    job.phase !== 'summarizing' ||
    job.pauseReason !== 'cloud_approval_required'
  ) {
    throw new Error('siyuan_cloud_summary_approval_reconcile_interrupted');
  }
}

function parseContextMapMarkdown(
  document: SiyuanManagedDocument,
  record: ContextMapRecord,
): SiyuanContextMapSnapshot {
  if (!document.markdown.includes(marker(record.id))) {
    throw new Error('siyuan_context_map_marker_invalid');
  }
  const payloadMatch = /\bpayload=([A-Za-z0-9_-]+)\s*-->/u.exec(document.markdown);
  if (payloadMatch?.[1]) {
    return {
      document,
      tree: {
        ...decodeTree(payloadMatch[1]),
        model: 'siyuan-managed-v1',
      },
    };
  }
  const nodes: ContextTreeNode[] = [];
  const stack: Array<{ depth: number; node: ContextTreeNode }> = [];
  const linePattern =
    /^(\s*)- \*\*(.+?)\*\* \((root|area|file|symbol|note)\)(?: — `([^`]*)`)?(?:: (.*?))?\s*<!-- vibespace-node:([^ ]+) -->$/u;
  for (const line of document.markdown.split(/\r?\n/u)) {
    const match = linePattern.exec(line);
    if (!match) continue;
    const depth = Math.min(24, Math.floor((match[1]?.length ?? 0) / 2));
    const node: ContextTreeNode = {
      id: nodeId(match[6] ?? '', record.id, nodes.length + stack.length),
      title: inlineText(match[2] ?? 'Untitled', 500),
      kind: (match[3] ?? 'note') as ContextTreeNode['kind'],
      summary: match[5]
        ? inlineText(match[5], 1_500)
        : `${inlineText(match[2] ?? 'Untitled', 500)} in the SiYuan Context Map.`,
      ...(match[4] ? { path: inlineText(match[4], 1_000) } : {}),
    };
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    const parent = stack.at(-1)?.node;
    if (parent) {
      parent.children = [...(parent.children ?? []), node];
    } else {
      nodes.push(node);
    }
    stack.push({ depth, node });
  }
  if (record.tree.nodes.length > 0 && nodes.length === 0) {
    throw new Error('siyuan_context_map_graph_invalid');
  }
  return {
    document,
    tree: {
      ...record.tree,
      model: 'siyuan-managed-v1',
      nodes,
    },
  };
}

function isManagedDocumentAmbiguity(error: unknown): boolean {
  return siyuanErrorCode(error) === 'siyuan_managed_document_ambiguous';
}

async function readManagedDocumentWithDuplicateRecovery(
  port: ProductionSiyuanRlmPort,
  projectId: string,
  record: ContextMapRecord,
  boundDocumentIds: readonly string[] = [],
): Promise<SiyuanManagedDocument | null> {
  const lookup = { query: record.id, marker: marker(record.id) };
  try {
    return await port.readManagedDocument(projectId, lookup);
  } catch (error) {
    if (!isManagedDocumentAmbiguity(error)) throw error;
  }

  const summaries = await port.searchBlocks(projectId, record.id, 50);
  const candidates: SiyuanManagedDocument[] = [];
  for (const id of [...new Set(summaries.map((summary) => summary.id))]) {
    const block = await port.getBlock(projectId, id);
    if (block.markdown.includes(lookup.marker)) candidates.push(block);
  }
  const byNotebook = new Map<string, SiyuanManagedDocument[]>();
  for (const candidate of candidates) {
    const grouped = byNotebook.get(candidate.notebookId) ?? [];
    grouped.push(candidate);
    byNotebook.set(candidate.notebookId, grouped);
  }
  const duplicateGroups = [...byNotebook.values()].filter((group) => group.length > 1);
  if (duplicateGroups.length !== 1) throw new Error('siyuan_managed_document_ambiguous');
  const duplicateGroup = duplicateGroups[0]!;
  let bindingDocuments: SiyuanManagedDocument[] = [];
  if (boundDocumentIds.length > 0) {
    for (const id of [...new Set(boundDocumentIds)]) {
      try {
        bindingDocuments.push(await port.getBlock(projectId, id));
      } catch (error) {
        if (!isSiyuanBlockNotFoundError(error)) throw error;
      }
    }
    if (bindingDocuments.length === 0) throw new Error('siyuan_managed_document_ambiguous');
  }
  const bindingAuthorities = duplicateGroup.filter((candidate) => {
    if (bindingDocuments.length === 0) return false;
    const rootStem = candidate.path.endsWith('.sy') ? candidate.path.slice(0, -3) : '';
    if (!rootStem) return false;
    const childPrefix = `${rootStem}/`;
    return bindingDocuments.every(
      (document) =>
        document.notebookId === candidate.notebookId &&
        (document.id === candidate.id ||
          (document.path.startsWith(childPrefix) &&
            document.path.endsWith('.sy') &&
            !document.path.split('/').some((segment) => segment === '.' || segment === '..'))),
    );
  });
  if (bindingDocuments.length > 0 && bindingAuthorities.length !== 1) {
    throw new Error('siyuan_managed_document_ambiguous');
  }
  const sorted = [...duplicateGroup].sort((left, right) =>
    left.id.localeCompare(right.id, 'en-US'),
  );
  const canonical = bindingAuthorities[0] ?? sorted[0];
  if (!canonical) throw new Error('siyuan_managed_document_ambiguous');
  const duplicates = sorted.filter((candidate) => candidate.id !== canonical.id);
  for (const duplicate of duplicates) {
    await port.deleteManagedDocument(projectId, duplicate.id, duplicate.markdown, duplicate.id);
  }
  devConsole.log({
    channel: 'ai',
    level: 'warn',
    message: 'SiYuan Context map duplicates repaired',
    detail: { mapId: record.id, removed: duplicates.length },
  });
  return canonical;
}

export function createSiyuanContextMapIntegration(port: ProductionSiyuanRlmPort) {
  const warming = new Map<string, Promise<void>>();
  const synchronizing = new Map<string, Promise<SiyuanContextMapSnapshot>>();
  const syncControllers = new Map<string, AbortController>();
  const managedDocumentIds = new Map<string, string>();
  const documentKey = (projectId: string, mapId: string) => `${projectId}\u0000${mapId}`;

  const syncNativeNodeDocuments = async (
    projectId: string,
    record: ContextMapRecord,
    rootDocument: SiyuanManagedDocument,
    manifest: SiyuanMapManifest,
    options: SiyuanContextMapSyncOptions,
  ): Promise<{ manifest: SiyuanMapManifest; tree: ProjectContextTree }> => {
    const nativeFilesystemAvailable =
      typeof window !== 'undefined' &&
      '__TAURI_INTERNALS__' in window &&
      record.sourceType !== 'github_repository';
    const rendererStartedAt =
      typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
        ? performance.timeOrigin
        : Date.now();
    let durableJob: SiyuanIndexJobRecord | null = nativeFilesystemAvailable
      ? await readSiyuanIndexJob(projectId, record.id)
      : null;
    const needsResumeReconciliation = Boolean(
      durableJob &&
      (options.forceReconcile === true || (durableJob.reconciledAt ?? 0) < rendererStartedAt),
    );
    if (durableJob?.status === 'running') {
      const resumeNow = Date.now();
      const accounted = accountForSiyuanRendererOfflineTime(
        durableJob,
        rendererStartedAt,
        resumeNow,
      );
      if (accounted.pausedMs !== durableJob.pausedMs) {
        durableJob = accounted;
        await checkpointSiyuanIndexJob({ job: durableJob });
      }
    }
    const previousEntriesForForcedReconciliation =
      nativeFilesystemAvailable && durableJob && options.forceReconcile === true
        ? await readSiyuanIndexEntries(projectId, record.id)
        : null;
    let index = nativeFilesystemAvailable
      ? await scanSiyuanFilesystemIndex(record, manifest.summaryPolicy, {
          signal: options.signal,
          control: options.control,
          excludedPaths: manifest.sourcePolicy.excludedPaths,
          onProgress: options.onIndexProgress,
          durableJob:
            options.forceReconcile === true
              ? undefined
              : { accountId: options.accountId ?? null, projectId, mapId: record.id },
          list: options.list,
        })
      : buildSiyuanSafeIndex(record, manifest.summaryPolicy, manifest.sourcePolicy.excludedPaths);
    let forcedChangedEntries: SiyuanSafeIndexEntry[] = [];
    if (durableJob && previousEntriesForForcedReconciliation) {
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      const previousById = new Map(
        previousEntriesForForcedReconciliation.map((entry) => [entry.nodeId, entry]),
      );
      const reconciledEntries = index.entries.map((entry) => {
        const previous = previousById.get(entry.nodeId);
        return previous && sameSiyuanEntryRevision(previous, entry)
          ? { ...entry, summary: previous.summary, summaryState: previous.summaryState }
          : entry;
      });
      forcedChangedEntries = reconciledEntries.filter((entry) => {
        const previous = previousById.get(entry.nodeId);
        return !previous || !sameSiyuanEntryRevision(previous, entry);
      });
      const activeReconciledNodeIds = new Set(reconciledEntries.map((entry) => entry.nodeId));
      const removedReconciledNodeIds = previousEntriesForForcedReconciliation
        .filter((entry) => !activeReconciledNodeIds.has(entry.nodeId))
        .map((entry) => entry.nodeId);
      index = Object.freeze({
        ...index,
        entries: Object.freeze(reconciledEntries) as SiyuanSafeIndexEntry[],
        summarized: reconciledEntries.filter((entry) => entry.summaryState === 'completed').length,
      });
      const reconciledJob: SiyuanIndexJobRecord = {
        ...durableJob,
        phase: 'creating_nodes',
        indexed: reconciledEntries.length,
        excluded: index.excluded,
        unreadable: index.unreadable,
        summarized: index.summarized,
        updatedAt: Date.now(),
        completedAt: null,
        reconciledAt: Date.now(),
        pendingNativeNodeIds: [
          ...new Set([
            ...durableJob.pendingNativeNodeIds.filter((nodeId) =>
              activeReconciledNodeIds.has(nodeId),
            ),
            ...forcedChangedEntries.map((entry) => entry.nodeId),
          ]),
        ],
      };
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      const persistedReconciledJob = await reconcileSiyuanIndexEntries(
        projectId,
        record.id,
        forcedChangedEntries,
        removedReconciledNodeIds,
        reconciledJob,
      );
      durableJob = persistedReconciledJob ?? reconciledJob;
      if (durableJob.status !== 'running') {
        throw new Error(
          durableJob.status === 'cancelled' ? 'siyuan_index_cancelled' : 'siyuan_index_paused',
        );
      }
    }
    const bindings: Record<string, string> = {
      ...manifest.nodeBindings,
      ...(await readSiyuanNodeBindings(projectId, record.id)),
    };
    const createDocumentBackedNode = async (
      entry: SiyuanSafeIndexEntry,
      parentDocumentId: string,
      markdown: string,
    ): Promise<SiyuanManagedDocument> => {
      const input = {
        parentId: parentDocumentId,
        path: nodeStagingPath(record, rootDocument, entry),
        markdown,
        marker: nodeMarker(record.id, entry.nodeId),
      };
      if (port.createManagedDocumentUnderParent) {
        return port.createManagedDocumentUnderParent(projectId, rootDocument.id, input);
      }
      if (port.createManagedDocumentsUnderParents) {
        const results = await port.createManagedDocumentsUnderParents(projectId, rootDocument.id, [
          input,
        ]);
        if (results.length !== 1) {
          throw new Error('siyuan_managed_document_batch_response_invalid');
        }
        const result = results[0]!;
        if (!result.ok) throw result.error;
        return result.document;
      }
      if (nativeSiyuanDocumentSegments(rootDocument.path)) {
        throw new Error('siyuan_managed_document_under_parent_unavailable');
      }
      return port.createManagedDocument(
        projectId,
        `/VibeSpace Context Maps/${slug(record.name)}-${slug(record.id)}/Nodes/${slug(entry.title)}-${stableNodeSlug(entry.nodeId)}`,
        markdown,
      );
    };
    for (const cleanup of await readSiyuanLegacyCleanupReceipts(projectId, record.id)) {
      if (
        cleanup.mapRootId !== rootDocument.id ||
        !cleanup.expectedMarkdown.includes(nodeMarker(record.id, cleanup.nodeId))
      ) {
        throw new Error('siyuan_legacy_cleanup_authority_invalid');
      }
      try {
        const legacyDocument = await port.getBlock(projectId, cleanup.legacyDocumentId);
        if (
          legacyDocument.id !== cleanup.legacyDocumentId ||
          legacyDocument.path !== rootDocument.path ||
          legacyDocument.markdown !== cleanup.expectedMarkdown
        ) {
          throw new Error('siyuan_legacy_cleanup_authority_invalid');
        }
        await port.deleteManagedDocument(
          projectId,
          cleanup.legacyDocumentId,
          cleanup.expectedMarkdown,
          rootDocument.id,
        );
      } catch (error) {
        if (!isSiyuanBlockNotFoundError(error)) throw error;
      }
      await deleteSiyuanLegacyCleanupReceipt(
        projectId,
        record.id,
        cleanup.nodeId,
        cleanup.legacyDocumentId,
      );
    }
    const staleBindingNodeIds: string[] = [];
    const legacyRootFileBindings: Array<{
      entry: SiyuanSafeIndexEntry;
      document: SiyuanManagedDocument;
    }> = [];
    if (nativeSiyuanDocumentSegments(rootDocument.path)) {
      for (const entry of index.entries) {
        const documentId = bindings[entry.nodeId];
        if (!documentId) continue;
        try {
          const document = await port.getBlock(projectId, documentId);
          if (isInsideNativeSiyuanRoot(rootDocument, document) === false) {
            staleBindingNodeIds.push(entry.nodeId);
          } else if (
            entry.kind === 'file' &&
            entry.parentNodeId === null &&
            document.id !== rootDocument.id &&
            document.path === rootDocument.path
          ) {
            legacyRootFileBindings.push({ entry, document });
          }
        } catch (error) {
          // Only an exact not-found code proves the saved target is gone.
          // Transport and response-shape failures remain fail-closed because
          // they cannot authorize detaching a potentially live binding.
          if (!isSiyuanBlockNotFoundError(error)) throw error;
          staleBindingNodeIds.push(entry.nodeId);
        }
      }
    }
    if (staleBindingNodeIds.length > 0) {
      for (const nodeId of staleBindingNodeIds) delete bindings[nodeId];
      await deleteSiyuanNodeBindings(projectId, record.id, staleBindingNodeIds);
      devConsole.log({
        channel: 'ai',
        level: 'warn',
        message: 'SiYuan stale node bindings detached from the active map root',
        detail: { mapId: record.id, detached: staleBindingNodeIds.length },
      });
    }
    for (const { entry, document: legacyDocument } of legacyRootFileBindings) {
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      const markdown = nodeDocumentMarkdown(record.id, entry, rootDocument.id);
      // Legacy versions appended a root-level file as a block inside the map
      // root. Create the stable child document first, durably swap the binding,
      // and only then retire the owned legacy block. The native under-parent
      // command is marker-idempotent, so a crash before the checkpoint safely
      // recovers the same child document on the next run.
      const replacement = await createDocumentBackedNode(entry, rootDocument.id, markdown);
      await swapSiyuanNodeBindingWithCleanup(projectId, record.id, {
        nodeId: entry.nodeId,
        replacementDocumentId: replacement.id,
        legacyDocumentId: legacyDocument.id,
        expectedMarkdown: legacyDocument.markdown,
        mapRootId: rootDocument.id,
      });
      bindings[entry.nodeId] = replacement.id;
      try {
        await port.deleteManagedDocument(
          projectId,
          legacyDocument.id,
          legacyDocument.markdown,
          rootDocument.id,
        );
      } catch (error) {
        if (!isSiyuanBlockNotFoundError(error)) throw error;
      }
      await deleteSiyuanLegacyCleanupReceipt(projectId, record.id, entry.nodeId, legacyDocument.id);
    }
    const previouslyBoundNodeIds = new Set(Object.keys(bindings));
    durableJob = nativeFilesystemAvailable ? await readSiyuanIndexJob(projectId, record.id) : null;
    if (durableJob) {
      const resumeNow = Date.now();
      const phaseChanged = durableJob.phase !== 'creating_nodes';
      const needsInitialRateSample = phaseChanged || durableJob.rateSamples.length === 0;
      const phaseStartedAt = needsInitialRateSample ? resumeNow : durableJob.phaseStartedAt;
      durableJob = {
        ...durableJob,
        phase: 'creating_nodes',
        status: 'running',
        createdNodes: Object.keys(bindings).length,
        updatedAt: resumeNow,
        completedAt: null,
        phaseStartedAt,
        rateSamples: needsInitialRateSample
          ? [{ at: phaseStartedAt, processed: Object.keys(bindings).length }]
          : durableJob.rateSamples,
        estimatedPercent: Math.max(durableJob.estimatedPercent ?? 0, 25),
        estimatedEtaSeconds: null,
      };
      await checkpointSiyuanIndexJob({ job: durableJob });
    }
    let activeNodeIds = new Set(index.entries.map((entry) => entry.nodeId));
    const documentPromises = new Map<string, Promise<string>>();
    const unboundEntries = index.entries.filter((entry) => !bindings[entry.nodeId]);
    // A root-level file cannot be an appended block in the map-root document:
    // refreshing the authoritative map payload replaces that document body and
    // would invalidate the persisted child-block ID. Keep only nested files on
    // the bounded block path; root-level files receive stable child documents.
    const unboundDocumentEntries = unboundEntries.filter(isDocumentBackedEntry);
    const unboundFileEntries = unboundEntries.filter(isBlockBackedFileEntry);
    const checkpointCompletedNodes = async (completedBatch: Record<string, string>) => {
      Object.assign(bindings, completedBatch);
      if (Object.keys(completedBatch).length > 0) {
        await writeSiyuanNodeBindings(projectId, record.id, completedBatch);
      }
      if (durableJob) {
        const sampledAt = Date.now();
        const completedNodeIds = new Set(Object.keys(completedBatch));
        durableJob = {
          ...durableJob,
          createdNodes: Object.keys(bindings).length,
          updatedAt: sampledAt,
          rateSamples: [
            ...durableJob.rateSamples,
            { at: sampledAt, processed: Object.keys(bindings).length },
          ].slice(-20),
          estimatedPercent: Math.max(
            durableJob.estimatedPercent ?? 0,
            durableJob.indexed > 0
              ? 25 + Math.min(1, Object.keys(bindings).length / durableJob.indexed) * 65
              : 25,
          ),
          pendingNativeNodeIds: durableJob.pendingNativeNodeIds.filter(
            (nodeId) => !completedNodeIds.has(nodeId),
          ),
        };
        await checkpointSiyuanIndexJob({ job: durableJob });
      }
    };
    const recoverCreatedNode = async (entry: SiyuanSafeIndexEntry, markdown: string) => {
      const existing = await port.readManagedDocument(projectId, {
        query: entry.nodeId,
        marker: nodeMarker(record.id, entry.nodeId),
      });
      if (!existing) return null;
      return existing.markdown === markdown
        ? existing
        : await port.updateManagedDocument(
            projectId,
            existing.id,
            existing.markdown,
            markdown,
            rootDocument.id,
          );
    };
    if (port.createManagedDocumentsUnderParents || port.createManagedDocuments) {
      const pendingEntries = new Map(unboundDocumentEntries.map((entry) => [entry.nodeId, entry]));
      while (pendingEntries.size > 0) {
        await options.control?.checkpoint(options.signal);
        if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
        const batch = [...pendingEntries.values()]
          .filter((entry) => !entry.parentNodeId || Boolean(bindings[entry.parentNodeId]))
          .slice(0, SIYUAN_NODE_WRITE_CONCURRENCY);
        if (batch.length === 0) throw new Error('siyuan_node_parent_binding_unavailable');
        const requests = batch.map((entry) => {
          const parentId = entry.parentNodeId ? bindings[entry.parentNodeId]! : rootDocument.id;
          return {
            parentId,
            path: port.createManagedDocumentsUnderParents
              ? nodeStagingPath(record, rootDocument, entry)
              : `/VibeSpace Context Maps/${slug(record.name)}-${slug(record.id)}/Nodes/${slug(entry.title)}-${stableNodeSlug(entry.nodeId)}`,
            markdown: nodeDocumentMarkdown(record.id, entry, parentId),
            marker: nodeMarker(record.id, entry.nodeId),
          };
        });
        const results = port.createManagedDocumentsUnderParents
          ? await port.createManagedDocumentsUnderParents(projectId, rootDocument.id, requests)
          : await port.createManagedDocuments!(projectId, requests);
        if (results.length !== batch.length) {
          throw new Error('siyuan_managed_document_batch_response_invalid');
        }
        const completedBatch: Record<string, string> = {};
        let firstError: unknown;
        for (let index = 0; index < batch.length; index += 1) {
          const entry = batch[index]!;
          const request = requests[index]!;
          const result = results[index]!;
          if (result.ok) {
            completedBatch[entry.nodeId] = result.document.id;
            continue;
          }
          try {
            const recovered = await recoverCreatedNode(entry, request.markdown);
            if (recovered) completedBatch[entry.nodeId] = recovered.id;
            else firstError ??= result.error;
          } catch (recoveryError) {
            firstError ??= recoveryError;
          }
        }
        await checkpointCompletedNodes(completedBatch);
        for (const nodeId of Object.keys(completedBatch)) pendingEntries.delete(nodeId);
        if (firstError !== undefined) throw firstError;
      }
    } else {
      for (
        let cursor = 0;
        cursor < unboundDocumentEntries.length;
        cursor += SIYUAN_NODE_WRITE_CONCURRENCY
      ) {
        await options.control?.checkpoint(options.signal);
        if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
        const batch = unboundDocumentEntries.slice(cursor, cursor + SIYUAN_NODE_WRITE_CONCURRENCY);
        const tasks = batch.map((entry) => {
          const parentPromise = entry.parentNodeId
            ? (documentPromises.get(entry.parentNodeId) ??
              Promise.resolve(bindings[entry.parentNodeId] ?? rootDocument.id))
            : Promise.resolve(rootDocument.id);
          const task = (async (): Promise<readonly [string, string]> => {
            const parentDocumentId = await parentPromise;
            if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
            const markdown = nodeDocumentMarkdown(record.id, entry, parentDocumentId);
            let document: SiyuanManagedDocument;
            try {
              // A stable SiYuan path makes the normal first-index path one
              // native mutation instead of a serialized search plus mutation.
              // If a crash occurred after SiYuan committed but before our
              // IndexedDB binding checkpoint, recover the exact marker below.
              document = port.createManagedDocumentUnderParent
                ? await port.createManagedDocumentUnderParent(projectId, rootDocument.id, {
                    parentId: parentDocumentId,
                    path: nodeStagingPath(record, rootDocument, entry),
                    markdown,
                    marker: nodeMarker(record.id, entry.nodeId),
                  })
                : await port.createManagedDocument(
                    projectId,
                    `/VibeSpace Context Maps/${slug(record.name)}-${slug(record.id)}/Nodes/${slug(entry.title)}-${stableNodeSlug(entry.nodeId)}`,
                    markdown,
                  );
            } catch (createError) {
              const existing = await recoverCreatedNode(entry, markdown);
              if (!existing) throw createError;
              document = existing;
            }
            return [entry.nodeId, document.id] as const;
          })();
          if (isDocumentBackedEntry(entry)) {
            documentPromises.set(
              entry.nodeId,
              task.then(([, documentId]) => documentId),
            );
          }
          return task;
        });
        const settledBatch = await Promise.allSettled(tasks);
        const completedBatch = Object.fromEntries(
          settledBatch.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        );
        await checkpointCompletedNodes(completedBatch);
        const failedTask = settledBatch.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failedTask) throw failedTask.reason;
      }
    }
    if (port.appendManagedBlocks) {
      const pendingAtResume = new Set(durableJob?.pendingNativeNodeIds ?? []);
      for (const entry of unboundFileEntries.filter((candidate) =>
        pendingAtResume.has(candidate.nodeId),
      )) {
        await options.control?.checkpoint(options.signal);
        if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
        const parentDocumentId = entry.parentNodeId
          ? bindings[entry.parentNodeId]
          : rootDocument.id;
        if (!parentDocumentId) throw new Error('siyuan_node_parent_binding_unavailable');
        const markdown = nodeFileBlockMarkdown(record.id, entry, parentDocumentId);
        // The exact parent is the receipt authority. Read it before global
        // search so a slow or unavailable full-text index cannot strand a
        // definitely uncommitted append after restart.
        let parent: SiyuanManagedDocument;
        try {
          parent = await port.getBlock(projectId, parentDocumentId);
        } catch {
          throw new Error('siyuan_native_block_recovery_inconclusive');
        }
        if (parent.markdown.includes(nodeMarker(record.id, entry.nodeId))) {
          const recovered = await recoverCreatedNode(entry, markdown);
          if (!recovered) throw new Error('siyuan_native_block_recovery_inconclusive');
          await checkpointCompletedNodes({ [entry.nodeId]: recovered.id });
          continue;
        }
        if (durableJob) {
          durableJob = {
            ...durableJob,
            updatedAt: Date.now(),
            pendingNativeNodeIds: durableJob.pendingNativeNodeIds.filter(
              (nodeId) => nodeId !== entry.nodeId,
            ),
          };
          await checkpointSiyuanIndexJob({ job: durableJob });
        }
      }

      const remainingFiles = unboundFileEntries.filter((entry) => !bindings[entry.nodeId]);
      let fileCursor = 0;
      while (fileCursor < remainingFiles.length) {
        await options.control?.checkpoint(options.signal);
        if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
        const batch: Array<{
          entry: SiyuanSafeIndexEntry;
          parentId: string;
          markdown: string;
        }> = [];
        let batchBytes = 0;
        while (fileCursor < remainingFiles.length && batch.length < SIYUAN_FILE_BLOCK_BATCH_LIMIT) {
          const entry = remainingFiles[fileCursor]!;
          const parentId = entry.parentNodeId ? bindings[entry.parentNodeId] : rootDocument.id;
          if (!parentId) throw new Error('siyuan_node_parent_binding_unavailable');
          const markdown = nodeFileBlockMarkdown(record.id, entry, parentId);
          const markdownBytes = new TextEncoder().encode(markdown).byteLength;
          if (markdownBytes > SIYUAN_FILE_BLOCK_BATCH_BYTES) {
            throw new Error('siyuan_file_block_too_large');
          }
          if (batch.length > 0 && batchBytes + markdownBytes > SIYUAN_FILE_BLOCK_BATCH_BYTES) break;
          batch.push({ entry, parentId, markdown });
          batchBytes += markdownBytes;
          fileCursor += 1;
        }
        if (batch.length === 0) throw new Error('siyuan_file_block_batch_empty');
        if (durableJob) {
          durableJob = {
            ...durableJob,
            updatedAt: Date.now(),
            pendingNativeNodeIds: [
              ...new Set([
                ...durableJob.pendingNativeNodeIds,
                ...batch.map(({ entry }) => entry.nodeId),
              ]),
            ],
          };
          await checkpointSiyuanIndexJob({ job: durableJob });
        }
        await options.control?.checkpoint(options.signal);
        if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
        const ids = await port.appendManagedBlocks(
          projectId,
          rootDocument.id,
          batch.map(({ parentId, markdown }) => ({ parentId, markdown })),
        );
        if (ids.length !== batch.length || new Set(ids).size !== ids.length) {
          throw new Error('siyuan_managed_block_batch_response_invalid');
        }
        await checkpointCompletedNodes(
          Object.fromEntries(batch.map(({ entry }, index) => [entry.nodeId, ids[index]!])),
        );
      }
    } else {
      for (const entry of unboundFileEntries) {
        await options.control?.checkpoint(options.signal);
        if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
        const parentDocumentId = entry.parentNodeId
          ? bindings[entry.parentNodeId]
          : rootDocument.id;
        if (!parentDocumentId) throw new Error('siyuan_node_parent_binding_unavailable');
        const markdown = nodeDocumentMarkdown(record.id, entry, parentDocumentId);
        let document: SiyuanManagedDocument;
        try {
          document = await port.createManagedDocument(
            projectId,
            `/VibeSpace Context Maps/${slug(record.name)}-${slug(record.id)}/Nodes/${slug(entry.title)}-${stableNodeSlug(entry.nodeId)}`,
            markdown,
          );
        } catch (createError) {
          const existing = await recoverCreatedNode(entry, markdown);
          if (!existing) throw createError;
          document = existing;
        }
        await checkpointCompletedNodes({ [entry.nodeId]: document.id });
      }
    }
    const pendingNativeNodeIds = new Set(durableJob?.pendingNativeNodeIds ?? []);
    for (const entry of index.entries.filter(
      (candidate) =>
        previouslyBoundNodeIds.has(candidate.nodeId) && pendingNativeNodeIds.has(candidate.nodeId),
    )) {
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      const documentId = bindings[entry.nodeId];
      if (!documentId) continue;
      const parentDocumentId = entry.parentNodeId
        ? (bindings[entry.parentNodeId] ?? rootDocument.id)
        : rootDocument.id;
      const markdown = nodeManagedMarkdown(record.id, entry, parentDocumentId);
      try {
        const current = await port.getBlock(projectId, documentId);
        if (current.markdown !== markdown) {
          await port.updateManagedDocument(
            projectId,
            current.id,
            current.markdown,
            markdown,
            rootDocument.id,
          );
        }
      } catch (error) {
        if (!isSiyuanBlockNotFoundError(error)) throw error;
        delete bindings[entry.nodeId];
        await deleteSiyuanNodeBindings(projectId, record.id, [entry.nodeId]);
        let recovered;
        try {
          if (isBlockBackedFileEntry(entry) && port.appendManagedBlocks) {
            const ids = await port.appendManagedBlocks(projectId, rootDocument.id, [
              { parentId: parentDocumentId, markdown },
            ]);
            if (ids.length !== 1) throw new Error('siyuan_managed_block_batch_response_invalid');
            recovered = await port.getBlock(projectId, ids[0]!);
          } else {
            recovered = await createDocumentBackedNode(entry, parentDocumentId, markdown);
          }
        } catch (createError) {
          const existing = await port.readManagedDocument(projectId, {
            query: entry.nodeId,
            marker: nodeMarker(record.id, entry.nodeId),
          });
          if (!existing) throw createError;
          recovered =
            existing.markdown === markdown
              ? existing
              : await port.updateManagedDocument(
                  projectId,
                  existing.id,
                  existing.markdown,
                  markdown,
                  rootDocument.id,
                );
        }
        bindings[entry.nodeId] = recovered.id;
        await writeSiyuanNodeBindings(projectId, record.id, { [entry.nodeId]: recovered.id });
      }
      if (durableJob) {
        durableJob = {
          ...durableJob,
          updatedAt: Date.now(),
          pendingNativeNodeIds: durableJob.pendingNativeNodeIds.filter(
            (nodeId) => nodeId !== entry.nodeId,
          ),
        };
        await checkpointSiyuanIndexJob({ job: durableJob });
      }
    }
    if (durableJob && needsResumeReconciliation && options.forceReconcile !== true) {
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      const freshIndex = await scanSiyuanFilesystemIndex(record, manifest.summaryPolicy, {
        signal: options.signal,
        control: options.control,
        excludedPaths: manifest.sourcePolicy.excludedPaths,
        list: options.list,
      });
      const previousById = new Map(index.entries.map((entry) => [entry.nodeId, entry]));
      const reconciledEntries = freshIndex.entries.map((entry) => {
        const previous = previousById.get(entry.nodeId);
        return previous && sameSiyuanEntryRevision(previous, entry)
          ? { ...entry, summary: previous.summary, summaryState: previous.summaryState }
          : entry;
      });
      const changedEntries = reconciledEntries.filter((entry) => {
        const previous = previousById.get(entry.nodeId);
        return !previous || !sameSiyuanEntryRevision(previous, entry);
      });
      const activeReconciledNodeIds = new Set(reconciledEntries.map((entry) => entry.nodeId));
      const removedReconciledNodeIds = index.entries
        .filter((entry) => !activeReconciledNodeIds.has(entry.nodeId))
        .map((entry) => entry.nodeId);
      const snapshotChanged =
        changedEntries.length > 0 ||
        reconciledEntries.length !== index.entries.length ||
        freshIndex.excluded !== index.excluded ||
        freshIndex.unreadable !== index.unreadable;
      if (snapshotChanged) {
        index = Object.freeze({
          ...freshIndex,
          entries: Object.freeze(reconciledEntries) as SiyuanSafeIndexEntry[],
          summarized: reconciledEntries.filter((entry) => entry.summaryState === 'completed')
            .length,
        });
        activeNodeIds = new Set(reconciledEntries.map((entry) => entry.nodeId));
        const reconciledJob: SiyuanIndexJobRecord = {
          ...durableJob,
          phase: 'creating_nodes',
          indexed: reconciledEntries.length,
          excluded: freshIndex.excluded,
          unreadable: freshIndex.unreadable,
          summarized: index.summarized,
          updatedAt: Date.now(),
          completedAt: null,
          reconciledAt: Date.now(),
          pendingNativeNodeIds: [
            ...new Set([
              ...durableJob.pendingNativeNodeIds.filter((nodeId) =>
                activeReconciledNodeIds.has(nodeId),
              ),
              ...changedEntries.map((entry) => entry.nodeId),
            ]),
          ],
        };
        const persistedReconciledJob = await reconcileSiyuanIndexEntries(
          projectId,
          record.id,
          changedEntries,
          removedReconciledNodeIds,
          reconciledJob,
        );
        durableJob = persistedReconciledJob ?? reconciledJob;
        if (durableJob.status !== 'running') {
          throw new Error(
            durableJob.status === 'cancelled' ? 'siyuan_index_cancelled' : 'siyuan_index_paused',
          );
        }

        for (const entry of changedEntries) {
          await options.control?.checkpoint(options.signal);
          if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
          const parentDocumentId = entry.parentNodeId
            ? (bindings[entry.parentNodeId] ?? rootDocument.id)
            : rootDocument.id;
          const markdown = nodeManagedMarkdown(record.id, entry, parentDocumentId);
          let documentId: string | undefined = bindings[entry.nodeId];
          if (documentId) {
            try {
              const current = await port.getBlock(projectId, documentId);
              if (current.markdown !== markdown) {
                await port.updateManagedDocument(
                  projectId,
                  current.id,
                  current.markdown,
                  markdown,
                  rootDocument.id,
                );
              }
            } catch (error) {
              if (!isSiyuanBlockNotFoundError(error)) {
                throw error;
              }
              delete bindings[entry.nodeId];
              await deleteSiyuanNodeBindings(projectId, record.id, [entry.nodeId]);
              documentId = undefined;
            }
          }
          if (!documentId) {
            try {
              if (isBlockBackedFileEntry(entry) && port.appendManagedBlocks) {
                const ids = await port.appendManagedBlocks(projectId, rootDocument.id, [
                  { parentId: parentDocumentId, markdown },
                ]);
                if (ids.length !== 1) {
                  throw new Error('siyuan_managed_block_batch_response_invalid');
                }
                documentId = ids[0]!;
              } else {
                const created = await createDocumentBackedNode(entry, parentDocumentId, markdown);
                documentId = created.id;
              }
            } catch (createError) {
              const existing = await port.readManagedDocument(projectId, {
                query: entry.nodeId,
                marker: nodeMarker(record.id, entry.nodeId),
              });
              if (!existing) throw createError;
              documentId = existing.id;
              if (existing.markdown !== markdown) {
                await port.updateManagedDocument(
                  projectId,
                  existing.id,
                  existing.markdown,
                  markdown,
                  rootDocument.id,
                );
              }
            }
            bindings[entry.nodeId] = documentId;
            await writeSiyuanNodeBindings(projectId, record.id, {
              [entry.nodeId]: documentId,
            });
          }
          durableJob = {
            ...durableJob,
            updatedAt: Date.now(),
            pendingNativeNodeIds: durableJob.pendingNativeNodeIds.filter(
              (nodeId) => nodeId !== entry.nodeId,
            ),
          };
          await checkpointSiyuanIndexJob({ job: durableJob });
        }
      }
      if (!snapshotChanged) {
        durableJob = { ...durableJob, reconciledAt: Date.now(), updatedAt: Date.now() };
        await checkpointSiyuanIndexJob({ job: durableJob });
      }
    }
    const removedUnboundCandidate = previousEntriesForForcedReconciliation?.find(
      (entry) => !activeNodeIds.has(entry.nodeId) && !bindings[entry.nodeId],
    );
    if (removedUnboundCandidate) {
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      const marker = nodeMarker(record.id, removedUnboundCandidate.nodeId);
      const stale = await port.readManagedDocument(projectId, {
        query: removedUnboundCandidate.nodeId,
        marker,
      });
      if (stale?.markdown.includes(marker)) {
        await port.deleteManagedDocument(projectId, stale.id, stale.markdown, rootDocument.id);
      }
    }
    const removedNodeIds: string[] = [];
    for (const [nodeId, documentId] of Object.entries(bindings)) {
      await options.control?.checkpoint(options.signal);
      if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
      if (activeNodeIds.has(nodeId)) continue;
      try {
        const stale = await port.getBlock(projectId, documentId);
        if (stale.markdown.includes(nodeMarker(record.id, nodeId))) {
          await port.deleteManagedDocument(projectId, stale.id, stale.markdown, rootDocument.id);
          delete bindings[nodeId];
          removedNodeIds.push(nodeId);
        }
      } catch {
        // Preserve the binding so a transient runtime/permission failure is
        // retried instead of orphaning managed SiYuan evidence.
      }
    }
    await deleteSiyuanNodeBindings(projectId, record.id, removedNodeIds);
    if (durableJob) {
      durableJob = {
        ...durableJob,
        phase: manifest.summaryPolicy.mode === 'none' ? 'reconciling' : 'summarizing',
        createdNodes: Object.keys(bindings).length,
        updatedAt: Date.now(),
        phaseStartedAt: Date.now(),
        rateSamples: [{ at: Date.now(), processed: Object.keys(bindings).length }],
        estimatedPercent: Math.max(
          durableJob.estimatedPercent ?? 0,
          manifest.summaryPolicy.mode === 'none' ? 99 : 90,
        ),
        estimatedEtaSeconds: null,
      };
      await checkpointSiyuanIndexJob({ job: durableJob });
    }
    if (
      durableJob &&
      manifest.summaryPolicy.mode !== 'none' &&
      (options.approvalPreflight === true || options.pauseBeforeSummaries === true)
    ) {
      const approvalPreflight = options.approvalPreflight === true;
      durableJob = {
        ...durableJob,
        phase: 'summarizing',
        status: 'paused',
        pauseReason: approvalPreflight ? 'cloud_approval_required' : 'user',
        updatedAt: Date.now(),
        phaseStartedAt: Date.now(),
        rateSamples: [{ at: Date.now(), processed: durableJob.summarized }],
      };
      await checkpointSiyuanIndexJob({ job: durableJob }, { forceStatus: true });
      throw new Error(
        approvalPreflight ? 'siyuan_cloud_summary_scope_ready' : 'siyuan_summary_paused_before_run',
      );
    }
    if (durableJob && manifest.summaryPolicy.mode !== 'none') {
      let summaryIdentity;
      let summaryGenerator = generateSiyuanSummaryWithRegisteredLocalModel;
      try {
        const approval = manifest.cloudSummaryApproval;
        const cloudPinned =
          Boolean(durableJob.summaryProviderId) &&
          (durableJob.summaryProviderId !== 'ollama' ||
            durableJob.summaryConnectionId !== 'ollama-local');
        if (cloudPinned) {
          summaryIdentity = approvedCloudSiyuanSummaryIdentity({
            approval,
            job: durableJob,
            entries: index.entries,
            root: record.rootDir,
            policy: manifest.summaryPolicy,
          });
          summaryGenerator = generateSiyuanSummaryWithApprovedCloudModel;
        } else {
          summaryIdentity = resolveSiyuanSummaryIdentityForJob(durableJob);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'local_model_unavailable' ||
            error.message.startsWith('siyuan_cloud_summary_'))
        ) {
          durableJob = {
            ...durableJob,
            phase: 'summarizing',
            status: 'paused',
            pauseReason:
              error.message === 'local_model_unavailable'
                ? 'local_model_unavailable'
                : 'cloud_approval_required',
            updatedAt: Date.now(),
            phaseStartedAt: Date.now(),
            rateSamples: [{ at: Date.now(), processed: durableJob.summarized }],
          };
          await checkpointSiyuanIndexJob({ job: durableJob }, { forceStatus: true });
        }
        throw error;
      }
      const summaryResult = await runSiyuanSummaryPipeline({
        projectId,
        mapId: record.id,
        root: record.rootDir,
        policy: manifest.summaryPolicy,
        entries: index.entries,
        job: durableJob,
        identity: summaryIdentity,
        generator: summaryGenerator,
        requestScope:
          options.accountId && options.workspaceId
            ? {
                accountId: options.accountId,
                workspaceId: options.workspaceId,
                projectId,
                workingDirectory: record.rootDir,
              }
            : undefined,
        control: options.control,
        signal: options.signal,
        onCompleted: async (entry) => {
          const documentId = bindings[entry.nodeId];
          if (!documentId) throw new Error('siyuan_summary_binding_missing');
          const current = await port.getBlock(projectId, documentId);
          const parentDocumentId = entry.parentNodeId
            ? (bindings[entry.parentNodeId] ?? rootDocument.id)
            : rootDocument.id;
          const markdown = nodeManagedMarkdown(record.id, entry, parentDocumentId);
          if (current.markdown !== markdown) {
            await port.updateManagedDocument(
              projectId,
              current.id,
              current.markdown,
              markdown,
              rootDocument.id,
            );
          }
        },
      });
      durableJob = summaryResult.job;
      index = Object.freeze({
        ...index,
        entries: Object.freeze(summaryResult.entries) as SiyuanSafeIndexEntry[],
        summarized: summaryResult.job.summarized,
      });
    }
    if (durableJob?.pendingNativeNodeIds.length) {
      throw new Error('siyuan_native_node_reconciliation_incomplete');
    }
    const compactBindingCache = Object.fromEntries(
      index.entries
        .filter(isDocumentBackedEntry)
        .slice(0, SIYUAN_MANIFEST_BINDING_CACHE_LIMIT)
        .flatMap((entry) => {
          const documentId = bindings[entry.nodeId];
          return documentId ? [[entry.nodeId, documentId] as const] : [];
        }),
    );
    const readyManifest = updateSiyuanMapManifest(manifest, {
      notebookId: rootDocument.notebookId,
      rootDocumentId: rootDocument.id,
      nodeBindings: compactBindingCache,
      counts: {
        indexed: index.entries.length,
        excluded: index.excluded,
        summarized: index.summarized,
        unreadable: index.unreadable,
      },
      summaryModel:
        index.summarized > 0 && durableJob?.summaryModelId
          ? {
              kind: durableJob.summaryProviderId === 'ollama' ? 'local' : 'cloud-approved',
              providerId: durableJob.summaryProviderId ?? 'ollama',
              connectionId: durableJob.summaryConnectionId ?? 'ollama-local',
              modelId: durableJob.summaryModelId,
            }
          : index.summarized > 0 && /(?:^|[-_])(local|siyuan)(?:$|[-_])/iu.test(record.tree.model)
            ? { kind: 'local', modelId: record.tree.model }
            : { kind: 'none' },
      status: 'ready',
    });
    await options.control?.checkpoint(options.signal);
    if (options.signal?.aborted) throw new Error('siyuan_index_cancelled');
    if (durableJob) {
      const latestJob = await readSiyuanIndexJob(projectId, record.id);
      if (latestJob && latestJob.status !== 'running') {
        throw new Error(
          latestJob.status === 'cancelled' ? 'siyuan_index_cancelled' : 'siyuan_index_paused',
        );
      }
    }
    // Publish the complete manifest before the terminal job checkpoint. If
    // interrupted between these writes, the still-running job can reconcile
    // again instead of becoming stranded as completed behind an old manifest.
    writeSiyuanMapManifest(readyManifest);
    if (durableJob) {
      await checkpointSiyuanIndexJob({
        job: {
          ...durableJob,
          phase: 'completed',
          status: 'completed',
          createdNodes: index.entries.length,
          updatedAt: Date.now(),
          completedAt: Date.now(),
          estimatedPercent: 100,
          estimatedEtaSeconds: 0,
        },
      });
      const finalizedJob = await readSiyuanIndexJob(projectId, record.id);
      if (finalizedJob && finalizedJob.status !== 'completed') {
        writeSiyuanMapManifest(updateSiyuanMapManifest(readyManifest, { status: 'paused' }));
        throw new Error('siyuan_index_paused');
      }
    }
    return {
      manifest: readyManifest,
      tree: nativeFilesystemAvailable
        ? buildProjectContextTreeFromSiyuanIndex(record.tree, index.entries)
        : record.tree,
    };
  };

  const readKnownDocument = async (
    projectId: string,
    record: ContextMapRecord,
  ): Promise<SiyuanManagedDocument | null> => {
    const key = documentKey(projectId, record.id);
    const manifest = readSiyuanMapManifest(projectId, record.id);
    const knownId = managedDocumentIds.get(key) ?? manifest?.rootDocumentId;
    if (!knownId) return null;
    try {
      const document = await port.getBlock(projectId, knownId);
      if (
        document.id === knownId &&
        (!manifest?.notebookId || document.notebookId === manifest.notebookId) &&
        document.markdown.includes(marker(record.id))
      )
        return document;
    } catch {
      // The document may have been removed or replaced in SiYuan. Fall back
      // to marker lookup so user/Jarvis edits remain authoritative.
    }
    managedDocumentIds.delete(key);
    return null;
  };

  return Object.freeze({
    prewarm(projectId: string): Promise<void> {
      const exact = projectId.trim();
      if (!exact) return Promise.resolve();
      const existing = warming.get(exact);
      if (existing) return existing;
      const startedAt = Date.now();
      const task = port
        .searchBlocks(exact, 'vibespace-context-map:v1', 1)
        .then(() => {
          devConsole.log({
            channel: 'ai',
            level: 'info',
            message: 'SiYuan Context vault ready',
            durationMs: Date.now() - startedAt,
          });
        })
        .catch((error) => {
          warming.delete(exact);
          devConsole.log({
            channel: 'ai',
            level: 'warn',
            message: 'SiYuan Context vault prewarm failed safely',
            durationMs: Date.now() - startedAt,
            detail: { error: error instanceof Error ? error.message : String(error) },
          });
        });
      warming.set(exact, task);
      return task;
    },

    async read(
      projectId: string,
      record: ContextMapRecord,
    ): Promise<SiyuanContextMapSnapshot | null> {
      const exactProjectId = projectId.trim();
      if (!exactProjectId || record.status !== 'active') return null;
      // An indexing manifest is deliberately not presented as ready. Returning
      // null makes the Context page call sync(), which restores the durable
      // directory frontier after navigation, HMR, a crash, or full app restart.
      const manifest = readSiyuanMapManifest(exactProjectId, record.id);
      if (manifest?.status === 'indexing') return null;
      const document =
        (await readKnownDocument(exactProjectId, record)) ??
        (await readManagedDocumentWithDuplicateRecovery(port, exactProjectId, record));
      if (!document) return null;
      managedDocumentIds.set(documentKey(exactProjectId, record.id), document.id);
      try {
        return parseContextMapMarkdown(document, record);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'message' in error &&
          error.message === 'siyuan_context_map_graph_invalid'
        ) {
          return null;
        }
        throw error;
      }
    },

    async sync(
      projectId: string,
      record: ContextMapRecord,
      options: SiyuanContextMapSyncOptions = {},
    ): Promise<SiyuanContextMapSnapshot> {
      const exactProjectId = projectId.trim();
      if (!exactProjectId || record.status !== 'active')
        throw new Error('siyuan_context_map_scope_invalid');
      const syncKey = documentKey(exactProjectId, record.id);
      const activeSync = synchronizing.get(syncKey);
      if (activeSync) return activeSync;
      const syncController = new AbortController();
      const relayAbort = () => syncController.abort(options.signal?.reason);
      if (options.signal?.aborted) relayAbort();
      else options.signal?.addEventListener('abort', relayAbort, { once: true });
      const effectiveOptions = { ...options, signal: syncController.signal };
      const task = (async (): Promise<SiyuanContextMapSnapshot> => {
        const startedAt = Date.now();
        let manifest =
          readSiyuanMapManifest(exactProjectId, record.id) ??
          createSiyuanMapManifest(
            record,
            exactProjectId,
            effectiveOptions.summaryPolicy,
            effectiveOptions.sourcePolicy,
          );
        if (manifest.status === 'recycled') {
          // Retained bindings are the durable retirement journal. Restore
          // reconciles survivors and recreates only blocks already deleted.
          managedDocumentIds.delete(documentKey(exactProjectId, record.id));
        }
        const interruptedStatus = manifest.status;
        const persistedBindings =
          interruptedStatus === 'indexing' ||
          interruptedStatus === 'paused' ||
          interruptedStatus === 'error'
            ? await readSiyuanNodeBindings(exactProjectId, record.id)
            : {};
        manifest = updateSiyuanMapManifest(manifest, { status: 'indexing' });
        writeSiyuanMapManifest(manifest);
        const markdown = contextMapMarkdown(record);
        const knownDocument = await readKnownDocument(exactProjectId, record);
        const recoveredDocument =
          Object.keys(persistedBindings).length > 0
            ? await readManagedDocumentWithDuplicateRecovery(
                port,
                exactProjectId,
                record,
                Object.values(persistedBindings),
              )
            : null;
        const existing =
          recoveredDocument ??
          knownDocument ??
          (await readManagedDocumentWithDuplicateRecovery(port, exactProjectId, record));
        let document = existing
          ? existing.markdown === markdown
            ? existing
            : await port.updateManagedDocument(
                exactProjectId,
                existing.id,
                existing.markdown,
                markdown,
                existing.id,
              )
          : await port.createManagedDocument(
              exactProjectId,
              `/VibeSpace Context Maps/${slug(record.name)}-${slug(record.id)}`,
              markdown,
            );
        managedDocumentIds.set(documentKey(exactProjectId, record.id), document.id);
        manifest = updateSiyuanMapManifest(manifest, {
          notebookId: document.notebookId,
          rootDocumentId: document.id,
          status: 'indexing',
        });
        writeSiyuanMapManifest(manifest);
        try {
          const completed = await syncNativeNodeDocuments(
            exactProjectId,
            record,
            document,
            manifest,
            effectiveOptions,
          );
          manifest = completed.manifest;
          const completedMarkdown = contextMapMarkdown({ ...record, tree: completed.tree });
          if (document.markdown !== completedMarkdown) {
            document = await port.updateManagedDocument(
              exactProjectId,
              document.id,
              document.markdown,
              completedMarkdown,
              document.id,
            );
          }
          writeSiyuanMapManifest(manifest);
        } catch (error) {
          const userCancelled = effectiveOptions.control?.state === 'cancelled';
          const summaryPaused =
            error instanceof Error &&
            [
              'local_model_unavailable',
              'siyuan_summary_entries_failed',
              'siyuan_cloud_summary_approval_required',
              'siyuan_cloud_summary_approval_scope_drift',
              'siyuan_cloud_summary_restart_required',
              'siyuan_cloud_summary_scope_ready',
              'siyuan_summary_paused_before_run',
            ].includes(error.message);
          const currentJob = await readSiyuanIndexJob(exactProjectId, record.id);
          const durablePaused =
            (error instanceof Error && error.message === 'siyuan_index_paused') ||
            currentJob?.status === 'paused';
          const interrupted =
            effectiveOptions.signal?.aborted ||
            (error instanceof Error && error.message === 'siyuan_index_cancelled');
          if (!userCancelled && !summaryPaused && !interrupted) {
            if (currentJob?.status === 'running') {
              await updateSiyuanIndexJobStatus(exactProjectId, record.id, 'failed');
            }
          }
          writeSiyuanMapManifest(
            updateSiyuanMapManifest(manifest, {
              status:
                userCancelled || summaryPaused || durablePaused
                  ? 'paused'
                  : interrupted
                    ? 'indexing'
                    : 'error',
            }),
          );
          throw error;
        }
        const snapshot = { ...parseContextMapMarkdown(document, record), manifest };
        devConsole.log({
          channel: 'ai',
          level: 'info',
          message: 'SiYuan Context map synchronized',
          durationMs: Date.now() - startedAt,
          detail: {
            fileCount: record.tree.fileCount,
            indexedNodes: manifest.counts.indexed,
            excludedNodes: manifest.counts.excluded,
            updated: Boolean(existing),
          },
        });
        return snapshot;
      })();
      synchronizing.set(syncKey, task);
      syncControllers.set(syncKey, syncController);
      try {
        return await task;
      } finally {
        options.signal?.removeEventListener('abort', relayAbort);
        if (synchronizing.get(syncKey) === task) synchronizing.delete(syncKey);
        if (syncControllers.get(syncKey) === syncController) syncControllers.delete(syncKey);
      }
    },

    async pause(projectId: string, mapId: string): Promise<void> {
      const exactProjectId = projectId.trim();
      const exactMapId = mapId.trim();
      if (!exactProjectId || !exactMapId) throw new Error('siyuan_context_map_scope_invalid');
      const key = documentKey(exactProjectId, exactMapId);
      // The native operation may be blocked below JavaScript and therefore
      // unable to settle its promise promptly. Persist the user's pause first;
      // lifecycle-protected checkpoints then cannot resurrect the job while
      // abort remains best-effort cancellation of the in-flight operation.
      await updateSiyuanIndexJobStatus(exactProjectId, exactMapId, 'paused');
      syncControllers.get(key)?.abort('siyuan_index_paused');
      const manifest = readSiyuanMapManifest(exactProjectId, exactMapId);
      if (manifest) {
        writeSiyuanMapManifest(updateSiyuanMapManifest(manifest, { status: 'paused' }));
      }
    },

    async retire(projectId: string, record: ContextMapRecord): Promise<void> {
      const exactProjectId = projectId.trim();
      if (!exactProjectId) throw new Error('siyuan_context_map_scope_invalid');
      await updateSiyuanIndexJobStatus(exactProjectId, record.id, 'paused');
      const key = documentKey(exactProjectId, record.id);
      syncControllers.get(key)?.abort('siyuan_map_recycled');
      await synchronizing.get(key)?.catch(() => undefined);
      await updateSiyuanIndexJobStatus(exactProjectId, record.id, 'paused');
      const current = readSiyuanMapManifest(exactProjectId, record.id);
      if (!current) return;
      const persistedBindings = await readSiyuanNodeBindings(exactProjectId, record.id);
      const ownedIds = [
        ...new Set([
          ...Object.values(persistedBindings),
          ...Object.values(current.nodeBindings),
          ...(current.rootDocumentId ? [current.rootDocumentId] : []),
        ]),
      ];
      let recycledManifest = updateSiyuanMapManifest(current, { status: 'recycled' });
      // The manifest root and IndexedDB bindings form a durable retirement
      // journal. Remove each pointer only after its native delete is terminal.
      writeSiyuanMapManifest(recycledManifest);
      managedDocumentIds.delete(documentKey(exactProjectId, record.id));
      for (const id of ownedIds) {
        try {
          const document = await port.getBlock(exactProjectId, id);
          const owned =
            document.markdown.includes(marker(record.id)) ||
            document.markdown.includes(`vibespace-context-node:v1 map=${safeText(record.id, 200)}`);
          if (owned) {
            await port.deleteManagedDocument(
              exactProjectId,
              id,
              document.markdown,
              current.rootDocumentId ?? id,
            );
          }
        } catch (error) {
          if (!isSiyuanBlockNotFoundError(error)) throw error;
        }
        const retiredNodeIds = Object.entries(persistedBindings)
          .filter(([, documentId]) => documentId === id)
          .map(([nodeId]) => nodeId);
        if (retiredNodeIds.length > 0) {
          await deleteSiyuanNodeBindings(exactProjectId, record.id, retiredNodeIds);
        }
        recycledManifest = updateSiyuanMapManifest(recycledManifest, {
          rootDocumentId:
            recycledManifest.rootDocumentId === id ? null : recycledManifest.rootDocumentId,
          nodeBindings: Object.fromEntries(
            Object.entries(recycledManifest.nodeBindings).filter(
              ([, documentId]) => documentId !== id,
            ),
          ),
        });
        writeSiyuanMapManifest(recycledManifest);
      }
      await clearSiyuanNodeBindings(exactProjectId, record.id);
      writeSiyuanMapManifest(
        updateSiyuanMapManifest(recycledManifest, {
          notebookId: null,
          rootDocumentId: null,
          nodeBindings: {},
          counts: { indexed: 0, summarized: 0 },
          status: 'recycled',
        }),
      );
    },
  });
}

export const productionSiyuanContextMaps = createSiyuanContextMapIntegration(
  getProductionSiyuanRlmPort(),
);
