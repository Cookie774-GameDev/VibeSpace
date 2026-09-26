import { describe, expect, it, vi } from 'vitest';
import { recoverCaoMission } from './missionRecovery';
import type { CaoMission, CaoMissionStore } from './types';

const mission: CaoMission = {
  id: 'mission-1',
  schemaVersion: 1,
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  objective: 'Continue the saved mission',
  createdAt: 1,
  updatedAt: 2,
  status: 'running',
  contextMapId: null,
  workers: [
    {
      targetId: 'chat-1',
      kind: 'chat',
      assignment: 'Continue the saved task',
      ownedPaths: ['src'],
      status: 'waiting',
      proposalId: 'proposal-1',
      lastObservedRevision: 7,
    },
  ],
  milestones: [],
  latestPlanRevision: 3,
  lastCaoWakeAt: null,
};

describe('recoverCaoMission', () => {
  it('reuses the persisted revision without rewriting timestamps or pending approval state', async () => {
    const store: CaoMissionStore = {
      save: vi.fn(async () => undefined),
      compareAndSave: vi.fn(async () => true),
      get: vi.fn(async () => mission),
      list: vi.fn(async () => [mission]),
    };

    await expect(
      recoverCaoMission({
        store,
        accountId: mission.accountId,
        workspaceId: mission.workspaceId,
        projectId: mission.projectId,
        missionId: mission.id,
      }),
    ).resolves.toBe(mission);

    expect(store.get).toHaveBeenCalledWith({
      accountId: mission.accountId,
      workspaceId: mission.workspaceId,
      projectId: mission.projectId,
      missionId: mission.id,
    });
    expect(store.compareAndSave).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});
