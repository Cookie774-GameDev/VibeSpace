import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTerminalCommandBatch,
  canClaimCanonicalTerminalCommand,
  claimCanonicalTerminalCommandForScope,
  commandForAgent,
  summarizeTerminalResetCancellations,
} from './TerminalsPage';
import { appendLeaf, flattenLeaves, MAX_PANES, newLeaf, type PaneNode } from './paneTree';
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

    expect(
      flattenLeaves(next).find((leaf) => leaf.executionId === 'terminal_open_tool_1'),
    ).toMatchObject({
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

  it('does not create a pane or mark an execution when a terminal ref is stale', () => {
    const current: PaneNode = {
      kind: 'split',
      id: 'split-isolation',
      orientation: 'h',
      ratio: 0.5,
      left: { kind: 'leaf', id: 'pane-a', sessionId: 'pty-a' },
      right: { kind: 'leaf', id: 'pane-b', sessionId: 'pty-b' },
    };
    const markExecution = vi.fn();

    const next = applyTerminalCommandBatch(
      current,
      [
        {
          kind: 'shell',
          id: 'send-stale',
          command: 'T09_TARGET_ONLY',
          target: 'refs',
          refs: [{ sessionId: 'pty-missing' }],
        },
      ],
      markExecution,
    );

    expect(next).toBe(current);
    expect(flattenLeaves(next)).toHaveLength(2);
    expect(flattenLeaves(next).every((leaf) => leaf.pendingCommand === undefined)).toBe(true);
    expect(markExecution).not.toHaveBeenCalled();
  });

  it('sends a referenced command to exactly one matching terminal', () => {
    const current: PaneNode = {
      kind: 'split',
      id: 'split-isolation',
      orientation: 'h',
      ratio: 0.5,
      left: { kind: 'leaf', id: 'pane-a', sessionId: 'pty-a' },
      right: { kind: 'leaf', id: 'pane-b', sessionId: 'pty-b' },
    };
    const markExecution = vi.fn();

    const next = applyTerminalCommandBatch(
      current,
      [
        {
          kind: 'shell',
          id: 'send-exact',
          command: 'T09_TARGET_ONLY',
          target: 'refs',
          refs: [{ sessionId: 'pty-a' }],
        },
      ],
      markExecution,
    );
    const leaves = flattenLeaves(next);

    expect(leaves).toHaveLength(2);
    expect(leaves.find((leaf) => leaf.sessionId === 'pty-a')?.pendingCommand).toBe(
      'T09_TARGET_ONLY',
    );
    expect(leaves.find((leaf) => leaf.sessionId === 'pty-b')?.pendingCommand).toBeUndefined();
    expect(markExecution).toHaveBeenCalledOnce();
    expect(markExecution).toHaveBeenCalledWith('send-exact', 'starting');
  });

  it('rejects a ref whose pane and session identities point at different terminals', () => {
    const current: PaneNode = {
      kind: 'split',
      id: 'split-isolation',
      orientation: 'h',
      ratio: 0.5,
      left: { kind: 'leaf', id: 'pane-a', sessionId: 'pty-a' },
      right: { kind: 'leaf', id: 'pane-b', sessionId: 'pty-b' },
    };
    const markExecution = vi.fn();

    const next = applyTerminalCommandBatch(
      current,
      [
        {
          kind: 'shell',
          id: 'send-conflicted',
          command: 'T09_TARGET_ONLY',
          target: 'refs',
          refs: [{ paneId: 'pane-a', sessionId: 'pty-b' }],
        },
      ],
      markExecution,
    );

    expect(next).toBe(current);
    expect(markExecution).not.toHaveBeenCalled();
    expect(flattenLeaves(next).every((leaf) => leaf.pendingCommand === undefined)).toBe(true);
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

  it('passes the exact active account workspace and tree project into canonical claim', async () => {
    const canonical = {
      kind: 'shell' as const,
      id: 'jterm_scoped',
      command: 'powershell',
      canonical: {
        accountId: 'account-a',
        runId: 'jrun_1',
        executionId: 'jterm_scoped',
        ownerId: 'approval:jappr_1',
        cancellationToken: 'jcancel_native_scoped',
      },
    };
    const claim = vi.fn(async () => true);

    await expect(
      claimCanonicalTerminalCommandForScope(
        newLeaf(),
        [],
        canonical,
        {
          accountId: 'account-a',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
        },
        claim,
      ),
    ).resolves.toBe(true);

    expect(claim).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledWith('jterm_scoped', {
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
  });

  it('does not claim or project a canonical command without a current tree scope', async () => {
    const canonical = {
      kind: 'shell' as const,
      id: 'jterm_unscoped',
      command: 'powershell',
      canonical: {
        accountId: 'account-a',
        runId: 'jrun_1',
        executionId: 'jterm_unscoped',
        ownerId: 'approval:jappr_1',
        cancellationToken: 'jcancel_native_unscoped',
      },
    };
    const claim = vi.fn(async () => true);

    await expect(
      claimCanonicalTerminalCommandForScope(newLeaf(), [], canonical, null, claim),
    ).resolves.toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });
});
