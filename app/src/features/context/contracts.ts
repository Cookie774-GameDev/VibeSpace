import {
  assertContextLocalFilePath,
  parseContextLocalFileScope,
  type ContextLocalFileScopeV1,
} from './contextLocalFileScope';

export const CONTEXT_SCHEMA_VERSION = 2 as const;

export const CONTEXT_SOURCE_KINDS = [
  'local_folder',
  'local_file',
  'github_repository',
  'linked_vibespace_content',
  'portable_markdown_folder',
] as const;

export const CONTEXT_SOURCE_STATUSES = [
  'pending',
  'indexing',
  'ready',
  'stale',
  'offline',
  'permission_required',
  'error',
  'removed',
] as const;

export const CONTEXT_ENTITY_KINDS = [
  'map',
  'source',
  'folder',
  'file',
  'markdown_note',
  'heading',
  'block',
  'symbol',
  'module',
  'class',
  'function',
  'method',
  'component',
  'route',
  'endpoint',
  'database_table',
  'migration',
  'test',
  'dependency',
  'task',
  'property',
  'tag',
  'attachment',
  'image',
  'audio',
  'video',
  'pdf',
  'url',
  'chat',
  'message',
  'terminal',
  'agent',
  'skill',
  'canvas',
  'canvas_object',
  'github_repository',
  'github_branch',
  'github_commit',
  'github_issue',
  'github_pull_request',
  'github_release',
  'github_workflow',
] as const;

export const CONTEXT_EDGE_KINDS = [
  'contains',
  'links_to',
  'embeds',
  'backlinks_to',
  'mentions',
  'unlinked_mention',
  'imports',
  'exports',
  'calls',
  'implements',
  'extends',
  'depends_on',
  'tested_by',
  'documents',
  'generated_from',
  'related_to',
  'owned_by',
  'assigned_to',
  'used_by',
  'changed_by',
  'introduced_in',
  'fixed_by',
  'references_file',
  'references_symbol',
  'attached_to',
  'derived_from',
] as const;

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];
export type ContextSourceStatus = (typeof CONTEXT_SOURCE_STATUSES)[number];
export type ContextEntityKind = (typeof CONTEXT_ENTITY_KINDS)[number];
export type ContextEdgeKind = (typeof CONTEXT_EDGE_KINDS)[number];
export type ContextMapStatusV2 = 'active' | 'archived' | 'deleted';
export type ContextProvenanceTargetKind = 'entity' | 'edge';

export interface GitHubContextSourceV2 {
  installationId: string;
  owner: string;
  repository: string;
  selectedRef: string;
  resolvedCommitSha: string;
  visibility: 'public' | 'private' | 'internal';
}

export interface ContextSourceV2 {
  version: 2;
  id: string;
  accountId: string;
  mapId: string;
  kind: ContextSourceKind;
  label: string;
  status: ContextSourceStatus;
  localRoot?: string;
  localFile?: string;
  localFileScope?: ContextLocalFileScopeV1;
  github?: GitHubContextSourceV2;
  createdAt: number;
  updatedAt: number;
  lastIndexedAt?: number;
  lastVerifiedAt?: number;
  sourceRevision?: string;
  parserVersion: number;
}

