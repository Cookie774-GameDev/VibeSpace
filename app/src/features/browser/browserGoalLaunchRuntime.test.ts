import { describe, expect, it, vi } from 'vitest';

import type { JarvisIssuedActionExecution } from '@/lib/jarvis/approvalEngine';
import type { JarvisRegisteredActionDefinition } from '@/lib/jarvis/actions/catalog';
import type { JarvisRun } from '@/lib/jarvis/contracts';
import {
  createGoalCheckpointRepository,
  type GoalCheckpointStoragePort,
  type GoalCheckpointStoredRecordV1,
} from '@/lib/jarvis/goalCheckpointRepository';
import { createBrowserGoalChatRuntime } from './browserGoalChatRuntime';
import {
  createBrowserGoalLaunchRuntime,
  type CanonicalBrowserActionInput,
} from './browserGoalLaunchRuntime';
import { createBrowserGoalStore } from './browserGoalStore';
import {
  createBrowserNativeHandoffRuntime,
  type BrowserNativeHandoffRequest,
} from './browserNativeHandoff';

function repositoryHarness() {
  const records: GoalCheckpointStoredRecordV1[] = [];
  const storage: GoalCheckpointStoragePort = {
    loadScope: async (accountId, projectId) =>
      records.filter(
        (record) => record.accountId === accountId && record.projectId === projectId,
      ),
    async appendExpected(input) {
      const duplicate = records.find(
        (record) =>
          record.manifestId === input.manifestId &&
          record.idempotencyKey === input.idempotencyKey,
      );
      if (duplicate) return { kind: 'duplicate', record: duplicate };
      const revision = records
        .filter((record) => record.manifestId === input.manifestId)
        .reduce((highest, record) => Math.max(highest, record.revision), 0);
      if (revision !== input.expectedRevision) {
        return { kind: 'conflict', currentRevision: revision };
      }
      records.push(input.record);
      return { kind: 'appended', record: input.record };
    },
  };
  return { repository: createGoalCheckpointRepository(storage), records };
}

