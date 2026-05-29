import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { ChatId, Message } from '@/types';

/**
 * Live-stream the messages for a chat in ascending creation order.
 *
 * Uses dexie-react-hooks so any insert/update on the messages table
 * for this chat (including streaming partial assistant outputs) re-renders
 * the consumer. Returns [] while the chatId is null/undefined so callers
 * never have to null-check.
 */
export function useChatMessages(chatId: ChatId | string | null | undefined): Message[] {
  const result = useLiveQuery(
    async () => {
      if (!chatId) return [];
      return db.messages.where('chat_id').equals(chatId as string).sortBy('created_at');
    },
    [chatId],
    [] as Message[],
  );
  return result ?? [];
}
