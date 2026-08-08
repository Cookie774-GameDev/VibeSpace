import { db, openDb, type JarvisDexie } from '@/lib/db';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import {
  convertContextMapRecordV1ToSnapshotV2,
  contextSelectionSettingKey,
  migrateContextV1ForAccount,
  type ContextSelectionV2,
  type ContextV1MigrationResult,
} from './migration';
import { createContextGraphRepository } from './repository';
import type { ContextEntityKind, ContextEntityV2, ContextGraphSnapshotV2 } from './contracts';
import { queueContextCloudDocument, type ContextCloudDocumentV1 } from './contextCloudSync';
import { loadContextRecoverySummary, type ContextRecoverySummary } from './contextRecovery';
import {
  contextNodeFilePath,
  findContextFileNodeByPath,
  type ContextMapRecord,
  type ContextNodeKind,
  type ContextTreeNode,
  type ProjectContextTree,
} from './tree';

export interface ContextPersistenceState {
  accountId: string;
  projectId: string | null;
  maps: readonly ContextMapRecord[];
  selectedMapId: string | null;
  selectedFile: string | null;
  migration: ContextV1MigrationResult;
  recovery: ContextRecoverySummary | null;
}

export interface ContextPersistenceService {
  initialize(accountId: string, projectId: string | null): Promise<ContextPersistenceState>;
  load(accountId: string, projectId: string | null): Promise<ContextPersistenceState>;
  saveTree(
    accountId: string,
    tree: ProjectContextTree,
    options?: ContextTreeSaveOptions,
  ): Promise<ContextPersistenceState>;
  selectMap(
    accountId: string,
    projectId: string | null,
    mapId: string,
  ): Promise<ContextPersistenceState>;
  deleteMap(
    accountId: string,
    projectId: string | null,
    mapId: string,
  ): Promise<ContextPersistenceState>;
  selectFile(
    accountId: string,
    projectId: string | null,
    path: string,
  ): Promise<ContextPersistenceState>;
}

export interface ContextTreeSaveOptions {
  mapId?: string;
  name?: string;
  source?: {
    kind: 'local_folder' | 'local_file' | 'github_repository';
    label: string;
    branchRef?: string;
    github?: {
      installationId: string;
      owner: string;
      repository: string;
      resolvedCommitSha: string;
      visibility: 'public' | 'private' | 'internal';
    };
  };
}

type Publish = (state: ContextPersistenceState) => void;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const MAX_ACTIVE_MAPS = 5;

function fail(detail: string): never {
  throw new Error(`context_persistence_${detail}`);
}

function assertIdentity(accountId: string, projectId: string | null): void {
  if (!SAFE_ID.test(accountId) || (projectId !== null && !SAFE_ID.test(projectId))) {
    fail('identity_invalid');
  }
}

function nodeKind(kind: ContextEntityKind): ContextNodeKind {
  if (kind === 'folder') return 'area';
  if (kind === 'file') return 'file';
  if (kind === 'markdown_note') return 'note';
  if (kind === 'map' || kind === 'source') return 'root';
  return 'symbol';
}

