import {
  getCompatibilityRunState,
  publishCompatibilityRunState,
} from './turn/turnStore';

export interface ChatRunState {
  chatId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancellationKey?: string;
  errorCode?: string;
}

/**
 * Compatibility surface for Composer and older listeners.
 * Canonical status is retained in TurnStore; this module is no longer a second state owner.
 */
export function getChatRunState(chatId: string): ChatRunState | undefined {
  return getCompatibilityRunState(chatId);
}

export function publishChatRunState(state: ChatRunState): void {
  publishCompatibilityRunState(state);
  window.dispatchEvent(new CustomEvent('jarvis:run-state', { detail: { ...state } }));
}
