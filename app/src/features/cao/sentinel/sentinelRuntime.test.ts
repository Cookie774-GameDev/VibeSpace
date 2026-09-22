import { describe, expect, it } from 'vitest';
import { createCaoSentinelRuntime } from './sentinelRuntime';
import type { CaoTargetSnapshot } from './types';
import type { JevEvaluation } from '@/lib/jev/types';

const snapshot: CaoTargetSnapshot = {
  missionId: 'm',
  targetId: 't',
  kind: 'chat',
  accountId: 'a',
  workspaceId: 'w',
  projectId: 'p',
  backend: 'codex',
  providerId: 'openai',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'high',
  assignment: 'work',
  ownedPaths: [],
  targetRevision: 2,
  runStatus: 'running',
  lastActivityAt: 100,
  pendingUserInput: false,
  pendingApproval: false,
  pendingTool: false,
  pendingRetry: false,
  receiptIds: [],
  verification: 'pending',
  recentDelta: 'progress',
  errors: [],
  claims: [],
  contextRevision: null,
  milestone: 'build',
  cursor: { targetRevision: 2, contentHash: 'h2', contextRevision: null, observedAt: 100 },
};

const wakeEvaluation = (): JevEvaluation => ({
  model: 'jev-1.13.0',
  observedAt: 101,
  usage: { inputTokens: 20, outputTokens: 8, costUsd: null },
  answers: {
    health: {
      type: 'choice',
      choice: 'likely_stuck',
      probabilities: {
        healthy_working: 0,
        waiting_for_user: 0,
        waiting_for_tool: 0,
        likely_stuck: 1,
        failed: 0,
        off_track: 0,
        done_unverified: 0,
        verified_done: 0,
        unclear: 0,
      },
      confidence: 1,
    },
    action: {
      type: 'choice',
      choice: 'wake_main_cao',
      probabilities: {
        noop: 0,
        refresh_evidence: 0,
        verify: 0,
        use_candidate_message: 0,
        wake_main_cao: 1,
        ask_user: 0,
      },
      confidence: 1,
    },
    urgency: {
      type: 'score',
      score: 2,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0, '1': 0, '2': 1 },
      confidence: 1,
    },
    evidence: {
      type: 'score',
      score: 2,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0, '1': 0, '2': 1 },
      confidence: 1,
    },
    offTrack: { type: 'noul', noul: 0.8 },
    doneWithoutProof: { type: 'noul', noul: 0.1 },
  },
});

const candidateEvaluation = (): JevEvaluation => ({
  ...wakeEvaluation(),
  answers: {
    ...wakeEvaluation().answers,
    action: {
      type: 'choice',
      choice: 'use_candidate_message',
      probabilities: {
        noop: 0,
        refresh_evidence: 0,
        verify: 0,
        use_candidate_message: 1,
        wake_main_cao: 0,
        ask_user: 0,
      },
      confidence: 1,
    },
  },
});

