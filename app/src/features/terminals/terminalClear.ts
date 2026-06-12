import { invoke } from '@tauri-apps/api/core';
import { useTerminalTranscriptStore } from './transcriptStore';
import {
  getTerminalPaneSessionId,
  runTerminalPaneClear,
} from './terminalClearRegistry';

export const TERMINAL_CLEAR_EVENT = 'jarvis:terminal:clear';

export interface TerminalClearDetail {
  sessionId: string;
  paneId?: string;
}

/** CSI erase display + scrollback + home. */
export const TERMINAL_CLEAR_ESCAPE = '\x1b[2J\x1b[3J\x1b[H';

/** Milliseconds to ignore stale PTY output after an intentional clear. */
export const TERMINAL_CLEAR_SUPPRESS_MS = 450;

/**
 * Shell-specific follow-up writes after the universal escape clear.
 * PowerShell often ignores CSI when injected via stdin; `Clear-Host` is reliable.
 */
export function shellClearFollowUp(command?: string | null): string {
  const cmd = (command ?? '').toLowerCase();
  if (cmd.includes('powershell') || cmd.includes('pwsh')) {
    return 'Clear-Host\r\n';
  }
  if (cmd.includes('cmd.exe') || cmd === 'cmd') {
    return 'cls\r';
  }
  return 'clear\r';
}

function resolveSessionId(sessionId: string, paneId?: string): string {
  if (paneId) {
    return getTerminalPaneSessionId(paneId) ?? sessionId;
  }
  return sessionId;
}

async function requestPtyClear(sessionId: string, command?: string | null): Promise<void> {
  const payload = `${TERMINAL_CLEAR_ESCAPE}\x0c${shellClearFollowUp(command)}`;
  try {
    await invoke('terminal_write', { sessionId, data: payload });
  } catch {
    /* backend torn down */
  }
}

/** Erase xterm surface, transcript store, and PTY scrollback for a session. */
export function clearTerminalSession(sessionId: string, paneId?: string): void {
  const resolvedSessionId = resolveSessionId(sessionId, paneId);
  const command =
    useTerminalTranscriptStore.getState().sessions[resolvedSessionId]?.command ?? null;

  const clearedSurface = paneId ? runTerminalPaneClear(paneId) : false;
  if (!clearedSurface) {
    window.dispatchEvent(
      new CustomEvent<TerminalClearDetail>(TERMINAL_CLEAR_EVENT, {
        detail: { sessionId: resolvedSessionId, paneId },
      }),
    );
  }

  useTerminalTranscriptStore.getState().clearSessionTranscript(resolvedSessionId);
  void requestPtyClear(resolvedSessionId, command);
}
