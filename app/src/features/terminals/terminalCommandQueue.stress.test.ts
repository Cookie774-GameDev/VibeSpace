import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastTerminalCommand,
  claimTerminalCommands,
  enqueueCanonicalTerminalCommand,
  enqueueTerminalClose,
  enqueueTerminalCommand,
  jarvisTerminalCommandQueueAuthority,
  readTerminalCommandQueueDurableStateForTests,
  resetTerminalCommandQueueDurabilityForTests,
  useTerminalCommandQueue,
} from './terminalCommandQueue';
import {
  appendLeaf,
  closePane,
  countLeaves,
  flattenLeaves,
  newLeaf,
  MAX_PANES,
  type PaneNode,
} from './paneTree';

/**
 * Stress-level coverage for the queue -> pane-tree pipeline that
 * `terminal.orchestrate` and the bulk actions drive: 10-pane batches,
 * close-all, interleaved order, and repeated churn must stay stable and
 * bounded with no leftover queue state.
 */
describe('terminal command queue stress', () => {
  beforeEach(() => {
    useTerminalCommandQueue.getState().clear();
    resetTerminalCommandQueueDurabilityForTests();
  });

  it('drains a 10-pane orchestration batch in exact arrival order', () => {
    enqueueTerminalClose(10);
    for (let i = 0; i < 5; i++) {
      enqueueTerminalCommand({
        command: 'claude',
        label: `code-agent ${i + 1}`,
        agentSlug: 'code-agent',
      });
    }
    for (let i = 0; i < 5; i++) {
      enqueueTerminalCommand({
        command: 'claude',
        label: `code-reviewer ${i + 1}`,
        agentSlug: 'code-reviewer',
      });
    }

    const items = useTerminalCommandQueue.getState().drain();
    expect(items).toHaveLength(11);
    expect(items[0]).toMatchObject({ kind: 'close', count: 10 });
    expect(
      items.slice(1, 6).every((item) => item.kind === 'shell' && item.agentSlug === 'code-agent'),
    ).toBe(true);
    expect(
      items.slice(6).every((item) => item.kind === 'shell' && item.agentSlug === 'code-reviewer'),
    ).toBe(true);
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(0);
    // Second drain is idempotent - nothing double-executes.
    expect(useTerminalCommandQueue.getState().drain()).toHaveLength(0);
  });

  it('applies the drained batch to the pane tree without exceeding MAX_PANES', () => {
    // Simulate the TerminalsPage drain loop against a full 10-pane tree.
    let tree: PaneNode = newLeaf({ agentSlug: 'old-1' });
    for (let i = 2; i <= MAX_PANES; i++) {
      tree = appendLeaf(tree, { agentSlug: `old-${i}` });
    }
    expect(countLeaves(tree)).toBe(MAX_PANES);

    // Close all 10. A pane tree can never be empty, so the drain marks the
    // leftover root for replacement by the first opened pane (mirrors the
    // TerminalsPage `replaceRootNext` behavior).
    const leaves = flattenLeaves(tree);
    for (const leaf of leaves.slice(-10)) {
      const closed = closePane(tree, leaf.id);
      if (closed) tree = closed;
    }
    let replaceRootNext = true;
    expect(countLeaves(tree)).toBe(1);

    // Open the new 5 + 5 role batch.
    const openRole = (agentSlug: string) => {
      const seed = { agentSlug, startupCommand: 'claude' };
      if (replaceRootNext && countLeaves(tree) === 1) {
        tree = newLeaf(seed);
        replaceRootNext = false;
      } else {
        tree = appendLeaf(tree, seed);
      }
    };
    for (let i = 0; i < 5; i++) openRole('code-agent');
    for (let i = 0; i < 5; i++) openRole('code-reviewer');

    const finalLeaves = flattenLeaves(tree);
    expect(finalLeaves).toHaveLength(MAX_PANES);
    expect(finalLeaves.filter((leaf) => leaf.agentSlug === 'code-agent')).toHaveLength(5);
    expect(finalLeaves.filter((leaf) => leaf.agentSlug === 'code-reviewer')).toHaveLength(5);
    expect(finalLeaves.every((leaf) => leaf.startupCommand === 'claude')).toBe(true);
  });

  it('survives repeated open/close churn without queue growth or id collisions', () => {
    const seenIds = new Set<string>();
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 10; i++) {
        seenIds.add(enqueueTerminalCommand({ command: '', label: `t${i}` }));
      }
      seenIds.add(enqueueTerminalClose(10));
      const drained = useTerminalCommandQueue.getState().drain();
      expect(drained).toHaveLength(11);
    }
    // 50 rounds × 11 ids - all unique, queue empty at the end.
    expect(seenIds.size).toBe(550);
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(0);
  });

  it('clamps close counts and keeps broadcasts targeted at all panes', () => {
    enqueueTerminalClose(999);
    enqueueTerminalClose(-5);
    broadcastTerminalCommand({ command: 'echo hi' });

    const items = useTerminalCommandQueue.getState().drain();
    expect(items[0]).toMatchObject({ kind: 'close', count: 10 });
    expect(items[1]).toMatchObject({ kind: 'close', count: 1 });
    expect(items[2]).toMatchObject({ kind: 'shell', target: 'all', command: 'echo hi' });
  });

  it('cancels an exact queued command without touching neighboring work', () => {
    const first = enqueueTerminalCommand({ command: 'echo first' });
    const second = enqueueTerminalCommand({ command: 'echo second' });
    expect(useTerminalCommandQueue.getState().cancel(first)).toBe(true);
    expect(useTerminalCommandQueue.getState().cancel(first)).toBe(false);
    expect(
      useTerminalCommandQueue
        .getState()
        .drain()
        .map((item) => item.id),
    ).toEqual([second]);
  });

  it('keeps ordered startup commands and preserve-existing intent intact through a drain', () => {
    enqueueTerminalCommand({
      command: 'codex',
      startupCommands: ["Set-Location -LiteralPath 'C:\\Repo'", 'codex', 'Review this PR.'],
      preserveExisting: true,
      cwd: 'C:\\Repo',
    });

    expect(useTerminalCommandQueue.getState().drain()[0]).toMatchObject({
      kind: 'shell',
      command: 'codex',
      startupCommands: ["Set-Location -LiteralPath 'C:\\Repo'", 'codex', 'Review this PR.'],
      preserveExisting: true,
    });
  });

  it('claims a canonical item only after its ownership handoff succeeds', async () => {
    enqueueCanonicalTerminalCommand({
      accountId: 'account-a',
      runId: 'jrun_1',
      executionId: 'jterm_1',
      ownerId: 'approval:jappr_1',
      cancellationToken: 'jcancel_native_1',
      command: 'powershell',
    });

    const rejected = await claimTerminalCommands(async () => false);
    expect(rejected).toEqual([]);
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(1);

    const claimed = await claimTerminalCommands(async (item) => {
      expect(item).toMatchObject({
        id: 'jterm_1',
        kind: 'shell',
        canonical: {
          accountId: 'account-a',
          runId: 'jrun_1',
          executionId: 'jterm_1',
          cancellationToken: 'jcancel_native_1',
        },
      });
      return true;
    });

    expect(claimed.map((item) => item.id)).toEqual(['jterm_1']);
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(0);
  });

  it('serializes cancellation tombstoning against claim and restores the exact item', async () => {
    enqueueCanonicalTerminalCommand({
      accountId: 'account-a',
      runId: 'jrun_1',
      executionId: 'jterm_1',
      ownerId: 'approval:jappr_1',
      cancellationToken: 'jcancel_native_1',
      command: 'powershell',
    });
    const identity = {
      accountId: 'account-a',
      runId: 'jrun_1',
      queueItemId: 'jterm_1',
      executionId: 'jterm_1',
      ownerId: 'terminal:jterm_1',
    } as const;
    const tombstone = {
      schemaVersion: 1,
      kind: 'cancellation_tombstone',
      runnable: false,
      accountId: 'account-a',
      runId: 'jrun_1',
      queueItemId: 'jterm_1',
      executionId: 'jterm_1',
    } as const;

    await jarvisTerminalCommandQueueAuthority.withExclusiveItemLock(identity, async () => {
      await expect(
        jarvisTerminalCommandQueueAuthority.replaceExactRunnableWithTombstone({
          identity,
          tombstone,
        }),
      ).resolves.toEqual({ applied: true, tombstone });
    });
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(1);
    const blockedClaim = vi.fn(async () => true);
    await expect(claimTerminalCommands(blockedClaim)).resolves.toEqual([]);
    expect(blockedClaim).not.toHaveBeenCalled();
    await jarvisTerminalCommandQueueAuthority.withExclusiveItemLock(identity, async () => {
      await expect(
        jarvisTerminalCommandQueueAuthority.restoreExactRunnable(tombstone),
      ).resolves.toBe(true);
    });

    expect(useTerminalCommandQueue.getState().queue).toHaveLength(1);
    expect(useTerminalCommandQueue.getState().queue[0]?.id).toBe('jterm_1');
  });

  it('keeps later work behind an in-place tombstone until exact rollback completes', async () => {
    for (const executionId of ['jterm_1', 'jterm_2']) {
      enqueueCanonicalTerminalCommand({
        accountId: 'account-a',
        runId: 'jrun_1',
        executionId,
        ownerId: `approval:${executionId}`,
        cancellationToken: `jcancel_native_${executionId}`,
        command: 'powershell',
      });
    }
    const identity = {
      accountId: 'account-a',
      runId: 'jrun_1',
      queueItemId: 'jterm_1',
      executionId: 'jterm_1',
      ownerId: 'terminal:jterm_1',
    } as const;
    const tombstone = {
      schemaVersion: 1,
      kind: 'cancellation_tombstone',
      runnable: false,
      accountId: 'account-a',
      runId: 'jrun_1',
      queueItemId: 'jterm_1',
      executionId: 'jterm_1',
    } as const;

    await jarvisTerminalCommandQueueAuthority.replaceExactRunnableWithTombstone({
      identity,
      tombstone,
    });
    const claim = vi.fn(async () => true);
    await expect(claimTerminalCommands(claim)).resolves.toEqual([]);
    expect(claim).not.toHaveBeenCalled();

    await jarvisTerminalCommandQueueAuthority.restoreExactRunnable(tombstone);
    await expect(claimTerminalCommands(claim)).resolves.toEqual([
      expect.objectContaining({ id: 'jterm_1' }),
      expect.objectContaining({ id: 'jterm_2' }),
    ]);
  });

  it('commits a durable tombstone before queued cancellation CAS and preserves it across clear', async () => {
    enqueueCanonicalTerminalCommand({
      accountId: 'account-a',
      runId: 'jrun_1',
      executionId: 'jterm_1',
      ownerId: 'approval:jappr_1',
      cancellationToken: 'jcancel_native_1',
      command: 'powershell',
    });
    const identity = {
      accountId: 'account-a',
      runId: 'jrun_1',
      queueItemId: 'jterm_1',
      executionId: 'jterm_1',
      ownerId: 'terminal:jterm_1',
    } as const;
    const tombstone = {
      schemaVersion: 1,
      kind: 'cancellation_tombstone',
      runnable: false,
      accountId: 'account-a',
      runId: 'jrun_1',
      queueItemId: 'jterm_1',
      executionId: 'jterm_1',
    } as const;

    await expect(
      jarvisTerminalCommandQueueAuthority.withExclusiveItemLock(identity, () =>
        jarvisTerminalCommandQueueAuthority.replaceExactRunnableWithTombstone({
          identity,
          tombstone,
        }),
      ),
    ).resolves.toEqual({ applied: true, tombstone });
    const durable = readTerminalCommandQueueDurableStateForTests('account-a', 'jterm_1');
    expect(durable).toMatchObject({
      state: 'tombstone',
      runnable: false,
    });
    expect(JSON.stringify(durable)).not.toContain('powershell');
    expect(JSON.stringify(durable)).not.toContain('jcancel_native_1');

    useTerminalCommandQueue.getState().clear();

    expect(readTerminalCommandQueueDurableStateForTests('account-a', 'jterm_1')).toMatchObject({
      state: 'tombstone',
    });
    expect(() =>
      enqueueCanonicalTerminalCommand({
        accountId: 'account-a',
        runId: 'jrun_1',
        executionId: 'jterm_1',
        ownerId: 'approval:jappr_1',
        cancellationToken: 'jcancel_native_1',
        command: 'powershell',
      }),
    ).toThrow(/already owned/i);
  });
});
