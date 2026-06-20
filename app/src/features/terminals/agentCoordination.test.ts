import { describe, expect, it } from 'vitest';
import {
  acquireFileLock,
  applyCoordinationEvent,
  createEmptyCoordinationSnapshot,
  markStaleCoordinationLocks,
  releaseFileLock,
  summarizeCoordinationSnapshot,
  type AgentCoordinationRecord,
} from './agentCoordination';

const now = '2026-06-18T14:00:00.000Z';

function record(overrides: Partial<AgentCoordinationRecord> = {}): AgentCoordinationRecord {
  return {
    id: overrides.id ?? 'rec-a',
    terminalId: overrides.terminalId ?? 'tty-a',
    paneId: overrides.paneId ?? 'pane-a',
    agentName: overrides.agentName ?? 'Claude Code',
    agentSlug: overrides.agentSlug ?? 'coder',
    provider: overrides.provider ?? 'claude',
    mode: overrides.mode ?? 'coordinated',
    status: overrides.status ?? 'working',
    claimedFiles: overrides.claimedFiles ?? [],
    lockedFiles: overrides.lockedFiles ?? [],
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
    lastActionSummary: overrides.lastActionSummary,
  };
}

describe('agent coordination state helpers', () => {
  it('registers active coordinated agents through append-only events', () => {
    const snapshot = createEmptyCoordinationSnapshot('C:\\repo', now);
    const next = applyCoordinationEvent(snapshot, {
      id: 'evt-1',
      timestamp: now,
      terminalId: 'tty-a',
      paneId: 'pane-a',
      agentName: 'Claude Code',
      agentSlug: 'coder',
      provider: 'claude',
      mode: 'coordinated',
      type: 'agent_registered',
      summary: 'Claude joined the coordinated swarm.',
    });

    expect(next.agents).toHaveLength(1);
    expect(next.agents[0]).toMatchObject({
      terminalId: 'tty-a',
      mode: 'coordinated',
      status: 'idle',
    });
    expect(next.events).toHaveLength(1);
  });

  it('rejects active file lock conflicts without deleting the original lock', () => {
    const snapshot = {
      ...createEmptyCoordinationSnapshot('C:\\repo', now),
      agents: [record({ lockedFiles: ['app/src/A.tsx'] })],
    };
    const locked = acquireFileLock(snapshot, {
      filePath: 'app/src/A.tsx',
      terminalId: 'tty-a',
      agentName: 'Claude Code',
      reason: 'Editing terminal lifecycle',
      now,
    });

    const conflict = acquireFileLock(locked.snapshot, {
      filePath: 'app/src/A.tsx',
      terminalId: 'tty-b',
      agentName: 'Gemini CLI',
      reason: 'Needs same file',
      now,
    });

    expect(locked.ok).toBe(true);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.conflict?.lockedByTerminalId).toBe('tty-a');
    }
    expect(conflict.snapshot.locks.filter((lock) => lock.status === 'active')).toHaveLength(1);
  });

  it('releases only locks owned by the requesting terminal', () => {
    const snapshot = acquireFileLock(createEmptyCoordinationSnapshot('C:\\repo', now), {
      filePath: 'app/src/A.tsx',
      terminalId: 'tty-a',
      agentName: 'Claude Code',
      now,
    }).snapshot;

    const denied = releaseFileLock(snapshot, {
      filePath: 'app/src/A.tsx',
      terminalId: 'tty-b',
      now,
    });
    const released = releaseFileLock(denied.snapshot, {
      filePath: 'app/src/A.tsx',
      terminalId: 'tty-a',
      now,
    });

    expect(denied.ok).toBe(false);
    expect(released.ok).toBe(true);
    expect(released.snapshot.locks[0]?.status).toBe('released');
  });

  it('marks locks stale when the owning agent stops heartbeating', () => {
    const oldHeartbeat = '2026-06-18T13:00:00.000Z';
    const snapshot = acquireFileLock({
      ...createEmptyCoordinationSnapshot('C:\\repo', oldHeartbeat),
      agents: [record({ lastHeartbeatAt: oldHeartbeat, lockedFiles: ['app/src/A.tsx'] })],
    }, {
      filePath: 'app/src/A.tsx',
      terminalId: 'tty-a',
      agentName: 'Claude Code',
      now: oldHeartbeat,
    }).snapshot;

    const stale = markStaleCoordinationLocks(snapshot, {
      now: '2026-06-18T14:10:00.000Z',
      heartbeatTtlMs: 5 * 60 * 1000,
    });

    expect(stale.locks[0]?.status).toBe('stale');
    expect(stale.agents[0]?.status).toBe('blocked');
  });

  it('builds a prompt-safe summary of active agents, locks, and recent events', () => {
    const snapshot = applyCoordinationEvent({
      ...createEmptyCoordinationSnapshot('C:\\repo', now),
      agents: [
        record({
          terminalId: 'tty-a',
          agentName: 'Claude Code',
          lastActionSummary: 'Editing TerminalView.tsx',
        }),
      ],
      locks: [
        {
          filePath: 'app/src/TerminalView.tsx',
          lockedByTerminalId: 'tty-a',
          lockedByAgentName: 'Claude Code',
          reason: 'Terminal lifecycle fix',
          lockedAt: now,
          status: 'active',
        },
      ],
    }, {
      id: 'evt-1',
      timestamp: now,
      terminalId: 'tty-a',
      agentName: 'Claude Code',
      type: 'edit_started',
      filePath: 'app/src/TerminalView.tsx',
      summary: 'Started lifecycle edit with sk-live-should-not-leak token nearby.',
    });

    const summary = summarizeCoordinationSnapshot(snapshot);

    expect(summary).toContain('Claude Code');
    expect(summary).toContain('app/src/TerminalView.tsx');
    expect(summary).not.toContain('sk-live-should-not-leak');
    expect(summary.length).toBeLessThan(4000);
  });
});
