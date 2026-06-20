import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  loadCoordinationSummary,
  registerCoordinatedTerminal,
  heartbeatCoordinatedTerminal,
  inferAgentProvider,
} from './agentCoordinationClient';
import {
  acquireFileLock,
  createEmptyCoordinationSnapshot,
} from './agentCoordination';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const now = '2026-06-18T15:00:00.000Z';

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
    expect(invokeMock).toHaveBeenCalledWith('agent_coordination_register', expect.objectContaining({
      projectRoot: 'C:\\repo',
      stateJson: expect.stringContaining('"terminalId":"tty-a"'),
      eventJson: expect.stringContaining('"agent_registered"'),
    }));
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
    expect(invokeMock.mock.calls.some(([name]) => name === 'agent_coordination_heartbeat')).toBe(true);
  });

  it('loads a prompt-safe coordination summary from the native snapshot', async () => {
    const locked = acquireFileLock({
      ...createEmptyCoordinationSnapshot('C:\\repo', now),
      agents: [{
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
      }],
    }, {
      filePath: 'app/src/TerminalView.tsx',
      terminalId: 'tty-a',
      agentName: 'Coder',
      now,
    }).snapshot;
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
});
