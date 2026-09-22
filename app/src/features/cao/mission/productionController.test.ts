import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JarvisDexie } from '@/lib/db/database';
import type { Chat } from '@/types/chat';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import { writeChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import {
  selectCaoExecutionProfile,
  type CaoExecutionProfile,
  type CaoLiveExecutionCatalog,
} from '../executionProfile';
import type { ProviderCompletionEvidence } from '@/lib/ai/router';
import type { CaoTargetSnapshot } from '../sentinel/types';
import type { CaoMission, CaoMissionScope, CaoMissionStore } from './types';
import {
  createCaoProductionController,
  dispatchCaoWakeToMainBrain,
  type CaoMainBrainDispatchResult,
  type CaoMissionStartInput,
} from './productionController';
import { planCaoMission } from './missionPlanner';

const scope: CaoMissionScope = {
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
};

const catalog: CaoLiveExecutionCatalog = {
  source: 'live',
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  catalogGeneration: 'live-1',
  catalogHash: 'a'.repeat(64),
  verifiedAt: 1,
  entries: [
    {
      backend: 'codex',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
    {
      backend: 'codex',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'low',
    },
  ],
};

const worker = {
  targetId: 'chat-1',
  kind: 'chat' as const,
  backend: 'codex' as const,
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  assignment: 'Implement the bounded gameplay slice and report the test receipt.',
  ownedPaths: ['src/gameplay'],
};

function memoryStore(): CaoMissionStore {
  const rows = new Map<string, CaoMission>();
  return {
    async save(mission) {
      const existing = rows.get(mission.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(mission)) {
        throw new Error('cao_mission_conflict');
      }
      rows.set(mission.id, mission);
    },
    async compareAndSave({ expected, next }) {
      const existing = rows.get(expected.id);
      if (existing !== expected && JSON.stringify(existing) !== JSON.stringify(expected))
        return false;
      rows.set(next.id, next);
      return true;
    },
    async get(input) {
      const mission = rows.get(input.missionId);
      return mission &&
        mission.accountId === input.accountId &&
        mission.workspaceId === input.workspaceId &&
        mission.projectId === input.projectId
        ? mission
        : undefined;
    },
    async list(input) {
      return [...rows.values()].filter(
        (mission) =>
          mission.accountId === input.accountId &&
          mission.workspaceId === input.workspaceId &&
          (input.projectId === undefined || mission.projectId === input.projectId),
      );
    },
  };
}

function receipt(profile: CaoExecutionProfile, requestId: string): ProviderCompletionEvidence {
  return {
    observedAt: 2,
    requestId,
    sessionId: `session-${requestId}`,
    providerId: profile.providerId,
    connectionId: profile.connectionId,
    modelId: profile.modelId,
    reasoningEffort: profile.reasoningEffort,
    usage: { capturedAt: 2 },
  };
}

function input(overrides: Partial<CaoMissionStartInput> = {}): CaoMissionStartInput {
  return {
    scope,
    objective: 'Build and verify the shared project slice.',
    workers: [worker],
    mainProfile: {
      backend: 'codex',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
    ...overrides,
  };
}

function legacyCodexChat(backend_affinity?: Chat['backend_affinity']): Chat {
  return {
    id: 'chat-1',
    workspace_id: scope.workspaceId,
    project_id: scope.projectId,
    title: 'Legacy Codex QA chat',
    mode: 'chat',
    active_agent_ids: [],
    connection: {
      id: 'openai-codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
    },
    ...(backend_affinity ? { backend_affinity } : {}),
    created_at: 1,
    updated_at: 1,
  } as unknown as Chat;
}

function databaseForChat(chat: Chat): JarvisDexie {
  return {
    workspaces: { get: vi.fn(async () => ({ owner_id: scope.accountId })) },
    projects: { get: vi.fn(async () => ({ workspace_id: scope.workspaceId })) },
    chats: { get: vi.fn(async () => chat) },
    terminal_sessions: { get: vi.fn(async () => undefined) },
  } as unknown as JarvisDexie;
}

function prepareLegacyCodexCatalog(): void {
  setDiscoveredConnectionModels('openai-codex', [
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      variants: ['low', 'high'],
      defaultReasoningEffort: 'low',
      source: 'cli_model',
      lastVerifiedAt: 1,
    },
  ]);
  writeChatRuntimePolicyState('chat-1', {
    settings: {
      effort: 'low',
      fastMode: 'auto',
      performance: 'balanced',
      rlmEnabled: false,
    },
    access: 'read-only',
    approveAllForRun: false,
  });
}

afterEach(() => {
  resetDiscoveredConnectionModelsForTests();
  localStorage.removeItem('vibespace.chat-runtime-settings.v1');
});

describe('CAO production controller', () => {
  it('plans automatic assignments from context and dispatches the validated generated work', async () => {
    const dispatchAssignment = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const controller = createCaoProductionController({
      missionStore: memoryStore(),
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      readPlanningContext: async () => ({ currentTask: 'Existing gameplay implementation' }),
      dispatchMainBrain: async ({ profile, requestId, prompt }) => {
        expect(JSON.parse(prompt).context.currentTask).toBe('Existing gameplay implementation');
        return {
          text: JSON.stringify({
            workers: [
              {
                targetId: worker.targetId,
                assignment: 'Verify movement and fix collisions.',
                ownedPaths: ['src/game.ts'],
              },
            ],
          }),
          receipt: receipt(profile, requestId),
        };
      },
      dispatchAssignment,
      newMissionId: () => 'automatic',
      now: () => 100,
    });
    const result = await controller.start(input({ assignmentMode: 'automatic' }));
    expect(dispatchAssignment.mock.calls[0]?.[0]).toMatchObject({
      worker: { assignment: 'Verify movement and fix collisions.' },
    });
    expect(result.mission.workers[0]?.ownedPaths).toEqual(['src/game.ts']);
  });

  it('does not dispatch any worker when the generated plan includes an unknown target', async () => {
    const dispatchAssignment = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const controller = createCaoProductionController({
      missionStore: memoryStore(),
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      readPlanningContext: async () => ({}),
      dispatchMainBrain: async ({ profile, requestId }) => ({
        text: JSON.stringify({
          workers: [
            {
              targetId: 'other-chat',
              assignment: 'Do work',
              ownedPaths: [],
            },
          ],
        }),
        receipt: receipt(profile, requestId),
      }),
      dispatchAssignment,
      newMissionId: () => 'invalid-plan',
      now: () => 100,
    });
    await expect(controller.start(input({ assignmentMode: 'automatic' }))).rejects.toThrow(
      'cao_plan_worker_mismatch',
    );
    expect(dispatchAssignment).not.toHaveBeenCalled();
  });
  it('persists the selected main profile and dispatches every worker through the authority seam', async () => {
    const store = memoryStore();
    const persisted = vi.fn(async () => undefined);
    const dispatched: string[] = [];
    const dispatchMainBrain = vi.fn(async ({ profile, requestId }) => ({
      text: 'bounded plan\n\n1. Verify the receipt.\n2. Continue the assigned slice.',
      receipt: receipt(profile, requestId),
    }));
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: persisted,
      validateWorkerTarget: async () => undefined,
      dispatchMainBrain,
      dispatchAssignment: async ({ worker: target }) => {
        dispatched.push(target.targetId);
        return { status: 'sent' as const, proposalId: `proposal-${target.targetId}` };
      },
      newMissionId: () => 'mission-start',
      now: () => 100,
    });

    const result = await controller.start(input());

    expect(persisted).toHaveBeenCalledOnce();
    expect(dispatchMainBrain).toHaveBeenCalledOnce();
    expect(dispatched).toEqual(['chat-1']);
    expect(result.mission.status).toBe('running');
    expect(result.mission.workers[0]?.status).toBe('running');
    expect(result.assignments[0]).toMatchObject({ targetId: 'chat-1', status: 'sent' });
    expect(result.profile.modelId).toBe('gpt-5.6-luna');
  });

  it('persists a redacted failure reason when automatic mission start fails', async () => {
    const store = memoryStore();
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      readPlanningContext: async () => ({ currentTask: 'Existing bounded task' }),
      dispatchMainBrain: async () => {
        throw new Error('cao_snapshot_mission_invalid; API_KEY=fixture-secret-value-123456');
      },
      newMissionId: () => 'mission-failure',
      now: () => 100,
    });

    await expect(controller.start(input({ assignmentMode: 'automatic' }))).rejects.toThrow(
      'cao_snapshot_mission_invalid',
    );
    const failed = await store.get({ ...scope, missionId: 'mission-failure' });
    expect(failed).toMatchObject({
      status: 'cancelled',
      failureReason: expect.stringContaining('cao_snapshot_mission_invalid'),
    });
    expect(failed?.failureReason).not.toContain('fixture-secret-value-123456');
  });

  it('accepts a legacy Codex chat without backend affinity through the default validator', async () => {
    prepareLegacyCodexCatalog();
    const store = memoryStore();
    const dispatchMainBrain = vi.fn(async ({ profile, requestId }) => ({
      text: 'plan\nwith a verified receipt',
      receipt: receipt(profile, requestId),
    }));
    const controller = createCaoProductionController({
      database: databaseForChat(legacyCodexChat()),
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      dispatchMainBrain,
      dispatchAssignment: async () => ({ status: 'sent' as const }),
      newMissionId: () => 'mission-legacy-codex',
      now: () => 100,
    });

    const result = await controller.start(input());

    expect(result.mission.status).toBe('running');
    expect(dispatchMainBrain).toHaveBeenCalledOnce();
  });

  it('rejects an explicit conflicting backend affinity before any provider dispatch', async () => {
    prepareLegacyCodexCatalog();
    const dispatchMainBrain = vi.fn(async ({ profile, requestId }) => ({
      text: 'plan',
      receipt: receipt(profile, requestId),
    }));
    const controller = createCaoProductionController({
      database: databaseForChat(
        legacyCodexChat({
          version: 1,
          backend: 'opencode',
          locked: true,
          selectedAt: 1,
          lockedAt: 1,
        }),
      ),
      missionStore: memoryStore(),
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      dispatchMainBrain,
      dispatchAssignment: async () => ({ status: 'sent' as const }),
      newMissionId: () => 'mission-conflicting-affinity',
      now: () => 100,
    });

    await expect(controller.start(input())).rejects.toThrow('cao_mission_target_identity_mismatch');
    expect(dispatchMainBrain).not.toHaveBeenCalled();
  });

  it('aborts a deferred CAO plan before any worker assignment is dispatched', async () => {
    const store = memoryStore();
    let releasePlan!: (result: { text: string; receipt: ProviderCompletionEvidence }) => void;
    const plan = new Promise<{ text: string; receipt: ProviderCompletionEvidence }>((resolve) => {
      releasePlan = resolve;
    });
    const dispatchAssignment = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      dispatchMainBrain: async ({ profile, requestId }) =>
        plan.then((result) => ({
          ...result,
          receipt: result.receipt ?? receipt(profile, requestId),
        })),
      dispatchAssignment,
      newMissionId: () => 'mission-cancel',
      now: () => 100,
    });

    const started = controller.start(input());
    await vi.waitFor(() =>
      expect(controller.get({ ...scope, missionId: 'mission-cancel' })).resolves.toMatchObject({
        status: 'planning',
      }),
    );
    await expect(
      controller.cancel({ ...scope, missionId: 'mission-cancel', reason: 'user_cancelled' }),
    ).resolves.toMatchObject({ status: 'cancelled' });
    releasePlan({
      text: 'late plan',
      receipt: {
        observedAt: 2,
        requestId: 'late',
        sessionId: 'session-late',
        providerId: 'openai',
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        usage: { capturedAt: 2 },
      },
    });
    await expect(started).rejects.toThrow();
    expect(dispatchAssignment).not.toHaveBeenCalled();
    await expect(store.get({ ...scope, missionId: 'mission-cancel' })).resolves.toMatchObject({
      status: 'cancelled',
    });
    await expect(store.get({ ...scope, missionId: 'mission-cancel' })).resolves.not.toHaveProperty(
      'failureReason',
    );
  });

  it('keeps exact proposal linkage and starts after the matching approval', async () => {
    const store = memoryStore();
    const dispatchedApproval = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      dispatchMainBrain: async ({ profile, requestId }) => ({
        text: 'plan with a multiline\ncheckpoint',
        receipt: receipt(profile, requestId),
      }),
      dispatchAssignment: async () => ({
        status: 'awaiting_approval' as const,
        proposalId: 'proposal-exact',
      }),
      approveAssignment: dispatchedApproval,
      newMissionId: () => 'mission-approval',
      now: () => 100,
    });

    const started = await controller.start(input());
    expect(started.mission.status).toBe('planning');
    expect(started.mission.workers[0]).toMatchObject({
      status: 'waiting',
      proposalId: 'proposal-exact',
    });
    await expect(
      controller.approveAssignment({
        ...scope,
        missionId: 'mission-approval',
        targetId: worker.targetId,
        proposalId: 'wrong-proposal',
      }),
    ).rejects.toThrow('cao_mission_approval_invalid');
    const approved = await controller.approveAssignment({
      ...scope,
      missionId: 'mission-approval',
      targetId: worker.targetId,
      proposalId: 'proposal-exact',
    });
    expect(dispatchedApproval).toHaveBeenCalledOnce();
    expect(approved.status).toBe('running');
    expect(approved.workers[0]).toMatchObject({ status: 'running' });
    expect(approved.workers[0]).not.toHaveProperty('proposalId');
  });

  it('approves a guarded proposal on a live running mission', async () => {
    const store = memoryStore();
    const approveAssignment = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      dispatchMainBrain: async ({ profile, requestId }) => ({
        text: 'plan',
        receipt: receipt(profile, requestId),
      }),
      dispatchAssignment: async () => ({ status: 'sent' as const }),
      approveAssignment,
      newMissionId: () => 'mission-live-approval',
      now: () => 100,
    });

    await controller.start(input());
    const running = await controller.get({ ...scope, missionId: 'mission-live-approval' });
    if (!running) throw new Error('running mission missing');
    const waiting = Object.freeze({
      ...running,
      workers: Object.freeze(
        running.workers.map((candidate) =>
          Object.freeze({ ...candidate, status: 'waiting' as const, proposalId: 'live-proposal' }),
        ),
      ),
    });
    expect(await store.compareAndSave({ expected: running, next: waiting })).toBe(true);

    const approved = await controller.approveAssignment({
      ...scope,
      missionId: 'mission-live-approval',
      targetId: worker.targetId,
      proposalId: 'live-proposal',
    });
    expect(approveAssignment).toHaveBeenCalledOnce();
    expect(approved.status).toBe('running');
    expect(approved.workers[0]).toMatchObject({ status: 'running' });
  });

  it('serializes approval, and records a delivered result after cancellation without resurrection', async () => {
    const store = memoryStore();
    let releaseApproval!: () => void;
    let approvalStarted!: () => void;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const approvalStartedGate = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const approveAssignment = vi.fn(async () => {
      approvalStarted();
      await approvalGate;
      return { status: 'sent' as const };
    });
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      dispatchMainBrain: async ({ profile, requestId }) => ({
        text: 'plan',
        receipt: receipt(profile, requestId),
      }),
      dispatchAssignment: async () => ({
        status: 'awaiting_approval' as const,
        proposalId: 'proposal-race',
      }),
      approveAssignment,
      newMissionId: () => 'mission-approval-race',
      now: () => 100,
    });

    await controller.start(input());
    const approval = controller.approveAssignment({
      ...scope,
      missionId: 'mission-approval-race',
      targetId: worker.targetId,
      proposalId: 'proposal-race',
    });
    await approvalStartedGate;
    await expect(
      controller.approveAssignment({
        ...scope,
        missionId: 'mission-approval-race',
        targetId: worker.targetId,
        proposalId: 'proposal-race',
      }),
    ).rejects.toThrow('cao_mission_approval_in_progress');

    await expect(
      controller.cancel({ ...scope, missionId: 'mission-approval-race', reason: 'stop now' }),
    ).resolves.toMatchObject({ status: 'cancelled' });
    releaseApproval();
    const result = await approval;

    expect(approveAssignment).toHaveBeenCalledOnce();
    expect(result.status).toBe('cancelled');
    expect(result.workers[0]).toMatchObject({
      status: 'waiting',
      proposalId: 'proposal-race',
      approvalOutcome: 'delivered',
    });
    expect(result.workers[0]).not.toHaveProperty('approvalClaimId');
    await expect(
      controller.get({ ...scope, missionId: 'mission-approval-race' }),
    ).resolves.toMatchObject({
      status: 'cancelled',
      workers: [{ approvalOutcome: 'delivered' }],
    });
  });

  it('does not downgrade an externally delivered approval when final persistence conflicts', async () => {
    const baseStore = memoryStore();
    const store: CaoMissionStore = {
      ...baseStore,
      async compareAndSave(input) {
        const finalizingDelivered =
          input.expected.workers.some((candidate) => candidate.approvalClaimId) &&
          input.next.workers.some(
            (candidate) => candidate.status === 'running' && !candidate.approvalClaimId,
          );
        if (finalizingDelivered) {
          return false;
        }
        return baseStore.compareAndSave(input);
      },
    };
    const approveAssignment = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const controller = createCaoProductionController({
      missionStore: store,
      readLiveCatalog: async () => catalog,
      persistProfile: async () => undefined,
      validateWorkerTarget: async () => undefined,
      dispatchMainBrain: async ({ profile, requestId }) => ({
        text: 'plan',
        receipt: receipt(profile, requestId),
      }),
      dispatchAssignment: async () => ({
        status: 'awaiting_approval' as const,
        proposalId: 'proposal-persistence-race',
      }),
      approveAssignment,
      newMissionId: () => 'mission-persistence-race',
      now: () => 100,
    });

    await controller.start(input());
    await expect(
      controller.approveAssignment({
        ...scope,
        missionId: 'mission-persistence-race',
        targetId: worker.targetId,
        proposalId: 'proposal-persistence-race',
      }),
    ).rejects.toThrow('cao_mission_conflict');
    expect(approveAssignment).toHaveBeenCalledOnce();
    await expect(
      controller.get({ ...scope, missionId: 'mission-persistence-race' }),
    ).resolves.toMatchObject({
      workers: [{ approvalOutcome: 'pending' }],
    });
  });

  it('rechecks wake cancellation after the main brain response before assignment', async () => {
    const mainProfile = selectCaoExecutionProfile({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      catalog,
      backend: 'codex',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      now: 100,
    });
    const mission = planCaoMission({
      missionId: 'mission-wake-cancel',
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      objective: 'Recover the bounded slice.',
      workers: [worker],
      now: 100,
    });
    const snapshot: CaoTargetSnapshot = {
      missionId: mission.id,
      targetId: worker.targetId,
      kind: 'chat',
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      backend: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      assignment: worker.assignment,
      ownedPaths: worker.ownedPaths,
      targetRevision: 1,
      runStatus: 'running',
      lastActivityAt: 100,
      pendingUserInput: false,
      pendingApproval: false,
      pendingTool: false,
      pendingRetry: false,
      receiptIds: [],
      verification: 'pending',
      recentDelta: 'working',
      errors: [],
      claims: [],
      contextRevision: null,
      milestone: 'active-turn',
      cursor: {
        targetRevision: 1,
        contentHash: 'wake-cancel',
        contextRevision: null,
        observedAt: 100,
      },
    };
    const packet = {
      key: 'wake-cancel-key',
      missionId: mission.id,
      targetId: worker.targetId,
      targetRevision: snapshot.targetRevision,
      evidenceHash: 'wake-cancel-evidence',
      reasonCode: 'target_failed',
      observedAt: 100,
    } as const;
    const abort = new AbortController();
    let release!: (result: CaoMainBrainDispatchResult) => void;
    const response = new Promise<CaoMainBrainDispatchResult>((resolve) => {
      release = resolve;
    });
    let mainBrainStarted!: () => void;
    const mainBrainStartedGate = new Promise<void>((resolve) => {
      mainBrainStarted = resolve;
    });
    const dispatchAssignment = vi.fn(async (_input: { worker: unknown }) => ({
      status: 'sent' as const,
    }));
    const wake = dispatchCaoWakeToMainBrain(
      {
        scope,
        mission,
        worker: { ...mission.workers[0]!, status: 'running' },
        profile: mainProfile,
        snapshot,
        packet,
        signal: abort.signal,
      },
      {
        resolveMainBrainProfile: async () => mainProfile,
        dispatchMainBrain: async () => {
          mainBrainStarted();
          return response;
        },
        dispatchAssignment,
      },
    );
    await mainBrainStartedGate;
    abort.abort();
    release({
      text: JSON.stringify({
        action: 'send_message',
        targetId: worker.targetId,
        message: 'Continue the exact failed step.',
        reason: 'The target needs a fresh receipt.',
      }),
      receipt: receipt(mainProfile, 'cao-wake:wake-cancel-key'),
    });
    await expect(wake).rejects.toThrow();
    expect(dispatchAssignment).not.toHaveBeenCalled();
  });

  it('grounds multiline wake decisions in the exact bounded observation', async () => {
    const mainProfile = selectCaoExecutionProfile({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      catalog,
      backend: 'codex',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      now: 100,
    });
    const mission = planCaoMission({
      missionId: 'mission-wake',
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      objective: 'Recover the bounded slice.',
      workers: [worker],
      now: 100,
    });
    const snapshot: CaoTargetSnapshot = {
      missionId: mission.id,
      targetId: worker.targetId,
      kind: 'chat',
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      backend: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      assignment: worker.assignment,
      ownedPaths: worker.ownedPaths,
      targetRevision: 7,
      runStatus: 'error',
      lastActivityAt: 100,
      pendingUserInput: false,
      pendingApproval: false,
      pendingTool: false,
      pendingRetry: true,
      receiptIds: ['receipt-7'],
      verification: 'failed',
      recentDelta: 'provider timeout; credential [REDACTED]',
      errors: ['provider timeout'],
      claims: [],
      contextRevision: 'rev-7',
      milestone: 'active-turn',
      cursor: {
        targetRevision: 7,
        contentHash: 'hash-7',
        contextRevision: 'rev-7',
        observedAt: 100,
      },
    };
    const promptSeen = vi.fn();
    const assignmentSeen = vi.fn();
    const packet = {
      key: 'wake-key-7',
      missionId: mission.id,
      targetId: worker.targetId,
      targetRevision: snapshot.targetRevision,
      evidenceHash: 'evidence-7',
      reasonCode: 'target_failed',
      observedAt: 100,
    } as const;
    const result = await dispatchCaoWakeToMainBrain(
      {
        scope,
        mission,
        worker: { ...mission.workers[0]!, status: 'running' },
        profile: mainProfile,
        snapshot,
        packet,
        signal: new AbortController().signal,
      },
      {
        resolveMainBrainProfile: async () => mainProfile,
        dispatchMainBrain: async ({ profile, requestId, prompt }) => {
          promptSeen(prompt);
          const parsed = JSON.parse(prompt) as {
            snapshot: CaoTargetSnapshot;
            worker: { targetId: string };
          };
          expect(parsed.snapshot.errors).toContain('provider timeout');
          expect(parsed.worker.targetId).toBe(worker.targetId);
          expect(prompt).not.toContain('Bearer sk-secret');
          return {
            text: JSON.stringify({
              action: 'send_message',
              targetId: worker.targetId,
              message: 'Retry the failed step.\nReport the fresh receipt.',
              reason: 'The bounded provider timeout requires a fresh receipt.',
            }),
            receipt: receipt(profile, requestId),
          };
        },
        dispatchAssignment: async ({ worker: target }) => {
          assignmentSeen(target.assignment);
          return { status: 'sent' as const };
        },
      },
    );
    expect(promptSeen).toHaveBeenCalledOnce();
    expect(assignmentSeen).toHaveBeenCalledWith(
      'Retry the failed step.\nReport the fresh receipt.',
    );
    expect(result.status).toBe('sent');
  });
});
