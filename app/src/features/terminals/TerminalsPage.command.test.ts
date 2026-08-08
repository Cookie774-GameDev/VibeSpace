import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTerminalCommandBatch,
  canClaimCanonicalTerminalCommand,
  commandForAgent,
  summarizeTerminalResetCancellations,
} from './TerminalsPage';
import { appendLeaf, flattenLeaves, MAX_PANES, newLeaf } from './paneTree';
import {
  claimTerminalCommands,
  enqueueCanonicalTerminalCommand,
  resetTerminalCommandQueueDurabilityForTests,
  useTerminalCommandQueue,
} from './terminalCommandQueue';

vi.mock('./TileGrid', () => ({
  TileGrid: () => null,
}));

describe('commandForAgent', () => {
  beforeEach(() => {
    useTerminalCommandQueue.getState().clear();
    resetTerminalCommandQueueDurabilityForTests();
  });
  it('prefills CLIs for terminal agents that need instruction-file loading at startup', () => {
    expect(commandForAgent('coder')).toBe('claude');
    expect(commandForAgent('builder')).toBe('claude');
    expect(commandForAgent('scout')).toBe('opencode');
    expect(commandForAgent('reviewer')).toBe('opencode');
    expect(commandForAgent('critic')).toBe('opencode');
  });

  it('leaves general Jarvis panes on the user shell', () => {
    expect(commandForAgent('jarvis')).toBeUndefined();
  });

  it('preserves the claimed canonical execution identity in the spawned pane', () => {
    const next = applyTerminalCommandBatch(newLeaf(), [
      {
        kind: 'shell',
        id: 'jterm_1',
        command: 'powershell',
        canonical: {
          accountId: 'account-a',
          runId: 'jrun_1',
          executionId: 'jterm_1',
          ownerId: 'approval:jappr_1',
          cancellationToken: 'jcancel_native_1',
        },
      },
    ]);

    expect(flattenLeaves(next).find((leaf) => leaf.executionId === 'jterm_1')).toMatchObject({
      startupCommand: 'powershell',
      executionId: 'jterm_1',
    });
  });

  it('preserves ordered startup writes and the native preserve-existing boundary', () => {
    const next = applyTerminalCommandBatch(newLeaf(), [
      {
        kind: 'shell',
        id: 'terminal_open_tool_1',
        command: 'opencode',
        startupCommands: [
          "Set-Location -LiteralPath 'C:\\Work Tree'",
          'opencode',
          'Inspect the tests.',
        ],
        preserveExisting: true,
        cwd: 'C:\\Work Tree',
      },
    ]);

    expect(flattenLeaves(next).find((leaf) => leaf.executionId === 'terminal_open_tool_1')).toMatchObject({
      startupCommand: 'opencode',
      startupCommands: [
        "Set-Location -LiteralPath 'C:\\Work Tree'",
        'opencode',
        'Inspect the tests.',
      ],
      preserveExisting: true,
      cwd: 'C:\\Work Tree',
    });
  });

  it('does not present null or revoked reset authority as committed cancellation', () => {
    expect(
      summarizeTerminalResetCancellations([
        null,
        { kind: 'authority_revoked_before_intent' },
        { kind: 'already_terminal', terminalStatus: 'completed' },
        {
          kind: 'intent_committed',
          requestState: 'new',
          authorityState: 'current',
          cancellationRequestId: 'jcancel_1',
          aggregate: { kind: 'handoff_pending', ownerIds: ['terminal:jterm_1'] },
        },
      ]),
    ).toEqual({ pending: 1, terminal: 1, rejected: 2 });
  });

  it('leaves a canonical command unclaimed when the pane grid is saturated', () => {
    let tree = newLeaf();
    for (let index = 1; index < MAX_PANES; index += 1) {
      tree = appendLeaf(tree, { name: `pane-${index}` });
    }
    const canonical = {
      kind: 'shell' as const,
      id: 'jterm_full',
      command: 'powershell',
      canonical: {
        accountId: 'account-a',
        runId: 'jrun_1',
        executionId: 'jterm_full',
        ownerId: 'approval:jappr_1',
        cancellationToken: 'jcancel_native_full',
      },
    };

    expect(canClaimCanonicalTerminalCommand(tree, [], canonical)).toBe(false);
    expect(
      canClaimCanonicalTerminalCommand(
        tree,
        [{ kind: 'close', id: 'close_1', count: 1 }],
        canonical,
      ),
    ).toBe(true);
  });

  it('preserves a saturated canonical queue owner instead of starting an unattached run', async () => {
    let tree = newLeaf();
    for (let index = 1; index < MAX_PANES; index += 1) {
      tree = appendLeaf(tree, { name: `pane-${index}` });
    }
    enqueueCanonicalTerminalCommand({
      accountId: 'account-a',
      runId: 'jrun_1',
      executionId: 'jterm_full',
      ownerId: 'approval:jappr_1',
      cancellationToken: 'jcancel_native_full',
      command: 'powershell',
    });
    const claimController = vi.fn(async () => true);

    await expect(
      claimTerminalCommands(async (item, priorClaimedItems) => {
        if (!canClaimCanonicalTerminalCommand(tree, priorClaimedItems, item)) return false;
        return claimController();
      }),
    ).resolves.toEqual([]);

    expect(claimController).not.toHaveBeenCalled();
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(1);
    expect(useTerminalCommandQueue.getState().queue[0]?.id).toBe('jterm_full');
  });
});
