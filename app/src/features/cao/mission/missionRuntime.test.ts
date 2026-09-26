import { describe, expect, it, vi } from 'vitest';
import * as secretDetector from '@/lib/security/secretDetector';
import { createCaoMissionRuntime, sanitizeCaoMissionFailureReason } from './missionRuntime';
import { createCaoMissionStore } from './missionStore';
import type { CaoMission } from './types';

const mission: CaoMission = {
  id: 'm',
  schemaVersion: 1,
  accountId: 'a',
  workspaceId: 'w',
  projectId: null,
  objective: 'Build',
  createdAt: 1,
  updatedAt: 1,
  status: 'planning',
  contextMapId: null,
  workers: [],
  milestones: [],
  latestPlanRevision: 1,
  lastCaoWakeAt: null,
};

const scope = {
  accountId: 'a',
  workspaceId: 'w',
  projectId: null,
  missionId: 'm',
} as const;

describe('CAO mission runtime', () => {
  it('uses the safe fallback when the secret policy omits public text', () => {
    const policy = vi.spyOn(secretDetector, 'applySecretPolicy').mockReturnValueOnce({
      decision: 'excluded',
      findings: [],
      requiresUserDecision: false,
    });
    try {
      expect(sanitizeCaoMissionFailureReason('private failure detail')).toBe(
        'cao_mission_start_failed',
      );
      expect(policy).toHaveBeenCalledWith('private failure detail', 'redact');
    } finally {
      policy.mockRestore();
    }
  });

  it('transitions durable mission lifecycle and recovers running work after reload', async () => {
    let current = mission;
    const runtime = createCaoMissionRuntime({
      store: {
        save: async (next) => {
          current = next;
        },
        compareAndSave: async ({ expected, next }) => {
          if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
          current = next;
          return true;
        },
        get: async () => current,
        list: async () => [current],
      },
      now: () => 10,
    });
    await expect(runtime.start(mission)).resolves.toMatchObject({
      status: 'running',
      updatedAt: 10,
    });
    await expect(runtime.transition(scope, 'verifying')).resolves.toMatchObject({
      status: 'verifying',
    });
    current = { ...current, status: 'running' };
    await expect(runtime.recover(scope)).resolves.toMatchObject({ status: 'running' });
  });

  it('requires the exact project scope for lifecycle transitions', async () => {
    let current: CaoMission = { ...mission, status: 'running' };
    const runtime = createCaoMissionRuntime({
      store: {
        save: async (next) => {
          current = next;
        },
        compareAndSave: async ({ expected, next }) => {
          if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
          current = next;
          return true;
        },
        get: async (requested) =>
          requested.accountId === current.accountId &&
          requested.workspaceId === current.workspaceId &&
          requested.projectId === current.projectId
            ? current
            : undefined,
        list: async () => [current],
      },
    });

    await expect(
      runtime.transition({ ...scope, projectId: 'foreign-project' }, 'verifying'),
    ).rejects.toThrow('cao_mission_unavailable');
    await expect(runtime.cancel(scope)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('serializes cancellation before a stale run transition and prevents resurrection', async () => {
    let current: CaoMission = { ...mission, status: 'running' };
    let staleSaveStarted!: () => void;
    const staleSaveObserved = new Promise<void>((resolve) => {
      staleSaveStarted = resolve;
    });
    let releaseStaleSave!: () => void;
    const runtime = createCaoMissionRuntime({
      store: {
        save: async (next) => {
          current = next;
        },
        compareAndSave: async ({ expected, next }) => {
          if (next.status === 'verifying') {
            staleSaveStarted();
            await new Promise<void>((resolve) => {
              releaseStaleSave = resolve;
            });
          }
          if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
          current = next;
          return true;
        },
        get: async (requested) =>
          requested.accountId === current.accountId &&
          requested.workspaceId === current.workspaceId &&
          requested.projectId === current.projectId
            ? current
            : undefined,
        list: async () => [current],
      },
    });

    const staleRun = runtime.transition(scope, 'verifying');
    await staleSaveObserved;
    await expect(runtime.cancel(scope)).resolves.toMatchObject({ status: 'cancelled' });
    releaseStaleSave();
    await expect(staleRun).rejects.toThrow('cao_mission_conflict');
    expect(current.status).toBe('cancelled');
  });

  it('does not restart a cancelled mission when start is repeated', async () => {
    const rows = new Map<string, any>();
    const backend = {
      async get(id: string) {
        return rows.get(id);
      },
      async insertIfAbsent(row: any) {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
      async put(row: any) {
        rows.set(row.id, row);
      },
      async compareAndPut(expected: any, next: any) {
        const current = rows.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
        rows.set(next.id, next);
        return true;
      },
      async list(accountId: string, workspaceId: string) {
        return [...rows.values()].filter(
          (row) => row.accountId === accountId && row.workspaceId === workspaceId,
        );
      },
    };
    const store = createCaoMissionStore(backend);
    const cancelled = { ...mission, status: 'cancelled' as const };
    await store.save(cancelled);
    const runtime = createCaoMissionRuntime({ store });

    await expect(runtime.start(mission)).rejects.toThrow('cao_mission_conflict');
    await expect(store.get(scope)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('retries cancellation when a normal transition wins the first compare-and-save', async () => {
    let current: CaoMission = { ...mission, status: 'running' };
    let cancelSaveStarted!: () => void;
    const cancelSaveObserved = new Promise<void>((resolve) => {
      cancelSaveStarted = resolve;
    });
    let releaseCancelSave!: () => void;
    let blockFirstCancel = true;
    const runtime = createCaoMissionRuntime({
      store: {
        save: async (next) => {
          current = next;
        },
        compareAndSave: async ({ expected, next }) => {
          if (next.status === 'cancelled' && blockFirstCancel) {
            blockFirstCancel = false;
            cancelSaveStarted();
            await new Promise<void>((resolve) => {
              releaseCancelSave = resolve;
            });
          }
          if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
          current = next;
          return true;
        },
        get: async (requested) =>
          requested.accountId === current.accountId &&
          requested.workspaceId === current.workspaceId &&
          requested.projectId === current.projectId
            ? current
            : undefined,
        list: async () => [current],
      },
    });

    const cancel = runtime.cancel(scope);
    await cancelSaveObserved;
    const transition = runtime.transition(scope, 'verifying');
    await expect(transition).resolves.toMatchObject({ status: 'verifying' });
    releaseCancelSave();
    await expect(cancel).resolves.toMatchObject({ status: 'cancelled' });
    expect(current.status).toBe('cancelled');
  });

  it('preserves completed as a terminal state for cancellation', async () => {
    let current: CaoMission = { ...mission, status: 'completed' };
    const runtime = createCaoMissionRuntime({
      store: {
        save: async (next) => {
          current = next;
        },
        compareAndSave: async () => false,
        get: async () => current,
        list: async () => [current],
      },
    });

    await expect(runtime.cancel(scope)).rejects.toThrow('cao_mission_transition_invalid');
    expect(current.status).toBe('completed');
  });

  it('persists a bounded redacted automatic failure reason across reload', async () => {
    const rows = new Map<string, any>();
    const backend = {
      async get(id: string) {
        return rows.get(id);
      },
      async insertIfAbsent(row: any) {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
      async put(row: any) {
        rows.set(row.id, row);
      },
      async compareAndPut(expected: any, next: any) {
        const current = rows.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
        rows.set(next.id, next);
        return true;
      },
      async list(accountId: string, workspaceId: string) {
        return [...rows.values()].filter(
          (row) => row.accountId === accountId && row.workspaceId === workspaceId,
        );
      },
    };
    const store = createCaoMissionStore(backend);
    await store.save(mission);
    const runtime = createCaoMissionRuntime({ store, now: () => 10 });

    await expect(
      runtime.cancel(scope, 'cao_snapshot_mission_invalid; API_KEY=fixture-secret-value-123456'),
    ).resolves.toMatchObject({
      status: 'cancelled',
      failureReason: expect.stringContaining('cao_snapshot_mission_invalid'),
    });

    const reloaded = createCaoMissionStore(backend);
    const persisted = await reloaded.get(scope);
    expect(persisted?.failureReason).toContain('cao_snapshot_mission_invalid');
    expect(persisted?.failureReason).not.toContain('fixture-secret-value-123456');
    expect(persisted?.failureReason?.length).toBeLessThanOrEqual(512);
  });
});
