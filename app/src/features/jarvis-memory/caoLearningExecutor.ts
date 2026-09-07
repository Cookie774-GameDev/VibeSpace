import { CAO_LEARNER_IDENTITY, assertCaoLearnerExecutionIdentity } from '@/features/cao/bootstrap';
import type { CaoLearningExecutionInput, CaoLearningExecutionResult } from './caoScheduledLearning';

type Identity = Record<keyof typeof CAO_LEARNER_IDENTITY, string>;
export interface CaoLearningReview {
  schemaVersion: 1;
  receiptId: string;
  input: CaoLearningExecutionInput;
  summary: string;
  sourceIds: string[];
  identity: Identity;
  requestId: string;
  sessionId: string;
}
export interface CaoLearningExecutorDependencies {
  snapshot(
    input: CaoLearningExecutionInput,
  ): Promise<{ enabled: boolean; markdown: string; sourceIds: string[] }>;
  execute(input: {
    input: CaoLearningExecutionInput;
    identity: Identity;
    markdown: string;
    signal: AbortSignal;
  }): Promise<{ text: string; identity: Identity; requestId: string; sessionId: string }>;
  save(review: CaoLearningReview): Promise<void>;
  markEvaluated(input: CaoLearningExecutionInput): Promise<void>;
}
export function createCaoLearningExecutor(dependencies: CaoLearningExecutorDependencies) {
  return async (
    input: CaoLearningExecutionInput,
    signal: AbortSignal,
  ): Promise<CaoLearningExecutionResult> => {
    try {
      signal.throwIfAborted();
      const snapshot = await dependencies.snapshot(input);
      if (!snapshot.enabled) return { status: 'cancelled' };
      signal.throwIfAborted();
      if (
        !snapshot.markdown.startsWith('# Jarvis Learning\n') ||
        snapshot.markdown.length > 128_000
      )
        throw new Error('cao_learning_evidence_invalid');
      const result = await dependencies.execute({
        input,
        identity: CAO_LEARNER_IDENTITY,
        markdown: snapshot.markdown,
        signal,
      });
      signal.throwIfAborted();
      assertCaoLearnerExecutionIdentity({
        requested: CAO_LEARNER_IDENTITY,
        observed: result.identity,
      });
      if (
        result.requestId !== input.requestId ||
        !result.sessionId ||
        !result.text.trim() ||
        result.text.length > 16_000
      )
        throw new Error('cao_learning_receipt_invalid');
      const receiptId = `cao_receipt_${input.passId}`.slice(0, 128);
      await dependencies.save({
        schemaVersion: 1,
        receiptId,
        input: structuredClone(input),
        summary: result.text,
        sourceIds: [...snapshot.sourceIds],
        identity: result.identity,
        requestId: result.requestId,
        sessionId: result.sessionId,
      });
      signal.throwIfAborted();
      await dependencies.markEvaluated(input);
      return { status: 'completed', receiptId };
    } catch {
      return { status: signal.aborted ? 'cancelled' : 'failed' };
    }
  };
}
