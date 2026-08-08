import type { JarvisDexie } from '@/lib/db';
import type { ContextMigrationBackupRow, ContextQuarantineRow } from '@/lib/db/schema';
import {
  parseContextGraphSnapshotV2,
  type ContextEdgeV2,
  type ContextEntityKind,
  type ContextEntityV2,
  type ContextGraphSnapshotV2,
  type ContextProvenanceV2,
  type ContextReferenceV2,
  type ContextSourceStatus,
} from './contracts';
import { createContextGraphRepository, ContextGraphRepositoryError } from './repository';
import {
  contextMapCollectionKey,
  contextSelectedFileKey,
  contextStorageKey,
  type ContextMapRecord,
  type ContextNodeKind,
  type ContextTreeNode,
  type ProjectContextTree,
} from './tree';

export type ContextV1MigrationState =
  | 'no_legacy_data'
  | 'foreign_legacy_ignored'
  | 'migrated'
  | 'migrated_with_quarantine'
  | 'already_migrated';

export type ContextV1MigrationResult = Readonly<{
  state: ContextV1MigrationState;
  accountId: string;
  projectId: string | null;
  backupId?: string;
  expectedMapCount: number;
  migratedMapCount: number;
  selectedMapId?: string;
  quarantinedCount: number;
  legacyRetained: true;
  idRemaps: Readonly<Record<string, string>>;
}>;

export type ContextV1MigrationInput = Readonly<{
  database: JarvisDexie;
  storage: Pick<Storage, 'getItem'>;
  accountId: string;
  projectId: string | null;
  now?: () => number;
}>;

export type ContextSelectionV2 = Readonly<{
  version: 2;
  accountId: string;
  projectId: string | null;
  selectedMapId: string | null;
  selectedFile?: Readonly<{ mapId: string; relativePath: string }>;
}>;

type LegacyCollection = {
  selectedMapId: string | null;
  maps: ContextMapRecord[];
};

type ConvertedLegacyMap = {
  legacyId: string;
  snapshot: ContextGraphSnapshotV2;
};

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const RESERVED_DEFAULT_PROJECT_ID = '__default__';
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const NODE_KINDS = new Set<ContextNodeKind>(['root', 'area', 'file', 'symbol', 'note']);
const RECOVERY_OPTIONS: ContextQuarantineRow['recoveryOptions'] = [
  'retry',
  'restore_backup',
  'export_then_discard',
];

class LegacyContextInvalid extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LegacyContextInvalid';
  }
}

function fail(reason: string): never {
  throw new LegacyContextInvalid(reason);
}

function hashToken(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function boundedId(value: string, prefix = 'ctx'): string {
  if (STABLE_ID.test(value)) return value;
  return `${prefix}_${hashToken(value)}`;
}

function plainRecord(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(reason);
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(reason);
  return value as number;
}

function safeText(value: unknown, reason: string, max = 8_192): string {
  if (typeof value !== 'string') fail(reason);
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!clean || clean.length > max) fail(reason);
  return clean;
}

function optionalTime(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function normalizedPath(value: string): string {
  const slashPath = value.replace(/\\/g, '/');
  const unc = slashPath.startsWith('//');
  let normalized = slashPath.replace(/\/+/g, '/');
  if (unc) normalized = `//${normalized.replace(/^\/+/, '')}`;
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/$/, '');
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('/') || value.startsWith('//');
}

function absoluteRoot(value: unknown): string {
  const root = safeText(value, 'legacy_root_invalid', 4_096);
  const normalized = normalizedPath(root);
  if (!isAbsolutePath(normalized) || normalized.split('/').includes('..')) {
    fail('legacy_root_invalid');
  }
  return root === '/' || /^[A-Za-z]:[\\/]$/.test(root) ? root : root.replace(/[\\/]+$/, '');
}