export interface ContextReferenceV2 {
  entityId: string;
  kind: ContextEntityKind;
  label: string;
  sourceId: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ContextMapStatisticsV2 {
  sourceCount: number;
  entityCount: number;
  edgeCount: number;
  noteCount: number;
  attachmentCount: number;
  staleSourceCount: number;
}

export interface ContextMapRecordV2 {
  version: 2;
  id: string;
  accountId: string;
  projectId: string | null;
  name: string;
  status: ContextMapStatusV2;
  sourceIds: string[];
  selectedWorkspaceId?: string;
  summary: string;
  recommendedEntryPoints: ContextReferenceV2[];
  statistics: ContextMapStatisticsV2;
  createdAt: number;
  updatedAt: number;
  lastIndexedAt?: number;
  knowledgeRevision: number;
}

export interface ContextEntityV2 {
  version: 2;
  id: string;
  accountId: string;
  mapId: string;
  sourceId: string;
  kind: ContextEntityKind;
  label: string;
  path?: string;
  summary?: string;
  /** Physical source observations, distinct from entity lifecycle timestamps. */
  sourceSizeBytes?: number;
  sourceModifiedAt?: number;
  sourceRevision: string;
  provenanceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContextEdgeV2 {
  version: 2;
  id: string;
  accountId: string;
  mapId: string;
  sourceEntityId: string;
  targetEntityId: string;
  kind: ContextEdgeKind;
  provenanceIds: string[];
  confidence: number;
  sourceRevision: string;
  createdAt: number;
  updatedAt: number;
}

export interface ContextProvenanceV2 {
  version: 2;
  id: string;
  accountId: string;
  mapId: string;
  targetKind: ContextProvenanceTargetKind;
  targetId: string;
  sourceId: string;
  sourceKind: ContextSourceKind;
  path?: string;
  githubRef?: string;
  githubSha?: string;
  lineStart?: number;
  lineEnd?: number;
  heading?: string;
  blockId?: string;
  messageId?: string;
  terminalSessionId?: string;
  extractedAt: number;
  parser: string;
  confidence: number;
  sourceRevision: string;
}

export interface ContextGraphSnapshotV2 {
  version: 2;
  map: ContextMapRecordV2;
  sources: ContextSourceV2[];
  entities: ContextEntityV2[];
  edges: ContextEdgeV2[];
  provenance: ContextProvenanceV2[];
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ContextParseResult<T> =
  | Readonly<{ ok: true; value: DeepReadonly<T> }>
  | Readonly<{ ok: false; reason: string }>;

const MAP_STATUSES = ['active', 'archived', 'deleted'] as const;
const PROVENANCE_TARGET_KINDS = ['entity', 'edge'] as const;
const GITHUB_VISIBILITIES = ['public', 'private', 'internal'] as const;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 500;
const MAX_SUMMARY_CHARS = 8_192;
const MAX_PATH_CHARS = 4_096;
const MAX_REVISION_CHARS = 512;
const MAX_REFERENCE_COUNT = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

class ContextContractFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ContextContractFailure';
  }
}

function fail(reason: string): never {
  throw new ContextContractFailure(reason);
}

function plainRecord(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reason);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(reason);
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  reason: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) fail(reason);
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function safeString(value: unknown, reason: string, maximum = MAX_LABEL_CHARS): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail(reason);
  }
  return value;
}

function optionalSafeString(
  value: unknown,
  reason: string,
  maximum = MAX_LABEL_CHARS,
): string | undefined {
  return value === undefined ? undefined : safeString(value, reason, maximum);
}

function stableId(value: unknown, reason: string): string {
  const id = safeString(value, reason, MAX_ID_CHARS);
  if (!SAFE_ID.test(id)) fail(reason);
  return id;
}

function optionalStableId(value: unknown, reason: string): string | undefined {
  return value === undefined ? undefined : stableId(value, reason);
}

function safeInteger(value: unknown, reason: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(reason);
  return value as number;
}

function optionalSafeInteger(value: unknown, reason: string, minimum = 0): number | undefined {
  return value === undefined ? undefined : safeInteger(value, reason, minimum);
}

function confidence(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(reason);
  return value;
}

function uniqueIds(
  value: unknown,
  reason: string,
  options: Readonly<{ allowEmpty?: boolean; maximum?: number }> = {},
): string[] {
  if (!Array.isArray(value)) fail(reason);
  if (!options.allowEmpty && value.length === 0) fail(reason);
  if (value.length > (options.maximum ?? 100_000)) fail(reason);
  const ids = value.map((entry) => stableId(entry, reason));
  if (new Set(ids).size !== ids.length) fail(reason);
  return ids;
}

function timeOrder(
  createdAt: number,
  updatedAt: number,
  optionalTimes: readonly (number | undefined)[],
  reason: string,
): void {
  if (updatedAt < createdAt) fail(reason);
  if (
    optionalTimes.some((value) => value !== undefined && (value < createdAt || value > updatedAt))
  ) {
    fail(reason);
  }
}

function safePath(value: unknown, reason: string): string {
  const path = safeString(value, reason, MAX_PATH_CHARS);
  if (path.split(/[\\/]/).includes('..')) fail(reason);
  return path;
}

