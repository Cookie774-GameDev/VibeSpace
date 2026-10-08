import { contextLocalFileScopeFingerprint, readContextLocalFileScope } from './contextLocalFileScope';
import { db, openDb } from '@/lib/db';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { captureContextPersistenceScope, type ContextTreeCommitReceipt } from './contextPersistence';
import { createContextSearchIndexPopulationPort } from './contextSearchIndexing';
import { productionSiyuanContextMaps } from './siyuanContextMapIntegration';
import { readSiyuanMapManifest } from './siyuan/siyuanMapManifest';
import { readSiyuanIndexJob } from './siyuan/siyuanIndexJobStore';
import {
  buildProjectContextTreeFromSiyuanIndex,
  assertSiyuanLocalFileEntries,
  projectSiyuanMapForContextSearch,
  scanSiyuanFilesystemIndex,
  type SiyuanSafeIndex,
} from './siyuan/siyuanSafeIndex';
import { canonicalSiyuanAuthorityRoot } from './siyuan/siyuanPathAuthority';
import type { ContextMapRecord, ContextTreeNode, ProjectContextTree } from './tree';
import { contextEntityIdForTreeNode } from './migration';

export interface ContextAutoUpdateScope {
  accountId: string;
  workspaceId: string;
  projectId: string;
  mapId: string;
}
export interface ContextAutoMetadata {
  id: string;
  path: string | null;
  kind: string;
  title: string;
  size: number | null;
  modified: number | null;
}
export interface ContextAutoUpdateSetting extends ContextAutoUpdateScope {
  kind: 'context-auto-update-v1';
  enabled: boolean;
  consentRevision: number;
  fingerprint: string;
  baseline?: ContextAutoMetadata[];
  baselineMapRevision?: number;
  indexIdentityVersion?: 1;
  status?: 'watching' | 'waiting' | 'updating' | 'failed';
  error?: string;
  lastSuccessAt?: number;
}
export const CONTEXT_AUTO_UPDATE_EVENT = 'jarvis:context-auto-update-changed';
export const contextAutoUpdateKey = (scope: ContextAutoUpdateScope) =>
  `context-auto-update-v1:${JSON.stringify({ accountId: scope.accountId, workspaceId: scope.workspaceId,
    projectId: scope.projectId, mapId: scope.mapId })}`;
const summaryNone = { mode: 'none' as const, selectedExtensions: [], selectedPaths: [] };
const updatingScopes = new Set<string>();
// Read authority stays in memory; it is never persisted as part of the setting.
const settingObservations = new WeakMap<ContextAutoUpdateSetting, { updatedAt: number; value: string }>();
export const isContextAutoUpdateRunning = (scope: ContextAutoUpdateScope) =>
  updatingScopes.has(contextAutoUpdateKey(scope));

