import { terminalRestoreText, type SessionTranscript } from './transcriptStore';

export interface BackendTerminalInfo {
  sessionId: string;
  command: string;
  cwd: string;
  rows: number;
  cols: number;
  startedAt: number;
  projectId?: string | null;
}

export type TerminalRestoreDecision =
  | {
      kind: 'attach';
      sessionId: string;
      restoredText: string;
      source: 'existing-session' | 'historical-pane';
    }
  | {
      kind: 'spawn';
      restoredText: string;
      restoredInput: string;
      oldSessionId: string | null;
      source: 'dead-existing-session' | 'dead-historical-pane' | 'new-pane';
    };

interface ResolveTerminalRestoreInput {
  existingSessionId?: string | null;
  paneId?: string | null;
  projectId?: string | null;
  activeSessions: BackendTerminalInfo[];
  transcripts: Record<string, SessionTranscript>;
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  return projectId ?? null;
}

function isActiveBackendSession(
  activeSessions: BackendTerminalInfo[],
  sessionId: string,
  projectId: string | null,
): boolean {
  return activeSessions.some((session) => (
    session.sessionId === sessionId &&
    normalizeProjectId(session.projectId) === projectId
  ));
}

function findHistoricalPaneTranscript(
  transcripts: Record<string, SessionTranscript>,
  paneId: string,
  projectId: string | null,
): SessionTranscript | null {
  const matches = Object.values(transcripts).filter((session) => (
    session.paneId === paneId &&
    normalizeProjectId(session.projectId) === projectId
  ));
  matches.sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  return matches[0] ?? null;
}

const INTERACTIVE_TUI_COMMAND_RE =
  /\b(opencode|open-code|claude|codex|gemini|cursor-agent|cline|aider|goose|qwen|openai)\b/i;

function restoredTextForDeadSession(
  session: SessionTranscript | null | undefined,
): string {
  if (!session) return '';
  if (session.command && INTERACTIVE_TUI_COMMAND_RE.test(session.command)) {
    return '';
  }
  return terminalRestoreText(session);
}

export function resolveTerminalRestoreSession({
  existingSessionId,
  paneId,
  projectId,
  activeSessions,
  transcripts,
}: ResolveTerminalRestoreInput): TerminalRestoreDecision {
  const normalizedProjectId = normalizeProjectId(projectId);

  if (existingSessionId) {
    if (isActiveBackendSession(activeSessions, existingSessionId, normalizedProjectId)) {
      return {
        kind: 'attach',
        sessionId: existingSessionId,
        restoredText: terminalRestoreText(transcripts[existingSessionId]),
        source: 'existing-session',
      };
    }

    const oldSession = transcripts[existingSessionId];
    return {
      kind: 'spawn',
      restoredText: restoredTextForDeadSession(oldSession),
      restoredInput: oldSession?.currentInput ?? '',
      oldSessionId: existingSessionId,
      source: 'dead-existing-session',
    };
  }

  if (paneId) {
    const historicalSession = findHistoricalPaneTranscript(
      transcripts,
      paneId,
      normalizedProjectId,
    );
    if (historicalSession) {
      if (isActiveBackendSession(activeSessions, historicalSession.sessionId, normalizedProjectId)) {
        return {
          kind: 'attach',
          sessionId: historicalSession.sessionId,
          restoredText: terminalRestoreText(historicalSession),
          source: 'historical-pane',
        };
      }

      return {
        kind: 'spawn',
        restoredText: restoredTextForDeadSession(historicalSession),
        restoredInput: historicalSession.currentInput ?? '',
        oldSessionId: historicalSession.sessionId,
        source: 'dead-historical-pane',
      };
    }
  }

  return {
    kind: 'spawn',
    restoredText: '',
    restoredInput: '',
    oldSessionId: null,
    source: 'new-pane',
  };
}