function relativePathWithinRoot(rootDir: string, rawPath: unknown): string | undefined {
  if (rawPath === undefined) return undefined;
  const value = safeText(rawPath, 'legacy_node_path_invalid', 4_096);
  const normalized = normalizedPath(value);
  const root = normalizedPath(rootDir);
  let relative = normalized;
  if (isAbsolutePath(normalized)) {
    const windows = /^[A-Za-z]:\//.test(root);
    const comparableRoot = windows ? root.toLocaleLowerCase('en-US') : root;
    const comparablePath = windows ? normalized.toLocaleLowerCase('en-US') : normalized;
    const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
    if (comparablePath !== comparableRoot && !comparablePath.startsWith(rootPrefix)) {
      fail('legacy_node_outside_root');
    }
    relative = normalized.slice(root.length).replace(/^\/+/, '');
  }
  const segments = relative.split('/');
  if (
    !relative ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative)
  ) {
    fail('legacy_node_path_invalid');
  }
  return relative;
}

function parseLegacyNode(
  value: unknown,
  rootDir: string,
  fallbackTime: number,
  depth: number,
  ids: Set<string>,
): ContextTreeNode {
  if (depth > 64) fail('legacy_tree_depth_invalid');
  const record = plainRecord(value, 'legacy_node_invalid');
  const id = safeText(record.id, 'legacy_node_id_invalid', 200);
  if (!STABLE_ID.test(id) || ids.has(id)) fail('legacy_node_id_invalid');
  ids.add(id);
  if (!NODE_KINDS.has(record.kind as ContextNodeKind)) fail('legacy_node_kind_invalid');
  const createdAt = optionalTime(record.createdAt, fallbackTime);
  const modifiedAt = optionalTime(record.modifiedAt, createdAt);
  if (modifiedAt < createdAt) fail('legacy_node_time_invalid');
  const childrenRaw = record.children === undefined ? [] : record.children;
  if (!Array.isArray(childrenRaw) || childrenRaw.length > 100_000) {
    fail('legacy_node_children_invalid');
  }
  const tags =
    record.tags === undefined
      ? undefined
      : Array.isArray(record.tags) && record.tags.length <= 1_000
        ? record.tags.map((tag) => safeText(tag, 'legacy_node_tag_invalid', 200))
        : fail('legacy_node_tags_invalid');
  return {
    id,
    title: safeText(record.title, 'legacy_node_title_invalid', 500),
    kind: record.kind as ContextNodeKind,
    summary:
      record.summary === '' ? '' : safeText(record.summary, 'legacy_node_summary_invalid', 8_192),
    ...(record.path === undefined ? {} : { path: relativePathWithinRoot(rootDir, record.path) }),
    ...(tags ? { tags } : {}),
    ...(typeof record.importance === 'number' && Number.isFinite(record.importance)
      ? { importance: record.importance }
      : {}),
    ...(Number.isSafeInteger(record.sizeBytes) && (record.sizeBytes as number) >= 0
      ? { sizeBytes: record.sizeBytes as number }
      : {}),
    createdAt,
    modifiedAt,
    ...(childrenRaw.length
      ? {
          children: childrenRaw.map((child) =>
            parseLegacyNode(child, rootDir, fallbackTime, depth + 1, ids),
          ),
        }
      : {}),
  };
}

function parseLegacyTree(value: unknown, projectId: string | null): ProjectContextTree {
  const record = plainRecord(value, 'legacy_tree_invalid');
  if (record.version !== 1 || record.projectId !== projectId) fail('legacy_tree_scope_invalid');
  const rootDir = absoluteRoot(record.rootDir);
  const generatedAt = safeInteger(record.generatedAt, 'legacy_tree_time_invalid');
  if (!Array.isArray(record.nodes) || record.nodes.length > 100_000) {
    fail('legacy_tree_nodes_invalid');
  }
  const ids = new Set<string>();
  const recommendedEntryPoints =
    record.recommendedEntryPoints === undefined
      ? undefined
      : Array.isArray(record.recommendedEntryPoints) && record.recommendedEntryPoints.length <= 100
        ? record.recommendedEntryPoints.map((entry) =>
            safeText(entry, 'legacy_tree_entry_point_invalid', 4_096),
          )
        : fail('legacy_tree_entry_points_invalid');
  return {
    version: 1,
    projectId,
    rootDir,
    generatedAt,
    model: safeText(record.model, 'legacy_tree_model_invalid', 500),
    fileCount: safeInteger(record.fileCount, 'legacy_tree_file_count_invalid'),
    totalBytes: safeInteger(record.totalBytes, 'legacy_tree_bytes_invalid'),
    summary:
      record.summary === '' ? '' : safeText(record.summary, 'legacy_tree_summary_invalid', 8_192),
    nodes: record.nodes.map((node) => parseLegacyNode(node, rootDir, generatedAt, 0, ids)),
    ...(recommendedEntryPoints ? { recommendedEntryPoints } : {}),
  };
}

