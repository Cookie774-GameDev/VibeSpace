import type { CaoMission, CaoMissionWorker } from './types';

function clean(value: string, fallback: string, max = 1200): string {
  const result = value
    .trim()
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .slice(0, max);
  return result || fallback;
}

function cleanPath(value: string): string {
  return value.trim().replace(/\\/gu, '/').slice(0, 320);
}

function canonicalPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
      else segments.push('..');
      continue;
    }
    // Case folding is for ownership comparison only. The stored path keeps
    // its meaningful internal whitespace and original spelling.
    segments.push(segment.toLocaleLowerCase('en-US'));
  }
  return segments.join('/');
}

function pathsOverlap(left: string, right: string): boolean {
  const a = canonicalPath(left).split('/').filter(Boolean);
  const b = canonicalPath(right).split('/').filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((segment, index) => segment === longer[index]);
}

export function planCaoMission(input: {
  missionId: string;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  objective: string;
  workers: readonly Readonly<{
    targetId: string;
    kind: CaoMissionWorker['kind'];
    backend?: CaoMissionWorker['backend'];
    connectionId?: string;
    modelId?: string;
    reasoningEffort?: string;
    assignment: string;
    ownedPaths: readonly string[];
  }>[];
  now?: number;
}): CaoMission {
  const targetIds = new Set<string>();
  const paths = new Map<string, { targetId: string; storedPath: string }>();
  const workers = input.workers.map((worker) => {
    const targetId = clean(worker.targetId, '');
    if (!targetId || targetIds.has(targetId)) throw new Error('cao_mission_target_duplicate');
    targetIds.add(targetId);
    const ownedPaths = Object.freeze(worker.ownedPaths.map(cleanPath).filter(Boolean));
    const connectionId =
      worker.connectionId === undefined ? undefined : clean(worker.connectionId, '', 256);
    if (worker.connectionId !== undefined && !connectionId) {
      throw new Error('cao_mission_connection_invalid');
    }
    for (const path of ownedPaths) {
      const canonical = canonicalPath(path);
      if (!canonical) throw new Error('cao_mission_path_invalid');
      for (const existing of paths.values()) {
        if (existing.targetId !== targetId && pathsOverlap(existing.storedPath, path)) {
          throw new Error('cao_mission_path_overlap');
        }
      }
      paths.set(`${targetId}:${canonical}`, { targetId, storedPath: path });
    }
    return Object.freeze({
      targetId,
      kind: worker.kind,
      ...(worker.backend ? { backend: worker.backend } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(worker.modelId ? { modelId: clean(worker.modelId, '', 256) } : {}),
      ...(worker.reasoningEffort ? { reasoningEffort: clean(worker.reasoningEffort, '', 32) } : {}),
      assignment: clean(worker.assignment, 'unassigned'),
      ownedPaths,
      status: 'assigned' as const,
      lastObservedRevision: null,
    });
  });
  const now = input.now ?? Date.now();
  return Object.freeze({
    id: clean(input.missionId, ''),
    schemaVersion: 1 as const,
    accountId: clean(input.accountId, ''),
    workspaceId: clean(input.workspaceId, ''),
    projectId: input.projectId,
    objective: clean(input.objective, 'Unspecified objective'),
    createdAt: now,
    updatedAt: now,
    status: 'planning' as const,
    contextMapId: null,
    workers: Object.freeze(workers),
    milestones: Object.freeze([]),
    latestPlanRevision: 1,
    lastCaoWakeAt: null,
  });
}