function treeFromSnapshot(snapshot: ContextGraphSnapshotV2): ProjectContextTree {
  const source = snapshot.sources[0];
  if (!source) fail('source_missing');
  const sourceRoot =
    source.localRoot ??
    source.localFile ??
    (source.github
      ? `https://github.com/${source.github.owner}/${source.github.repository}/tree/${source.github.resolvedCommitSha}`
      : '');
  const byId = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const children = new Map<string, string[]>();
  const childIds = new Set<string>();
  const parentByChild = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'contains') continue;
    if (!byId.has(edge.sourceEntityId) || !byId.has(edge.targetEntityId)) {
      fail('contains_edge_invalid');
    }
    if (edge.sourceEntityId === edge.targetEntityId || parentByChild.has(edge.targetEntityId)) {
      fail('contains_hierarchy_invalid');
    }
    parentByChild.set(edge.targetEntityId, edge.sourceEntityId);
    const list = children.get(edge.sourceEntityId) ?? [];
    list.push(edge.targetEntityId);
    children.set(edge.sourceEntityId, list);
    childIds.add(edge.targetEntityId);
  }
  const built = new Set<string>();
  const build = (entity: ContextEntityV2, ancestors: ReadonlySet<string>): ContextTreeNode => {
    if (ancestors.has(entity.id)) fail('contains_cycle');
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(entity.id);
    built.add(entity.id);
    const nested = (children.get(entity.id) ?? []).map((id) => build(byId.get(id)!, nextAncestors));
    return {
      id: entity.id,
      title: entity.label,
      kind: nodeKind(entity.kind),
      summary: entity.summary ?? '',
      ...(entity.path ? { path: entity.path } : {}),
      createdAt: entity.createdAt,
      modifiedAt: entity.updatedAt,
      ...(nested.length ? { children: nested } : {}),
    };
  };
  const roots = snapshot.entities
    .filter((entity) => !childIds.has(entity.id))
    .map((entity) => build(entity, new Set()));
  for (const entity of snapshot.entities) {
    if (!built.has(entity.id)) roots.push(build(entity, new Set()));
  }
  return {
    version: 1,
    projectId: snapshot.map.projectId,
    rootDir: sourceRoot,
    generatedAt: snapshot.map.lastIndexedAt ?? snapshot.map.updatedAt,
    model: 'context-map-v2',
    fileCount: snapshot.entities.filter((entity) => entity.kind === 'file').length,
    totalBytes: 0,
    summary: snapshot.map.summary,
    nodes: roots,
    recommendedEntryPoints: snapshot.map.recommendedEntryPoints
      .map((reference) => reference.path ?? reference.label)
      .slice(0, 100),
  };
}

function mapFromSnapshot(snapshot: ContextGraphSnapshotV2): ContextMapRecord {
  const source = snapshot.sources[0];
  if (!source) fail('source_missing');
  const rootDir =
    source.localRoot ??
    source.localFile ??
    (source.github
      ? `https://github.com/${source.github.owner}/${source.github.repository}/tree/${source.github.resolvedCommitSha}`
      : '');
  return {
    id: snapshot.map.id,
    projectId: snapshot.map.projectId,
    rootDir,
    name: snapshot.map.name,
    status: snapshot.map.status === 'active' ? 'active' : 'deleted',
    createdAt: snapshot.map.createdAt,
    updatedAt: snapshot.map.updatedAt,
    sourceType: source.kind,
    sourceLabel: source.label,
    sourceStatus: source.status,
    branchRef: source.github?.selectedRef,
    github: source.github
      ? {
          owner: source.github.owner,
          repository: source.github.repository,
          resolvedCommitSha: source.github.resolvedCommitSha,
          visibility: source.github.visibility,
        }
      : undefined,
    lastIndexedAt: snapshot.map.lastIndexedAt,
    tree: treeFromSnapshot(snapshot),
  };
}

function selectionFromRow(
  value: unknown,
  accountId: string,
  projectId: string | null,
  mapIds: ReadonlySet<string>,
): ContextSelectionV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 2, accountId, projectId, selectedMapId: null };
  }
  const selection = value as Partial<ContextSelectionV2>;
  if (
    selection.version !== 2 ||
    selection.accountId !== accountId ||
    selection.projectId !== projectId
  ) {
    return { version: 2, accountId, projectId, selectedMapId: null };
  }
  const selectedMapId =
    typeof selection.selectedMapId === 'string' && mapIds.has(selection.selectedMapId)
      ? selection.selectedMapId
      : null;
  const selectedFile =
    selection.selectedFile &&
    typeof selection.selectedFile.mapId === 'string' &&
    mapIds.has(selection.selectedFile.mapId) &&
    typeof selection.selectedFile.relativePath === 'string'
      ? {
          mapId: selection.selectedFile.mapId,
          relativePath: selection.selectedFile.relativePath,
        }
      : undefined;
  return {
    version: 2,
    accountId,
    projectId,
    selectedMapId,
    ...(selectedFile ? { selectedFile } : {}),
  };
}

function scopeToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function generatedMapId(accountId: string, tree: ProjectContextTree): string {
  const root = tree.rootDir
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  const scope = scopeToken(`${accountId}\u0000${tree.projectId ?? '<default>'}`);
  return `map-${scope}-${root || 'project'}-${tree.generatedAt}`;
}

function mapName(tree: ProjectContextTree): string {
  const root = tree.rootDir
    .replace(/[\\/]$/gu, '')
    .split(/[\\/]/gu)
    .filter(Boolean)
    .at(-1);
  return `${root || 'Project'} Context Map`;
}

function freezeState(state: Omit<ContextPersistenceState, 'maps'> & { maps: ContextMapRecord[] }) {
  return Object.freeze({
    ...state,
    maps: Object.freeze(state.maps.map((map) => structuredClone(map))),
  });
}

export function createContextPersistenceService(
  database: JarvisDexie,
  storage: Pick<Storage, 'getItem'>,
  publish: Publish = () => {},
): ContextPersistenceService {
  const repository = createContextGraphRepository(database);
  const migrations = new Map<string, ContextV1MigrationResult>();
  const key = (accountId: string, projectId: string | null) =>
    `${accountId}\u0000${projectId ?? ''}`;

  const load = async (
    accountId: string,
    projectId: string | null,
  ): Promise<ContextPersistenceState> => {
    assertIdentity(accountId, projectId);
    const mapRows = await repository.listMaps(accountId, projectId);
    const snapshots = await Promise.all(
      mapRows.map((map) => repository.readWithRecovery(accountId, map.id)),
    );
    const maps = snapshots.flatMap((result) =>
      result.state === 'ready'
        ? [mapFromSnapshot(structuredClone(result.snapshot) as ContextGraphSnapshotV2)]
        : [],
    );
    const mapIds = new Set(maps.filter((map) => map.status === 'active').map((map) => map.id));
    const rawSelection = await database.settings.get(
      contextSelectionSettingKey(accountId, projectId),
    );
    const selection = selectionFromRow(rawSelection?.value, accountId, projectId, mapIds);
    const selectedMapId =
      selection.selectedMapId ?? maps.find((map) => map.status === 'active')?.id ?? null;
    const selectedMap = maps.find((map) => map.id === selectedMapId && map.status === 'active');
    const selectedFile =
      selection.selectedFile?.mapId === selectedMapId &&
      selectedMap &&
      findContextFileNodeByPath(selectedMap.tree, selection.selectedFile.relativePath)
        ? selection.selectedFile.relativePath
        : null;
    const migration =
      migrations.get(key(accountId, projectId)) ??
      Object.freeze({
        state: 'no_legacy_data',
        accountId,
        projectId,
        expectedMapCount: 0,
        migratedMapCount: 0,
        quarantinedCount: 0,
        legacyRetained: true,
        idRemaps: Object.freeze({}),
      });
    const recovery = await loadContextRecoverySummary(database, accountId, projectId, migration);
    const state = freezeState({
      accountId,
      projectId,
      maps,
      selectedMapId,
      selectedFile,
      migration,
      recovery,
    });
    publish(state);
    return state;
  };

  const writeSelection = async (
    accountId: string,
    projectId: string | null,
    selectedMapId: string | null,
    selectedFile?: ContextSelectionV2['selectedFile'],
  ) => {
    await database.settings.put({
      key: contextSelectionSettingKey(accountId, projectId),
      value: {
        version: 2,
        accountId,
        projectId,
        selectedMapId,
        ...(selectedFile ? { selectedFile } : {}),
      } satisfies ContextSelectionV2,
      updated_at: Date.now(),
    });
  };

  const service: ContextPersistenceService = {
    async initialize(accountId, projectId) {
      assertIdentity(accountId, projectId);
      let migration: ContextV1MigrationResult;
      try {
        migration = await migrateContextV1ForAccount({
          database,
          storage,
          accountId,
          projectId,
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('context_migration_legacy_claimed_by_another_account')
        ) {
          throw error;
        }
        migration = Object.freeze({
          state: 'foreign_legacy_ignored',
          accountId,
          projectId,
          expectedMapCount: 0,
          migratedMapCount: 0,
          quarantinedCount: 0,
          legacyRetained: true,
          idRemaps: Object.freeze({}),
        });
      }
      migrations.set(key(accountId, projectId), migration);
      return load(accountId, projectId);
    },

    load,

    async saveTree(accountId, tree, options = {}) {
      assertIdentity(accountId, tree.projectId);
      const current = await load(accountId, tree.projectId);
      const mapId = options.mapId ?? generatedMapId(accountId, tree);
      const globalExisting = await database.context_maps.get(mapId);
      if (
        globalExisting &&
        (globalExisting.accountId !== accountId || globalExisting.projectId !== tree.projectId)
      ) {
        fail('map_scope_conflict');
      }
      const existing = await repository.getSnapshot(accountId, mapId);
      if (existing && existing.map.projectId !== tree.projectId) {
        fail('map_scope_conflict');
      }
      if (
        !existing &&
        current.maps.filter((map) => map.status === 'active').length >= MAX_ACTIVE_MAPS
      ) {
        fail('active_map_limit');
      }
      const record: ContextMapRecord = {
        id: mapId,
        projectId: tree.projectId,
        rootDir: tree.rootDir,
        name:
          options.name?.trim() ||
          current.maps.find((map) => map.id === mapId)?.name ||
          mapName(tree),
        status: 'active',
        createdAt: existing?.map.createdAt ?? tree.generatedAt,
        updatedAt: Math.max(Date.now(), tree.generatedAt),
        sourceType: options.source?.kind ?? 'local_folder',
        sourceLabel: options.source?.label ?? 'Local folder',
        sourceStatus: 'ready',
        branchRef: options.source?.branchRef ?? 'workspace',
        github: options.source?.github
          ? {
              owner: options.source.github.owner,
              repository: options.source.github.repository,
              resolvedCommitSha: options.source.github.resolvedCommitSha,
              visibility: options.source.github.visibility,
            }
          : undefined,
        lastIndexedAt: tree.generatedAt,
        tree,
      };
      const snapshot = convertContextMapRecordV1ToSnapshotV2(record, accountId, mapId, {
        knowledgeRevision: (existing?.map.knowledgeRevision ?? 0) + 1,
        sourceStatus: 'ready',
        parser: 'context-tree-v2-persistence',
        github: options.source?.github,
        sourceLabel: options.source?.label,
        branchRef: options.source?.branchRef,
      });
      await repository.putSnapshot(accountId, snapshot, {
        expectedKnowledgeRevision: existing?.map.knowledgeRevision ?? 0,
      });
      await writeSelection(accountId, tree.projectId, mapId);
      return load(accountId, tree.projectId);
    },

    async selectMap(accountId, projectId, mapId) {
      const state = await load(accountId, projectId);
      if (!state.maps.some((map) => map.id === mapId && map.status === 'active')) {
        fail('map_missing');
      }
      await writeSelection(accountId, projectId, mapId);
      return load(accountId, projectId);
    },

    async deleteMap(accountId, projectId, mapId) {
      const snapshot = await repository.getSnapshot(accountId, mapId);
      if (!snapshot || snapshot.map.projectId !== projectId) fail('map_missing');
      if (snapshot.map.status !== 'deleted') {
        const next = structuredClone(snapshot) as ContextGraphSnapshotV2;
        next.map.status = 'deleted';
        next.map.updatedAt = Math.max(Date.now(), next.map.updatedAt);
        next.map.knowledgeRevision += 1;
        await repository.putSnapshot(accountId, next, {
          expectedKnowledgeRevision: snapshot.map.knowledgeRevision,
        });
      }
      return load(accountId, projectId);
    },

    async selectFile(accountId, projectId, path) {
      const state = await load(accountId, projectId);
      const clean = path.trim();
      const owner = state.maps.find(
        (map) => map.status === 'active' && findContextFileNodeByPath(map.tree, clean),
      );
      if (!owner) fail('selected_file_missing');
      const node = findContextFileNodeByPath(owner.tree, clean)!;
      await writeSelection(accountId, projectId, owner.id, {
        mapId: owner.id,
        relativePath: node.path!,
      });
      return load(accountId, projectId);
    },
  };
  return Object.freeze(service);
}

const productionStates = new Map<string, ContextPersistenceState>();
const productionInitializers = new Map<string, Promise<ContextPersistenceState>>();
let productionService: ContextPersistenceService | undefined;

function scopeKey(accountId: string, projectId: string | null): string {
  return `${accountId}\u0000${projectId ?? ''}`;
}

function publishProductionState(state: ContextPersistenceState): void {
  productionStates.set(scopeKey(state.accountId, state.projectId), state);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('jarvis:context-tree-updated', {
        detail: { projectId: state.projectId, mapId: state.selectedMapId, persistence: 'dexie-v2' },
      }),
    );
  }
}