function optionalSafePath(value: unknown, reason: string): string | undefined {
  return value === undefined ? undefined : safePath(value, reason);
}

function absoluteLocalPath(value: unknown, reason: string): string {
  const path = safePath(value, reason);
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/') && !path.startsWith('\\\\')) {
    fail(reason);
  }
  return path;
}

function lineRange(
  startValue: unknown,
  endValue: unknown,
  reason: string,
): Readonly<{ lineStart?: number; lineEnd?: number }> {
  if (startValue === undefined && endValue === undefined) return {};
  if (startValue === undefined || endValue === undefined) fail(reason);
  const lineStart = safeInteger(startValue, reason, 1);
  const lineEnd = safeInteger(endValue, reason, 1);
  if (lineEnd < lineStart) fail(reason);
  return { lineStart, lineEnd };
}

function parseGitHubSource(value: unknown): GitHubContextSourceV2 {
  const record = plainRecord(value, 'source_github_invalid');
  exactKeys(
    record,
    ['installationId', 'owner', 'repository', 'selectedRef', 'resolvedCommitSha', 'visibility'],
    'source_github_keys_invalid',
  );
  const installationId = stableId(record.installationId, 'source_github_installation_invalid');
  const owner = safeString(record.owner, 'source_github_owner_invalid', 100);
  const repository = safeString(record.repository, 'source_github_repository_invalid', 100);
  if (!SAFE_GITHUB_NAME.test(owner) || !SAFE_GITHUB_NAME.test(repository)) {
    fail('source_github_repository_invalid');
  }
  const selectedRef = safeString(record.selectedRef, 'source_github_ref_invalid', 255);
  const resolvedCommitSha = safeString(record.resolvedCommitSha, 'source_github_sha_invalid', 64);
  if (!GITHUB_SHA.test(resolvedCommitSha)) fail('source_github_sha_invalid');
  if (!isOneOf(record.visibility, GITHUB_VISIBILITIES)) fail('source_github_visibility_invalid');
  return {
    installationId,
    owner,
    repository,
    selectedRef,
    resolvedCommitSha,
    visibility: record.visibility,
  };
}

