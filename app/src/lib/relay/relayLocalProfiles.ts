import { db } from '@/lib/db/database';
import type { ChatId } from '@/types/common';
import { readRelayLocalParticipants } from './relayProductionClient';

/** Enrich only participants whose chat is verified in the selected project. */
export async function readLocalRelayProfiles(projectId: string | null | undefined) {
  if (!projectId) return [];
  const local = readRelayLocalParticipants().filter((item) => item.projectId === String(projectId));
  return Promise.all(local.map(async (item) => {
    const chat = await db.chats.get(item.chatId as ChatId);
    if (!chat || String(chat.project_id) !== String(projectId)) return { relayAgentId: item.relayAgentId };
    const messages = await db.messages.where('chat_id').equals(item.chatId).toArray();
    const latestUser = messages.filter((message) => message.role === 'user')
      .sort((left, right) => right.created_at - left.created_at)[0];
    const latestPrompt = latestUser?.parts.flatMap((part) => part.kind === 'text' ? [part.text] : [])
      .join(' ').trim().slice(0, 400);
    return {
      relayAgentId: item.relayAgentId,
      harness: chat.connection?.displayName,
      model: chat.connection?.modelId,
      task: chat.title,
      latestPrompt,
    };
  }));
}
