import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '@/lib/db/database';
import {
  resolveChatBackendAffinity,
  type ChatBackendAffinityV1,
} from '@/lib/ai/backend/chatBackend';
import type { ChatId } from '@/types/common';

/** Observe durable authority, including the first message saved by another chat surface. */
export function useChatBackendAffinity(chatId: string): ChatBackendAffinityV1 | null {
  const [state, setState] = useState<{ chatId: string; affinity: ChatBackendAffinityV1 | null }>();
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const chat = await db.chats.get(chatId as ChatId);
      if (!chat) return null;
      const firstUserMessage = await db.messages
        .where('chat_id')
        .equals(chatId)
        .and((message) => message.role === 'user')
        .first();
      return resolveChatBackendAffinity(chat.backend_affinity, {
        hasCommittedUserMessage: Boolean(firstUserMessage),
        chatCreatedAt: chat.created_at,
      });
    }).subscribe({
      next: (affinity) => setState({ chatId, affinity }),
      error: () => setState({ chatId, affinity: null }),
    });
    return () => subscription.unsubscribe();
  }, [chatId]);
  return state?.chatId === chatId ? state.affinity : null;
}