async function queuePersistedMapMetadata(accountId: string, mapId: string): Promise<void> {
  const map = await db.context_maps.get(mapId);
  if (!map || map.accountId !== accountId) return;
  const deleted = map.status === 'deleted';
  const document: ContextCloudDocumentV1 = {
    version: 1,
    accountId,
    projectId: map.projectId,
    kind: 'map_metadata',
    id: map.id,
    revisionId: `map-revision-${map.knowledgeRevision}`,
    baseRevisionId: map.knowledgeRevision > 1 ? `map-revision-${map.knowledgeRevision - 1}` : null,
    provenance: {
      origin: 'app_metadata',
      producer: 'context_map_persistence',
    },
    updatedAt: map.updatedAt,
    ...(deleted ? { deletedAt: map.updatedAt } : {}),
    fields: deleted
      ? {}
      : {
          name: map.name,
          status: map.status,
          statistics: {
            sourceCount: map.statistics.sourceCount,
            entityCount: map.statistics.entityCount,
            edgeCount: map.statistics.edgeCount,
            noteCount: map.statistics.noteCount,
            attachmentCount: map.statistics.attachmentCount,
            staleSourceCount: map.statistics.staleSourceCount,
          },
          knowledgeRevision: map.knowledgeRevision,
          ...(map.lastIndexedAt === undefined ? {} : { lastIndexedAt: map.lastIndexedAt }),
        },
  };
  await queueContextCloudDocument(accountId, document, new AbortController().signal);
}