function parseLegacyMap(value: unknown, projectId: string | null): ContextMapRecord {
  const record = plainRecord(value, 'legacy_map_invalid');
  const tree = parseLegacyTree(record.tree, projectId);
  const id = safeText(record.id, 'legacy_map_invalid', 200);
  if (!STABLE_ID.test(id) || record.projectId !== projectId) fail('legacy_map_invalid');
  const rootDir = absoluteRoot(record.rootDir);
  if (normalizedPath(rootDir) !== normalizedPath(tree.rootDir)) fail('legacy_map_invalid');
  if (record.status !== 'active' && record.status !== 'deleted') fail('legacy_map_invalid');
  const createdAt = safeInteger(record.createdAt, 'legacy_map_invalid');
  const updatedAt = safeInteger(record.updatedAt, 'legacy_map_invalid');
  if (updatedAt < createdAt) fail('legacy_map_invalid');
  return {
    id,
    projectId,
    rootDir,
    ...(typeof record.filePath === 'string' && record.filePath.trim()
      ? { filePath: record.filePath.trim() }
      : {}),
    name: safeText(record.name, 'legacy_map_invalid', 500),
    status: record.status,
    createdAt,
    updatedAt,
    tree,
  };
}

function parseLegacyCollection(
  raw: string,
  projectId: string | null,
): { collection?: LegacyCollection; jsonInvalid?: boolean; collectionInvalid?: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { jsonInvalid: true };
  }
  try {
    const record = plainRecord(value, 'legacy_collection_invalid');
    if (record.version !== 1 || record.projectId !== projectId || !Array.isArray(record.maps)) {
      fail('legacy_collection_invalid');
    }
    const selectedMapId =
      record.selectedMapId === null
        ? null
        : typeof record.selectedMapId === 'string'
          ? record.selectedMapId
          : fail('legacy_collection_invalid');
    return {
      collection: {
        selectedMapId,
        maps: record.maps as ContextMapRecord[],
      },
    };
  } catch {
    return { collectionInvalid: true };
  }
}

function nodeKind(kind: ContextNodeKind): ContextEntityKind {
  switch (kind) {
    case 'root':
      return 'source';
    case 'area':
      return 'folder';
    case 'file':
      return 'file';
    case 'symbol':
      return 'symbol';
    case 'note':
      return 'markdown_note';
  }
}

function referenceForEntry(
  entry: string,
  entities: readonly ContextEntityV2[],
): ContextReferenceV2 | undefined {
  const wanted = normalizedPath(entry).toLocaleLowerCase('en-US');
  const entity = entities.find(
    (candidate) =>
      candidate.id.toLocaleLowerCase('en-US') === wanted ||
      candidate.label.toLocaleLowerCase('en-US') === wanted ||
      candidate.path?.toLocaleLowerCase('en-US') === wanted,
  );
  if (!entity) return undefined;
  return {
    entityId: entity.id,
    kind: entity.kind,
    label: entity.label,
    sourceId: entity.sourceId,
    ...(entity.path ? { path: entity.path } : {}),
  };
}