export function contextAutoFingerprint(map: ContextMapRecord): string {
  const manifest = map.projectId ? readSiyuanMapManifest(map.projectId, map.id) : null;
  const base = [
    canonicalSiyuanAuthorityRoot(map.rootDir),
    map.sourceType ?? 'local_folder',
    [...(manifest?.sourcePolicy.excludedPaths ?? [])].sort(),
  ];
  try {
    const fileScope = contextLocalFileScopeFingerprint(map);
    return JSON.stringify(fileScope ? [...base, fileScope] : base);
  } catch {
    // Legacy/invalid rows remain renderable; runtime admission still rejects them.
    return JSON.stringify([...base, 'context_local_file_scope_unavailable']);
  }
}
export function contextAutoMetadata(index: SiyuanSafeIndex): ContextAutoMetadata[] {
  return index.entries.map((entry) => ({
    id: entry.nodeId,
    path: entry.relativePath,
    kind: entry.kind,
    title: entry.title,
    size: entry.sizeBytes,
    modified: entry.modifiedAt,
  }));
}
function treeMetadata(tree: ProjectContextTree): ContextAutoMetadata[] {
  const entries: ContextAutoMetadata[] = [];
  const visit = (nodes: ProjectContextTree['nodes']) =>
    nodes.forEach((node) => {
      if (node.kind === 'file' || node.kind === 'area')
        entries.push({
          id: node.id,
          path: node.path ?? null,
          kind: node.kind,
          title: node.title,
          size: node.sizeBytes ?? null,
          modified: node.modifiedAt ?? null,
        });
      visit(node.children ?? []);
    });
  visit(tree.nodes);
  return entries;
}
export function contextAutoDelta(
  previous: readonly ContextAutoMetadata[],
  next: readonly ContextAutoMetadata[],
) {
  const old = new Map(previous.map((entry) => [entry.id, JSON.stringify(entry)]));
  const current = new Set(next.map((entry) => entry.id));
  return {
    changed: next
      .filter((entry) => old.get(entry.id) !== JSON.stringify(entry))
      .map((entry) => entry.id),
    deleted: previous.filter((entry) => !current.has(entry.id)).map((entry) => entry.id),
  };
}
export async function readContextAutoUpdate(
  scope: ContextAutoUpdateScope,
): Promise<ContextAutoUpdateSetting | null> {
  await openDb();
  const row = await db.settings.get(contextAutoUpdateKey(scope));
  const value = row?.value as ContextAutoUpdateSetting | undefined;
  if (
    !value ||
    value.kind !== 'context-auto-update-v1' ||
    value.accountId !== scope.accountId ||
    value.workspaceId !== scope.workspaceId ||
    value.projectId !== scope.projectId ||
    value.mapId !== scope.mapId
  )
    return null;
  settingObservations.set(value, { updatedAt: row!.updated_at, value: JSON.stringify(value) });
  return value;
}
function active(scope: ContextAutoUpdateScope) {
  const state = useAuthStore.getState();
  return (
    resolveAccountIdentity(state)?.accountId === scope.accountId &&
    String(state.workspaceId) === scope.workspaceId &&
    String(state.projectId) === scope.projectId
  );
}
function notify() {
  window.dispatchEvent(new Event(CONTEXT_AUTO_UPDATE_EVENT));
}
export async function setContextAutoUpdate(
  scope: ContextAutoUpdateScope,
  map: ContextMapRecord,
  enabled: boolean,
): Promise<void> {
  if (
    !active(scope) ||
    map.id !== scope.mapId ||
    map.projectId !== scope.projectId ||
    map.status !== 'active' ||
    (map.sourceType && map.sourceType !== 'local_folder')
  )
    throw new Error('context_auto_update_scope_invalid');
  await openDb();
  const persistence = await captureContextPersistenceScope(scope.accountId, scope.projectId);
  const latest = await persistence.loadMap(map.id);
  if (!latest || latest.status !== 'active' || latest.updatedAt !== map.updatedAt || !active(scope))
    throw new Error('context_auto_update_scope_changed');
  await db.settings.put({
    key: contextAutoUpdateKey(scope),
    value: {
      ...scope,
      kind: 'context-auto-update-v1',
      enabled,
      consentRevision: Date.now(),
      fingerprint: contextAutoFingerprint(latest),
      status: 'watching',
    } satisfies ContextAutoUpdateSetting,
    updated_at: Date.now(),
  });
  notify();
}

export interface ContextAutoUpdatePorts {
  readSetting(): Promise<ContextAutoUpdateSetting | null>;
  readMap(): Promise<ContextMapRecord | null>;
  fingerprint(map: ContextMapRecord): string;
  active(): boolean;
  scan(map: ContextMapRecord, signal: AbortSignal): Promise<SiyuanSafeIndex>;
  stage(
    map: ContextMapRecord,
    changed: string[],
    deleted: string[],
    signal: AbortSignal,
    options?: { reconcileMembership: true },
  ): Promise<{ commit(): Promise<void>; abort(): Promise<void> }>;
  sync(
    map: ContextMapRecord,
    index: SiyuanSafeIndex,
    signal: AbortSignal,
  ): Promise<ProjectContextTree>;
  saveTree(map: ContextMapRecord, tree: ProjectContextTree, signal?: AbortSignal, onCommitted?: (receipt: ContextTreeCommitReceipt) => void): Promise<ContextMapRecord>;
  prepareRollback?(map: ContextMapRecord): Promise<(savedUpdatedAt: number) => Promise<void>>;
  saveSetting(setting: ContextAutoUpdateSetting, recovery?: {
    observed: ContextAutoUpdateSetting;
    map: ContextMapRecord;
    signal: AbortSignal;
  }): Promise<void>;
  now(): number;
}

