import type { ProjectId } from '@/types/common';
import {
  MAX_PANES,
  type PaneNode,
  flattenLeaves,
  fromLeaves,
  newLeaf,
} from './paneTree';
import { captureLiveTree, getLiveTree } from './terminalLiveCache';
import type { TerminalRef } from './terminalRefs';
import { terminalRefLabel } from './terminalRefs';
import { useTerminalTranscriptStore } from './transcriptStore';

const TREE_KEY_PREFIX = 'jarvis-terminal-pane-tree';
const LEGACY_TREE_KEY = 'jarvis-terminal-pane-tree';
const DEFAULT_PROJECT_KEY = '__default__';

type LeafNode = Extract<PaneNode, { kind: 'leaf' }>;

export interface TerminalMoveResult {
  ok: boolean;
  reason?: string;
  sourceProjectId: ProjectId | string | null;
  targetProjectId: ProjectId | string | null;
  sourceTree?: PaneNode;
  targetTree?: PaneNode;
  movedLeaf?: LeafNode;
}

export interface MoveTerminalInput {
  ref: TerminalRef;
  sourceProjectId?: ProjectId | string | null;
  targetProjectId: ProjectId | string | null;
  targetProjectName?: string | null;
  targetPaneId?: string | null;
  currentTree?: PaneNode;
}

export function defaultShell(): string {
  if (typeof navigator === 'undefined') return 'bash';
  const plat = (navigator.platform || '').toLowerCase();
  if (plat.includes('win')) return 'powershell.exe';
  return 'bash';
}

export function normalizeTerminalProjectId(
  projectId: ProjectId | string | null | undefined,
): ProjectId | string | null {
  if (!projectId || projectId === DEFAULT_PROJECT_KEY) return null;
  return projectId;
}

export function terminalTreeStorageKey(
  projectId: ProjectId | string | null | undefined,
): string {
  return `${TREE_KEY_PREFIX}:${normalizeTerminalProjectId(projectId) ?? DEFAULT_PROJECT_KEY}`;
}

function stripVolatileTerminalFields(key: string, value: unknown): unknown {
  if (key === 'pendingCommand') return undefined;
  if (key === 'pendingCommandId') return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function cleanFontSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1 || value > 100) return undefined;
  return value;
}

function normalizeLeafForProject(
  raw: unknown,
  projectId: ProjectId | string | null,
  seenIds: Set<string>,
): LeafNode | null {
  if (!isRecord(raw)) return null;
  const embeddedProjectId = normalizeTerminalProjectId(
    cleanString(raw.projectId) ?? null,
  );
  if (embeddedProjectId !== null && embeddedProjectId !== projectId) {
    return null;
  }

  let id = cleanString(raw.id);
  if (!id || seenIds.has(id)) {
    id = `leaf_repair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  seenIds.add(id);

  return {
    kind: 'leaf',
    id,
    sessionId: cleanString(raw.sessionId) ?? null,
    projectId,
    command: cleanString(raw.command),
    startupCommand: cleanString(raw.startupCommand),
    cwd: cleanString(raw.cwd),
    agentSlug: cleanString(raw.agentSlug),
    name: cleanString(raw.name),
    connectedFiles: cleanStringArray(raw.connectedFiles),
    fontSize: cleanFontSize(raw.fontSize),
  };
}

function normalizeTreeForProject(
  raw: unknown,
  projectId: ProjectId | string | null,
  seenIds = new Set<string>(),
): PaneNode | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'leaf') {
    return normalizeLeafForProject(raw, projectId, seenIds);
  }
  if (raw.kind === 'split') {
    const left = normalizeTreeForProject(raw.left, projectId, seenIds);
    const right = normalizeTreeForProject(raw.right, projectId, seenIds);
    if (!left && !right) return null;
    if (!left) return right;
    if (!right) return left;
    return {
      kind: 'split',
      id: cleanString(raw.id) ?? `split_repair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      orientation: raw.orientation === 'v' ? 'v' : 'h',
      ratio: typeof raw.ratio === 'number' && Number.isFinite(raw.ratio) && raw.ratio > 0 && raw.ratio < 1
        ? raw.ratio
        : 0.5,
      left,
      right,
    };
  }
  return null;
}

