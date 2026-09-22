import type { JevEvaluation } from '@/lib/jev/types';
import { snapshotEvidenceHash } from './targetSnapshot';
import type { CaoSentinelObservation, CaoSentinelHealth, CaoSentinelNextAction, CaoTargetSnapshot } from './types';

const HEALTH_VALUES: readonly CaoSentinelHealth[] = [
  'healthy_working', 'waiting_for_user', 'waiting_for_tool', 'likely_stuck', 'failed',
  'off_track', 'done_unverified', 'verified_done', 'unclear',
];
const ACTION_VALUES: readonly CaoSentinelNextAction[] = [
  'noop', 'refresh_evidence', 'verify', 'use_candidate_message', 'wake_main_cao', 'ask_user',
];

export const CAO_SENTINEL_QUESTIONS = Object.freeze({
  health: Object.freeze({
    type: 'choice' as const,
    instructions: 'Classify the observed target lifecycle using only the supplied bounded snapshot.',
    criteria: Object.freeze(Object.fromEntries(HEALTH_VALUES.map((value) => [value, value]))),
  }),
  action: Object.freeze({
    type: 'choice' as const,
    instructions: 'Choose the least invasive next action; only wake the main CAO when deep reasoning is needed.',
    criteria: Object.freeze(Object.fromEntries(ACTION_VALUES.map((value) => [value, value]))),
  }),
  urgency: Object.freeze({
    type: 'score' as const,
    instructions: 'Score urgency from low to high.',
    criteria: Object.freeze(['low', 'medium', 'high']),
  }),
  evidence: Object.freeze({
    type: 'score' as const,
    instructions: 'Score the quality of the evidence from low to high.',
    criteria: Object.freeze(['low', 'medium', 'high']),
  }),
  offTrack: Object.freeze({
    type: 'noul' as const,
    instructions: 'Is the target off the assigned objective?',
  }),
  doneWithoutProof: Object.freeze({
    type: 'noul' as const,
    instructions: 'Does the target claim completion without sufficient proof?',
  }),
});

function choiceAnswer(evaluation: JevEvaluation, id: 'health' | 'action'): { choice: string; probabilities: Readonly<Record<string, number>> } {
  const answer = evaluation.answers[id];
  if (!answer || answer.type !== 'choice') throw new Error('jev_sentinel_answer_invalid');
  return answer;
}

function scoreAnswer(evaluation: JevEvaluation, id: 'urgency' | 'evidence') {
  const answer = evaluation.answers[id];
  if (!answer || answer.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 2) {
    throw new Error('jev_sentinel_answer_invalid');
  }
  return answer;
}

function noulAnswer(evaluation: JevEvaluation, id: 'offTrack' | 'doneWithoutProof'): number {
  const answer = evaluation.answers[id];
  if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error('jev_sentinel_answer_invalid');
  }
  return answer.noul;
}

export function interpretJevSentinelEvaluation(
  snapshot: CaoTargetSnapshot,
  evaluation: JevEvaluation,
): CaoSentinelObservation {
  const healthAnswer = choiceAnswer(evaluation, 'health');
  const actionAnswer = choiceAnswer(evaluation, 'action');
  if (!HEALTH_VALUES.includes(healthAnswer.choice as CaoSentinelHealth) || !ACTION_VALUES.includes(actionAnswer.choice as CaoSentinelNextAction)) {
    throw new Error('jev_sentinel_answer_invalid');
  }
  const urgency = scoreAnswer(evaluation, 'urgency');
  const evidence = scoreAnswer(evaluation, 'evidence');
  const observation: CaoSentinelObservation = {
    missionId: snapshot.missionId,
    targetId: snapshot.targetId,
    targetRevision: snapshot.targetRevision,
    evidenceHash: snapshotEvidenceHash(snapshot),
    observedAt: evaluation.observedAt,
    health: healthAnswer.choice as CaoSentinelHealth,
    nextAction: actionAnswer.choice as CaoSentinelNextAction,
    urgency: urgency.score / 2,
    evidenceQuality: evidence.score / 2,
    needsMainCaoProbability: actionAnswer.probabilities.wake_main_cao ?? 0,
    offTrackProbability: noulAnswer(evaluation, 'offTrack'),
    doneWithoutProofProbability: noulAnswer(evaluation, 'doneWithoutProof'),
    reasonCode: `jev_${healthAnswer.choice}_${actionAnswer.choice}`,
    model: evaluation.model,
    usage: evaluation.usage,
  };
  return Object.freeze(observation);
}