/** Two matching metadata observations batch saved edits; bodies are only read for changed files. */
export function createContextAutoUpdater(ports: ContextAutoUpdatePorts, scope?: ContextAutoUpdateScope) {
  const capturedScope = scope ? { ...scope } : undefined;
  let pendingSignature = '';
  let pendingSince = 0;
  let inFlight: Promise<'idle' | 'waiting' | 'updated'> | null = null;
  const run = async (signal: AbortSignal, manual: boolean): Promise<'idle' | 'waiting' | 'updated'> => {
    const setting = manual ? null : await ports.readSetting();
    if (!manual && (!setting?.enabled || !ports.active() || signal.aborted)) return 'idle';
    const owner = capturedScope ?? setting;
    if (!owner || !ports.active() || signal.aborted) throw new Error('context_auto_update_scope_changed');
    const key = contextAutoUpdateKey(owner);
    // The lease covers discovery, staging and compensation across updater instances.
    // In particular, awaiting stage is too late to acquire ownership.
    if (updatingScopes.has(key)) {
      if (manual) throw new Error('context_auto_update_busy');
      return 'idle';
    }
    updatingScopes.add(key);
    try {
      const map = await ports.readMap();
      if (!map || map.status !== 'active' || map.id !== owner.mapId || map.projectId !== owner.projectId ||
          (!manual && ports.fingerprint(map) !== setting!.fingerprint)) {
        if (manual) throw new Error('context_auto_update_scope_changed');
        return 'idle';
      }
      const fingerprint = ports.fingerprint(map);
      const guard = async (expectedRevision = map.updatedAt) => {
        const current = manual ? null : await ports.readSetting();
        const latest = await ports.readMap();
        if (
          signal.aborted || !ports.active() ||
          (!manual && (!current?.enabled || current.consentRevision !== setting!.consentRevision ||
            current.fingerprint !== fingerprint)) ||
          !latest || latest.status !== 'active' || latest.id !== owner.mapId || latest.projectId !== owner.projectId ||
          latest.updatedAt !== expectedRevision || ports.fingerprint(latest) !== fingerprint
        ) throw new Error('context_auto_update_scope_changed');
      };
      if (manual) await guard();
      readContextLocalFileScope(map);
      const index = await ports.scan(map, signal);
      // A partial discovery cannot authorize removing files absent from its result.
      if (index.unreadable > 0) throw new Error('context_auto_update_discovery_incomplete');
      await guard();
      assertSiyuanLocalFileEntries(map, index.entries);
      const metadata = contextAutoMetadata(index);
      // This is the last committed physical-source checkpoint, not a projection
      // revision. Rehydrating the same map must not discard source metadata.
      const baseline = setting?.baseline ?? treeMetadata(map.tree);
      const migrateIndexIdentity = manual || setting?.indexIdentityVersion !== 1 || !setting.baseline;
      const delta = contextAutoDelta(baseline, metadata);
      if (!migrateIndexIdentity && !delta.changed.length && !delta.deleted.length) {
        pendingSignature = '';
        if (setting?.status === 'failed' && setting.error === 'context_auto_update_scope_changed') {
          await ports.saveSetting({ ...setting, status: 'watching', error: undefined }, {
            observed: setting, map, signal,
          });
        }
        return 'idle';
      }
      const signature = JSON.stringify(metadata);
      if (!manual && signature !== pendingSignature) {
        pendingSignature = signature;
        pendingSince = ports.now();
        return 'waiting';
      }
      if (!manual && ports.now() - pendingSince < 1_500) return 'waiting';
      const fileIds = new Set(
        index.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.nodeId),
      );
      const previousFileIds = new Set(
        baseline.filter((entry) => entry.kind === 'file').map((entry) => entry.id),
      );
      const nextMap = {
        ...map,
        tree: buildProjectContextTreeFromSiyuanIndex(map.tree, index.entries),
      };
      // Initial population indexes the persisted V2 entity IDs. Refreshes must
      // use that same identity, while SiYuan bindings keep their filesystem IDs.
      const canonicalId = (id: string) => contextEntityIdForTreeNode(map.id, id);
      const canonicalNodes = (nodes: ContextTreeNode[]): ContextTreeNode[] =>
        nodes.map((node) => ({
          ...node,
          id: canonicalId(node.id),
          ...(node.children ? { children: canonicalNodes(node.children) } : {}),
        }));
      const restore = await ports.prepareRollback?.(map);
      await guard();
      const transaction = await ports.stage(
        { ...nextMap, tree: { ...nextMap.tree, nodes: canonicalNodes(nextMap.tree.nodes) } },
        (migrateIndexIdentity ? [...fileIds] : delta.changed.filter((id) => fileIds.has(id))).map(
          canonicalId,
        ),
        migrateIndexIdentity
          ? []
          : delta.deleted.filter((id) => previousFileIds.has(id)).map(canonicalId),
        signal,
        migrateIndexIdentity ? { reconcileMembership: true } : undefined,
      );
      let saved: ContextMapRecord | null = null;
      const saveReceipt: { current: ContextTreeCommitReceipt | null } = { current: null };
      let committed = false;
      try {
        await guard();
        const tree = await ports.sync(map, index, signal);
        await guard();
        // Check again after native/model-free graph reconciliation and before publication.
        saved = await ports.saveTree(map, { ...tree, generatedAt: ports.now() }, signal, receipt => {
          if (receipt.accountId === owner.accountId && receipt.projectId === owner.projectId &&
              receipt.mapId === map.id && receipt.updatedAt > map.updatedAt) saveReceipt.current = receipt;
        });
        await guard(saved.updatedAt);
        await transaction.commit();
        committed = true;
        if (setting) await ports.saveSetting({
          ...setting,
          baseline: metadata,
          baselineMapRevision: saved.updatedAt,
          indexIdentityVersion: 1,
          status: 'watching',
          lastSuccessAt: ports.now(),
          error: undefined,
        });
        pendingSignature = '';
        return 'updated';
      } catch (error) {
        if (!committed) {
          const failures: unknown[] = [error];
          try {
            await transaction.abort();
          } catch (abortError) {
            failures.push(abortError);
          }
          const savedUpdatedAt = saveReceipt.current?.updatedAt ?? saved?.updatedAt;
          if (savedUpdatedAt !== undefined) {
            try {
              if (restore) await restore(savedUpdatedAt);
              else if (saved) await ports.saveTree(saved, map.tree);
              else throw new Error('context_auto_update_rollback_receipt_unavailable');
            } catch (restoreError) {
              failures.push(restoreError);
            }
          }
          if (failures.length > 1)
            throw new AggregateError(failures, 'context_auto_update_rollback_needs_review');
        }
        throw error;
      }
    } finally {
      updatingScopes.delete(key);
    }
  };
  const start = (signal: AbortSignal, manual: boolean) => {
    if (inFlight) return manual ? Promise.reject(new Error('context_auto_update_busy')) : inFlight;
    inFlight = run(signal, manual).finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    tick: (signal: AbortSignal) => start(signal, false),
    refresh: (signal: AbortSignal) => start(signal, true),
  };
}