function parseContextSourceUnsafe(value: unknown): ContextSourceV2 {
  const record = plainRecord(value, 'source_invalid');
  exactKeys(
    record,
    [
      'version',
      'id',
      'accountId',
      'mapId',
      'kind',
      'label',
      'status',
      'localRoot',
      'localFile',
      'localFileScope',
      'github',
      'createdAt',
      'updatedAt',
      'lastIndexedAt',
      'lastVerifiedAt',
      'sourceRevision',
      'parserVersion',
    ],
    'source_keys_invalid',
  );
  if (record.version !== CONTEXT_SCHEMA_VERSION) fail('source_version_invalid');
  if (!isOneOf(record.kind, CONTEXT_SOURCE_KINDS)) fail('source_kind_invalid');
  if (!isOneOf(record.status, CONTEXT_SOURCE_STATUSES)) fail('source_status_invalid');
  const createdAt = safeInteger(record.createdAt, 'source_created_at_invalid');
  const updatedAt = safeInteger(record.updatedAt, 'source_updated_at_invalid');
  const lastIndexedAt = optionalSafeInteger(record.lastIndexedAt, 'source_last_indexed_at_invalid');
  const lastVerifiedAt = optionalSafeInteger(
    record.lastVerifiedAt,
    'source_last_verified_at_invalid',
  );
  timeOrder(createdAt, updatedAt, [lastIndexedAt, lastVerifiedAt], 'source_time_order_invalid');

  const localRoot =
    record.localRoot === undefined
      ? undefined
      : absoluteLocalPath(record.localRoot, 'source_locator_invalid');
  const localFile =
    record.localFile === undefined
      ? undefined
      : absoluteLocalPath(record.localFile, 'source_locator_invalid');
  const github = record.github === undefined ? undefined : parseGitHubSource(record.github);
  const locatorValid =
    (record.kind === 'local_folder' && localRoot !== undefined && !localFile && !github) ||
    (record.kind === 'portable_markdown_folder' &&
      localRoot !== undefined &&
      !localFile &&
      !github) ||
    (record.kind === 'local_file' && localFile !== undefined && !localRoot && !github) ||
    (record.kind === 'github_repository' && github !== undefined && !localRoot && !localFile) ||
    (record.kind === 'linked_vibespace_content' && !localRoot && !localFile && !github);
  if (!locatorValid) fail('source_locator_invalid');

  let localFileScope: ContextLocalFileScopeV1 | undefined;
  if (record.localFileScope !== undefined) {
    try {
      if (record.kind !== 'local_file' || !localFile) fail('source_local_file_scope_invalid');
      localFileScope = parseContextLocalFileScope(record.localFileScope);
      assertContextLocalFilePath(
        { sourceType: 'local_file', rootDir: localFileScope.rootDir, localFileScope },
        localFile,
      );
    } catch {
      fail('source_local_file_scope_invalid');
    }
  }

  return {
    version: CONTEXT_SCHEMA_VERSION,
    id: stableId(record.id, 'source_id_invalid'),
    accountId: stableId(record.accountId, 'source_account_id_invalid'),
    mapId: stableId(record.mapId, 'source_map_id_invalid'),
    kind: record.kind,
    label: safeString(record.label, 'source_label_invalid'),
    status: record.status,
    ...(localRoot ? { localRoot } : {}),
    ...(localFile ? { localFile: localFileScope?.filePath ?? localFile } : {}),
    ...(localFileScope ? { localFileScope } : {}),
    ...(github ? { github } : {}),
    createdAt,
    updatedAt,
    ...(lastIndexedAt === undefined ? {} : { lastIndexedAt }),
    ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
    ...(record.sourceRevision === undefined
      ? {}
      : {
          sourceRevision: safeString(
            record.sourceRevision,
            'source_revision_invalid',
            MAX_REVISION_CHARS,
          ),
        }),
    parserVersion: safeInteger(record.parserVersion, 'source_parser_version_invalid', 1),
  };
}

function parseReference(value: unknown): ContextReferenceV2 {
  const record = plainRecord(value, 'reference_invalid');
  exactKeys(
    record,
    ['entityId', 'kind', 'label', 'sourceId', 'path', 'lineStart', 'lineEnd'],
    'reference_keys_invalid',
  );
  if (!isOneOf(record.kind, CONTEXT_ENTITY_KINDS)) fail('reference_kind_invalid');
  const range = lineRange(record.lineStart, record.lineEnd, 'reference_line_range_invalid');
  return {
    entityId: stableId(record.entityId, 'reference_entity_id_invalid'),
    kind: record.kind,
    label: safeString(record.label, 'reference_label_invalid'),
    sourceId: stableId(record.sourceId, 'reference_source_id_invalid'),
    ...(record.path === undefined ? {} : { path: safePath(record.path, 'reference_path_invalid') }),
    ...range,
  };
}

function parseStatistics(value: unknown): ContextMapStatisticsV2 {
  const record = plainRecord(value, 'map_statistics_invalid');
  exactKeys(
    record,
    ['sourceCount', 'entityCount', 'edgeCount', 'noteCount', 'attachmentCount', 'staleSourceCount'],
    'map_statistics_keys_invalid',
  );
  return {
    sourceCount: safeInteger(record.sourceCount, 'map_source_count_invalid'),
    entityCount: safeInteger(record.entityCount, 'map_entity_count_invalid'),
    edgeCount: safeInteger(record.edgeCount, 'map_edge_count_invalid'),
    noteCount: safeInteger(record.noteCount, 'map_note_count_invalid'),
    attachmentCount: safeInteger(record.attachmentCount, 'map_attachment_count_invalid'),
    staleSourceCount: safeInteger(record.staleSourceCount, 'map_stale_source_count_invalid'),
  };
}

