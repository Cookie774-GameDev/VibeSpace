import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalExecution } from '@/features/terminals/terminalExecutionStore';
import { useTerminalExecutionStore } from '@/features/terminals/terminalExecutionStore';
import type { TerminalCommand } from '@/features/terminals/terminalCommandQueue';
import { useTerminalCommandQueue } from '@/features/terminals/terminalCommandQueue';
import type { SessionTranscript } from '@/features/terminals/transcriptStore';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import {
  createJarvisTerminalOperatingSnapshot,
  readJarvisTerminalOperatingSnapshot,
  summarizeJarvisTerminalOperatingSnapshot,
  type JarvisTerminalLifecycleObservation,
} from './terminalIntelligence';

function transcript(
  sessionId: string,
  paneId: string,
  overrides: Partial<SessionTranscript> = {},
): SessionTranscript {
  return {
    sessionId,
    paneId,
    projectId: 'project-a',
    agentSlug: 'builder',
    command: 'npm test',
    text: 'RUN tests\n12 tests passed\nBuild succeeded',
    currentInput: '',
    lastWriteAt: 900,
    bytesSeen: 128,
    ...overrides,
  };
}

function execution(
  id: string,
  sessionId: string,
  status: TerminalExecution['status'],
  overrides: Partial<TerminalExecution> = {},
): TerminalExecution {
  return {
    id,
    sessionId,
    status,
    updatedAt: 950,
    ...overrides,
  };
}

function processIdentity(
  overrides: Partial<NonNullable<TerminalExecution['processIdentity']>> = {},
): NonNullable<TerminalExecution['processIdentity']> {
  return Object.freeze({
    accountId: 'account-a',
    projectId: 'project-a',
    runId: 'run-a',
    executionId: 'exec-1',
    paneId: 'pane-1',
    sessionId: 'pty-1',
    processInstanceId: 'ptyproc-1',
    pid: 4242,
    processStartedAt: 1_723_456_789_000,
    runtimeGeneration: 'runtime-1',
    ...overrides,
  });
}

function shellCommand(
  id: string,
  command: string,
  overrides: Partial<Extract<TerminalCommand, { kind: 'shell' }>> = {},
): Extract<TerminalCommand, { kind: 'shell' }> {
  return {
    kind: 'shell',
    id,
    command,
    ...overrides,
  };
}

afterEach(() => {
  useTerminalTranscriptStore.setState({ sessions: {} });
  useTerminalExecutionStore.setState({ executions: {} });
  useTerminalCommandQueue.setState({ queue: [] });
});

