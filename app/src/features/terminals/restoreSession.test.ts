import { describe, expect, it } from 'vitest';
import { resolveTerminalRestoreSession, type BackendTerminalInfo } from './restoreSession';
import type { SessionTranscript } from './transcriptStore';
import type { TerminalSnapshotPayload } from './terminalSnapshot';

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
    processInstanceId: `process-${sessionId}`,
    pid: 4242,
    processStartedAt: 1_723_456_789_000,
    runtimeGeneration: 'runtime-generation-1',
  };
}

function renderedSnapshot(text: string): TerminalSnapshotPayload {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    paneId: 'pane-a',
    text,
    rows: 30,
    cols: 100,
    updatedAt: 200,
    command: 'opencode',
    interactive: true,
  };
}

describe('resolveTerminalRestoreSession', () => {
  it('reattaches a live historical pane session from its authoritative rendered screen', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [backend('session-a', 'project-a')],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          text: 'PS C:\\repo> PS C:\\repo> echo MARK',
        },
      },
      readActiveScreenSnapshot: () => 'PS C:\\repo> echo MARK\r\nMARK\r\nPS C:\\repo> ',
    });

    expect(decision.kind).toBe('attach');
    if (decision.kind === 'attach') {
      expect(decision.sessionId).toBe('session-a');
      expect(decision.backendInfo).toEqual(backend('session-a', 'project-a'));
      expect(decision.source).toBe('historical-pane');
      expect(decision.restoredText).toBe('PS C:\\repo> echo MARK\r\nMARK\r\nPS C:\\repo> ');
    }
  });

  it('reattaches an explicitly known live shell but fails closed without an exact screen snapshot', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: 'session-a',
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
      expect(decision.backendInfo).toEqual(backend('session-a', 'project-a'));
      expect(decision.restoredText).toBe('');
    }
  });

  it('ignores forged persisted identity and returns only the fresh terminal-list binding', () => {
    const fresh = backend('session-a', 'project-a');
    const decision = resolveTerminalRestoreSession({
      existingSessionId: 'session-a',
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [fresh],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          processInstanceId: 'forged-persisted-process',
          pid: 9999,
          processStartedAt: 1,
          runtimeGeneration: 'forged-generation',
        } as SessionTranscript,
      },
    });

    expect(decision).toMatchObject({ kind: 'attach', backendInfo: fresh });
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

  it('restores a sanitized rendered snapshot for a dead interactive TUI', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [],
      renderedSnapshot: renderedSnapshot('OpenCode Zen\nlast rendered screen'),
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          command: 'opencode',
          text: 'half-painted raw TUI',
        },
      },
    });

    expect(decision).toMatchObject({
      kind: 'spawn',
      source: 'dead-historical-pane',
      restoredText: 'OpenCode Zen\r\nlast rendered screen',
    });
  });

  it('restores a pane snapshot even when the bounded transcript was evicted', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [],
      renderedSnapshot: renderedSnapshot('durable pane snapshot'),
      transcripts: {},
    });

    expect(decision).toMatchObject({
      kind: 'spawn',
      source: 'dead-snapshot',
      oldSessionId: null,
      restoredText: 'durable pane snapshot',
      restoredInput: '',
    });
  });

  it('repairs control-bearing restored drafts and never restores a line ending', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: 'session-a',
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          currentInput: 'npm test\u001b[A[<35;24;22M\rmalicious',
        },
      },
    });

    expect(decision).toMatchObject({
      kind: 'spawn',
      restoredInput: 'npm testmalicious',
    });
    if (decision.kind === 'spawn') {
      expect(decision.restoredInput).not.toMatch(/[\r\n\x1b]/);
    }
  });

  it('does not replay OpenCode TUI text when the CLI was launched inside PowerShell', () => {
    const decision = resolveTerminalRestoreSession({
      existingSessionId: null,
      paneId: 'pane-a',
      projectId: 'project-a',
      activeSessions: [],
      transcripts: {
        'session-a': {
          ...transcript('session-a', 'pane-a', 'project-a'),
          command: 'powershell.exe',
          text: 'PS C:\\repo> opencode\nOpenCode Zen\nctrl+p commands\n]4;0;rgb:aa/bb/cc',
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
