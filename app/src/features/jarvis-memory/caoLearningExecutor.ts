import type { CaoLearningExecutionInput, CaoLearningExecutionResult } from './caoScheduledLearning';
import type { CaoExecutionIdentity } from '@/features/cao/executionProfile';

export type CaoLearningExecutionIdentity = CaoExecutionIdentity;
export type CaoLearningFailureStage =
  | 'snapshot'
  | 'execute'
  | 'identity'
  | 'receipt'
  | 'save'
  | 'mark-evaluated';
export interface CaoLearningReview {
  schemaVersion: 1;
  receiptId: string;
  input: CaoLearningExecutionInput;
  summary: string;
  sourceIds: string[];
  identity: CaoLearningExecutionIdentity;
  requestId: string;
  sessionId: string;
}
export interface CaoLearningExecutorDependencies {
  resolveIdentity(input: CaoLearningExecutionInput): Promise<CaoLearningExecutionIdentity>;
  snapshot(
    input: CaoLearningExecutionInput,
  ): Promise<{ enabled: boolean; markdown: string; sourceIds: string[] }>;
  execute(input: {
    input: CaoLearningExecutionInput;
    identity: CaoLearningExecutionIdentity;
    markdown: string;
    signal: AbortSignal;
  }): Promise<{
    text: string;
    identity: CaoLearningExecutionIdentity;
    requestId: string;
    sessionId: string;
  }>;
  save(review: CaoLearningReview): Promise<void>;
  markEvaluated(input: CaoLearningExecutionInput): Promise<void>;
  onFailure?(stage: CaoLearningFailureStage): void;
}
export function createCaoLearningExecutor(dependencies: CaoLearningExecutorDependencies) {
  return async (
    input: CaoLearningExecutionInput,
    signal: AbortSignal,
  ): Promise<CaoLearningExecutionResult> => {
    let stage: CaoLearningFailureStage = 'snapshot';
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
      stage = 'identity';
      const identity = await dependencies.resolveIdentity(input);
      stage = 'execute';
      const result = await dependencies.execute({
        input,
        identity,
        markdown: snapshot.markdown,
        signal,
      });
      signal.throwIfAborted();
      stage = 'identity';
      if (
        result.identity.backend !== identity.backend ||
        result.identity.providerId !== identity.providerId ||
        result.identity.connectionId !== identity.connectionId ||
        result.identity.modelId !== identity.modelId ||
        result.identity.reasoningEffort !== identity.reasoningEffort
      )
        throw new Error('cao_learning_execution_identity_mismatch');
      stage = 'receipt';
      if (
        result.requestId !== input.requestId ||
        !result.sessionId ||
        !result.text.trim() ||
        result.text.length > 16_000
      )
        throw new Error('cao_learning_receipt_invalid');
      const receiptId = `cao_receipt_${input.passId}`.slice(0, 128);
      stage = 'save';
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
      stage = 'mark-evaluated';
      await dependencies.markEvaluated(input);
      return { status: 'completed', receiptId };
    } catch {
      if (!signal.aborted) {
        // Report only the bounded stage; provider errors may contain private data.
        try {
          dependencies.onFailure?.(stage);
        } catch {
          // Diagnostics must not change the failed execution outcome.
        }
      }
      return { status: signal.aborted ? 'cancelled' : 'failed' };
    }
  };
}
