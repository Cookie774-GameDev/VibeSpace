import { useCallback, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { ChatId, Message } from '@/types';

export const DEFAULT_CHAT_MESSAGE_PAGE_SIZE = 400;
export const CHAT_MESSAGE_PAGE_INCREMENT = 100;

export interface ChatMessagePage {
  messages: Message[];
  hasOlder: boolean;
}

const EMPTY_CHAT_MESSAGE_PAGE: ChatMessagePage = { messages: [], hasOlder: false };

/**
 * Read only the newest bounded page from IndexedDB's compound chat/time
 * index. One extra sentinel row tells the caller whether another older page
 * exists without loading the complete chat into JavaScript memory.
 */
export async function queryChatMessagePage(
  chatId: ChatId | string,
  limit = DEFAULT_CHAT_MESSAGE_PAGE_SIZE,
): Promise<ChatMessagePage> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid chat message page size.');
  const descending = await db.messages
    .where('[chat_id+created_at]')
    .between([chatId as string, 0], [chatId as string, Number.POSITIVE_INFINITY])
    .reverse()
    .limit(limit + 1)
    .toArray();
  const hasOlder = descending.length > limit;
  return {
    messages: descending.slice(0, limit).reverse(),
    hasOlder,
  };
}

/** Backward-compatible bounded ordered query for non-paging consumers. */
export async function queryChatMessagesInOrder(chatId: ChatId | string): Promise<Message[]> {
  return (await queryChatMessagePage(chatId)).messages;
}

/**
 * Live-query a bounded active-chat page. Loading older history increases the
 * IndexedDB limit in fixed increments; switching chats immediately resets the
 * effective limit without waiting for an effect.
 */
export function usePagedChatMessages(
  chatId: ChatId | string | null | undefined,
): ChatMessagePage & { loadOlder: () => void } {
  const chatKey = String(chatId ?? '');
  const [request, setRequest] = useState({
    chatKey,
    limit: DEFAULT_CHAT_MESSAGE_PAGE_SIZE,
  });
  const activeLimit = request.chatKey === chatKey ? request.limit : DEFAULT_CHAT_MESSAGE_PAGE_SIZE;
  const result = useLiveQuery(
    async () => ({
      chatKey,
      page: chatId ? await queryChatMessagePage(chatId, activeLimit) : EMPTY_CHAT_MESSAGE_PAGE,
    }),
    [chatId, activeLimit],
    null,
  );
  // Live queries retain the previous value while a new subscription loads.
  // Never publish that value under a different selected chat (including null).
  const page = result?.chatKey === chatKey ? result.page : EMPTY_CHAT_MESSAGE_PAGE;
  const hasOlder = page.hasOlder;
  const loadOlder = useCallback(() => {
    if (!chatId || !hasOlder) return;
    setRequest({ chatKey, limit: activeLimit + CHAT_MESSAGE_PAGE_INCREMENT });
  }, [activeLimit, chatId, chatKey, hasOlder]);
  return {
    messages: page.messages,
    hasOlder,
    loadOlder,
  };
}

/** Bounded live-stream compatibility hook for consumers that only need recent messages. */
export function useChatMessages(chatId: ChatId | string | null | undefined): Message[] {
  return usePagedChatMessages(chatId).messages;
}
