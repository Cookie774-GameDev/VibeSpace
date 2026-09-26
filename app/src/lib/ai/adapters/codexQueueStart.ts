import {
  buildCodexThreadQueueStartRequest,
  validateCodexThreadQueueStartResponse,
  type CodexThreadQueueStartRequestInput,
} from './codexAppServerProtocol';

export type CodexQueueTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type CodexQueueStartDenial =
  | 'thread_mismatch'
  | 'turn_active'
  | 'turn_not_completed'
  | 'turn_mismatch'
  | 'unknown_submission'
  | 'start_already_pending'
  | 'start_outcome_unknown'
  | 'invalid_acknowledgement';

export type CodexQueueStartResult =
  | {
      ok: true;
      submissionId: string;
      clientUserMessageId: string;
      turnId: string;
      turnStatus: CodexQueueTurnStatus;
    }
  | { ok: false; reason: CodexQueueStartDenial };

/** Tracks only acknowledged queue-add receipts and starts them only after an exact turn completes. */
export function createCodexQueueStartCoordinator(expectedThreadId: string) {
  const pending = new Map<string, { clientUserMessageId: string; addedDuringTurnId: string }>();
  const starting = new Set<string>();
  const uncertain = new Set<string>();

  return {
    recordAdded(input: {
      threadId: string;
      turnId: string;
      submissionId: string;
      clientUserMessageId: string;
    }): boolean {
      if (
        input.threadId !== expectedThreadId ||
        !input.turnId ||
        !input.submissionId ||
        !input.clientUserMessageId ||
        pending.has(input.submissionId) ||
        starting.has(input.submissionId)
      )
        return false;
      pending.set(input.submissionId, {
        clientUserMessageId: input.clientUserMessageId,
        addedDuringTurnId: input.turnId,
      });
      return true;
    },

    async startNext(input: {
      threadId: string;
      currentTurnId: string;
      currentTurnStatus: CodexQueueTurnStatus | null;
      send: (request: ReturnType<typeof buildCodexThreadQueueStartRequest>) => Promise<unknown>;
    }): Promise<CodexQueueStartResult> {
      if (input.threadId !== expectedThreadId) return { ok: false, reason: 'thread_mismatch' };
      if (input.currentTurnStatus === 'inProgress') return { ok: false, reason: 'turn_active' };
      if (input.currentTurnStatus !== null && input.currentTurnStatus !== 'completed') {
        return { ok: false, reason: 'turn_not_completed' };
      }
      const next = pending.entries().next();
      if (next.done) return { ok: false, reason: 'unknown_submission' };
      const [submissionId, submission] = next.value;
      if (input.currentTurnId !== submission.addedDuringTurnId)
        return { ok: false, reason: 'turn_mismatch' };
      if (uncertain.has(submissionId)) return { ok: false, reason: 'start_outcome_unknown' };
      if (starting.has(submissionId)) return { ok: false, reason: 'start_already_pending' };
      starting.add(submissionId);
      const uuid = globalThis.crypto?.randomUUID?.();
      if (!uuid) {
        starting.delete(submissionId);
        return { ok: false, reason: 'start_outcome_unknown' };
      }
      const requestId = `queue_start_${uuid.replaceAll('-', '')}`;
      const requestInput: CodexThreadQueueStartRequestInput = {
        requestId,
        threadId: expectedThreadId,
        queuedSubmissionId: submissionId,
      };
      try {
        let response: unknown;
        try {
          response = await input.send(buildCodexThreadQueueStartRequest(requestInput));
        } catch {
          uncertain.add(submissionId);
          return { ok: false, reason: 'start_outcome_unknown' };
        }
        const validated = validateCodexThreadQueueStartResponse(response, requestId);
        if (!validated.ok || !validated.turnId || !validated.turnStatus) {
          uncertain.add(submissionId);
          return { ok: false, reason: 'invalid_acknowledgement' };
        }
        pending.delete(submissionId);
        return {
          ok: true,
          submissionId,
          clientUserMessageId: submission.clientUserMessageId,
          turnId: validated.turnId,
          turnStatus: validated.turnStatus,
        };
      } finally {
        starting.delete(submissionId);
      }
    },

    pendingCount(): number {
      return pending.size;
    },
  };
}