function withProjectOwnership(
  tree: PaneNode,
  projectId: ProjectId | string | null,
): PaneNode {
  const normalized = normalizeTreeForProject(tree, projectId);
  return normalized ?? newLeaf({ command: defaultShell(), projectId });
}

export function loadStoredTerminalTree(
  projectId: ProjectId | string | null | undefined,
): PaneNode | undefined {
  if (typeof window === 'undefined') return undefined;
  const parseTree = (raw: string | null): PaneNode | undefined => {
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return normalizeTreeForProject(parsed, normalizeTerminalProjectId(projectId)) ?? undefined;
  };
  try {
    const key = terminalTreeStorageKey(projectId);
    const scoped = parseTree(window.localStorage.getItem(key));
    if (scoped) return scoped;
    const legacy = parseTree(window.localStorage.getItem(LEGACY_TREE_KEY));
    if (legacy) {
      saveTerminalTree(projectId, legacy);
      return legacy;
    }
  } catch {
    // Corrupt or unavailable localStorage should not block terminals.
  }
  return undefined;
}

export function saveTerminalTree(
  projectId: ProjectId | string | null | undefined,
  tree: PaneNode,
): void {
  if (typeof window === 'undefined') return;
  try {
    const ownedTree = withProjectOwnership(
      tree,
      normalizeTerminalProjectId(projectId),
    );
    window.localStorage.setItem(
      terminalTreeStorageKey(projectId),
      JSON.stringify(ownedTree, stripVolatileTerminalFields),
    );
  } catch {
    // localStorage may be full; live cache still preserves this session.
  }
}

export function loadTerminalTreeForProject(
  projectId: ProjectId | string | null | undefined,
): PaneNode {
  const normalizedProjectId = normalizeTerminalProjectId(projectId);
  const liveTree = getLiveTree(normalizedProjectId);
  if (liveTree) return withProjectOwnership(liveTree, normalizedProjectId);
  return (
    loadStoredTerminalTree(normalizedProjectId) ??
    newLeaf({ command: defaultShell(), projectId: normalizedProjectId })
  );
}

function freshLeaf(seed?: Partial<LeafNode>): LeafNode {
  const leaf = newLeaf(seed);
  const base = (leaf.kind === 'leaf' ? leaf : flattenLeaves(leaf)[0]) as LeafNode;
  return seed?.id ? { ...base, id: seed.id } : base;
}

function matchesRef(leaf: LeafNode, ref: TerminalRef): boolean {
  return !!(
    (ref.paneId && leaf.id === ref.paneId) ||
    (ref.sessionId && leaf.sessionId === ref.sessionId)
  );
}

function fallbackLeafFromRef(ref: TerminalRef): LeafNode {
  return freshLeaf({
    id: ref.paneId || undefined,
    sessionId: ref.sessionId ?? null,
    command: ref.command,
    agentSlug: ref.agentSlug ?? undefined,
    name: ref.label,
  });
}

function insertLeafAt(
  leaves: LeafNode[],
  moved: LeafNode,
  targetPaneId?: string | null,
): LeafNode[] {
  const next = [...leaves];
  const targetIndex = targetPaneId
    ? next.findIndex((leaf) => leaf.id === targetPaneId)
    : -1;
  next.splice(targetIndex >= 0 ? targetIndex : next.length, 0, moved);
  return next;
}

function withoutMovedLeaf(leaves: LeafNode[], moved: LeafNode, ref: TerminalRef): LeafNode[] {
  return leaves.filter((leaf) => leaf.id !== moved.id && !matchesRef(leaf, ref));
}

