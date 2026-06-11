import { invoke } from '@tauri-apps/api/core';
import { useTerminalTranscriptStore } from './transcriptStore';

export const TERMINAL_CLEAR_EVENT = 'jarvis:terminal:clear';

export interface TerminalClearDetail {
  sessionId: string;
  paneId?: string;
}

/** Erase xterm surface, transcript store, and PTY scrollback for a session. */
export function clearTerminalSession(sessionId: string, paneId?: string): void {
  window.dispatchEvent(
    new CustomEvent<TerminalClearDetail>(TERMINAL_CLEAR_EVENT, {
      detail: { sessionId, paneId },
    }),
  );
  useTerminalTranscriptStore.getState().clearSessionTranscript(sessionId);
  // CSI erase display + scrollback, then home — more reliable than ^L alone.
  invoke('terminal_write', { sessionId, data: '\x1b[2J\x1b[3J\x1b[H' }).catch(() => {
    /* backend torn down */
  });
}
