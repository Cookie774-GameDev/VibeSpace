import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { useUIStore } from '@/stores/ui';
import type { ChatId } from '@/types/common';

/** Focus a multitask/subagent child thread without destroying the parent tab. */
export function openNativeChildChat(childChatId: string | ChatId): void {
  const id = String(childChatId);
  browserChatStore.getState().setEngine('native', id);
  useUIStore.setState({ activeChatId: id, route: 'chat' });
}
