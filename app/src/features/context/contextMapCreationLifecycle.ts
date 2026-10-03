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
