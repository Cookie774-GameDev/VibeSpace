import type { CaoMission, CaoMissionStore } from './types';

export async function recoverCaoMission(input: {
  store: CaoMissionStore;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  missionId: string;
  now?: number;
}): Promise<CaoMission | undefined> {
  const mission = await input.store.get({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    missionId: input.missionId,
  });
  if (!mission || mission.status !== 'running') return mission;
  const recovered = Object.freeze({ ...mission, updatedAt: input.now ?? Date.now() });
  const applied = await input.store.compareAndSave({
    expected: mission,
    next: recovered,
  });
  if (!applied) throw new Error('cao_mission_recovery_conflict');
  return recovered;
}
