import type { ContextGalaxyNode } from './ContextGalaxy';
import type { GalaxyEdge } from './contextGalaxyLayout';
import type { ContextTreeNode, ProjectContextTree } from './tree';

const MAX_LIVE_NODES = 1_000;
const MAX_LIVE_EDGES = 1_600;

export interface ContextGalaxySnapshot {
  accountId: string;
  projectId: string | null;
  mapId: string;
  nodes: readonly ContextGalaxyNode[];
  edges: readonly GalaxyEdge[];
  selectedId: string | null;
  activityNodeIds: readonly string[];
  updatedAt: number;
}

export interface ContextGalaxySnapshotInput extends Omit<ContextGalaxySnapshot, 'updatedAt'> {}

const snapshots = new Map<string, ContextGalaxySnapshot>();
const listeners = new Set<() => void>();

function categoryDescription(node: ContextTreeNode): string {
  const normalized = node.title.trim().toLocaleLowerCase('en-US');
  if (normalized === 'sources')
    return 'Connected files, repositories, and imported knowledge used by Context.';
  if (normalized === 'notes') return 'Authored workspace knowledge linked to this Context map.';
  if (normalized === 'templates')
    return 'Reusable structures for creating consistent Context content.';
  if (normalized === 'workspace') return 'Working collections and active project context.';
  if (normalized === 'views')
    return 'Saved filters and graph perspectives over the same Context data.';
  return node.summary || node.path || `${node.kind} in the current Context map.`;
}

export function contextTreeToGalaxyData(
  tree: ProjectContextTree,
  maxNodes = MAX_LIVE_NODES,
): {
  nodes: ContextGalaxyNode[];
  edges: GalaxyEdge[];
} {
  const nodes: ContextGalaxyNode[] = [];
  const edges: GalaxyEdge[] = [];
  const visit = (
    node: ContextTreeNode,
    parentId: string | null,
    groupId: string,
    depth: number,
  ) => {
    if (nodes.length >= maxNodes) return;
    nodes.push({
      id: node.id,
      label: node.title,
      description: categoryDescription(node),
      parentId,
      groupId,
      depth,
      order: nodes.length,
      radius: depth === 0 ? 18 : depth === 1 ? 12 : 8,
      importance: node.importance,
    });
    if (parentId) edges.push({ id: `${parentId}:${node.id}`, from: parentId, to: node.id });
    for (const child of node.children ?? []) {
      if (nodes.length >= maxNodes) break;
      visit(child, node.id, depth === 0 ? node.id : groupId, depth + 1);
    }
  };
  for (const root of tree.nodes) {
    if (nodes.length >= maxNodes) break;
    visit(root, null, root.id, 0);
  }
  return { nodes, edges };
}

function scopeKey(accountId: string, projectId: string | null): string {
  return JSON.stringify([accountId, projectId]);
}

function boundedSnapshot(input: ContextGalaxySnapshotInput): ContextGalaxySnapshot {
  const requiredIds = new Set(
    [input.nodes[0]?.id, input.selectedId, ...input.activityNodeIds].filter((id): id is string =>
      Boolean(id),
    ),
  );
  const selectedNodes: ContextGalaxyNode[] = [];
  for (const value of input.nodes) {
    if (requiredIds.has(value.id)) selectedNodes.push(value);
  }
  for (const value of input.nodes) {
    if (selectedNodes.length >= MAX_LIVE_NODES) break;
    if (!requiredIds.has(value.id)) selectedNodes.push(value);
  }
  const included = new Set(selectedNodes.map((value) => value.id));
  const selectedEdges = input.edges
    .filter((edge) => included.has(edge.from) && included.has(edge.to))
    .slice(0, MAX_LIVE_EDGES);
  return Object.freeze({
    ...input,
    nodes: Object.freeze(selectedNodes),
    edges: Object.freeze(selectedEdges),
    activityNodeIds: Object.freeze(input.activityNodeIds.filter((id) => included.has(id))),
    selectedId: input.selectedId && included.has(input.selectedId) ? input.selectedId : null,
    updatedAt: Date.now(),
  });
}

export function publishContextGalaxySnapshot(input: ContextGalaxySnapshotInput): () => void {
  const key = scopeKey(input.accountId, input.projectId);
  const snapshot = boundedSnapshot(input);
  snapshots.set(key, snapshot);
  listeners.forEach((listener) => listener());
  return () => {
    if (snapshots.get(key) !== snapshot) return;
    snapshots.delete(key);
    listeners.forEach((listener) => listener());
  };
}

export function getContextGalaxySnapshot(
  accountId: string | null,
  projectId: string | null,
): ContextGalaxySnapshot | null {
  if (!accountId) return null;
  return snapshots.get(scopeKey(accountId, projectId)) ?? null;
}

export function subscribeContextGalaxySnapshots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearContextGalaxySnapshotsForTests(): void {
  snapshots.clear();
  listeners.clear();
}