export async function createProductionContextAutoUpdater(scope: ContextAutoUpdateScope) {
  const persistence = await captureContextPersistenceScope(scope.accountId, scope.projectId);
  const search = createContextSearchIndexPopulationPort();
  const readMap = () => persistence.loadMap(scope.mapId);
  return createContextAutoUpdater({
    readSetting: () => readContextAutoUpdate(scope),
    readMap,
    fingerprint: contextAutoFingerprint,
    active: () => active(scope),
    now: () => Date.now(),
    async scan(map, signal) {
      readContextLocalFileScope(map);
      if (map.sourceStatus === 'indexing' || map.sourceStatus === 'pending' || map.sourceStatus === 'error') {
        throw new Error('context_auto_update_initial_map_not_ready');
      }
      const manifest = readSiyuanMapManifest(scope.projectId, map.id);
      const job = await readSiyuanIndexJob(scope.projectId, map.id);
      if (
        manifest?.status !== 'ready' ||
        job?.status !== 'completed' ||
        job.accountId !== scope.accountId ||
        canonicalSiyuanAuthorityRoot(manifest.sourceRoot) !==
          canonicalSiyuanAuthorityRoot(map.rootDir) ||
        canonicalSiyuanAuthorityRoot(job.canonicalRoot) !==
          canonicalSiyuanAuthorityRoot(map.rootDir)
      )
        throw new Error('context_auto_update_initial_map_not_ready');
      return scanSiyuanFilesystemIndex(map, summaryNone, {
        signal,
        excludedPaths: manifest.sourcePolicy.excludedPaths,
      });
    },
    async stage(map, changed, deleted, signal, options) {
      return search.stageChangedMap(
        scope.accountId,
        projectSiyuanMapForContextSearch(map),
        changed,
        deleted,
        signal,
        options,
      );
    },
    async sync(map, index, signal) {
      return (
        await productionSiyuanContextMaps.sync(scope.projectId, map, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          automaticRefresh: true,
          preScannedIndex: index,
          forceReconcile: true,
          signal,
        })
      ).tree;
    },
    async prepareRollback(map) {
      const restore = await persistence.captureMapRestore(map.id, map.updatedAt);
      return async savedUpdatedAt => { await restore(savedUpdatedAt); };
    },
    async saveTree(map, tree, signal, onCommitted) {
      const state = await persistence.saveExistingTree(tree, {
        mapId: map.id,
        name: map.name,
        expectedUpdatedAt: map.updatedAt,
        signal,
        onCommitted,
        select: false,
        source: {
          kind: 'local_folder',
          label: map.sourceLabel ?? 'Local folder',
          branchRef: map.branchRef,
        },
      });
      const saved = state.maps.find((entry) => entry.id === map.id);
      if (!saved) throw new Error('context_auto_update_map_missing');
      return saved;
    },
    async saveSetting(setting, recovery) {
      if (recovery) {
        const { observed, map, signal } = recovery;
        const observation = settingObservations.get(observed);
        if (!observation || observation.value !== JSON.stringify(observed)) return;
        let abortTransaction: (() => void) | undefined;
        const abort = () => abortTransaction?.();
        signal.addEventListener('abort', abort, { once: true });
        let recovered = false;
        try {
          await db.transaction('rw', db.settings, db.context_maps, async (transaction) => {
            abortTransaction = () => transaction.abort();
            signal.throwIfAborted();
            const row = await db.settings.get(contextAutoUpdateKey(scope));
            const current = row?.value as ContextAutoUpdateSetting | undefined;
            const currentMap = await db.context_maps.get(scope.mapId);
            signal.throwIfAborted();
            if (
              !active(scope) ||
              map.id !== scope.mapId || map.projectId !== scope.projectId ||
              !current?.enabled ||
              current.status !== 'failed' ||
              current.error !== 'context_auto_update_scope_changed' ||
              row?.updated_at !== observation.updatedAt ||
              JSON.stringify(current) !== observation.value ||
              !currentMap || currentMap.accountId !== scope.accountId ||
              currentMap.projectId !== scope.projectId || currentMap.status !== 'active' ||
              currentMap.updatedAt !== map.updatedAt ||
              contextAutoFingerprint(map) !== current.fingerprint
            ) return;
            await db.settings.put({
              key: contextAutoUpdateKey(scope),
              value: { ...current, status: 'watching', error: undefined },
              updated_at: Math.max(Date.now(), observation.updatedAt + 1),
            });
            signal.throwIfAborted();
            if (!active(scope) || contextAutoFingerprint(map) !== current.fingerprint) {
              transaction.abort();
              return;
            }
            recovered = true;
          });
        } finally {
          signal.removeEventListener('abort', abort);
        }
        if (recovered) notify();
        return;
      }
      // Do not resurrect a disabled/deleted setting after an asynchronous success.
      await db.transaction('rw', db.settings, async () => {
        const current = await readContextAutoUpdate(scope);
        if (!current?.enabled || current.consentRevision !== setting.consentRevision) return;
        await db.settings.put({
          key: contextAutoUpdateKey(scope),
          value: setting,
          updated_at: Date.now(),
        });
      });
      notify();
    },
  }, scope);
}