export function convertContextMapRecordV1ToSnapshotV2(
  legacy: ContextMapRecord,
  accountId: string,
  mapId: string,
  options: {
    knowledgeRevision?: number;
    sourceStatus?: ContextSourceStatus;
    parser?: string;
    sourceLabel?: string;
    branchRef?: string;
    github?: {
      installationId: string;
      owner: string;
      repository: string;
      resolvedCommitSha: string;
      visibility: 'public' | 'private' | 'internal';
    };
  } = {},
): ContextGraphSnapshotV2 {
  const knowledgeRevision = options.knowledgeRevision ?? 1;
  const sourceStatus = options.sourceStatus ?? 'stale';
  const parser = options.parser ?? 'context-v1-tree-migration';
  const tree = legacy.tree;
  const createdAt = Math.min(legacy.createdAt, tree.generatedAt);
  const updatedAt = Math.max(legacy.updatedAt, tree.generatedAt, createdAt);
  const sourceId = boundedId(`${mapId}:source`, 'ctxsrc');
  const sourceRevision = `v1-${tree.generatedAt}-${tree.fileCount}-${tree.totalBytes}`;
  const sourceKind = options.github
    ? ('github_repository' as const)
    : legacy.sourceType === 'local_file'
      ? ('local_file' as const)
      : ('local_folder' as const);
  const entities: ContextEntityV2[] = [];
  const edges: ContextEdgeV2[] = [];
  const provenance: ContextProvenanceV2[] = [];

  const walk = (node: ContextTreeNode, parentEntityId?: string) => {
    const entityId = boundedId(`${mapId}:${node.id}`, 'ctxent');
    const entityProvenanceId = boundedId(`${entityId}:provenance`, 'ctxprov');
    const entityCreatedAt = optionalTime(node.createdAt, createdAt);
    const entityUpdatedAt = Math.max(optionalTime(node.modifiedAt, updatedAt), entityCreatedAt);
    entities.push({
      version: 2,
      id: entityId,
      accountId,
      mapId,
      sourceId,
      kind: nodeKind(node.kind),
      label: node.title,
      ...(node.path ? { path: node.path } : {}),
      ...(node.summary !== '' ? { summary: node.summary } : { summary: '' }),
      sourceRevision,
      provenanceIds: [entityProvenanceId],
      createdAt: entityCreatedAt,
      updatedAt: entityUpdatedAt,
    });
    provenance.push({
      version: 2,
      id: entityProvenanceId,
      accountId,
      mapId,
      targetKind: 'entity',
      targetId: entityId,
      sourceId,
      sourceKind,
      ...(node.path ? { path: node.path } : {}),
      extractedAt: tree.generatedAt,
      parser,
      confidence: 1,
      sourceRevision,
    });

    if (parentEntityId) {
      const edgeId = boundedId(`${mapId}:edge:${parentEntityId}:${entityId}`, 'ctxedge');
      const edgeProvenanceId = boundedId(`${edgeId}:provenance`, 'ctxprov');
      edges.push({
        version: 2,
        id: edgeId,
        accountId,
        mapId,
        sourceEntityId: parentEntityId,
        targetEntityId: entityId,
        kind: 'contains',
        provenanceIds: [edgeProvenanceId],
        confidence: 1,
        sourceRevision,
        createdAt,
        updatedAt,
      });
      provenance.push({
        version: 2,
        id: edgeProvenanceId,
        accountId,
        mapId,
        targetKind: 'edge',
        targetId: edgeId,
        sourceId,
        sourceKind,
        ...(node.path ? { path: node.path } : {}),
        extractedAt: tree.generatedAt,
        parser,
        confidence: 1,
        sourceRevision,
      });
    }
    for (const child of node.children ?? []) walk(child, entityId);
  };
  for (const node of tree.nodes) walk(node);

  const recommendedEntryPoints = (tree.recommendedEntryPoints ?? [])
    .map((entry) => referenceForEntry(entry, entities))
    .filter((entry): entry is ContextReferenceV2 => entry !== undefined);
  const snapshot: ContextGraphSnapshotV2 = {
    version: 2,
    map: {
      version: 2,
      id: mapId,
      accountId,
      projectId: legacy.projectId,
      name: legacy.name,
      status: legacy.status,
      sourceIds: [sourceId],
      summary: tree.summary,
      recommendedEntryPoints,
      statistics: {
        sourceCount: 1,
        entityCount: entities.length,
        edgeCount: edges.length,
        noteCount: entities.filter(({ kind }) => kind === 'markdown_note').length,
        attachmentCount: entities.filter(({ kind }) => kind === 'attachment').length,
        staleSourceCount: sourceStatus === 'stale' ? 1 : 0,
      },
      createdAt,
      updatedAt,
      lastIndexedAt: tree.generatedAt,
      knowledgeRevision,
    },
    sources: [
      {
        version: 2,
        id: sourceId,
        accountId,
        mapId,
        kind: sourceKind,
        label: options.sourceLabel ?? legacy.sourceLabel ?? legacy.name,
        status: sourceStatus,
        ...(sourceKind === 'local_folder' ? { localRoot: tree.rootDir } : {}),
        ...(sourceKind === 'local_file' ? { localFile: tree.rootDir } : {}),
        ...(options.github
          ? {
              github: {
                ...options.github,
                selectedRef: options.branchRef ?? legacy.branchRef ?? 'HEAD',
              },
            }
          : {}),
        createdAt,
        updatedAt,
        lastIndexedAt: tree.generatedAt,
        ...(sourceStatus === 'ready' ? { lastVerifiedAt: tree.generatedAt } : {}),
        sourceRevision,
        parserVersion: 1,
      },
    ],
    entities,
    edges,
    provenance,
  };
  const parsed = parseContextGraphSnapshotV2(snapshot);
  if (!parsed.ok) fail(parsed.reason);
  return structuredClone(parsed.value) as ContextGraphSnapshotV2;
}