describe('CAO Sentinel runtime', () => {
  it('turns typed Jev answers into a bounded observation and wake packet', async () => {
    const runtime = createCaoSentinelRuntime({
      jev: {
        evaluate: async () => ({
          model: 'jev-1.13.0',
          observedAt: 101,
          usage: { inputTokens: 20, outputTokens: 8, costUsd: null },
          answers: {
            health: {
              type: 'choice',
              choice: 'likely_stuck',
              probabilities: {
                healthy_working: 0,
                waiting_for_user: 0,
                waiting_for_tool: 0,
                likely_stuck: 1,
                failed: 0,
                off_track: 0,
                done_unverified: 0,
                verified_done: 0,
                unclear: 0,
              },
              confidence: 1,
            },
            action: {
              type: 'choice',
              choice: 'wake_main_cao',
              probabilities: {
                noop: 0,
                refresh_evidence: 0,
                verify: 0,
                use_candidate_message: 0,
                wake_main_cao: 1,
                ask_user: 0,
              },
              confidence: 1,
            },
            urgency: {
              type: 'score',
              score: 2,
              legend: { '0': 'low', '1': 'medium', '2': 'high' },
              probabilities: { '0': 0, '1': 0, '2': 1 },
              confidence: 1,
            },
            evidence: {
              type: 'score',
              score: 2,
              legend: { '0': 'low', '1': 'medium', '2': 'high' },
              probabilities: { '0': 0, '1': 0, '2': 1 },
              confidence: 1,
            },
            offTrack: { type: 'noul', noul: 0.8 },
            doneWithoutProof: { type: 'noul', noul: 0.1 },
          },
        }),
      },
    });
    const result = await runtime.observe(snapshot, 'event');
    expect(result.observation).toMatchObject({
      health: 'likely_stuck',
      nextAction: 'wake_main_cao',
    });
    expect(result.wake?.missionId).toBe('m');
    expect(result.wake?.targetId).toBe('t');
  });

  it('fails closed to manual CAO when Jev is unavailable', async () => {
    const runtime = createCaoSentinelRuntime({
      jev: {
        evaluate: async () => {
          throw new Error('offline');
        },
      },
    });
    const result = await runtime.observe(snapshot, 'sweep');
    expect(result.observation).toMatchObject({
      health: 'unclear',
      nextAction: 'noop',
      reasonCode: 'jev_unavailable',
    });
    expect(result.wake).toBeUndefined();
  });

  it('keeps a failed wake retryable', async () => {
    let attempts = 0;
    const runtime = createCaoSentinelRuntime({
      jev: { evaluate: async () => wakeEvaluation() },
      onWake: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('wake failed');
      },
    });

    await expect(runtime.observe(snapshot, 'event')).rejects.toThrow('wake failed');
    const retry = await runtime.observe(snapshot, 'event');

    expect(attempts).toBe(2);
    expect(retry.decision.action).toBe('wake_main_cao');
  });

  it('deduplicates a successful wake with the same evidence', async () => {
    let calls = 0;
    const runtime = createCaoSentinelRuntime({
      jev: { evaluate: async () => wakeEvaluation() },
      onWake: async () => {
        calls += 1;
      },
    });

    await runtime.observe(snapshot, 'event');
    const duplicate = await runtime.observe(snapshot, 'event');

    expect(calls).toBe(1);
    expect(duplicate.decision).toMatchObject({ action: 'noop', reasonCode: 'wake_deduplicated' });
    expect(duplicate.wake).toBeUndefined();
  });

  it('deduplicates a successful failed-target wake using the policy key', async () => {
    let calls = 0;
    const runtime = createCaoSentinelRuntime({
      jev: { evaluate: async () => wakeEvaluation() },
      onWake: async () => {
        calls += 1;
      },
    });
    const failedSnapshot = {
      ...snapshot,
      runStatus: 'error' as const,
      errors: ['provider failed'],
    };

    await runtime.observe(failedSnapshot, 'tool-failure');
    const duplicate = await runtime.observe(failedSnapshot, 'tool-failure');

    expect(calls).toBe(1);
    expect(duplicate.decision).toMatchObject({ action: 'noop', reasonCode: 'wake_deduplicated' });
    expect(duplicate.wake).toBeUndefined();
  });

  it('protects an in-flight wake from a concurrent duplicate', async () => {
    let calls = 0;
    let signalWakeStarted!: () => void;
    let releaseWake!: () => void;
    const wakeStarted = new Promise<void>((resolve) => {
      signalWakeStarted = resolve;
    });
    const wakeGate = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const runtime = createCaoSentinelRuntime({
      jev: { evaluate: async () => wakeEvaluation() },
      onWake: async () => {
        calls += 1;
        signalWakeStarted();
        await wakeGate;
      },
    });

    const first = runtime.observe(snapshot, 'event');
    await wakeStarted;
    const duplicate = await runtime.observe(snapshot, 'event');
    releaseWake();
    const firstResult = await first;

    expect(calls).toBe(1);
    expect(firstResult.decision.action).toBe('wake_main_cao');
    expect(duplicate.decision).toMatchObject({ action: 'noop', reasonCode: 'wake_deduplicated' });
    expect(duplicate.wake).toBeUndefined();
  });

  it('fails closed to a truthful noop when candidate authority is unavailable', async () => {
    const runtime = createCaoSentinelRuntime({
      jev: { evaluate: async () => candidateEvaluation() },
    });

    const result = await runtime.observe(snapshot, 'event');

    expect(result.candidates).toHaveLength(1);
    expect(result.decision).toMatchObject({
      action: 'noop',
      reasonCode: 'candidate_authority_unavailable',
    });
    expect(result.candidateDispatch).toBeUndefined();
  });

  it('routes candidates once and retries after a rejected authority dispatch', async () => {
    let attempts = 0;
    const onCandidate = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('authority rejected');
      return { status: 'awaiting_approval' as const, proposalId: 'proposal-1' };
    });
    const runtime = createCaoSentinelRuntime({
      jev: { evaluate: async () => candidateEvaluation() },
      onCandidate,
    });

    await expect(runtime.observe(snapshot, 'event')).rejects.toThrow('authority rejected');
    const dispatched = await runtime.observe(snapshot, 'event');
    const duplicate = await runtime.observe(snapshot, 'event');

    expect(onCandidate).toHaveBeenCalledTimes(2);
    expect(dispatched.candidateDispatch).toEqual({
      status: 'awaiting_approval',
      proposalId: 'proposal-1',
    });
    expect(dispatched.decision).toMatchObject({
      action: 'use_candidate_message',
      reasonCode: 'candidate_awaiting_approval',
    });
    expect(duplicate.decision).toMatchObject({
      action: 'noop',
      reasonCode: 'candidate_deduplicated',
    });
  });
});
