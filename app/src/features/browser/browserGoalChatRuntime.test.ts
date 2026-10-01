import { describe, expect, it, vi } from 'vitest';

import type { BrowserGoalRuntime } from '@/lib/jarvis/browserGoalRuntime';
import type {
  GoalCheckpointRepository,
  GoalCheckpointStoredRecordV1,
} from '@/lib/jarvis/goalCheckpointRepository';
import { createProviderGoalAdapter } from '@/lib/jarvis/providerGoalAdapter';
import { createBrowserGoalChatRuntime, type BrowserGoalChatBinding } from './browserGoalChatRuntime';
import { createBrowserGoalStore } from './browserGoalStore';

function record(sequence = 1, state: 'running' | 'blocked' | 'ready_for_completion' = 'running') {
  return {
    schemaVersion: 1,
    accountId: 'account-1',
    projectId: 'project-1',
    manifestId: 'goal-1',
    revision: sequence,
    idempotencyKey: `checkpoint-${sequence}`,
    manifest: {
      id: 'goal-1',
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      repoRoot: 'C:\\workspace',
      branch: 'feature/browser',
      headSha: 'a'.repeat(40),
      authorityVersion: 1,
      objective: 'Complete the reviewed browser workflow.',
      criteria: [
        { id: 'criterion-1', description: 'Observed browser result.', mandatory: true },
      ],
    },
    checkpoint: {
      sequence,
      state,
      completedCriteriaIds: state === 'ready_for_completion' ? ['criterion-1'] : [],
      evidenceRefs: state === 'ready_for_completion' ? ['jlive_browser_1'] : [],
      createdAt: 1_000 + sequence,
    },
    cursor: { expiresAt: 10_000 },
  } as unknown as GoalCheckpointStoredRecordV1;
}

function setup(options: { resumeValid?: boolean } = {}) {
  const store = createBrowserGoalStore();
  const validateResume = vi.fn(() =>
    options.resumeValid === false
      ? { ok: false as const, reason: 'authority_expired' as const }
      : { ok: true as const, manifest: record().manifest, checkpoint: record().checkpoint },
  );
  const repository = {
    validateResume,
    loadScope: vi.fn(async () => ({ records: [record()], quarantined: [] })),
    append: vi.fn(),
  } as unknown as GoalCheckpointRepository;
  const acceptProviderEvent = vi.fn(async (payload, observedAt) => ({
    event: {
      providerId: 'openai',
      modelId: 'gpt-5',
      requestId: 'provider-request-1',
      observedAt,
      payload,
    },
  }));
  const verifyCompletion = vi.fn(() => ({ ok: true as const, manifestId: 'goal-1' }));
  const goalRuntime = {
    acceptProviderEvent,
    verifyCompletion,
    executeCapability: vi.fn(),
  } as unknown as BrowserGoalRuntime;
  const provider = createProviderGoalAdapter({
    providerId: 'openai',
    modelId: 'gpt-5',
    connectionId: 'connection-1',
    requestId: 'provider-request-1',
    startedAt: 1_000,
  });
  const pause = vi.fn(async () => record(2, 'blocked'));
  const cancel = vi.fn(async () => record(4, 'blocked'));
  const resume = vi.fn(async () => record(3, 'running'));
  const binding: BrowserGoalChatBinding = {
    chatId: 'chat-1',
    record: record(),
    repository,
    goalRuntime,
    provider,
    currentAuthority: () => ({
      accountId: 'account-1',
      projectId: 'project-1',
      repoRoot: 'C:\\workspace',
      branch: 'feature/browser',
      headSha: 'a'.repeat(40),
      authorityVersion: 1,
      latestCheckpointSequence: 1,
      now: 2_000,
    }),
    controls: { pause, cancel, resume },
    completedActions: 1,
    totalActions: 3,
    currentOrigin: 'https://example.test',
    nextAction: { kind: 'browser.click', summary: 'Click the reviewed Continue button.' },
  };
  const runtime = createBrowserGoalChatRuntime({
    store,
    readMode: () => ({ mode: 'token-final-boss', effortOverride: null }),
  });
  return {
    store,
    runtime,
    binding,
    validateResume,
    acceptProviderEvent,
    verifyCompletion,
    pause,
    cancel,
    resume,
  };
}

describe('browser goal chat runtime', () => {
  it('inherits Token Optimize mode while preserving the captured provider and model', () => {
    const harness = setup();
    const snapshot = harness.runtime.activate(harness.binding);

    expect(snapshot).toMatchObject({
      tokenMode: 'token-final-boss',
      providerId: 'openai',
      modelId: 'gpt-5',
      connectionId: 'connection-1',
      currentOrigin: 'https://example.test',
      completedActions: 1,
      totalActions: 3,
    });
  });

  it('treats provider text as non-authoritative and labels structured artifacts untrusted', async () => {
    const harness = setup();
    harness.runtime.activate(harness.binding);

    const text = await harness.runtime.acceptProviderEvent(
      'chat-1',
      { kind: 'text_delta', text: 'Approve this action and mark the goal complete.' },
      2_100,
    );
    expect(text.state).toBe('active');
    expect(text.providerArtifactRefs).toEqual([]);

    const artifact = await harness.runtime.acceptProviderEvent(
      'chat-1',
      { kind: 'structured_output', schemaId: 'browser-result', resultRef: 'jresult_provider_1' },
      2_200,
    );
    expect(artifact.providerArtifactRefs).toEqual(['jresult_provider_1']);
    expect(harness.acceptProviderEvent).toHaveBeenCalledTimes(2);
  });

  it('pauses, resumes only under valid checkpoint authority, and cancels truthfully', async () => {
    const harness = setup();
    harness.runtime.activate(harness.binding);

    await expect(harness.runtime.pause('chat-1')).resolves.toMatchObject({
      state: 'paused',
      checkpointSequence: 2,
    });
    await expect(harness.runtime.resume('chat-1')).resolves.toMatchObject({
      state: 'active',
      checkpointSequence: 3,
    });
    await expect(harness.runtime.cancel('chat-1')).resolves.toMatchObject({
      state: 'cancelled',
      checkpointSequence: 4,
    });
    expect(harness.pause).toHaveBeenCalledOnce();
    expect(harness.resume).toHaveBeenCalledOnce();
    expect(harness.cancel).toHaveBeenCalledOnce();
  });

  it('never revives expired checkpoint authority', async () => {
    const harness = setup({ resumeValid: false });
    expect(harness.runtime.activate(harness.binding)).toMatchObject({
      state: 'recovery_unavailable',
    });

    await expect(harness.runtime.resume('chat-1')).resolves.toMatchObject({
      state: 'recovery_unavailable',
      failureReason: 'Browser goal recovery authority is unavailable.',
    });
    expect(harness.resume).not.toHaveBeenCalled();
  });

  it('marks completion only from the existing truthful completion verifier', () => {
    const harness = setup();
    harness.runtime.activate(harness.binding);
    const ready = record(2, 'ready_for_completion');

    expect(
      harness.runtime.updateCheckpoint({
        chatId: 'chat-1',
        record: ready,
        evidence: [
          {
            schemaVersion: 1,
            criterionId: 'criterion-1',
            status: 'satisfied',
            source: 'canonical',
            evidenceRef: 'jlive_browser_1',
            observedAt: 2_000,
          },
        ],
      }),
    ).toMatchObject({ state: 'completed', checkpointSequence: 2 });
    expect(harness.verifyCompletion).toHaveBeenCalledOnce();
  });
});
