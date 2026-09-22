import type { CaoCandidateMessage, CaoSentinelObservation, CaoTargetSnapshot } from './types';

export function buildCaoCandidateMessages(
  snapshot: CaoTargetSnapshot,
  observation: CaoSentinelObservation,
): readonly CaoCandidateMessage[] {
  if (observation.nextAction === 'noop' || observation.nextAction === 'ask_user') return Object.freeze([]);
  const kind = snapshot.verification === 'verified' ? 'request_evidence' : snapshot.runStatus === 'error' ? 'recover' : 'verify';
  const body =
    kind === 'recover'
      ? `Review the latest bounded failure evidence for target ${snapshot.targetId}, repair the smallest failing step, and report a fresh receipt.`
      : kind === 'verify'
        ? `Verify target ${snapshot.targetId} against the assigned objective using fresh bounded evidence and report the exact receipt.`
        : `Collect fresh bounded evidence for target ${snapshot.targetId} before claiming completion.`;
  const message: CaoCandidateMessage = Object.freeze({
    id: `cao-candidate:${snapshot.missionId}:${snapshot.targetId}:${snapshot.targetRevision}:${kind}`,
    targetId: snapshot.targetId,
    kind,
    body,
  });
  return Object.freeze([message]);
}