function fixture(options: {
  repository?: ReturnType<typeof repositoryHarness>['repository'];
  now?: () => number;
  modelId?: string;
  approvalId?: string;
} = {}) {
  const repository = options.repository ?? repositoryHarness().repository;
  const store = createBrowserGoalStore();
  const handoffValues = new Map<string, string>();
  const handoffRuntime = createBrowserNativeHandoffRuntime({
    storage: {
      getItem: (key) => handoffValues.get(key) ?? null,
      setItem: (key, value) => void handoffValues.set(key, value),
    },
    now: () => 1_100,
    hash: async (text) => [...text].reduce(
      (hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0,
      5381,
    ).toString(16).padStart(64, '0'),
  });
  const chatRuntime = createBrowserGoalChatRuntime({
    store,
    handoffRuntime,
    readMode: () => ({ mode: 'token-saver', effortOverride: null }),
  });
  const requestCancellation = vi.fn(async () => ({ kind: 'already_terminal' as const }));
  const execution = {
    approval: {
      runId: 'jrun_browser_1',
      requestId: 'jreq_browser_1',
      attemptNumber: 1,
    },
    requestCancellation,
  } as unknown as JarvisIssuedActionExecution;
  const run = {
    id: 'jrun_browser_1',
    accountId: 'account-1',
    projectId: 'project-1',
    chatId: 'chat-1',
    source: 'typed_chat',
    status: 'completed',
    agentId: 'agent-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-1',
    model: {
      providerId: 'openai',
      modelId: options.modelId ?? 'gpt-5',
      connectionId: 'connection-1',
      connectionMode: 'native-api',
      capabilities: {},
      capturedAt: 900,
    },
    createdAt: 900,
    updatedAt: 1_000,
  } satisfies JarvisRun;
  const registration = {
    id: 'browser.click',
    version: 1,
    title: 'Browser click',
    description: 'Perform one reviewed click.',
    inputSchema: {},
    outputSchema: {},
    requiredCapabilities: ['browser.operator'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect: 'Click Continue.',
    exposeToAI: false,
    executor: { kind: 'builtin', registryActionId: 'browser.click' },
    credentialBindings: [],
    validateParameters: (value: unknown) => value as Record<string, unknown>,
    deriveTarget: () => ({ kind: 'external_resource', service: 'browser', resourceId: 'tab-1' }),
  } as unknown as JarvisRegisteredActionDefinition;
  const action: CanonicalBrowserActionInput = {
    registration,
    params: {
      origin: 'https://example.test',
      tabId: 'tab-1',
      reviewId: 'review-1',
      expectedEffect: 'Click the reviewed Continue button.',
    },
    context: {
      source: 'ai',
      chatId: 'chat-1',
      accountId: 'account-1',
      runId: 'jrun_browser_1',
      approvalId: options.approvalId ?? 'approval-1',
      requestId: 'jreq_browser_1',
      attemptNumber: 1,
    },
    execution,
    run,
  };
  const runtime = createBrowserGoalLaunchRuntime({
    repository,
    chatRuntime,
    store,
    now: options.now ?? (() => 1_000),
    hash: async (text) =>
      text.includes('other-model') ? 'b'.repeat(64) : 'a'.repeat(64),
    handoffRuntime,
  });
  return { runtime, chatRuntime, store, action, repository, requestCancellation };
}

function successOutcome() {
  return {
    kind: 'executor_returned' as const,
    result: {
      ok: true as const,
      summary: 'Approved browser operation completed and was observed.',
      data: {
        outcome: {
          capabilityId: 'browser.operator',
          capabilityVersion: 1,
          kind: 'browser',
          operation: 'browser.click',
          state: 'completed',
          resultRef: 'jresult_browser_1',
          evidenceRef: 'jlive_browser_1',
        },
        observation: {
          url: 'https://example.test/after',
          title: 'After',
          text: 'Done',
        },
        sessionId: 'session-1',
        tabId: 'tab-1',
      },
    },
  };
}

describe('Browser Goal live launch runtime', () => {
  it('binds a native handoff to the reviewed launch and chat checkpoint without granting completion', async () => {
    const harness = fixture();
    await harness.runtime.executeRegisteredAction(harness.action, async () => successOutcome());
    const checkpointSequence = harness.store.getSnapshot('chat-1')!.checkpointSequence;
    const request: BrowserNativeHandoffRequest = {
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'jrun_browser_1',
      chatId: 'chat-1',
      providerId: 'openai',
      modelId: 'gpt-5',
      connectionId: 'connection-1',
      browserOrigin: 'https://example.test',
      browserTabId: 'tab-1',
      approvalId: 'approval-1',
      reviewId: 'review-1',
      visiblePrompt: 'Create the reviewed summary.',
      purpose: 'Return a canonical summary artifact.',
      attachments: [],
      expectedArtifact: {
        schemaId: 'summary-v1',
        mediaType: 'application/json',
        maximumBytes: 1_000,
      },
      checkpointSequence,
      issuedAt: 1_000,
      expiresAt: 2_000,
      idempotencyKey: 'handoff-1',
    };
    const envelope = await harness.runtime.issueNativeHandoff(harness.action, request);
    const returned = {
      handoffId: envelope.handoffId,
      bindingHash: envelope.bindingHash,
      checkpointSequence,
      schemaId: 'summary-v1',
      artifactRef: 'jresult_summary_1',
      evidenceRef: 'jlive_summary_1',
      artifactHash: 'c'.repeat(64),
      artifactBytes: 100,
      trust: 'external_untrusted' as const,
    };

    const launchReceipt = await harness.runtime.acceptNativeHandoff(
      harness.action,
      envelope,
      returned,
      1_200,
    );
    const chatResult = await harness.chatRuntime.acceptNativeHandoff(
      'chat-1',
      envelope,
      returned,
      1_200,
    );

    expect(chatResult.receipt).toEqual(launchReceipt);
    expect(chatResult.snapshot.providerArtifactRefs).toContain('jresult_summary_1');
    expect(chatResult.snapshot.state).toBe('completed');
    expect(launchReceipt.completionAuthority).toBe('none');
  });
  it('prepares durably before dispatch and completes only from canonical post-action evidence', async () => {
    const { repository, records } = repositoryHarness();
    let clock = 1_000;
    const harness = fixture({ repository, now: () => clock++ });
    const dispatch = vi.fn(async () => successOutcome());

    await expect(
      harness.runtime.executeRegisteredAction(harness.action, dispatch),
    ).resolves.toEqual(successOutcome());

    expect(dispatch).toHaveBeenCalledOnce();
    expect(records.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'browser-goal:approval-1:browser.click:prepare',
      'browser-goal:approval-1:browser.click:settled',
    ]);
    expect(harness.store.getSnapshot('chat-1')).toMatchObject({
      state: 'completed',
      providerId: 'openai',
      modelId: 'gpt-5',
      tokenMode: 'token-saver',
      checkpointSequence: 2,
      completedActions: 1,
      totalActions: 1,
      currentOrigin: 'https://example.test',
      evidenceRefs: ['jresult_browser_1', 'jlive_browser_1'],
    });
  });

  it('recovers an exact settled action without repeating its browser mutation', async () => {
    const { repository } = repositoryHarness();
    let clock = 1_000;
    const first = fixture({ repository, now: () => clock++ });
    await first.runtime.executeRegisteredAction(first.action, async () => successOutcome());

    const restarted = fixture({ repository, now: () => clock++ });
    const repeatMutation = vi.fn(async () => successOutcome());
    await expect(
      restarted.runtime.executeRegisteredAction(restarted.action, repeatMutation),
    ).resolves.toMatchObject({
      kind: 'executor_returned',
      result: { ok: true, data: { recovered: true } },
    });

    expect(repeatMutation).not.toHaveBeenCalled();
    expect(restarted.store.getSnapshot('chat-1')?.state).toBe('completed');
  });

  it('durably prepares every later action in the same run before its effect', async () => {
    const { repository, records } = repositoryHarness();
    let clock = 1_000;
    const first = fixture({ repository, now: () => clock++ });
    await first.runtime.executeRegisteredAction(first.action, async () => successOutcome());
    const secondAction = {
      ...first.action,
      context: { ...first.action.context, approvalId: 'approval-2' },
    };

    await expect(
      first.runtime.executeRegisteredAction(secondAction, async () => {
        throw new Error('host lost after the second effect began');
      }),
    ).rejects.toThrow(/host lost/i);

    expect(records.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'browser-goal:approval-1:browser.click:prepare',
      'browser-goal:approval-1:browser.click:settled',
      'browser-goal:approval-2:browser.click:prepare',
      'browser-goal:approval-2:browser.click:settled:failed',
    ]);
  });

  it('fails closed before dispatch on account/run/model scope conflicts', async () => {
    const { repository } = repositoryHarness();
    const first = fixture({ repository });
    await first.runtime.executeRegisteredAction(first.action, async () => successOutcome());

    const changedModel = fixture({
      repository,
      modelId: 'other-model',
      approvalId: 'approval-2',
    });
    const dispatch = vi.fn(async () => successOutcome());
    await expect(
      changedModel.runtime.executeRegisteredAction(changedModel.action, dispatch),
    ).resolves.toMatchObject({
      kind: 'executor_returned',
      result: { ok: false },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never revives expired authority or repeats a recovered uncertain mutation', async () => {
    const { repository, records } = repositoryHarness();
    const first = fixture({ repository });
    const neverSettles = vi.fn(async () => {
      throw new Error('simulated host loss before settlement');
    });
    await expect(
      first.runtime.executeRegisteredAction(first.action, neverSettles),
    ).rejects.toThrow(/host loss/i);
    expect(records).toHaveLength(2);

    const restarted = fixture({ repository, now: () => 2_000_000 });
    const repeatMutation = vi.fn(async () => successOutcome());
    await expect(
      restarted.runtime.executeRegisteredAction(restarted.action, repeatMutation),
    ).resolves.toMatchObject({
      kind: 'executor_returned',
      result: { ok: false },
    });
    expect(repeatMutation).not.toHaveBeenCalled();
    expect(restarted.store.getSnapshot('chat-1')?.state).toBe('recovery_unavailable');
  });
});
