import { caoWakeKey } from './wakePacket';
import type { CaoSentinelDecision, CaoSentinelObservation, CaoTargetSnapshot } from './types';

export function decideCaoSentinelAction(input: {
  snapshot: CaoTargetSnapshot;
  observation: CaoSentinelObservation;
  previousWakeKey?: string;
}): CaoSentinelDecision {
  const { snapshot, observation } = input;
  if (snapshot.pendingUserInput) return Object.freeze({ action: 'ask_user', reasonCode: 'user_input_pending' });
  if (snapshot.pendingApproval) return Object.freeze({ action: 'noop', reasonCode: 'approval_required' });
  if (snapshot.runStatus === 'error' || snapshot.runStatus === 'exited' || snapshot.errors.length > 0) {
    const reasonCode = 'target_failed';
    const wakeKey = caoWakeKey({ ...snapshot, evidenceHash: observation.evidenceHash, reasonCode });
    if (input.previousWakeKey === wakeKey) return Object.freeze({ action: 'noop', reasonCode: 'wake_deduplicated', wakeKey });
    return Object.freeze({ action: 'wake_main_cao', reasonCode, wakeKey });
  }
  if (observation.nextAction === 'wake_main_cao' && observation.needsMainCaoProbability >= 0.65) {
    const reasonCode = observation.reasonCode || 'jev_wake';
    const wakeKey = caoWakeKey({ ...snapshot, evidenceHash: observation.evidenceHash, reasonCode });
    if (input.previousWakeKey === wakeKey) return Object.freeze({ action: 'noop', reasonCode: 'wake_deduplicated', wakeKey });
    return Object.freeze({ action: 'wake_main_cao', reasonCode, wakeKey });
  }
  if (observation.nextAction === 'ask_user') return Object.freeze({ action: 'ask_user', reasonCode: observation.reasonCode });
  if (observation.nextAction === 'use_candidate_message') return Object.freeze({ action: 'use_candidate_message', reasonCode: observation.reasonCode });
  return Object.freeze({ action: 'noop', reasonCode: observation.health === 'healthy_working' ? 'healthy_noop' : observation.reasonCode });
}
