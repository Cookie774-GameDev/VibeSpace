import { describe, expect, it } from 'vitest';
import {
  resolveTerminalRestoreSession,
  type BackendTerminalInfo,
} from './restoreSession';
import type { SessionTranscript } from './transcriptStore';

function transcript(
  sessionId: string,
  paneId: string,
  projectId: string | null,
  lastWriteAt = 100,
): SessionTranscript {
  return {
    sessionId,
    paneId,
    projectId,
    agentSlug: null,
    command: 'powershell.exe',
    text: `output from ${sessionId}`,
    rawText: '',
    currentInput: '',
    lastWriteAt,
    bytesSeen: 10,
  };
}

function backend(sessionId: string, projectId: string | null): BackendTerminalInfo {
  return {
    sessionId,
    command: 'powershell.exe',
    cwd: 'C:\\repo',
    rows: 30,
    cols: 100,
    startedAt: 1,
    projectId,
  };
}

describe('resolveTerminalRestoreSession', () => {
  it('reattaches a live historical pane session after a frontend reload', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [backend('session-a', 'project-a')],
      transcripts: {
        'session-a': transcript('session-a', 'pane-a', 'project-a'),
      },
    });

    expect(decision.kind).toBe('attach');
    if (decision.kind === 'attach') {
      expect(decision.sessionId).toBe('session-a');
      expect(decision.source).toBe('historical-pane');
      expect(decision.restoredText).toContain('output from session-a');
    }
  });

  it('does not cross-attach a terminal from another project', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [backend('session-b', 'project-b')],
      transcripts: {
        'session-b': transcript('session-b', 'pane-a', 'project-b'),
      },
    });

    expect(decision).toMatchObject({
      kind: 'spawn',
      source: 'new-pane',
      oldSessionId: null,
    });
  });

  it('spawns with transcript repair when the historical pane session is dead', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          currentInput: 'npm test',
        },
      },
    });

    expect(decision).toMatchObject({
      kind: 'spawn',
      source: 'dead-historical-pane',
      oldSessionId: 'session-a',
      restoredInput: 'npm test',
    });
  });

  it('does not replay stale fullscreen TUI text when an opencode session is dead', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          command: 'opencode',
          text: 'OpenCode Zen\nM[<35;27;14M[<35;28;14M\nhalf-painted TUI',
        },
      },
    });

    expect(decision).toMatchObject({
      kind: 'spawn',
      source: 'dead-historical-pane',
      oldSessionId: 'session-a',
      restoredText: '',
    });
  });

  it('does not replay stripped TUI transcript when reattaching an active agent CLI', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: 'session-a',
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [
        {
          ...backend('session-a', 'project-a'),
          command: 'opencode',
        },
      ],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          command: 'opencode',
          text: 'OpenCode Zen\nhalf-painted TUI from before route switch',
        },
      },
    });

    expect(decision).toMatchObject({
      kind: 'attach',
      sessionId: 'session-a',
      restoredText: '',
    });
  });
});
