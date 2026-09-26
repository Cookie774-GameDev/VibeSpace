import { describe, expect, it, vi } from 'vitest';
import type { CaoMission, CaoMissionStore } from './mission/types';
import {
  createCaoProductionLifecycle,
  readCaoContextRevision,
  type CaoProductionLifecycleDependencies,
} from './productionLifecycle';
import type { JarvisDexie } from '@/lib/db';
import type { CaoLiveExecutionCatalog } from './executionProfile';
import type { CaoTargetSnapshot } from './sentinel/types';
import type { JevEvaluation } from '@/lib/jev/types';

const scope = { accountId: 'account-1', workspaceId: 'workspace-1' } as const;

const catalog: CaoLiveExecutionCatalog = {
  source: 'live',
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  catalogGeneration: 'live-100-a',
  catalogHash: 'a'.repeat(64),
  verifiedAt: 100,
  entries: [
    {
      backend: 'codex',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  ],
};

const mission: CaoMission = {
  id: 'mission-1',
  schemaVersion: 1,
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  projectId: 'project-1',
  objective: 'Observe the target',
  createdAt: 1,
  updatedAt: 2,
  status: 'running',
  contextMapId: null,
  workers: [
    {
      targetId: 'chat-1',
      kind: 'chat',
      backend: 'codex',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      assignment: 'Observe the target',
      ownedPaths: ['src'],
      status: 'running',
      lastObservedRevision: null,
    },
  ],
  milestones: [],
  latestPlanRevision: 1,
  lastCaoWakeAt: null,
};

const snapshot: CaoTargetSnapshot = {
  missionId: mission.id,
  targetId: 'chat-1',
  kind: 'chat',
  accountId: scope.accountId,
  workspaceId: scope.workspaceId,
  projectId: mission.projectId,
  backend: 'codex',
  providerId: 'openai',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'high',
  assignment: 'Observe the target',
  ownedPaths: ['src'],
  targetRevision: 1,
  runStatus: 'running',
  lastActivityAt: 0,
  pendingUserInput: false,
  pendingApproval: false,
  pendingTool: false,
  pendingRetry: false,
  receiptIds: ['receipt-1'],
  verification: 'pending',
  recentDelta: 'working',
  errors: [],
  claims: [],
  contextRevision: null,
  milestone: 'active-turn',
  cursor: { targetRevision: 1, contentHash: 'hash', contextRevision: null, observedAt: 100 },
};

function evaluation(
  action: 'noop' | 'use_candidate_message' | 'wake_main_cao' = 'noop',
): JevEvaluation {
  return {
    model: 'jev-latest',
    observedAt: 100,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
    answers: {
      health: {
        type: 'choice',
        choice: 'healthy_working',
        probabilities: {
          healthy_working: 1,
          waiting_for_user: 0,
          waiting_for_tool: 0,
          likely_stuck: 0,
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
        choice: action,
        probabilities: {
          noop: action === 'noop' ? 1 : 0,
          refresh_evidence: 0,
          verify: 0,
          use_candidate_message: action === 'use_candidate_message' ? 1 : 0,
          wake_main_cao: action === 'wake_main_cao' ? 1 : 0,
          ask_user: 0,
        },
        confidence: 1,
      },
      urgency: {
        type: 'score',
        score: 0,
        legend: { '0': 'low', '1': 'medium', '2': 'high' },
        probabilities: { '0': 1, '1': 0, '2': 0 },
        confidence: 1,
      },
      evidence: {
        type: 'score',
        score: 2,
        legend: { '0': 'low', '1': 'medium', '2': 'high' },
        probabilities: { '0': 0, '1': 0, '2': 1 },
        confidence: 1,
      },
      offTrack: { type: 'noul', noul: 0 },
      doneWithoutProof: { type: 'noul', noul: 0 },
    },
  };
}

function memoryMissionStore(read: () => CaoMission): CaoMissionStore {
  return {
    async save() {},
    async compareAndSave() {
      return true;
    },
    async get() {
      return read();
    },
    async list() {
      return [read()];
    },
  };
}

function settings(overrides: Partial<{ hasKey: boolean; connected: boolean }> = {}) {
  return { modelId: 'jev-latest', hasKey: true, connected: true, ...overrides };
}

describe('CAO production lifecycle', () => {
  it('publishes only the scoped Context Map revision and observes an A-to-B update', async () => {
    const map = {
      id: 'map-project-1',
      accountId: scope.accountId,
      projectId: mission.projectId,
      status: 'active',
      updatedAt: 10,
      knowledgeRevision: 4,
      summary: 'private transcript that must never enter the CAO revision',
    };
    const foreignMap = {
      ...map,
      id: 'map-foreign',
      projectId: 'project-2',
      knowledgeRevision: 99,
      summary: 'foreign transcript that must remain out of scope',
    };
    const maps = [map, foreignMap];
    const database = {
      context_maps: {
        get: vi.fn(async (id: string) => maps.find((candidate) => candidate.id === id)),
        where: vi.fn(() => ({
          equals: vi.fn(() => ({ toArray: vi.fn(async () => maps) })),
        })),
      },
      settings: {
        get: vi.fn(async () => undefined),
      },
    } as unknown as Pick<JarvisDexie, 'context_maps' | 'settings'>;

    const request = {
      accountId: scope.accountId,
      projectId: mission.projectId,
      contextMapId: map.id,
    } as const;
    const revisionA = await readCaoContextRevision(database, request);
    map.knowledgeRevision = 5;
    map.updatedAt = 11;
    const revisionB = await readCaoContextRevision(database, request);

    expect(revisionA).toBe(`${scope.accountId}\u001d${map.id}@4`);
    expect(revisionB).toBe(`${scope.accountId}\u001d${map.id}@5`);
    expect(revisionB).not.toContain(map.summary);
    expect(revisionB).not.toContain(foreignMap.summary);
    expect(revisionB).not.toContain('project-2');
  });

  it('falls back to the selected active map without crossing account or project scope', async () => {
    const selectedMap = {
      id: 'map-selected',
      accountId: scope.accountId,
      projectId: mission.projectId,
      status: 'active',
      updatedAt: 20,
      knowledgeRevision: 8,
    };
    const newerForeignMap = {
      ...selectedMap,
      id: 'map-foreign-newer',
      projectId: 'project-2',
      updatedAt: 100,
      knowledgeRevision: 80,
    };
    const maps = [selectedMap, newerForeignMap];
    const database = {
      context_maps: {
        get: vi.fn(async (id: string) => maps.find((candidate) => candidate.id === id)),
        where: vi.fn(() => ({
          equals: vi.fn(() => ({ toArray: vi.fn(async () => maps) })),
        })),
      },
      settings: {
        get: vi.fn(async () => ({
          key: 'context-selection-v2',
          value: {
            version: 2,
            accountId: scope.accountId,
            projectId: mission.projectId,
            selectedMapId: selectedMap.id,
          },
          updated_at: 20,
        })),
      },
    } as unknown as Pick<JarvisDexie, 'context_maps' | 'settings'>;

    await expect(
      readCaoContextRevision(database, {
        accountId: scope.accountId,
        projectId: mission.projectId,
        contextMapId: null,
      }),
    ).resolves.toBe(`${scope.accountId}\u001d${selectedMap.id}@8`);
  });

  it('does not create a Jev target for an idle or unconfigured scope', async () => {
    const createJev = vi.fn();
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings({ hasKey: false, connected: false }),
      createJev,
      listMissions: async () => [
        { ...mission, workers: [{ ...mission.workers[0]!, status: 'assigned' }] },
      ],
    });
    await lifecycle.reconcile();
    expect(createJev).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it('selects a live profile, observes active targets, and refreshes from receipts', async () => {
    type CreateJevRequest = Parameters<
      NonNullable<CaoProductionLifecycleDependencies['createJev']>
    >[0];
    const createJev = vi.fn(async (_request: CreateJevRequest) => ({
      evaluate: vi.fn(async () => evaluation()),
    }));
    const onObservation = vi.fn();
    const persistObservation = vi.fn(async () => undefined);
    let receiptListener: (() => void) | undefined;
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => catalog,
      listMissions: async () => [mission],
      persistProfile: vi.fn(async () => undefined),
      createJev,
      readSnapshot: async () => snapshot,
      onObservation,
      persistObservation,
      subscribeReceipts: (_scope, listener) => {
        receiptListener = listener;
        return () => {
          receiptListener = undefined;
        };
      },
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      now: () => 1000,
      sweepMs: 1,
      debounceMs: 1,
    });
    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledOnce();
    const firstCreateJevCall = createJev.mock.calls.at(0);
    if (!firstCreateJevCall) throw new Error('createJev was not called');
    expect(firstCreateJevCall[0]).toMatchObject({
      jevModelId: 'jev-latest',
      profile: { modelId: 'gpt-5.6-luna' },
    });
    expect(onObservation).toHaveBeenCalledOnce();
    expect(persistObservation).toHaveBeenCalledOnce();
    receiptListener?.();
    await lifecycle.refresh('event');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onObservation.mock.calls.length).toBeGreaterThanOrEqual(2);
    lifecycle.stop();
  });

  it('ignores observation-only mission changes but rebuilds for execution route changes', async () => {
    type CreateJevRequest = Parameters<
      NonNullable<CaoProductionLifecycleDependencies['createJev']>
    >[0];
    let persistedMission = mission;
    let liveCatalog = catalog;
    const createJev = vi.fn(async (_request: CreateJevRequest) => ({
      evaluate: vi.fn(async () => evaluation()),
    }));
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => liveCatalog,
      listMissions: async () => [persistedMission],
      createJev,
      readSnapshot: async () => snapshot,
      persistObservation: async () => undefined,
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      sweepMs: 1,
      debounceMs: 1,
    });

    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledOnce();

    persistedMission = {
      ...persistedMission,
      updatedAt: 3,
      workers: persistedMission.workers.map((worker) => ({
        ...worker,
        lastObservedRevision: 2,
      })),
    };
    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledOnce();

    persistedMission = {
      ...persistedMission,
      workers: persistedMission.workers.map((worker) => ({
        ...worker,
        assignment: 'Continue with the new assignment',
      })),
    };
    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledTimes(2);

    persistedMission = {
      ...persistedMission,
      workers: persistedMission.workers.map((worker) => ({
        ...worker,
        status: 'assigned' as const,
      })),
    };
    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledTimes(3);

    liveCatalog = {
      ...catalog,
      catalogHash: 'b'.repeat(64),
      entries: [
        ...catalog.entries,
        { ...catalog.entries[0]!, connectionId: 'openai-codex-secondary' },
      ],
    };
    persistedMission = {
      ...persistedMission,
      workers: persistedMission.workers.map((worker) => ({
        ...worker,
        connectionId: 'openai-codex-secondary',
      })),
    };
    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledTimes(4);
    lifecycle.stop();
  });

  it('stops late target setup after scope disposal', async () => {
    let release!: () => void;
    const setup = new Promise<void>((resolve) => {
      release = resolve;
    });
    type CreateJevRequest = Parameters<
      NonNullable<CaoProductionLifecycleDependencies['createJev']>
    >[0];
    const createJev = vi.fn(async (_request: CreateJevRequest) => {
      await setup;
      return { evaluate: vi.fn(async () => evaluation()) };
    });
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => catalog,
      listMissions: async () => [mission],
      persistProfile: async () => undefined,
      createJev,
      readSnapshot: async () => snapshot,
    });
    await vi.waitFor(() => expect(createJev).toHaveBeenCalledOnce());
    lifecycle.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(createJev).toHaveBeenCalledOnce();
  });

  it('does not dispatch a cached target after its durable mission is cancelled', async () => {
    let persistedMission = mission;
    let action: 'noop' | 'use_candidate_message' = 'noop';
    let missionListener: (() => void) | undefined;
    const createJev = vi.fn(async () => ({
      evaluate: vi.fn(async () => evaluation(action)),
    }));
    const dispatchCandidate = vi.fn(async () => ({ status: 'sent' as const }));
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => catalog,
      listMissions: async () => [persistedMission],
      missionStore: memoryMissionStore(() => persistedMission),
      createJev,
      readSnapshot: async () => snapshot,
      dispatchCandidate,
      persistObservation: async () => undefined,
      subscribeMissions: (_scope, listener) => {
        missionListener = listener;
        return () => {
          missionListener = undefined;
        };
      },
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      sweepMs: 1,
      debounceMs: 1,
    });

    await lifecycle.reconcile();
    persistedMission = { ...mission, status: 'cancelled', updatedAt: 3 };
    missionListener?.();
    action = 'use_candidate_message';
    await lifecycle.refresh('sweep');

    expect(dispatchCandidate).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it('persists a wake approval proposal as a waiting worker', async () => {
    let persistedMission = mission;
    const store: CaoMissionStore = {
      async save(next) {
        persistedMission = next;
      },
      async compareAndSave({ expected, next }) {
        if (expected !== persistedMission) return false;
        persistedMission = next;
        return true;
      },
      async get() {
        return persistedMission;
      },
      async list() {
        return [persistedMission];
      },
    };
    const onWake = vi.fn(async () => ({
      status: 'awaiting_approval' as const,
      targetId: 'chat-1',
      proposalId: 'wake-proposal',
      receipt: {
        observedAt: 100,
        requestId: 'wake-request',
        sessionId: 'wake-session',
        providerId: 'openai',
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        usage: { capturedAt: 100 },
      },
    }));
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => catalog,
      listMissions: async () => [persistedMission],
      missionStore: store,
      createJev: async () => ({
        evaluate: vi.fn(async () => evaluation()),
      }),
      readSnapshot: async () => ({
        ...snapshot,
        runStatus: 'error' as const,
        verification: 'failed' as const,
        errors: ['provider timeout'],
      }),
      onWake,
      persistObservation: async () => undefined,
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      now: () => 1000,
      sweepMs: 1,
      debounceMs: 1,
    });

    await lifecycle.reconcile();
    expect(onWake).toHaveBeenCalledOnce();
    expect(persistedMission.workers[0]).toMatchObject({
      status: 'waiting',
      proposalId: 'wake-proposal',
    });
    lifecycle.stop();
  });

  it('keeps pending approval paused across restart, resumes after approval, and stops on cancel', async () => {
    let persistedMission: CaoMission = {
      ...mission,
      workers: mission.workers.map((worker) => ({
        ...worker,
        status: 'waiting' as const,
        proposalId: 'proposal-1',
      })),
    };
    const createJev = vi.fn(async () => ({
      evaluate: vi.fn(async () => evaluation()),
    }));
    const onObservation = vi.fn();
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => catalog,
      listMissions: async () => [persistedMission],
      createJev,
      readSnapshot: async () => snapshot,
      onObservation,
      persistObservation: async () => undefined,
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      sweepMs: 1,
      debounceMs: 1,
    });

    await lifecycle.reconcile();
    expect(createJev).not.toHaveBeenCalled();
    expect(onObservation).not.toHaveBeenCalled();

    const waitingWorker = persistedMission.workers[0];
    if (!waitingWorker) throw new Error('waiting worker missing');
    const { proposalId: _proposalId, ...resumedWorker } = waitingWorker;
    persistedMission = {
      ...persistedMission,
      updatedAt: 3,
      workers: [{ ...resumedWorker, status: 'running' }],
    };
    await lifecycle.reconcile();
    expect(createJev).toHaveBeenCalledOnce();
    expect(onObservation).toHaveBeenCalledOnce();

    persistedMission = { ...persistedMission, status: 'cancelled', updatedAt: 4 };
    await lifecycle.reconcile();
    await lifecycle.refresh('sweep');
    expect(createJev).toHaveBeenCalledOnce();
    expect(onObservation).toHaveBeenCalledOnce();
    lifecycle.stop();
  });

  it('persists target observation revisions monotonically and skips duplicate revisions', async () => {
    let persistedMission = mission;
    let currentSnapshot = snapshot;
    const compareAndSave = vi.fn(
      async ({ expected, next }: { expected: CaoMission; next: CaoMission }) => {
        if (expected !== persistedMission) return false;
        persistedMission = next;
        return true;
      },
    );
    const missionStore: CaoMissionStore = {
      async save(next) {
        persistedMission = next;
      },
      compareAndSave,
      async get() {
        return persistedMission;
      },
      async list() {
        return [persistedMission];
      },
    };
    const lifecycle = createCaoProductionLifecycle({
      readScope: () => scope,
      isEnabled: () => true,
      loadSettings: async () => settings(),
      readLiveCatalog: async () => catalog,
      listMissions: async () => [persistedMission],
      missionStore,
      createJev: async () => ({ evaluate: vi.fn(async () => evaluation()) }),
      readSnapshot: async () => currentSnapshot,
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      now: () => 1000,
      sweepMs: 1,
      debounceMs: 1,
    });

    await lifecycle.reconcile();
    expect(persistedMission.workers[0]?.lastObservedRevision).toBe(1);
    expect(persistedMission.workers[0]?.sentinelReceipts).toEqual([
      expect.objectContaining({
        missionId: mission.id,
        targetId: 'chat-1',
        targetRevision: 1,
        trigger: 'sweep',
        action: 'noop',
        reasonCode: 'healthy_noop',
      }),
    ]);
    expect(compareAndSave).toHaveBeenCalledTimes(2);

    currentSnapshot = {
      ...snapshot,
      contextRevision: 'context@2',
      cursor: {
        targetRevision: 1,
        contentHash: 'hash-2',
        contextRevision: 'context@2',
        observedAt: 200,
      },
    };
    await lifecycle.refresh('sweep');
    expect(persistedMission.workers[0]?.lastObservedRevision).toBe(1);
    expect(compareAndSave).toHaveBeenCalledTimes(2);

    currentSnapshot = {
      ...snapshot,
      targetRevision: 2,
      cursor: { targetRevision: 2, contentHash: 'hash-3', contextRevision: null, observedAt: 300 },
    };
    await lifecycle.refresh('sweep');
    expect(persistedMission.workers[0]?.lastObservedRevision).toBe(2);
    expect(persistedMission.workers[0]?.sentinelReceipts).toHaveLength(2);
    expect(compareAndSave).toHaveBeenCalledTimes(4);

    currentSnapshot = {
      ...snapshot,
      cursor: {
        targetRevision: 1,
        contentHash: 'hash-stale',
        contextRevision: null,
        observedAt: 400,
      },
    };
    await lifecycle.refresh('sweep');
    expect(persistedMission.workers[0]?.lastObservedRevision).toBe(2);
    expect(persistedMission.workers[0]?.sentinelReceipts).toHaveLength(2);
    expect(compareAndSave).toHaveBeenCalledTimes(4);
    lifecycle.stop();
  });
});
