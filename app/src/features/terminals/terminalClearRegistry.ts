/**
 * Direct pane clear handlers — avoids brittle session-id matching when a
 * pane has respawned but the tree still holds a stale session id briefly.
 */
const paneClearHandlers = new Map<string, () => void>();
const paneSessionIds = new Map<string, string>();

export function registerTerminalPaneClearHandler(
  paneId: string,
  handler: () => void,
): () => void {
  paneClearHandlers.set(paneId, handler);
  return () => {
    paneClearHandlers.delete(paneId);
  };
}

export function setTerminalPaneSessionId(paneId: string, sessionId: string): void {
  paneSessionIds.set(paneId, sessionId);
}

export function clearTerminalPaneSessionId(paneId: string): void {
  paneSessionIds.delete(paneId);
}

export function getTerminalPaneSessionId(paneId: string): string | undefined {
  return paneSessionIds.get(paneId);
}

/** Run the mounted xterm clear for a pane. Returns false when no handler exists. */
export function runTerminalPaneClear(paneId: string): boolean {
  const handler = paneClearHandlers.get(paneId);
  if (!handler) return false;
  handler();
  return true;
}