async function queuePersistedMapMetadataSafely(accountId: string, mapId: string): Promise<void> {
  try {
    await queuePersistedMapMetadata(accountId, mapId);
  } catch (error) {
    console.warn('[context] optional map metadata sync enqueue failed:', error);
  }
}

function getProductionService(): ContextPersistenceService {
  if (typeof window === 'undefined') fail('browser_unavailable');
  productionService ??= createContextPersistenceService(
    db,
    window.localStorage,
    publishProductionState,
  );
  return productionService;
}

function activeIdentity(): string {
  const identity = getActiveAccountIdentity();
  if (!identity) fail('identity_unavailable');
  return identity.accountId;
}

function assertActiveIdentity(accountId: string): void {
  if (activeIdentity() !== accountId) fail('identity_changed');
}

export function contextTreeFromPersistenceState(
  state: ContextPersistenceState,
): ProjectContextTree | null {
  return (
    state.maps.find((map) => map.id === state.selectedMapId && map.status === 'active')?.tree ??
    state.maps.find((map) => map.status === 'active')?.tree ??
    null
  );
}

export function contextSelectedFileFromPersistenceState(state: ContextPersistenceState): string {
  if (!state.selectedFile) return '';
  const map =
    state.maps.find(
      (candidate) => candidate.id === state.selectedMapId && candidate.status === 'active',
    ) ??
    state.maps.find(
      (candidate) =>
        candidate.status === 'active' &&
        findContextFileNodeByPath(candidate.tree, state.selectedFile!),
    );
  if (!map) return '';
  const node = findContextFileNodeByPath(map.tree, state.selectedFile);
  return node ? (contextNodeFilePath(map.tree, node) ?? '') : '';
}

