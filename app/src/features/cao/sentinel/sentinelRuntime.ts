import { JevClientError, type JevClient } from '@/lib/jev/contracts';
import { buildCaoCandidateMessages } from './candidateMessages';
import { interpretJevSentinelEvaluation, CAO_SENTINEL_QUESTIONS } from './jevDecision';
import { decideCaoSentinelAction } from './sentinelPolicy';
import { buildCaoWakePacket } from './wakePacket';
import { snapshotEvidenceHash } from './targetSnapshot';
import type {
  CaoSentinelDecision,
  CaoSentinelObservation,
  CaoSentinelTrigger,
  CaoTargetSnapshot,
  CaoWakePacket,
  CaoCandidateMessage,
  CaoCandidateDispatchResult,
} from './types';

type SentinelResult = Readonly<{
  observation: CaoSentinelObservation;
  decision: CaoSentinelDecision;
  wake?: CaoWakePacket;
  candidates: readonly CaoCandidateMessage[];
  candidateDispatch?: CaoCandidateDispatchResult;
}>;

export type CaoSentinelDecisionReceipt = Readonly<{
  missionId: string;
  targetId: string;
  targetRevision: number;
  observedAt: number;
  trigger: CaoSentinelTrigger;
  action: CaoSentinelDecision['action'];
  reasonCode: string;
}>;