describe('createJarvisTerminalOperatingSnapshot', () => {
  it('projects only the exact frozen canonical execution and native process identity', () => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      transcripts: {
        'pty-1': transcript('pty-1', 'pane-1'),
      },
      executions: {
        'exec-1': execution('exec-1', 'pty-1', 'running', {
          accountId: 'account-a',
          runId: 'run-a',
          processIdentity: processIdentity(),
        }),
      },
      queue: [],
    });

    expect(snapshot.panes[0]).toMatchObject({
      executionId: 'exec-1',
      processInstanceId: 'ptyproc-1',
      pid: 4242,
      processStartedAt: 1_723_456_789_000,
      runtimeGeneration: 'runtime-1',
    });
  });

  it.each([
    ['account', { accountId: 'account-other' }],
    ['project', { projectId: 'project-other' }],
    ['run', { runId: 'run-other' }],
    ['execution', { executionId: 'exec-other' }],
    ['pane', { paneId: 'pane-other' }],
    ['session', { sessionId: 'pty-other' }],
  ])('omits process identity on a %s authority mismatch', (_label, mismatch) => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      transcripts: {
        'pty-1': transcript('pty-1', 'pane-1'),
      },
      executions: {
        'exec-1': execution('exec-1', 'pty-1', 'running', {
          accountId: 'account-a',
          runId: 'run-a',
          processIdentity: processIdentity(mismatch),
        }),
      },
      queue: [],
    });

    expect(snapshot.panes[0]).not.toHaveProperty('executionId');
    expect(snapshot.panes[0]).not.toHaveProperty('processInstanceId');
  });

  it('omits missing, incomplete, mutable, or ambiguous process identity atomically', () => {
    const base = processIdentity();
    const cases: TerminalExecution[] = [
      execution('exec-1', 'pty-1', 'running', {
        accountId: 'account-a',
        runId: 'run-a',
      }),
      execution('exec-1', 'pty-1', 'running', {
        accountId: 'account-a',
        runId: 'run-a',
        processIdentity: { ...base },
      }),
      execution('exec-1', 'pty-1', 'running', {
        accountId: 'account-a',
        runId: 'run-a',
        processIdentity: Object.freeze({ ...base, processInstanceId: '' }),
      }),
    ];

    for (const candidate of cases) {
      const snapshot = createJarvisTerminalOperatingSnapshot({
        observedAt: 1_000,
        transcripts: { 'pty-1': transcript('pty-1', 'pane-1') },
        executions: { 'exec-1': candidate },
        queue: [],
      });
      expect(snapshot.panes[0]).not.toHaveProperty('executionId');
      expect(snapshot.panes[0]).not.toHaveProperty('processInstanceId');
    }

    const ambiguous = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      transcripts: { 'pty-1': transcript('pty-1', 'pane-1') },
      executions: {
        'exec-1': execution('exec-1', 'pty-1', 'running', {
          accountId: 'account-a',
          runId: 'run-a',
          processIdentity: base,
        }),
        'exec-2': execution('exec-2', 'pty-1', 'running', {
          accountId: 'account-a',
          runId: 'run-b',
          processIdentity: processIdentity({
            runId: 'run-b',
            executionId: 'exec-2',
            processInstanceId: 'ptyproc-2',
          }),
          updatedAt: 951,
        }),
      },
      queue: [],
    });
    expect(ambiguous.panes[0]).not.toHaveProperty('executionId');
    expect(ambiguous.panes[0]).not.toHaveProperty('processInstanceId');
  });
  it('captures every available pane fact from existing sources with bounded redaction', () => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      staleAfterMs: 300,
      transcripts: {
        'pty-1': transcript('pty-1', 'pane-1', {
          command: 'npm test -- --run',
          text: [
            'API_KEY=synthetic-terminal-secret',
            '12 tests passed',
            'Build succeeded',
            'Error: missing import in VoiceModal.tsx',
          ].join('\n'),
          lastWriteAt: 990,
        }),
      },
      executions: {
        'exec-1': execution('exec-1', 'pty-1', 'running', { exitCode: null, updatedAt: 995 }),
      },
      queue: [
        shellCommand('exec-1', 'npm test -- --run', {
          cwd: 'C:\\repo',
          refs: [{ paneId: 'pane-1', sessionId: 'pty-1' }],
        }),
      ],
      lifecycleByExecutionId: {
        'exec-1': { state: 'verifying', updatedAt: 998 },
      },
      fileActivityByPaneId: {
        'pane-1': {
          lockedFiles: ['app/src/VoiceModal.tsx'],
          editedFiles: ['app/src/App.tsx'],
        },
      },
    });

    expect(snapshot).toEqual({
      capturedAt: 1_000,
      panes: [
        {
          paneId: 'pane-1',
          sessionId: 'pty-1',
          agentSlug: 'builder',
          cwd: 'C:\\repo',
          launchedCommand: 'npm test -- --run',
          state: 'verifying',
          exitCode: null,
          recentMeaningfulOutput: expect.stringContaining('[REDACTED]'),
          lastOutputAt: 990,
          stale: false,
          queuedCommand: 'npm test -- --run',
          markers: ['build_passed', 'tests_passed'],
          errors: ['Error: missing import in VoiceModal.tsx'],
          lockedFiles: ['app/src/VoiceModal.tsx'],
          editedFiles: ['app/src/App.tsx'],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-terminal-secret');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.panes)).toBe(true);
    expect(Object.isFrozen(snapshot.panes[0])).toBe(true);
  });

  it.each([
    ['queued', 'queued'],
    ['starting', 'sent'],
    ['running', 'running'],
    ['cancellation_requested', 'running'],
    ['complete', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'maps execution status %s without collapsing it to completion',
    (executionStatus, state) => {
      const snapshot = createJarvisTerminalOperatingSnapshot({
        observedAt: 1_000,
        staleAfterMs: 300,
        transcripts: {
          'pty-1': transcript('pty-1', 'pane-1', { lastWriteAt: 990 }),
        },
        executions: {
          'exec-1': execution('exec-1', 'pty-1', executionStatus),
        },
        queue: [],
      });

      expect(snapshot.panes[0]?.state).toBe(state);
    },
  );

  it.each([
    ['prepared', 'prepared'],
    ['awaiting_approval', 'awaiting_approval'],
    ['verifying', 'verifying'],
  ] as const)('uses canonical journal state %s when available', (lifecycleState, state) => {
    const lifecycle: JarvisTerminalLifecycleObservation = {
      state: lifecycleState,
      updatedAt: 995,
    };
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      staleAfterMs: 300,
      transcripts: {
        'pty-1': transcript('pty-1', 'pane-1', { lastWriteAt: 990 }),
      },
      executions: {
        'exec-1': execution('exec-1', 'pty-1', 'running'),
      },
      queue: [],
      lifecycleByExecutionId: { 'exec-1': lifecycle },
    });

    expect(snapshot.panes[0]?.state).toBe(state);
  });

  it('marks an active pane stalled after the bounded silence threshold without changing completed state', () => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 10_000,
      staleAfterMs: 1_000,
      transcripts: {
        running: transcript('running', 'pane-running', { lastWriteAt: 1_000 }),
        completed: transcript('completed', 'pane-completed', { lastWriteAt: 1_000 }),
      },
      executions: {
        running: execution('running', 'running', 'running', { updatedAt: 1_000 }),
        completed: execution('completed', 'completed', 'complete', {
          updatedAt: 1_000,
          exitCode: 0,
        }),
      },
      queue: [],
    });

    expect(snapshot.panes.find(({ paneId }) => paneId === 'pane-running')).toMatchObject({
      state: 'stalled',
      stale: true,
    });
    expect(snapshot.panes.find(({ paneId }) => paneId === 'pane-completed')).toMatchObject({
      state: 'completed',
      exitCode: 0,
      stale: true,
    });
  });

  it('represents queue-only work as queued and never as completed', () => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      staleAfterMs: 300,
      transcripts: {},
      executions: {},
      queue: [
        shellCommand('queue-1', 'npm run build', {
          cwd: 'C:\\repo',
          agentSlug: 'builder',
        }),
      ],
    });

    expect(snapshot.panes).toEqual([
      expect.objectContaining({
        paneId: 'queued:queue-1',
        agentSlug: 'builder',
        cwd: 'C:\\repo',
        state: 'queued',
        queuedCommand: 'npm run build',
      }),
    ]);
    expect(summarizeJarvisTerminalOperatingSnapshot(snapshot).text).toMatch(
      /queued|not completed/i,
    );
    expect(summarizeJarvisTerminalOperatingSnapshot(snapshot).text).not.toMatch(
      /all terminal tasks completed/i,
    );
  });

  it('detects bounded test, build, clean-tree, and actionable error markers', () => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      staleAfterMs: 300,
      transcripts: {
        'pty-1': transcript('pty-1', 'pane-1', {
          text: [
            'Test Files 2 failed',
            'Build failed',
            'fatal: first actionable error',
            'nothing to commit, working tree clean',
          ].join('\n'),
        }),
      },
      executions: {
        'exec-1': execution('exec-1', 'pty-1', 'failed', {
          exitCode: 1,
          settlementError: 'executor result failed',
        }),
      },
      queue: [],
    });

    expect(snapshot.panes[0]).toMatchObject({
      state: 'failed',
      exitCode: 1,
      markers: ['build_failed', 'tests_failed', 'working_tree_clean'],
      errors: ['executor result failed', 'fatal: first actionable error'],
    });
  });
});

