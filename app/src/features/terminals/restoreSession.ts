import { terminalRestoreText, type SessionTranscript } from './transcriptStore';
import { detectInteractiveAgentCli } from './agentPromptDelivery';

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

function isInteractiveTuiSession(
  session: SessionTranscript | null | undefined,
  backendInfo?: BackendTerminalInfo | null,
): boolean {
  return detectInteractiveAgentCli({
    command: session?.command ?? backendInfo?.command,
    startupCommand: backendInfo?.command,
    transcript: session?.text,
  });
}

function restoredTextForDeadSession(
  session: SessionTranscript | null | undefined,
): string {
  if (!session) return '';
  if (isInteractiveTuiSession(session)) {
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
    const activeExisting = activeSessions.find((session) => (
      session.sessionId === existingSessionId &&
      normalizeProjectId(session.projectId) === normalizedProjectId
    ));
    if (activeExisting) {
      return {
        kind: 'attach',
        sessionId: existingSessionId,
        restoredText: '',
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
      const activeHistorical = activeSessions.find((session) => (
        session.sessionId === historicalSession.sessionId &&
        normalizeProjectId(session.projectId) === normalizedProjectId
      ));
      if (activeHistorical) {
        return {
          kind: 'attach',
          sessionId: historicalSession.sessionId,
          restoredText: '',
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
