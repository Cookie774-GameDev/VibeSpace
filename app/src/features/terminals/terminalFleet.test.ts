import { describe, expect, it } from 'vitest';
import { newLeaf, type PaneNode } from './paneTree';
import {
  planTerminalFleet,
  validateTerminalFleetCustomCommand,
  type TerminalFleetPlanInput,
} from './terminalFleet';

type Leaf = Extract<PaneNode, { kind: 'leaf' }>;

function leaf(id: string, seed: Parameters<typeof newLeaf>[0] = {}): Leaf {
  return { ...(newLeaf(seed) as Leaf), id };
}

function input(overrides: Partial<TerminalFleetPlanInput> = {}): TerminalFleetPlanInput {
  return {
    targetTotal: 4,
    leaves: [
      leaf('occupied', { sessionId: 'pty-1', command: 'powershell' }),
      leaf('empty', { command: 'powershell' }),
      leaf('uncertain', { command: 'powershell' }),
    ],
    runtimeByPaneId: {
      occupied: { backendState: 'active', transcript: 'PS> work' },
      empty: { backendState: 'idle', transcript: '   ' },
      uncertain: { backendState: 'unknown', transcript: '' },
    },
    selection: { kind: 'preset', presetId: 'claude' },
    availableExecutables: new Set(['claude']),
    maxPanes: 10,
    ...overrides,
  };
}

describe('terminal fleet target-total planner', () => {
  it('counts conservative occupancy, reuses safe empty leaves, then appends', () => {
    const result = planTerminalFleet(input());

    expect(result).toMatchObject({
      kind: 'ready',
      currentTotal: 2,
      targetTotal: 4,
      requestedSlots: 2,
      reusedCount: 1,
      appendedCount: 1,
      skippedCount: 0,
    });
    if (result.kind !== 'ready') throw new Error('expected a ready plan');
    expect(result.assignments).toEqual([
      {
        source: 'reuse',
        paneId: 'empty',
        command: 'claude',
      },
      {
        source: 'append',
        command: 'claude',
      },
    ]);
  });

  it('does nothing and never closes panes when the target is below current occupancy', () => {
    const leaves = [
      leaf('one', { sessionId: 'pty-1' }),
      leaf('two', { sessionId: 'pty-2' }),
      leaf('three', { sessionId: 'pty-3' }),
    ];
    const before = structuredClone(leaves);
    const result = planTerminalFleet(
      input({
        targetTotal: 1,
        leaves,
        runtimeByPaneId: {
          one: { backendState: 'active' },
          two: { backendState: 'active' },
          three: { backendState: 'active' },
        },
      }),
    );

    expect(result).toMatchObject({
      kind: 'ready',
      currentTotal: 3,
      requestedSlots: 0,
      assignments: [],
    });
    expect(leaves).toEqual(before);
  });

  it('stops at the pane cap and reports unfilled slots without touching occupied leaves', () => {
    const leaves = Array.from({ length: 9 }, (_, index) =>
      leaf(`busy-${index}`, { sessionId: `pty-${index}`, name: `keep-${index}` }),
    );
    const before = structuredClone(leaves);
    const runtimeByPaneId = Object.fromEntries(
      leaves.map((item) => [item.id, { backendState: 'active' as const }]),
    );
    const result = planTerminalFleet(
      input({
        targetTotal: 15,
        leaves,
        runtimeByPaneId,
        maxPanes: 10,
      }),
    );

    expect(result).toMatchObject({
      kind: 'ready',
      currentTotal: 9,
      requestedSlots: 6,
      appendedCount: 1,
      skippedCount: 5,
      capacityLimited: true,
    });
    expect(leaves).toEqual(before);
  });

  it('returns a typed unavailable result when the selected preset is missing', () => {
    expect(
      planTerminalFleet(input({ availableExecutables: new Set(['codex']) })),
    ).toEqual({
      kind: 'unavailable',
      presetId: 'claude',
      executable: 'claude',
      reason: 'executable-missing',
    });
  });

  it('accepts a bounded custom command and rejects control or shell injection', () => {
    expect(validateTerminalFleetCustomCommand('aider --model sonnet')).toEqual({
      ok: true,
      command: 'aider --model sonnet',
    });

    for (const command of [
      '',
      'aider\nwhoami',
      'aider\0--model x',
      'aider; whoami',
      'aider && whoami',
      'aider | whoami',
      'aider > secrets.txt',
      'aider `whoami`',
      'aider $(whoami)',
    ]) {
      expect(validateTerminalFleetCustomCommand(command)).toMatchObject({ ok: false });
    }
  });

  it('plans custom launches without requiring or mutating preset detection state', () => {
    const availableExecutables = new Set<string>();
    const result = planTerminalFleet(
      input({
        targetTotal: 3,
        selection: { kind: 'custom', command: 'aider --model sonnet' },
        availableExecutables,
      }),
    );

    expect(result).toMatchObject({ kind: 'ready', requestedSlots: 1 });
    if (result.kind !== 'ready') throw new Error('expected a ready plan');
    expect(result.assignments[0]).toMatchObject({ command: 'aider --model sonnet' });
    expect(availableExecutables.size).toBe(0);
  });
});
