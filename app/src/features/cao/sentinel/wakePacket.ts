import type { CaoSentinelObservation, CaoTargetSnapshot, CaoWakePacket } from './types';

export function caoWakeKey(input: Pick<CaoTargetSnapshot, 'missionId' | 'targetId' | 'targetRevision'> & { evidenceHash: string; reasonCode: string }): string {
  return [input.missionId, input.targetId, input.targetRevision, input.evidenceHash, input.reasonCode].join('|');
}

export function buildCaoWakePacket(
  snapshot: CaoTargetSnapshot,
  observation: CaoSentinelObservation,
  now = observation.observedAt,
): CaoWakePacket {
  const packet: CaoWakePacket = {
    key: caoWakeKey({
      missionId: snapshot.missionId,
      targetId: snapshot.targetId,
      targetRevision: snapshot.targetRevision,
      evidenceHash: observation.evidenceHash,
      reasonCode: observation.reasonCode,
    }),
    missionId: snapshot.missionId,
    targetId: snapshot.targetId,
    targetRevision: snapshot.targetRevision,
    evidenceHash: observation.evidenceHash,
    reasonCode: observation.reasonCode,
    observedAt: now,
    ...(observation.selectedCandidateMessageId
      ? { candidateMessageId: observation.selectedCandidateMessageId }
      : {}),
  };
  return Object.freeze(packet);
}