function parseContextMapUnsafe(value: unknown): ContextMapRecordV2 {
  const record = plainRecord(value, 'map_invalid');
  exactKeys(
    record,
    [
      'version',
      'id',
      'accountId',
      'projectId',
      'name',
      'status',
      'sourceIds',
      'selectedWorkspaceId',
      'summary',
      'recommendedEntryPoints',
      'statistics',
      'createdAt',
      'updatedAt',
      'lastIndexedAt',
      'knowledgeRevision',
    ],
    'map_keys_invalid',
  );
  if (record.version !== CONTEXT_SCHEMA_VERSION) fail('map_version_invalid');
  if (!isOneOf(record.status, MAP_STATUSES)) fail('map_status_invalid');
  if (record.projectId !== null && typeof record.projectId !== 'string') {
    fail('map_project_id_invalid');
  }
  const projectId =
    record.projectId === null ? null : stableId(record.projectId, 'map_project_id_invalid');
  const createdAt = safeInteger(record.createdAt, 'map_created_at_invalid');
  const updatedAt = safeInteger(record.updatedAt, 'map_updated_at_invalid');
  const lastIndexedAt = optionalSafeInteger(record.lastIndexedAt, 'map_last_indexed_at_invalid');
  timeOrder(createdAt, updatedAt, [lastIndexedAt], 'map_time_order_invalid');
  if (!Array.isArray(record.recommendedEntryPoints)) fail('map_entry_points_invalid');
  if (record.recommendedEntryPoints.length > MAX_REFERENCE_COUNT) {
    fail('map_entry_points_invalid');
  }
  const recommendedEntryPoints = record.recommendedEntryPoints.map(parseReference);
  const entryIds = recommendedEntryPoints.map((entry) => entry.entityId);
  if (new Set(entryIds).size !== entryIds.length) fail('map_entry_points_duplicate');
  return {
    version: CONTEXT_SCHEMA_VERSION,
    id: stableId(record.id, 'map_id_invalid'),
    accountId: stableId(record.accountId, 'map_account_id_invalid'),
    projectId,
    name: safeString(record.name, 'map_name_invalid'),
    status: record.status,
    sourceIds: uniqueIds(record.sourceIds, 'map_source_ids_invalid'),
    ...(record.selectedWorkspaceId === undefined
      ? {}
      : {
          selectedWorkspaceId: stableId(
            record.selectedWorkspaceId,
            'map_selected_workspace_id_invalid',
          ),
        }),
    summary:
      record.summary === ''
        ? ''
        : safeString(record.summary, 'map_summary_invalid', MAX_SUMMARY_CHARS),
    recommendedEntryPoints,
    statistics: parseStatistics(record.statistics),
    createdAt,
    updatedAt,
    ...(lastIndexedAt === undefined ? {} : { lastIndexedAt }),
    knowledgeRevision: safeInteger(record.knowledgeRevision, 'map_knowledge_revision_invalid'),
  };
}

function parseContextEntityUnsafe(value: unknown): ContextEntityV2 {
  const record = plainRecord(value, 'entity_invalid');
  exactKeys(
    record,
    [
      'version',
      'id',
      'accountId',
      'mapId',
      'sourceId',
      'kind',
      'label',
      'path',
      'summary',
      'sourceRevision',
      'sourceSizeBytes',
      'sourceModifiedAt',
      'provenanceIds',
      'createdAt',
      'updatedAt',
    ],
    'entity_keys_invalid',
  );
  if (record.version !== CONTEXT_SCHEMA_VERSION) fail('entity_version_invalid');
  if (!isOneOf(record.kind, CONTEXT_ENTITY_KINDS)) fail('entity_kind_invalid');
  const createdAt = safeInteger(record.createdAt, 'entity_created_at_invalid');
  const updatedAt = safeInteger(record.updatedAt, 'entity_updated_at_invalid');
  timeOrder(createdAt, updatedAt, [], 'entity_time_order_invalid');
  return {
    version: CONTEXT_SCHEMA_VERSION,
    id: stableId(record.id, 'entity_id_invalid'),
    accountId: stableId(record.accountId, 'entity_account_id_invalid'),
    mapId: stableId(record.mapId, 'entity_map_id_invalid'),
    sourceId: stableId(record.sourceId, 'entity_source_id_invalid'),
    kind: record.kind,
    label: safeString(record.label, 'entity_label_invalid'),
    ...(record.path === undefined ? {} : { path: safePath(record.path, 'entity_path_invalid') }),
    ...(record.summary === undefined
      ? {}
      : {
          summary:
            record.summary === ''
              ? ''
              : safeString(record.summary, 'entity_summary_invalid', MAX_SUMMARY_CHARS),
        }),
    ...(record.sourceSizeBytes === undefined
      ? {}
      : { sourceSizeBytes: safeInteger(record.sourceSizeBytes, 'entity_source_size_invalid') }),
    ...(record.sourceModifiedAt === undefined
      ? {}
      : { sourceModifiedAt: safeInteger(record.sourceModifiedAt, 'entity_source_modified_invalid') }),
    sourceRevision: safeString(
      record.sourceRevision,
      'entity_source_revision_invalid',
      MAX_REVISION_CHARS,
    ),
    provenanceIds: uniqueIds(record.provenanceIds, 'entity_provenance_ids_invalid'),
    createdAt,
    updatedAt,
  };
}

