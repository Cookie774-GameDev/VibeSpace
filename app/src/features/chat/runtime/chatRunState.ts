export interface ChatRunState {
  chatId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancellationKey?: string;
  errorCode?: string;
}

// Runtime-owned, in-memory status survives view changes, never an app restart.
const states = new Map<string, ChatRunState>();

export function getChatRunState(chatId: string): ChatRunState | undefined {
  return states.get(chatId);
}

export function publishChatRunState(state: ChatRunState): void {
  if (state.status === 'running' || state.status === 'cancelled') {
    states.set(state.chatId, { ...state });
  } else {
    states.delete(state.chatId);
  }
  window.dispatchEvent(new CustomEvent('jarvis:run-state', { detail: state }));
}
