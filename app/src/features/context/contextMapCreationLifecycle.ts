import type { ContextSearchIndexPopulationPort } from './contextSearchIndexing';
import type { ContextPersistenceState } from './contextPersistence';
import type { ContextMapRecord, ContextTreeNode, ProjectContextTree } from './tree';
import { contextEntityIdForTreeNode } from './migration';

interface PopulatePersistedCreatedContextMapInput {
  persisted: ContextPersistenceState;
  tree: ProjectContextTree;
  signal?: AbortSignal;
  populateCreatedMap(
    accountId: string,
    map: ContextMapRecord,
    signal?: AbortSignal,
  ): Promise<unknown>;
  repairCreatedMap?(
    accountId: string,
    map: ContextMapRecord,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface PopulatedCreatedContextMap {
  persistedMap: ContextMapRecord;
  generatedMap: ContextMapRecord;
}

/**
 * Populate the physical search index for a newly persisted active map.
 *
 * A failed initial population gets one repair attempt against the same map.
 * If both attempts fail, the persisted map remains active. Only an explicit
 * user recycle action may turn a Context Map into a deleted tombstone.
 */
export async function populatePersistedCreatedContextMap(
  input: PopulatePersistedCreatedContextMapInput,
): Promise<PopulatedCreatedContextMap> {
  const persistedMap = input.persisted.maps.find(
    (map) => map.id === input.persisted.selectedMapId && map.status === 'active',
  );
  if (!persistedMap) throw new Error('context_search_index_snapshot_invalid');

  // Keep fresh ingestion metadata, but index the identities that persistence
  // exposes to search after reload. Raw scan IDs are not durable entity IDs.
  const persistedIds = new Set<string>();
  const collect = (node: ContextTreeNode) => {
    persistedIds.add(node.id);
    for (const child of node.children ?? []) collect(child);
  };
  for (const node of persistedMap.tree.nodes) collect(node);
  const canonicalNode = (node: ContextTreeNode): ContextTreeNode => {
    const id = contextEntityIdForTreeNode(persistedMap.id, node.id);
    if (!persistedIds.has(id)) throw new Error('context_search_index_snapshot_invalid');
    return { ...node, id, ...(node.children ? { children: node.children.map(canonicalNode) } : {}) };
  };
  const generatedMap: ContextMapRecord = {
    ...persistedMap,
    tree: { ...input.tree, nodes: input.tree.nodes.map(canonicalNode) },
  };
  try {
    await input.populateCreatedMap(input.persisted.accountId, generatedMap, input.signal);
  } catch (error) {
    if (!input.repairCreatedMap) throw error;
    await input.repairCreatedMap(input.persisted.accountId, generatedMap, input.signal);
  }
  return { persistedMap, generatedMap };
}


/** Resume only a durably pending/failed source through the existing atomic map lease. */
export async function reconcilePendingContextSearch(input: {
  accountId: string;
  map: ContextMapRecord;
  port: ContextSearchIndexPopulationPort;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<void> {
  if (input.map.sourceStatus !== 'indexing' && input.map.sourceStatus !== 'error') {
    throw new Error('context_search_reconciliation_not_pending');
  }
  input.signal.throwIfAborted(); input.assertCurrent();
  const ids: string[] = [];
  const visit = (nodes: readonly ContextTreeNode[]) => {
    for (const node of nodes) { if (node.kind === 'file') ids.push(node.id); visit(node.children ?? []); }
  };
  visit(input.map.tree.nodes);
  const transaction = await input.port.stageChangedMap(input.accountId, input.map, ids, [], input.signal, { reconcileMembership: true });
  try {
    input.signal.throwIfAborted(); input.assertCurrent();
    await transaction.commit();
  } catch (error) {
    try { await transaction.abort(); } catch (abortError) {
      throw new AggregateError([error, abortError], 'context_search_reconciliation_abort_failed');
    }
    throw error;
  }
}
