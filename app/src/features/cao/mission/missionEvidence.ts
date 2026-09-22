import type { CaoMissionEvidence } from './types';
import type { CaoTargetSnapshot } from '../sentinel/types';

export function projectCaoMissionEvidence(input: {
  missionId: string;
  snapshot: CaoTargetSnapshot;
  kind?: CaoMissionEvidence['kind'];
  now?: number;
}): CaoMissionEvidence {
  return Object.freeze({
    id: `evidence:${input.missionId}:${input.snapshot.targetId}:${input.snapshot.targetRevision}`,
    missionId: input.missionId,
    targetId: input.snapshot.targetId,
    targetRevision: input.snapshot.targetRevision,
    kind: input.kind ?? 'snapshot',
    summary: `${input.snapshot.kind} ${input.snapshot.runStatus} at revision ${input.snapshot.targetRevision}`,
    observedAt: input.now ?? Date.now(),
  });
}