function fallbackMapFromTree(tree: ProjectContextTree): ContextMapRecord {
  const cleanRoot = tree.rootDir.replace(/[\\/]$/, '');
  const rootName = cleanRoot.split(/[\\/]/).filter(Boolean).at(-1) || 'Project';
  return {
    id: boundedId(
      `map-${cleanRoot.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-')}-${tree.generatedAt}`,
      'ctxmap',
    ),
    projectId: tree.projectId,
    rootDir: tree.rootDir,
    name: `${rootName} Context Map`,
    status: 'active',
    createdAt: tree.generatedAt,
    updatedAt: tree.generatedAt,
    tree,
  };
}

async function backupId(
  accountId: string,
  projectId: string | null,
  values: Record<string, string | null>,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('context_migration_sha256_unavailable');
  const payload = new TextEncoder().encode(JSON.stringify({ accountId, projectId, values }));
  const digest = await subtle.digest('SHA-256', payload);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `ctxmig_${hex}`;
}

async function legacyPayloadFingerprint(
  projectId: string | null,
  values: Record<string, string | null>,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('context_migration_sha256_unavailable');
  const payload = new TextEncoder().encode(JSON.stringify({ projectId, values }));
  const digest = await subtle.digest('SHA-256', payload);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `ctxlegacy_${hex}`;
}

function legacyClaimSettingKey(projectId: string | null): string {
  return `context-v1-legacy-claim:${encodeURIComponent(projectId ?? '__default__')}`;
}

function quarantineRow(
  backup: string,
  index: number,
  accountId: string,
  recordKind: ContextQuarantineRow['recordKind'],
  reason: string,
  raw: unknown,
  now: number,
  mapId?: string,
): ContextQuarantineRow {
  return {
    version: 1,
    id: `ctxq_${backup.slice('ctxmig_'.length, 'ctxmig_'.length + 32)}_${index}`,
    accountId,
    ...(mapId ? { mapId } : {}),
    recordKind,
    reason,
    raw,
    recoveryOptions: [...RECOVERY_OPTIONS],
    quarantinedAt: now,
  };
}

async function availableMapId(
  database: JarvisDexie,
  legacyId: string,
  accountId: string,
  projectId: string | null,
  unavailableIds: ReadonlySet<string>,
): Promise<string> {
  const current = await database.context_maps.get(legacyId);
  if (
    !unavailableIds.has(legacyId) &&
    (!current || (current.accountId === accountId && current.projectId === projectId))
  ) {
    return legacyId;
  }
  const base = boundedId(
    `ctxmap-${hashToken(`${accountId}\0${projectId ?? '<null>'}`)}-${legacyId}`,
    'ctxmap',
  );
  let candidate = base;
  let suffix = 2;
  while (true) {
    const collision = await database.context_maps.get(candidate);
    if (
      !unavailableIds.has(candidate) &&
      (!collision || (collision.accountId === accountId && collision.projectId === projectId))
    ) {
      return candidate;
    }
    candidate = boundedId(`${base}-${suffix}`, 'ctxmap');
    suffix += 1;
  }
}

function selectedFileForMap(map: ContextGraphSnapshotV2, raw: string): string {
  return relativePathWithinRoot(map.sources[0]!.localRoot!, raw)!;
}

function migrationResult(
  input: ContextV1MigrationInput,
  value: Omit<ContextV1MigrationResult, 'accountId' | 'projectId' | 'legacyRetained'>,
): ContextV1MigrationResult {
  return Object.freeze({
    ...value,
    accountId: input.accountId,
    projectId: input.projectId,
    legacyRetained: true as const,
    idRemaps: Object.freeze({ ...value.idRemaps }),
  });
}

