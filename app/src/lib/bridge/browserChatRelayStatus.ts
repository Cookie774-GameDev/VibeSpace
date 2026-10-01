import type { BridgeStatus } from './BridgeClient';

export type BrowserChatRelayStatus = BridgeStatus | 'disabled';

let snapshot: BrowserChatRelayStatus = 'disabled';
const listeners = new Set<() => void>();

export const browserChatRelayStatusStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function publishBrowserChatRelayStatus(next: BrowserChatRelayStatus): void {
  if (snapshot === next) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function resetBrowserChatRelayStatus(): void {
  publishBrowserChatRelayStatus('disabled');
}
