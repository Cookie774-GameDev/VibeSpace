import { describe, expect, it, vi } from 'vitest';
import {
  createCaoLearningExecutor,
  type CaoLearningExecutorDependencies,
} from './caoLearningExecutor';
import type { CaoLearningExecutionInput } from './caoScheduledLearning';

const input: CaoLearningExecutionInput = {
  accountId: 'account',
  workspaceId: 'workspace',
  projectId: 'project',
  scheduleId: 'schedule',
  targetId: 'learning-md',
  passId: 'pass',
  requestId: 'request',
  trigger: 'manual_force',
  fromSeqExclusive: 0,
  throughSeqInclusive: 20,
  requestedAt: 1,
};
const identity = {
  backend: 'codex' as const,
  providerId: 'openai',
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'high',
} as const;
const result = {
  text: 'Use concise responses and verify changes.',
  identity,
  requestId: 'request',
  sessionId: 'session',
};
describe('CAO real learner execution', () => {
  it('reports a bounded failure stage without forwarding provider errors or consuming evidence', async () => {
    const onFailure = vi.fn();
    const save = vi.fn();
    const markEvaluated = vi.fn();
    const run = createCaoLearningExecutor({
      resolveIdentity: async () => identity,
      snapshot: async () => ({
        enabled: true,
        markdown: '# Jarvis Learning\nEvidence',
        sourceIds: ['chat'],
      }),
      execute: async () => {
        throw new Error('private provider response');
      },
      save,
      markEvaluated,
      onFailure,
    });
    expect(await run(input, new AbortController().signal)).toEqual({ status: 'failed' });
    expect(onFailure).toHaveBeenCalledWith('execute');
    expect(save).not.toHaveBeenCalled();
    expect(markEvaluated).not.toHaveBeenCalled();
  });
  it('runs the pinned learner over sourced learning, then persists its receipt before evaluation advances', async () => {
    const order: string[] = [];
    const execute = vi.fn(
      async (_input: Parameters<CaoLearningExecutorDependencies['execute']>[0]) => {
        order.push('execute');
        return result;
      },
    );
    const run = createCaoLearningExecutor({
      resolveIdentity: async () => identity,
      snapshot: async () => ({
        enabled: true,
        markdown: '# Jarvis Learning\nPreferences',
        sourceIds: ['chat-opencode', 'chat-codex'],
      }),
      execute,
      save: async (value) => {
        order.push('save');
        expect(value.sourceIds).toEqual(['chat-opencode', 'chat-codex']);
      },
      markEvaluated: async () => {
        order.push('evaluated');
      },
    });
    expect(await run(input, new AbortController().signal)).toEqual({
      status: 'completed',
      receiptId: 'cao_receipt_pass',
    });
    expect(order).toEqual(['execute', 'save', 'evaluated']);
    expect(execute.mock.calls[0]![0]).toMatchObject({ identity });
  });
  it('does not consume learning on a substituted model, missing session, failed persistence, or cancellation', async () => {
    for (const scenario of ['model', 'session', 'save', 'abort']) {
      const onFailure = vi.fn();
      const markEvaluated = vi.fn();
      const controller = new AbortController();
      const run = createCaoLearningExecutor({
        resolveIdentity: async () => identity,
        snapshot: async () => ({
          enabled: true,
          markdown: '# Jarvis Learning\nPreferences',
          sourceIds: ['chat'],
        }),
        execute: async () => {
          if (scenario === 'abort') controller.abort();
          return {
            ...result,
            identity:
              scenario === 'model' ? { ...result.identity, modelId: 'other' } : result.identity,
            sessionId: scenario === 'session' ? '' : result.sessionId,
          };
        },
        save: async () => {
          if (scenario === 'save') throw new Error('disk');
        },
        markEvaluated,
        onFailure,
      });
      expect((await run(input, controller.signal)).status).toBe(
        scenario === 'abort' ? 'cancelled' : 'failed',
      );
      expect(markEvaluated).not.toHaveBeenCalled();
      if (scenario === 'abort') expect(onFailure).not.toHaveBeenCalled();
      else
        expect(onFailure).toHaveBeenCalledWith(
          scenario === 'model' ? 'identity' : scenario === 'session' ? 'receipt' : 'save',
        );
    }
  });
});