function parseContextEdgeUnsafe(value: unknown): ContextEdgeV2 {
  const record = plainRecord(value, 'edge_invalid');
  exactKeys(
    record,
    [
      'version',
      'id',
      'accountId',
      'mapId',
      'sourceEntityId',
      'targetEntityId',
      'kind',
      'provenanceIds',
      'confidence',
      'sourceRevision',
      'createdAt',
      'updatedAt',
    ],
    'edge_keys_invalid',
  );
  if (record.version !== CONTEXT_SCHEMA_VERSION) fail('edge_version_invalid');
  if (!isOneOf(record.kind, CONTEXT_EDGE_KINDS)) fail('edge_kind_invalid');
  const sourceEntityId = stableId(record.sourceEntityId, 'edge_source_entity_id_invalid');
  const targetEntityId = stableId(record.targetEntityId, 'edge_target_entity_id_invalid');
  if (sourceEntityId === targetEntityId) fail('edge_self_reference_invalid');
  const createdAt = safeInteger(record.createdAt, 'edge_created_at_invalid');
  const updatedAt = safeInteger(record.updatedAt, 'edge_updated_at_invalid');
  timeOrder(createdAt, updatedAt, [], 'edge_time_order_invalid');
  return {
    version: CONTEXT_SCHEMA_VERSION,
    id: stableId(record.id, 'edge_id_invalid'),
    accountId: stableId(record.accountId, 'edge_account_id_invalid'),
    mapId: stableId(record.mapId, 'edge_map_id_invalid'),
    sourceEntityId,
    targetEntityId,
    kind: record.kind,
    provenanceIds: uniqueIds(record.provenanceIds, 'edge_provenance_ids_invalid'),
    confidence: confidence(record.confidence, 'edge_confidence_invalid'),
    sourceRevision: safeString(
      record.sourceRevision,
      'edge_source_revision_invalid',
      MAX_REVISION_CHARS,
    ),
    createdAt,
    updatedAt,
  };
}

