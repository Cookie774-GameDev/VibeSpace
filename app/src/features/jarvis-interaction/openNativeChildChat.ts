import type { ChatId } from '@/types/common';

export const OPEN_CHILD_CHAT_PANEL_EVENT = 'vibespace:open-child-chat-panel';

export interface OpenChildChatPanelDetail {
  childChatId: string;
  parentChatId?: string;
}

/** Request the child transcript in its parent chat's side panel. */
export function openNativeChildChat(
  childChatId: string | ChatId,
  parentChatId?: string | ChatId,
): void {
  const id = String(childChatId).trim();
  if (!id) return;
  if (typeof window === 'undefined') return;
  const parentId = parentChatId === undefined ? undefined : String(parentChatId).trim();
  window.dispatchEvent(
    new CustomEvent<OpenChildChatPanelDetail>(OPEN_CHILD_CHAT_PANEL_EVENT, {
      detail: { childChatId: id, ...(parentId ? { parentChatId: parentId } : {}) },
    }),
  );
}