export function contextSelectionSettingKey(accountId: string, projectId: string | null): string {
  return `context-selection-v2:${encodeURIComponent(accountId)}:${encodeURIComponent(
    projectId ?? '__default__',
  )}`;
}

export async function migrateContextV1ForAccount(
  input: ContextV1MigrationInput,
): Promise<ContextV1MigrationResult> {
  if (
    !ACCOUNT_ID.test(input.accountId) ||
    (input.projectId !== null &&
      (input.projectId === RESERVED_DEFAULT_PROJECT_ID || !PROJECT_ID.test(input.projectId)))
  ) {
    throw new Error('context_migration_identity_invalid');
  }
  const now = input.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('context_migration_time_invalid');
  const keys = [
    contextMapCollectionKey(input.projectId),
    contextStorageKey(input.projectId),
    contextSelectedFileKey(input.projectId),
  ];
  const legacyValues = Object.fromEntries(
    keys.map((key) => [key, input.storage.getItem(key)]),
  ) as Record<string, string | null>;
  if (Object.values(legacyValues).every((value) => value === null)) {
    return migrationResult(input, {
      state: 'no_legacy_data',
      expectedMapCount: 0,
      migratedMapCount: 0,
      quarantinedCount: 0,
      idRemaps: {},
    });
  }

  const payloadFingerprint = await legacyPayloadFingerprint(input.projectId, legacyValues);
  const claimKey = legacyClaimSettingKey(input.projectId);
  await input.database.transaction('rw', input.database.settings, async () => {
    const existing = await input.database.settings.get(claimKey);
    if (existing) {
      const claim = existing.value as {
        version?: unknown;
        accountId?: unknown;
        projectId?: unknown;
        payloadFingerprint?: unknown;
      };
      if (
        claim.version !== 1 ||
        claim.projectId !== input.projectId ||
        typeof claim.accountId !== 'string' ||
        typeof claim.payloadFingerprint !== 'string'
      ) {
        throw new Error('context_migration_legacy_claim_invalid');
      }
      if (claim.accountId !== input.accountId) {
        throw new Error('context_migration_legacy_claimed_by_another_account');
      }
      if (claim.payloadFingerprint !== payloadFingerprint) {
        throw new Error('context_migration_legacy_payload_changed');
      }
      return;
    }
    await input.database.settings.put({
      key: claimKey,
      value: {
        version: 1,
        accountId: input.accountId,
        projectId: input.projectId,
        payloadFingerprint,
      },
      updated_at: now,
    });
  });

  const id = await backupId(input.accountId, input.projectId, legacyValues);
  const existingBackup = await input.database.context_migration_backups.get(id);
  if (existingBackup?.status === 'verified') {
    const migratedMapIds = existingBackup.migratedMapIds ?? [];
    const migratedMaps = await input.database.context_maps.bulkGet(migratedMapIds);
    const exactMarker =
      new Set(migratedMapIds).size === migratedMapIds.length &&
      existingBackup.expectedMapCount === existingBackup.migratedMapCount &&
      migratedMapIds.length === existingBackup.migratedMapCount &&
      migratedMaps.every(
        (map, index) =>
          map?.id === migratedMapIds[index] &&
          map.accountId === input.accountId &&
          map.projectId === input.projectId,
      );
    if (exactMarker) {
      const setting = await input.database.settings.get(
        contextSelectionSettingKey(input.accountId, input.projectId),
      );
      const selection = setting?.value as Partial<ContextSelectionV2> | undefined;
      return migrationResult(input, {
        state: 'already_migrated',
        backupId: id,
        expectedMapCount: existingBackup.expectedMapCount,
        migratedMapCount: existingBackup.migratedMapCount,
        ...(typeof selection?.selectedMapId === 'string'
          ? { selectedMapId: selection.selectedMapId }
          : {}),
        quarantinedCount: existingBackup.quarantinedCount ?? 0,
        idRemaps: existingBackup.idRemaps ?? {},
      });
    }
  }

  const prepared: ContextMigrationBackupRow = existingBackup
    ? {
        ...existingBackup,
        status: 'prepared',
        migratedMapIds: existingBackup.migratedMapIds ?? [],
        verifiedAt: undefined,
        rolledBackAt: undefined,
      }
    : ({
        version: 1,
        id,
        accountId: input.accountId,
        projectId: input.projectId,
        status: 'prepared',
        legacyKeys: keys,
        legacyValues,
        expectedMapCount: 0,
        migratedMapCount: 0,
        migratedMapIds: [],
        rollbackAvailable: true,
        createdAt: now,
      } satisfies ContextMigrationBackupRow);
  await input.database.context_migration_backups.put(prepared);

  const quarantined: ContextQuarantineRow[] = [];
  const legacyMaps: ContextMapRecord[] = [];
  let selectedLegacyMapId: string | null = null;
  const collectionRaw = legacyValues[keys[0]!];
  if (collectionRaw !== null) {
    const parsed = parseLegacyCollection(collectionRaw, input.projectId);
    if (parsed.jsonInvalid || parsed.collectionInvalid || !parsed.collection) {
      quarantined.push(
        quarantineRow(
          id,
          quarantined.length,
          input.accountId,
          'legacy_collection',
          parsed.jsonInvalid ? 'legacy_collection_json_invalid' : 'legacy_collection_invalid',
          collectionRaw,
          now,
        ),
      );
    } else {
      selectedLegacyMapId = parsed.collection.selectedMapId;
      for (const rawMap of parsed.collection.maps) {
        try {
          legacyMaps.push(parseLegacyMap(rawMap, input.projectId));
        } catch {
          quarantined.push(
            quarantineRow(
              id,
              quarantined.length,
              input.accountId,
              'map',
              'legacy_map_invalid',
              rawMap,
              now,
              typeof rawMap?.id === 'string' ? rawMap.id : undefined,
            ),
          );
        }
      }
    }
  }

  const treeRaw = legacyValues[keys[1]!];
  if (treeRaw !== null) {
    try {
      const parsedTree = parseLegacyTree(JSON.parse(treeRaw), input.projectId);
      const represented = legacyMaps.some(
        ({ tree }) =>
          normalizedPath(tree.rootDir) === normalizedPath(parsedTree.rootDir) &&
          tree.generatedAt === parsedTree.generatedAt,
      );
      if (!represented) {
        const fallback = fallbackMapFromTree(parsedTree);
        legacyMaps.push(fallback);
        if (!selectedLegacyMapId) selectedLegacyMapId = fallback.id;
      }
    } catch {
      quarantined.push(
        quarantineRow(
          id,
          quarantined.length,
          input.accountId,
          'legacy_selected_tree',
          'legacy_selected_tree_invalid',
          treeRaw,
          now,
        ),
      );
    }
  }

  const repository = createContextGraphRepository(input.database);
  const converted: ConvertedLegacyMap[] = [];
  const idRemaps: Record<string, string> = {};
  const seenLegacyMapIds = new Set<string>();
  const seenFinalMapIds = new Set<string>();
  for (const legacy of legacyMaps) {
    if (seenLegacyMapIds.has(legacy.id)) {
      quarantined.push(
        quarantineRow(
          id,
          quarantined.length,
          input.accountId,
          'map',
          'legacy_map_id_duplicate',
          legacy,
          now,
          legacy.id,
        ),
      );
      continue;
    }
    seenLegacyMapIds.add(legacy.id);
    try {
      const unavailableMapIds = new Set(seenFinalMapIds);
      let mapId: string | undefined;
      let snapshot: ContextGraphSnapshotV2 | undefined;
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        const candidate = await availableMapId(
          input.database,
          legacy.id,
          input.accountId,
          input.projectId,
          unavailableMapIds,
        );
        const candidateSnapshot = convertContextMapRecordV1ToSnapshotV2(
          legacy,
          input.accountId,
          candidate,
        );
        const collision = await input.database.context_maps.get(candidate);
        if (
          collision &&
          collision.accountId === input.accountId &&
          collision.projectId === input.projectId &&
          collision.knowledgeRevision !== candidateSnapshot.map.knowledgeRevision
        ) {
          unavailableMapIds.add(candidate);
          continue;
        }
        try {
          await repository.putSnapshot(input.accountId, candidateSnapshot);
          mapId = candidate;
          snapshot = candidateSnapshot;
          break;
        } catch (error) {
          if (
            error instanceof ContextGraphRepositoryError &&
            (error.code === 'record_id_conflict' || error.code === 'revision_conflict')
          ) {
            unavailableMapIds.add(candidate);
            continue;
          }
          throw error;
        }
      }
      if (!mapId || !snapshot) fail('legacy_map_id_exhausted');
      if (seenFinalMapIds.has(mapId)) fail('legacy_final_map_id_duplicate');
      seenFinalMapIds.add(mapId);
      if (mapId !== legacy.id) idRemaps[legacy.id] = mapId;
      converted.push({ legacyId: legacy.id, snapshot });
    } catch (error) {
      if (
        !(error instanceof ContextGraphRepositoryError) &&
        !(error instanceof LegacyContextInvalid)
      ) {
        throw error;
      }
      const reason =
        error instanceof ContextGraphRepositoryError
          ? `legacy_map_${error.code}`
          : error instanceof LegacyContextInvalid
            ? error.reason
            : 'legacy_map_migration_failed';
      quarantined.push(
        quarantineRow(
          id,
          quarantined.length,
          input.accountId,
          'map',
          reason,
          legacy,
          now,
          legacy.id,
        ),
      );
    }
  }
  if (quarantined.length) await input.database.context_quarantine.bulkPut(quarantined);

  const selectedConverted =
    converted.find(({ legacyId }) => legacyId === selectedLegacyMapId) ??
    converted.find(({ snapshot }) => snapshot.map.status === 'active') ??
    converted[0];
  const selectedFileRaw = legacyValues[keys[2]!];
  let selectedFile: ContextSelectionV2['selectedFile'];
  if (selectedFileRaw !== null && selectedConverted) {
    try {
      selectedFile = {
        mapId: selectedConverted.snapshot.map.id,
        relativePath: selectedFileForMap(selectedConverted.snapshot, selectedFileRaw),
      };
    } catch {
      const row = quarantineRow(
        id,
        quarantined.length,
        input.accountId,
        'legacy_selected_file',
        'legacy_selected_file_outside_root',
        selectedFileRaw,
        now,
        selectedConverted.snapshot.map.id,
      );
      quarantined.push(row);
      await input.database.context_quarantine.put(row);
    }
  } else if (selectedFileRaw !== null) {
    const row = quarantineRow(
      id,
      quarantined.length,
      input.accountId,
      'legacy_selected_file',
      'legacy_selected_file_map_missing',
      selectedFileRaw,
      now,
    );
    quarantined.push(row);
    await input.database.context_quarantine.put(row);
  }

  const selection: ContextSelectionV2 = {
    version: 2,
    accountId: input.accountId,
    projectId: input.projectId,
    selectedMapId: selectedConverted?.snapshot.map.id ?? null,
    ...(selectedFile ? { selectedFile } : {}),
  };
  await input.database.settings.put({
    key: contextSelectionSettingKey(input.accountId, input.projectId),
    value: selection,
    updated_at: now,
  });

  const verifiedMaps = await Promise.all(
    converted.map(({ snapshot }) => input.database.context_maps.get(snapshot.map.id)),
  );
  const migratedMapIds = converted.map(({ snapshot }) => snapshot.map.id);
  if (
    new Set(migratedMapIds).size !== migratedMapIds.length ||
    verifiedMaps.some(
      (map, index) =>
        !map ||
        map.accountId !== input.accountId ||
        map.projectId !== input.projectId ||
        map.id !== converted[index]!.snapshot.map.id,
    )
  ) {
    throw new Error('context_migration_count_verification_failed');
  }
  const verified: ContextMigrationBackupRow = {
    ...prepared,
    status: 'verified',
    expectedMapCount: converted.length,
    migratedMapCount: verifiedMaps.length,
    migratedMapIds,
    quarantinedCount: quarantined.length,
    idRemaps,
    verifiedAt: now,
  };
  await input.database.context_migration_backups.put(verified);

  return migrationResult(input, {
    state: quarantined.length ? 'migrated_with_quarantine' : 'migrated',
    backupId: id,
    expectedMapCount: converted.length,
    migratedMapCount: verifiedMaps.length,
    ...(selectedConverted ? { selectedMapId: selectedConverted.snapshot.map.id } : {}),
    quarantinedCount: quarantined.length,
    idRemaps,
  });
}
