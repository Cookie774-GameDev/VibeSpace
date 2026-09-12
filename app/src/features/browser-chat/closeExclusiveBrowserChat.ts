import { browserChatSurface } from './providerSurface';
import {
  browserChatStore,
  resolveChatEngine,
  type VibeSpaceChatEngine,
} from './browserChatStore';

export const CLOSE_CHATGPT_BROWSER_CHAT_MESSAGE =
  'Close ChatGPT Browser Chat? This will close the entire ChatGPT screen.';

export type CloseExclusiveBrowserChatResult = 'skipped' | 'cancelled' | 'closed';

export interface CloseExclusiveBrowserChatInput {
  readonly chatId: string;
  readonly engine?: VibeSpaceChatEngine;
  readonly confirm?: () => boolean;
  readonly hideSurface?: () => Promise<void>;
  readonly retireChat?: (chatId: string) => void;
}

export async function closeExclusiveBrowserChatSurface(
  input: CloseExclusiveBrowserChatInput,
): Promise<CloseExclusiveBrowserChatResult> {
  const engine =
    input.engine ?? resolveChatEngine(browserChatStore.getState(), input.chatId);
  if (engine !== 'browser') return 'skipped';

  const confirmed = (input.confirm ?? (() => window.confirm(CLOSE_CHATGPT_BROWSER_CHAT_MESSAGE)))();
  if (!confirmed) return 'cancelled';

  await (input.hideSurface ?? (() => browserChatSurface.hideAll()))();
  const retire =
    input.retireChat ??
    ((chatId: string) => {
      const store = browserChatStore.getState();
      store.setEngine('native', chatId);
      store.clearChatPreferences([chatId]);
    });
  retire(input.chatId);
  return 'closed';
}
