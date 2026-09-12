import { terminalRestoreText, type SessionTranscript } from './transcriptStore';
import { detectInteractiveAgentCli } from './agentPromptDelivery';
import { sanitizePersistedDraft } from './terminalContentSanitizer';
import type { TerminalSnapshotPayload } from './terminalSnapshot';

export type BackendTerminalInfo = Readonly<{
  sessionId: string;
  command: string;
  cwd: string;
  rows: number;
  cols: number;
  startedAt: number;
  projectId?: string | null;
  processInstanceId: string;
  pid: number;
  processStartedAt: number;
  runtimeGeneration: string;
}>;

export type TerminalRestoreDecision =
  | {
      kind: 'attach';
      sessionId: string;
      backendInfo: BackendTerminalInfo;
      restoredText: string;
      source: 'existing-session' | 'historical-pane';
    }
  | {
      kind: 'spawn';
      restoredText: string;
      restoredInput: string;
      oldSessionId: string | null;
      source: 'dead-existing-session' | 'dead-historical-pane' | 'dead-snapshot' | 'new-pane';
    };

interface ResolveTerminalRestoreInput {
  existingSessionId?: string | null;
  paneId?: string | null;
  projectId?: string | null;
  activeSessions: BackendTerminalInfo[];
  transcripts: Record<string, SessionTranscript>;
  renderedSnapshot?: TerminalSnapshotPayload | null;
  readActiveScreenSnapshot?: (sessionId: string) => string;
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  return projectId ?? null;
}

function findHistoricalPaneTranscript(
  transcripts: Record<string, SessionTranscript>,
  paneId: string,
  projectId: string | null,
): SessionTranscript | null {
  const matches = Object.values(transcripts).filter(
    (session) => session.paneId === paneId && normalizeProjectId(session.projectId) === projectId,
  );
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
  renderedSnapshot?: TerminalSnapshotPayload | null,
): string {
  if (renderedSnapshot?.text) {
    return terminalRestoreText({ text: renderedSnapshot.text });
  }
  if (!session) return '';
  if (isInteractiveTuiSession(session)) {
    return '';
  }
  return terminalRestoreText(session);
}

function restoredTextForAttachedSession(
  session: SessionTranscript | null | undefined,
  backendInfo: BackendTerminalInfo,
  activeScreenSnapshot: string,
): string {
  if (isInteractiveTuiSession(session, backendInfo)) {
    return '';
  }
  // A stripped PTY event transcript is not a terminal screen: cursor motion
  // and carriage-return overwrites have already been lost. Only replay the
  // effective xterm buffer captured for this exact live session.
  return activeScreenSnapshot;
}

export function resolveTerminalRestoreSession({
  existingSessionId,
  paneId,
  projectId,
  activeSessions,
  transcripts,
  renderedSnapshot,
  readActiveScreenSnapshot,
}: ResolveTerminalRestoreInput): TerminalRestoreDecision {
  const normalizedProjectId = normalizeProjectId(projectId);

  if (existingSessionId) {
    const activeExisting = activeSessions.find(
      (session) =>
        session.sessionId === existingSessionId &&
        normalizeProjectId(session.projectId) === normalizedProjectId,
    );
    if (activeExisting) {
      return {
        kind: 'attach',
        sessionId: existingSessionId,
        backendInfo: Object.freeze({ ...activeExisting }),
        restoredText: restoredTextForAttachedSession(
          transcripts[existingSessionId],
          activeExisting,
          readActiveScreenSnapshot?.(existingSessionId) ?? '',
        ),
        source: 'existing-session',
      };
    }

    const oldSession = transcripts[existingSessionId];
    return {
      kind: 'spawn',
      restoredText: restoredTextForDeadSession(oldSession, renderedSnapshot),
      restoredInput: sanitizePersistedDraft(oldSession?.currentInput ?? '', oldSession?.text ?? ''),
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
      const activeHistorical = activeSessions.find(
        (session) =>
          session.sessionId === historicalSession.sessionId &&
          normalizeProjectId(session.projectId) === normalizedProjectId,
      );
      if (activeHistorical) {
        return {
          kind: 'attach',
          sessionId: historicalSession.sessionId,
          backendInfo: Object.freeze({ ...activeHistorical }),
          restoredText: restoredTextForAttachedSession(
            historicalSession,
            activeHistorical,
            readActiveScreenSnapshot?.(historicalSession.sessionId) ?? '',
          ),
          source: 'historical-pane',
        };
      }

      return {
        kind: 'spawn',
        restoredText: restoredTextForDeadSession(historicalSession, renderedSnapshot),
        restoredInput: sanitizePersistedDraft(
          historicalSession.currentInput ?? '',
          historicalSession.text,
        ),
        oldSessionId: historicalSession.sessionId,
        source: 'dead-historical-pane',
      };
    }
  }

  if (renderedSnapshot?.text) {
    return {
      kind: 'spawn',
      restoredText: restoredTextForDeadSession(null, renderedSnapshot),
      restoredInput: '',
      oldSessionId: null,
      source: 'dead-snapshot',
    };
  }

  return {
    kind: 'spawn',
    restoredText: '',
    restoredInput: '',
    oldSessionId: null,
    source: 'new-pane',
  };
}