function parseContextProvenanceUnsafe(value: unknown): ContextProvenanceV2 {
  const record = plainRecord(value, 'provenance_invalid');
  exactKeys(
    record,
    [
      'version',
      'id',
      'accountId',
      'mapId',
      'targetKind',
      'targetId',
      'sourceId',
      'sourceKind',
      'path',
      'githubRef',
      'githubSha',
      'lineStart',
      'lineEnd',
      'heading',
      'blockId',
      'messageId',
      'terminalSessionId',
      'extractedAt',
      'parser',
      'confidence',
      'sourceRevision',
    ],
    'provenance_keys_invalid',
  );
  if (record.version !== CONTEXT_SCHEMA_VERSION) fail('provenance_version_invalid');
  if (!isOneOf(record.targetKind, PROVENANCE_TARGET_KINDS)) {
    fail('provenance_target_kind_invalid');
  }
  if (!isOneOf(record.sourceKind, CONTEXT_SOURCE_KINDS)) {
    fail('provenance_source_kind_invalid');
  }
  const githubSha = optionalSafeString(record.githubSha, 'provenance_github_sha_invalid', 64);
  if (githubSha !== undefined && !GITHUB_SHA.test(githubSha)) {
    fail('provenance_github_sha_invalid');
  }
  const range = lineRange(record.lineStart, record.lineEnd, 'provenance_line_range_invalid');
  return {
    version: CONTEXT_SCHEMA_VERSION,
    id: stableId(record.id, 'provenance_id_invalid'),
    accountId: stableId(record.accountId, 'provenance_account_id_invalid'),
    mapId: stableId(record.mapId, 'provenance_map_id_invalid'),
    targetKind: record.targetKind,
    targetId: stableId(record.targetId, 'provenance_target_id_invalid'),
    sourceId: stableId(record.sourceId, 'provenance_source_id_invalid'),
    sourceKind: record.sourceKind,
    ...(record.path === undefined
      ? {}
      : { path: safePath(record.path, 'provenance_path_invalid') }),
    ...(record.githubRef === undefined
      ? {}
      : {
          githubRef: safeString(
            record.githubRef,
            'provenance_github_ref_invalid',
            MAX_REVISION_CHARS,
          ),
        }),
    ...(githubSha === undefined ? {} : { githubSha }),
    ...range,
    ...(record.heading === undefined
      ? {}
      : { heading: safeString(record.heading, 'provenance_heading_invalid', MAX_PATH_CHARS) }),
    ...(optionalStableId(record.blockId, 'provenance_block_id_invalid') === undefined
      ? {}
      : { blockId: record.blockId as string }),
    ...(optionalStableId(record.messageId, 'provenance_message_id_invalid') === undefined
      ? {}
      : { messageId: record.messageId as string }),
    ...(optionalStableId(record.terminalSessionId, 'provenance_terminal_session_id_invalid') ===
    undefined
      ? {}
      : { terminalSessionId: record.terminalSessionId as string }),
    extractedAt: safeInteger(record.extractedAt, 'provenance_extracted_at_invalid'),
    parser: safeString(record.parser, 'provenance_parser_invalid', 200),
    confidence: confidence(record.confidence, 'provenance_confidence_invalid'),
    sourceRevision: safeString(
      record.sourceRevision,
      'provenance_source_revision_invalid',
      MAX_REVISION_CHARS,
    ),
  };
}

