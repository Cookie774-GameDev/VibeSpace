import type { CaoMission, CaoMissionStore } from './types';

/**
 * Reload the durable mission snapshot used by the production lifecycle after
 * restart. Reconciliation rebuilds runtime effects from this snapshot, so this
 * read must not bump timestamps or replay an in-flight approval.
 */
export async function recoverCaoMission(input: {
  store: CaoMissionStore;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  missionId: string;
}): Promise<CaoMission | undefined> {
  return input.store.get({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    missionId: input.missionId,
  });
}