function ensureUniqueLeafId(moved: LeafNode, targetLeaves: LeafNode[]): LeafNode {
  if (!targetLeaves.some((leaf) => leaf.id === moved.id)) return moved;
  return {
    ...moved,
    id: `leaf_move_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

function syncMovedSessionMetadata(
  moved: LeafNode,
  targetProjectId: ProjectId | string | null,
  targetProjectName?: string | null,
): void {
  const sessionId = moved.sessionId;
  if (!sessionId) return;
  useTerminalTranscriptStore.getState().registerSession(sessionId, {
    paneId: moved.id,
    agentSlug: moved.agentSlug ?? null,
    command: moved.startupCommand ?? moved.command ?? null,
    projectId: targetProjectId,
  });
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('terminal_move', {
      sessionId,
      projectId: targetProjectId,
      projectName: targetProjectName ?? null,
    }))
    .catch(() => {
      // Web preview or older desktop backend: UI move remains valid.
    });
}

export function moveTerminalLeafToProject(input: MoveTerminalInput): TerminalMoveResult {
  const sourceProjectId = normalizeTerminalProjectId(
    input.sourceProjectId ?? input.ref.projectId ?? null,
  );
  const targetProjectId = normalizeTerminalProjectId(input.targetProjectId);
  const sameProject = sourceProjectId === targetProjectId;
  const sourceTree = input.currentTree ?? loadTerminalTreeForProject(sourceProjectId);
  const sourceLeaves = flattenLeaves(sourceTree);
  const found = sourceLeaves.find((leaf) => matchesRef(leaf, input.ref));
  const moved = found ?? fallbackLeafFromRef(input.ref);

  if (sameProject) {
    if (!found) {
      return {
        ok: false,
        reason: `Could not find ${terminalRefLabel(input.ref)} in this project.`,
        sourceProjectId,
        targetProjectId,
      };
    }
    if (input.targetPaneId && input.targetPaneId === moved.id) {
      return { ok: true, sourceProjectId, targetProjectId, sourceTree, targetTree: sourceTree, movedLeaf: moved };
    }
    const nextLeaves = insertLeafAt(
      withoutMovedLeaf(sourceLeaves, moved, input.ref),
      { ...moved, projectId: targetProjectId },
      input.targetPaneId,
    );
    const nextTree = fromLeaves(nextLeaves);
    captureLiveTree(sourceProjectId, nextTree);
    saveTerminalTree(sourceProjectId, nextTree);
    syncMovedSessionMetadata(moved, targetProjectId, input.targetProjectName);
    return {
      ok: true,
      sourceProjectId,
      targetProjectId,
      sourceTree: nextTree,
      targetTree: nextTree,
      movedLeaf: moved,
    };
  }

  const rawTargetTree = getLiveTree(targetProjectId) ?? loadStoredTerminalTree(targetProjectId);
  const targetLeaves = rawTargetTree ? flattenLeaves(rawTargetTree) : [];
  const dedupedTargetLeaves = targetLeaves.filter((leaf) => !matchesRef(leaf, input.ref));
  if (dedupedTargetLeaves.length >= MAX_PANES) {
    return {
      ok: false,
      reason: `That project already has ${MAX_PANES} terminal panes.`,
      sourceProjectId,
      targetProjectId,
    };
  }

  const movedForTarget = ensureUniqueLeafId(
    {
      ...moved,
      projectId: targetProjectId,
      pendingCommand: undefined,
      pendingCommandId: undefined,
    },
    dedupedTargetLeaves,
  );
  const nextTargetTree = fromLeaves(
    insertLeafAt(dedupedTargetLeaves, movedForTarget, input.targetPaneId),
  );
  const nextSourceLeaves = found
    ? sourceLeaves.filter((leaf) => leaf.id !== found.id)
    : sourceLeaves;
  const nextSourceTree = nextSourceLeaves.length > 0
    ? fromLeaves(nextSourceLeaves)
    : newLeaf({ command: defaultShell() });

  captureLiveTree(sourceProjectId, nextSourceTree);
  saveTerminalTree(sourceProjectId, nextSourceTree);
  captureLiveTree(targetProjectId, nextTargetTree);
  saveTerminalTree(targetProjectId, nextTargetTree);
  syncMovedSessionMetadata(movedForTarget, targetProjectId, input.targetProjectName);

  return {
    ok: true,
    sourceProjectId,
    targetProjectId,
    sourceTree: nextSourceTree,
    targetTree: nextTargetTree,
    movedLeaf: movedForTarget,
  };
}