function uniqueById<T extends { id: string }>(items: readonly T[], reason: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) fail(reason);
    result.set(item.id, item);
  }
  return result;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function parseContextGraphSnapshotUnsafe(value: unknown): ContextGraphSnapshotV2 {
  const record = plainRecord(value, 'snapshot_invalid');
  exactKeys(
    record,
    ['version', 'map', 'sources', 'entities', 'edges', 'provenance'],
    'snapshot_keys_invalid',
  );
  if (record.version !== CONTEXT_SCHEMA_VERSION) fail('snapshot_version_invalid');
  if (
    !Array.isArray(record.sources) ||
    !Array.isArray(record.entities) ||
    !Array.isArray(record.edges) ||
    !Array.isArray(record.provenance)
  ) {
    fail('snapshot_collections_invalid');
  }
  const map = parseContextMapUnsafe(record.map);
  const sources = record.sources.map(parseContextSourceUnsafe);
  const entities = record.entities.map(parseContextEntityUnsafe);
  const edges = record.edges.map(parseContextEdgeUnsafe);
  const provenance = record.provenance.map(parseContextProvenanceUnsafe);
  const sourceById = uniqueById(sources, 'snapshot_source_id_duplicate');
  const entityById = uniqueById(entities, 'snapshot_entity_id_duplicate');
  const edgeById = uniqueById(edges, 'snapshot_edge_id_duplicate');
  const provenanceById = uniqueById(provenance, 'snapshot_provenance_id_duplicate');

  if (
    !sameIds(
      map.sourceIds,
      sources.map((source) => source.id),
    )
  ) {
    fail('snapshot_source_set_mismatch');
  }
  if (
    map.statistics.sourceCount !== sources.length ||
    map.statistics.entityCount !== entities.length ||
    map.statistics.edgeCount !== edges.length ||
    map.statistics.noteCount !==
      entities.filter((entity) => entity.kind === 'markdown_note').length ||
    map.statistics.attachmentCount !==
      entities.filter((entity) => entity.kind === 'attachment').length ||
    map.statistics.staleSourceCount !== sources.filter((source) => source.status === 'stale').length
  ) {
    fail('snapshot_statistics_mismatch');
  }

  const ownedRecords: ReadonlyArray<{ accountId: string; mapId: string }> = [
    ...sources,
    ...entities,
    ...edges,
    ...provenance,
  ];
  if (ownedRecords.some((item) => item.accountId !== map.accountId || item.mapId !== map.id)) {
    fail('snapshot_ownership_mismatch');
  }

  for (const entity of entities) {
    const source = sourceById.get(entity.sourceId);
    if (!source) fail('entity_source_missing');
    if (source.sourceRevision && source.sourceRevision !== entity.sourceRevision) {
      fail('entity_source_revision_mismatch');
    }
    for (const provenanceId of entity.provenanceIds) {
      const entry = provenanceById.get(provenanceId);
      if (!entry) fail('entity_provenance_missing');
      if (entry.targetKind !== 'entity' || entry.targetId !== entity.id) {
        fail('entity_provenance_target_mismatch');
      }
    }
  }

  for (const edge of edges) {
    if (!entityById.has(edge.sourceEntityId)) fail('edge_source_missing');
    if (!entityById.has(edge.targetEntityId)) fail('edge_target_missing');
    for (const provenanceId of edge.provenanceIds) {
      const entry = provenanceById.get(provenanceId);
      if (!entry) fail('edge_provenance_missing');
      if (entry.targetKind !== 'edge' || entry.targetId !== edge.id) {
        fail('edge_provenance_target_mismatch');
      }
    }
  }

  for (const entry of provenance) {
    const source = sourceById.get(entry.sourceId);
    if (!source) fail('provenance_source_missing');
    if (entry.sourceKind !== source.kind) fail('provenance_source_kind_mismatch');
    if (source.sourceRevision && entry.sourceRevision !== source.sourceRevision) {
      fail('provenance_source_revision_mismatch');
    }
    const targetExists =
      entry.targetKind === 'entity' ? entityById.has(entry.targetId) : edgeById.has(entry.targetId);
    if (!targetExists) fail('provenance_target_missing');
  }

  for (const reference of map.recommendedEntryPoints) {
    const entity = entityById.get(reference.entityId);
    if (!entity || entity.kind !== reference.kind || entity.sourceId !== reference.sourceId) {
      fail('map_entry_point_target_mismatch');
    }
  }

  return {
    version: CONTEXT_SCHEMA_VERSION,
    map,
    sources,
    entities,
    edges,
    provenance,
  };
}

function detachedDeepFreeze<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => detachedDeepFreeze(entry)),
    ) as unknown as DeepReadonly<T>;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) copy[key] = detachedDeepFreeze(entry);
    return Object.freeze(copy) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

function parseResult<T>(operation: () => T): ContextParseResult<T> {
  try {
    return Object.freeze({ ok: true as const, value: detachedDeepFreeze(operation()) });
  } catch (error) {
    if (error instanceof ContextContractFailure) {
      return Object.freeze({ ok: false as const, reason: error.reason });
    }
    return Object.freeze({ ok: false as const, reason: 'context_contract_invalid' });
  }
}

export function parseContextSourceV2(value: unknown): ContextParseResult<ContextSourceV2> {
  return parseResult(() => parseContextSourceUnsafe(value));
}

export function parseContextMapRecordV2(value: unknown): ContextParseResult<ContextMapRecordV2> {
  return parseResult(() => parseContextMapUnsafe(value));
}

export function parseContextEntityV2(value: unknown): ContextParseResult<ContextEntityV2> {
  return parseResult(() => parseContextEntityUnsafe(value));
}

export function parseContextEdgeV2(value: unknown): ContextParseResult<ContextEdgeV2> {
  return parseResult(() => parseContextEdgeUnsafe(value));
}

export function parseContextProvenanceV2(value: unknown): ContextParseResult<ContextProvenanceV2> {
  return parseResult(() => parseContextProvenanceUnsafe(value));
}

export function parseContextGraphSnapshotV2(
  value: unknown,
): ContextParseResult<ContextGraphSnapshotV2> {
  return parseResult(() => parseContextGraphSnapshotUnsafe(value));
}
