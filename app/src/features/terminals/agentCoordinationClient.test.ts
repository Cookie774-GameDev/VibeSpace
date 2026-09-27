import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  createTerminalRelayParticipantDescriptor,
  createTerminalRelayParticipationAdapter,
  loadCoordinationSummary,
  registerCoordinatedTerminal,
  heartbeatCoordinatedTerminal,
  inferAgentProvider,
  type TerminalRelayParticipantIdentity,
} from './agentCoordinationClient';
import { acquireFileLock, createEmptyCoordinationSnapshot } from './agentCoordination';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const now = '2026-06-18T15:00:00.000Z';

const terminalRelayIdentity: TerminalRelayParticipantIdentity = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  sessionId: 'terminal-session-a',
  terminalId: 'terminal-a',
  processInstanceId: 'pty-process-a',
  runtimeGeneration: 'runtime-generation-a',
  provider: 'opencode',
  agentName: 'OpenCode',
};

describe('agentCoordinationClient', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('skips native writes outside coordinated mode', async () => {
    const result = await registerCoordinatedTerminal({
      cwd: 'C:\\repo',
      mode: 'no-context',
      terminalId: 'tty-a',
      paneId: 'pane-a',
      agentSlug: 'coder',
      agentName: 'Coder',
      provider: 'claude',
      now,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('registers coordinated terminals through native state and event files', async () => {
    invokeMock.mockResolvedValue({
      coordinationDir: 'C:\\repo\\.vibespace',
      stateJson: null,
      locksJson: null,
      eventsText: null,
    });

    const result = await registerCoordinatedTerminal({
      cwd: 'C:\\repo',
      mode: 'coordinated',
      terminalId: 'tty-a',
      paneId: 'pane-a',
      agentSlug: 'coder',
      agentName: 'Coder',
      provider: 'claude',
      now,
    });

    expect(result.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('agent_coordination_snapshot', {
      projectRoot: 'C:\\repo',
    });
    expect(invokeMock).toHaveBeenCalledWith(
      'agent_coordination_register',
      expect.objectContaining({
        projectRoot: 'C:\\repo',
        stateJson: expect.stringContaining('"terminalId":"tty-a"'),
        eventJson: expect.stringContaining('"agent_registered"'),
      }),
    );
  });

  it('heartbeats coordinated terminals without writing for default mode', async () => {
    invokeMock.mockResolvedValue({
      coordinationDir: 'C:\\repo\\.vibespace',
      stateJson: JSON.stringify(createEmptyCoordinationSnapshot('C:\\repo', now)),
      locksJson: null,
      eventsText: null,
    });

    const coordinated = await heartbeatCoordinatedTerminal({
      cwd: 'C:\\repo',
      mode: 'coordinated',
      terminalId: 'tty-a',
      paneId: 'pane-a',
      agentSlug: 'coder',
      agentName: 'Coder',
      provider: 'claude',
      now,
    });
    const skipped = await heartbeatCoordinatedTerminal({
      cwd: 'C:\\repo',
      mode: 'default',
      terminalId: 'tty-a',
      agentName: 'Coder',
      provider: 'claude',
      now,
    });

    expect(coordinated.ok).toBe(true);
    expect(skipped.skipped).toBe(true);
    expect(invokeMock.mock.calls.some(([name]) => name === 'agent_coordination_heartbeat')).toBe(
      true,
    );
  });

  it('loads a prompt-safe coordination summary from the native snapshot', async () => {
    const locked = acquireFileLock(
      {
        ...createEmptyCoordinationSnapshot('C:\\repo', now),
        agents: [
          {
            id: 'agent_tty-a',
            terminalId: 'tty-a',
            paneId: 'pane-a',
            agentName: 'Coder',
            agentSlug: 'coder',
            provider: 'claude',
            mode: 'coordinated',
            status: 'working',
            claimedFiles: [],
            lockedFiles: [],
            lastHeartbeatAt: now,
          },
        ],
      },
      {
        filePath: 'app/src/TerminalView.tsx',
        terminalId: 'tty-a',
        agentName: 'Coder',
        now,
      },
    ).snapshot;
    invokeMock.mockResolvedValue({
      coordinationDir: 'C:\\repo\\.vibespace',
      stateJson: JSON.stringify(locked),
      locksJson: null,
      eventsText: null,
    });

    const summary = await loadCoordinationSummary('C:\\repo');

    expect(summary).toContain('Coder');
    expect(summary).toContain('app/src/TerminalView.tsx');
  });

  it('infers common CLI providers from command text', () => {
    expect(inferAgentProvider('claude')).toBe('claude');
    expect(inferAgentProvider('gemini')).toBe('gemini');
    expect(inferAgentProvider('codex')).toBe('codex');
    expect(inferAgentProvider('opencode')).toBe('opencode');
    expect(inferAgentProvider('powershell')).toBe('custom');
  });

  it('fails closed when a terminal Relay identity is missing verified process or scope data', () => {
    expect(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        processInstanceId: '',
      }),
    ).toBeNull();
    expect(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        runtimeGeneration: '',
      }),
    ).toBeNull();
    expect(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        accountId: '',
      }),
    ).toBeNull();
    expect(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        workspaceId: '',
      }),
    ).toBeNull();
    expect(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        projectId: '',
      }),
    ).toBeNull();
    expect(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        sessionId: '',
      }),
    ).toBeNull();
  });

  it('builds a stable process-bound participant key that changes on restart or scope change', () => {
    const descriptor = createTerminalRelayParticipantDescriptor(terminalRelayIdentity);
    expect(descriptor).toMatchObject({
      surface: 'terminal',
      sessionId: 'terminal-session-a',
      terminalId: 'terminal-a',
      processInstanceId: 'pty-process-a',
      runtimeGeneration: 'runtime-generation-a',
      provider: 'opencode',
    });
    expect(descriptor?.participantKey).toBe(
      createTerminalRelayParticipantDescriptor({ ...terminalRelayIdentity })?.participantKey,
    );
    expect(descriptor?.participantKey).not.toBe(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        runtimeGeneration: 'runtime-generation-b',
      })?.participantKey,
    );
    expect(descriptor?.participantKey).not.toBe(
      createTerminalRelayParticipantDescriptor({
        ...terminalRelayIdentity,
        workspaceId: 'workspace-b',
      })?.participantKey,
    );
  });

  it('deduplicates concurrent and repeated registration and unregisters the bound process once', async () => {
    let finishRegistration!: () => void;
    const register = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRegistration = resolve;
        }),
    );
    const unregister = vi.fn();
    const adapter = createTerminalRelayParticipationAdapter({ register, unregister });

    const first = adapter.register(terminalRelayIdentity);
    const concurrent = adapter.register({ ...terminalRelayIdentity });
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);
    finishRegistration();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult.ok).toBe(true);
    expect(concurrentResult).toMatchObject({ ok: true, deduplicated: true });

    const repeatedResult = await adapter.register(terminalRelayIdentity);
    expect(repeatedResult).toMatchObject({ ok: true, deduplicated: true });
    expect(register).toHaveBeenCalledTimes(1);

    const participantKey =
      createTerminalRelayParticipantDescriptor(terminalRelayIdentity)!.participantKey;
    await expect(adapter.unregister(participantKey)).resolves.toMatchObject({ ok: true });
    await expect(adapter.unregister(participantKey)).resolves.toMatchObject({
      ok: true,
      deduplicated: true,
    });
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith(
      expect.objectContaining({
        participantKey,
        processInstanceId: 'pty-process-a',
        runtimeGeneration: 'runtime-generation-a',
      }),
    );
  });

  it('does not retain failed registrations and can retry the same verified process', async () => {
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary host failure'))
      .mockResolvedValueOnce(undefined);
    const unregister = vi.fn().mockResolvedValue(undefined);
    const adapter = createTerminalRelayParticipationAdapter({ register, unregister });

    await expect(adapter.register(terminalRelayIdentity)).resolves.toMatchObject({
      ok: false,
      reason: 'register_failed',
    });
    await expect(adapter.register(terminalRelayIdentity)).resolves.toMatchObject({ ok: true });
    expect(register).toHaveBeenCalledTimes(2);
  });
});
