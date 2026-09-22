import type { CaoMission } from './types';
import { planCaoMission } from './missionPlanner';

/** Accept assignments only for the selected workers; retain their verified routes. */
export function applyAutomaticAssignments(mission: CaoMission, text: string): CaoMission {
  const value = JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, ''),
  );
  if (!Array.isArray(value.workers) || value.workers.length !== mission.workers.length)
    throw new Error('cao_plan_worker_mismatch');
  const seen = new Set<string>();
  const workers = value.workers.map(
    (row: { targetId?: unknown; assignment?: unknown; ownedPaths?: unknown }) => {
      const worker = mission.workers.find((item) => item.targetId === row.targetId);
      if (!worker || seen.has(worker.targetId)) throw new Error('cao_plan_worker_mismatch');
      seen.add(worker.targetId);
      if (
        typeof row.assignment !== 'string' ||
        !row.assignment.trim() ||
        row.assignment.length > 1200 ||
        !Array.isArray(row.ownedPaths) ||
        row.ownedPaths.length > 64 ||
        row.ownedPaths.some(
          (path: unknown) => typeof path !== 'string' || !path.trim() || path.length > 320,
        )
      )
        throw new Error('cao_plan_assignment_invalid');
      return {
        ...worker,
        assignment: row.assignment.trim(),
        ownedPaths: row.ownedPaths as string[],
      };
    },
  );
  // Reuse the existing ownership checks before persisting or sending any assignment.
  const planned = planCaoMission({
    ...mission,
    missionId: mission.id,
    workers,
    now: mission.createdAt,
  });
  return Object.freeze({ ...mission, workers: planned.workers });
}