describe('terminal operating-intelligence live adapter and summary', () => {
  it('reads the existing transcript, execution, and queue stores without mutating them', () => {
    const session = transcript('pty-live', 'pane-live', { lastWriteAt: 990 });
    const run = execution('exec-live', 'pty-live', 'running', { updatedAt: 995 });
    const command = shellCommand('exec-live', 'npm test', {
      refs: [{ paneId: 'pane-live', sessionId: 'pty-live' }],
    });
    useTerminalTranscriptStore.setState({ sessions: { 'pty-live': session } });
    useTerminalExecutionStore.setState({ executions: { 'exec-live': run } });
    useTerminalCommandQueue.setState({ queue: [command] });

    const snapshot = readJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      staleAfterMs: 300,
    });

    expect(snapshot.panes[0]).toMatchObject({
      paneId: 'pane-live',
      sessionId: 'pty-live',
      state: 'running',
      queuedCommand: 'npm test',
    });
    expect(useTerminalTranscriptStore.getState().sessions['pty-live']).toBe(session);
    expect(useTerminalExecutionStore.getState().executions['exec-live']).toBe(run);
    expect(useTerminalCommandQueue.getState().queue[0]).toBe(command);
  });

  it('scopes live reads to the active project without admitting unrelated queue work', () => {
    useTerminalTranscriptStore.setState({
      sessions: {
        'pty-active': transcript('pty-active', 'pane-active', {
          projectId: 'project-active',
        }),
        'pty-other': transcript('pty-other', 'pane-other', {
          projectId: 'project-other',
        }),
      },
    });
    useTerminalExecutionStore.setState({
      executions: {
        active: execution('active', 'pty-active', 'running', {
          accountId: 'account-a',
          runId: 'run-active',
          processIdentity: processIdentity({
            projectId: 'project-active',
            runId: 'run-active',
            executionId: 'active',
            paneId: 'pane-active',
            sessionId: 'pty-active',
            processInstanceId: 'ptyproc-active',
          }),
        }),
        other: execution('other', 'pty-other', 'running', {
          accountId: 'account-a',
          runId: 'run-other',
          processIdentity: processIdentity({
            projectId: 'project-other',
            runId: 'run-other',
            executionId: 'other',
            paneId: 'pane-other',
            sessionId: 'pty-other',
            processInstanceId: 'ptyproc-other',
          }),
        }),
      },
    });
    useTerminalCommandQueue.setState({
      queue: [
        shellCommand('active', 'npm test'),
        shellCommand('other', 'npm run build', {
          refs: [
            {
              projectId: 'project-other',
              paneId: 'pane-other',
              sessionId: 'pty-other',
            },
          ],
        }),
        shellCommand('unscoped', 'npm publish'),
      ],
    });

    const snapshot = readJarvisTerminalOperatingSnapshot({
      observedAt: 1_000,
      staleAfterMs: 300,
      projectId: 'project-active',
    });

    expect(snapshot.panes.map(({ paneId }) => paneId)).toEqual(['pane-active']);
    expect(snapshot.panes[0]?.queuedCommand).toBe('npm test');
    expect(snapshot.panes[0]).toMatchObject({
      executionId: 'active',
      processInstanceId: 'ptyproc-active',
    });
    expect(JSON.stringify(snapshot)).not.toContain('pane-other');
    expect(JSON.stringify(snapshot)).not.toContain('ptyproc-other');
    expect(JSON.stringify(snapshot)).not.toContain('npm publish');
  });

  it('aggregates multiple panes into one concise status instead of pane-by-pane narration', () => {
    const snapshot = createJarvisTerminalOperatingSnapshot({
      observedAt: 10_000,
      staleAfterMs: 1_000,
      transcripts: {
        active: transcript('active', 'pane-active', { lastWriteAt: 9_900 }),
        stalled: transcript('stalled', 'pane-stalled', { lastWriteAt: 1_000 }),
        failed: transcript('failed', 'pane-failed', {
          lastWriteAt: 9_900,
          text: 'Error: missing import in VoiceModal.tsx',
        }),
      },
      executions: {
        active: execution('active', 'active', 'running', { updatedAt: 9_900 }),
        stalled: execution('stalled', 'stalled', 'running', { updatedAt: 1_000 }),
        failed: execution('failed', 'failed', 'failed', { updatedAt: 9_900, exitCode: 1 }),
      },
      queue: [],
    });

    const summary = summarizeJarvisTerminalOperatingSnapshot(snapshot);

    expect(summary).toMatchObject({
      total: 3,
      active: 1,
      stalled: 1,
      failed: 1,
      completed: 0,
    });
    expect(summary.text).toMatch(/3 terminal panes|1 failed|1 stalled/i);
    expect(summary.text).toContain('Error: missing import in VoiceModal.tsx');
    expect(summary.text.length).toBeLessThanOrEqual(240);
    expect(Object.isFrozen(summary)).toBe(true);
  });
});