export function getActiveContextPersistenceState(
  projectId: string | null,
): ContextPersistenceState | null {
  const identity = getActiveAccountIdentity();
  if (!identity) return null;
  return productionStates.get(scopeKey(identity.accountId, projectId)) ?? null;
}

export function getActivePersistedContextTree(projectId: string | null): ProjectContextTree | null {
  const state = getActiveContextPersistenceState(projectId);
  return state ? contextTreeFromPersistenceState(state) : null;
}

export function getActivePersistedContextSelectedFile(projectId: string | null): string {
  const state = getActiveContextPersistenceState(projectId);
  return state ? contextSelectedFileFromPersistenceState(state) : '';
}

export async function ensureContextPersistence(
  projectId: string | null,
): Promise<ContextPersistenceState> {
  const accountId = activeIdentity();
  const key = scopeKey(accountId, projectId);
  const current = productionInitializers.get(key);
  if (current) {
    const initialized = await current;
    assertActiveIdentity(accountId);
    return productionStates.get(key) ?? initialized;
  }
  const pending = (async () => {
    await openDb();
    return getProductionService().initialize(accountId, projectId);
  })();
  productionInitializers.set(key, pending);
  try {
    const initialized = await pending;
    assertActiveIdentity(accountId);
    return initialized;
  } catch (error) {
    productionInitializers.delete(key);
    throw error;
  }
}

export async function loadPersistedContextMaps(
  projectId: string | null,
): Promise<readonly ContextMapRecord[]> {
  return (await ensureContextPersistence(projectId)).maps;
}

export async function reloadPersistedContextMaps(
  projectId: string | null,
): Promise<readonly ContextMapRecord[]> {
  const initialized = await ensureContextPersistence(projectId);
  assertActiveIdentity(initialized.accountId);
  const reloaded = await getProductionService().load(initialized.accountId, projectId);
  assertActiveIdentity(initialized.accountId);
  return reloaded.maps;
}

export async function savePersistedContextTree(
  tree: ProjectContextTree,
  options: ContextTreeSaveOptions = {},
): Promise<ContextPersistenceState> {
  const initialized = await ensureContextPersistence(tree.projectId);
  assertActiveIdentity(initialized.accountId);
  const saved = await getProductionService().saveTree(initialized.accountId, tree, options);
  assertActiveIdentity(initialized.accountId);
  if (saved.selectedMapId) {
    await queuePersistedMapMetadataSafely(initialized.accountId, saved.selectedMapId);
    assertActiveIdentity(initialized.accountId);
  }
  return saved;
}

export async function selectPersistedContextMap(
  projectId: string | null,
  mapId: string,
): Promise<ContextPersistenceState> {
  const initialized = await ensureContextPersistence(projectId);
  assertActiveIdentity(initialized.accountId);
  const selected = await getProductionService().selectMap(initialized.accountId, projectId, mapId);
  assertActiveIdentity(initialized.accountId);
  return selected;
}

export async function deletePersistedContextMap(
  projectId: string | null,
  mapId: string,
): Promise<ContextPersistenceState> {
  const initialized = await ensureContextPersistence(projectId);
  assertActiveIdentity(initialized.accountId);
  const deleted = await getProductionService().deleteMap(initialized.accountId, projectId, mapId);
  assertActiveIdentity(initialized.accountId);
  await queuePersistedMapMetadataSafely(initialized.accountId, mapId);
  assertActiveIdentity(initialized.accountId);
  return deleted;
}

export async function selectPersistedContextFile(
  projectId: string | null,
  path: string,
): Promise<ContextPersistenceState> {
  const initialized = await ensureContextPersistence(projectId);
  assertActiveIdentity(initialized.accountId);
  const selected = await getProductionService().selectFile(initialized.accountId, projectId, path);
  assertActiveIdentity(initialized.accountId);
  return selected;
}
