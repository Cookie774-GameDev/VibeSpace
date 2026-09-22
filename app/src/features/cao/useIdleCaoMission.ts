import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useUIStore } from '@/stores/ui';
import { createCaoMissionStoreFromDatabase } from './mission/missionStore';
export function useIdleCaoMission(enabled: boolean) {
  const cloudSession = useAuthStore((state) => state.cloudSession);
  const localUserId = useAuthStore((state) => state.localUserId);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const chatId = useUIStore((state) => state.activeChatId);
  const accountId = resolveAccountIdentity({ cloudSession, localUserId })?.accountId;
  return useLiveQuery(async () => {
    if (!enabled || !accountId || !workspaceId) return undefined;
    const chat = chatId ? await db.chats.get(chatId as never) : undefined;
    const missions = (await createCaoMissionStoreFromDatabase(db).list({ accountId, workspaceId })).filter(
      (mission) =>
        mission.accountId === accountId &&
        mission.workspaceId === workspaceId &&
        ['planning', 'running', 'verifying'].includes(mission.status),
    );
    return missions.sort(
      (a, b) =>
        Number(b.projectId === chat?.project_id) - Number(a.projectId === chat?.project_id) ||
        b.updatedAt - a.updatedAt,
    )[0];
  }, [enabled, accountId, workspaceId, chatId]);
}