function unavailableObservation(
  snapshot: CaoTargetSnapshot,
  now: number,
  reasonCode = 'jev_unavailable',
): CaoSentinelObservation {
  return Object.freeze({
    missionId: snapshot.missionId,
    targetId: snapshot.targetId,
    targetRevision: snapshot.targetRevision,
    evidenceHash: snapshotEvidenceHash(snapshot),
    observedAt: now,
    health: 'unclear',
    nextAction: 'noop',
    urgency: 0,
    evidenceQuality: 0,
    needsMainCaoProbability: 0,
    offTrackProbability: 0,
    doneWithoutProofProbability: 0,
    reasonCode,
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}

function jevFailureReason(error: unknown): string {
  if (error instanceof JevClientError) {
    if (error.code === 'transport_timeout') return 'jev_timeout';
    if (error.code === 'response_invalid') return 'jev_invalid_result';
    if (error.code === 'request_invalid') return 'jev_invalid_request';
  }
  if (error instanceof Error && error.message === 'jev_sentinel_answer_invalid') {
    return 'jev_invalid_result';
  }
  return 'jev_unavailable';
}

export function createCaoSentinelRuntime(input: {
  jev: Pick<JevClient, 'evaluate'>;
  signal?: AbortSignal;
  now?: () => number;
  onObservation?: (
    observation: CaoSentinelObservation,
    trigger: CaoSentinelTrigger,
  ) => Promise<void> | void;
  onDecisionReceipt?: (receipt: CaoSentinelDecisionReceipt) => Promise<void> | void;
  onWake?: (packet: CaoWakePacket) => Promise<void> | void;
  onCandidate?: (
    candidate: CaoCandidateMessage,
    input: Readonly<{
      snapshot: CaoTargetSnapshot;
      observation: CaoSentinelObservation;
      decision: CaoSentinelDecision;
      trigger: CaoSentinelTrigger;
    }>,
  ) => Promise<CaoCandidateDispatchResult> | CaoCandidateDispatchResult;
}) {
  const now = input.now ?? Date.now;
  const previousWakeKeys = new Map<string, string>();
  const pendingWakeKeys = new Set<string>();
  const previousCandidateKeys = new Map<string, string>();
  const pendingCandidateKeys = new Set<string>();
  return Object.freeze({
    async observe(
      snapshot: CaoTargetSnapshot,
      trigger: CaoSentinelTrigger,
    ): Promise<SentinelResult> {
      assertNotAborted(input.signal);
      let observation: CaoSentinelObservation;
      try {
        const evaluation = await input.jev.evaluate({
          state: snapshot,
          questions: CAO_SENTINEL_QUESTIONS,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        assertNotAborted(input.signal);
        observation = interpretJevSentinelEvaluation(snapshot, evaluation);
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw error;
        observation = unavailableObservation(snapshot, now(), jevFailureReason(error));
      }
      const key = `${snapshot.missionId}:${snapshot.targetId}`;
      const candidates = buildCaoCandidateMessages(snapshot, observation);
      if (observation.nextAction === 'use_candidate_message' && candidates[0]) {
        observation = Object.freeze({
          ...observation,
          selectedCandidateMessageId: candidates[0].id,
        });
      }
      await input.onObservation?.(observation, trigger);
      assertNotAborted(input.signal);
      const decision = decideCaoSentinelAction({
        snapshot,
        observation,
        previousWakeKey: previousWakeKeys.get(key),
      });
      let finalDecision = decision;
      let wake: CaoWakePacket | undefined;
      let candidateDispatch: CaoCandidateDispatchResult | undefined;
      if (decision.action === 'use_candidate_message') {
        const candidate =
          candidates.find((item) => item.id === decision.candidateMessageId) ?? candidates[0];
        if (!candidate) {
          finalDecision = Object.freeze({
            ...decision,
            action: 'noop',
            reasonCode: 'candidate_unavailable',
          });
        } else if (!input.onCandidate) {
          finalDecision = Object.freeze({
            ...decision,
            action: 'noop',
            reasonCode: 'candidate_authority_unavailable',
          });
        } else {
          assertNotAborted(input.signal);
          const candidateKey = `${key}:${candidate.id}`;
          if (
            previousCandidateKeys.get(key) === candidate.id ||
            pendingCandidateKeys.has(candidateKey)
          ) {
            finalDecision = Object.freeze({
              ...decision,
              action: 'noop',
              reasonCode: 'candidate_deduplicated',
            });
          } else {
            pendingCandidateKeys.add(candidateKey);
            try {
              const dispatched = await input.onCandidate(candidate, {
                snapshot,
                observation,
                decision,
                trigger,
              });
              if (
                (dispatched.status !== 'sent' && dispatched.status !== 'awaiting_approval') ||
                (dispatched.proposalId !== undefined &&
                  (typeof dispatched.proposalId !== 'string' ||
                    dispatched.proposalId.trim().length === 0)) ||
                (dispatched.status === 'awaiting_approval' && !dispatched.proposalId)
              ) {
                throw new Error('cao_candidate_dispatch_invalid');
              }
              candidateDispatch = Object.freeze({ ...dispatched });
              previousCandidateKeys.set(key, candidate.id);
              finalDecision = Object.freeze({
                ...decision,
                reasonCode:
                  dispatched.status === 'sent' ? 'candidate_sent' : 'candidate_awaiting_approval',
                candidateMessageId: candidate.id,
              });
            } finally {
              pendingCandidateKeys.delete(candidateKey);
            }
          }
        }
      }
      if (decision.action === 'wake_main_cao') {
        assertNotAborted(input.signal);
        const packet = buildCaoWakePacket(snapshot, observation, observation.observedAt);
        const wakeKey = decision.wakeKey ?? packet.key;
        const dispatchKey = `${key}:${wakeKey}`;
        if (pendingWakeKeys.has(dispatchKey)) {
          finalDecision = Object.freeze({
            ...decision,
            action: 'noop',
            reasonCode: 'wake_deduplicated',
          });
        } else {
          pendingWakeKeys.add(dispatchKey);
          wake = packet;
          try {
            await input.onWake?.(packet);
            assertNotAborted(input.signal);
            if (decision.wakeKey) previousWakeKeys.set(key, decision.wakeKey);
          } finally {
            pendingWakeKeys.delete(dispatchKey);
          }
        }
      }
      await input.onDecisionReceipt?.(
        Object.freeze({
          missionId: observation.missionId,
          targetId: observation.targetId,
          targetRevision: observation.targetRevision,
          observedAt: observation.observedAt,
          trigger,
          action: finalDecision.action,
          reasonCode: finalDecision.reasonCode.slice(0, 64),
        }),
      );
      return Object.freeze({
        observation,
        decision: finalDecision,
        ...(wake ? { wake } : {}),
        ...(candidateDispatch ? { candidateDispatch } : {}),
        candidates,
      });
    },
    clearWakeDedupe(): void {
      previousWakeKeys.clear();
      previousCandidateKeys.clear();
      pendingCandidateKeys.clear();
    },
  });
}
