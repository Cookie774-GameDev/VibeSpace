import { describe, expect, it, vi } from 'vitest';
import type { InstantCommand, LiveTerminalTarget } from './types';
import { InstantCommandLedger } from './commandLedger';
import {
  executeInstantCommand,
  executeInstantCommandWithReceipt,
  type InstantCommandDependencies,
} from './execute';

const codex: LiveTerminalTarget = {
  sessionId: 'tty-codex',
  paneId: 'pane-codex',
  projectId: 'project-a',
  ordinal: 1,
  provider: 'codex',
  label: 'Codex',
  processIdentity: {
    projectId: 'project-a',
    processInstanceId: 'process-codex',
    pid: 4242,
    processStartedAt: 1_723_456_789_000,
    runtimeGeneration: 'runtime-a',
  },
};

function dependencies(targets: LiveTerminalTarget[] = [codex]) {
  const executeLegacy = vi.fn(async () => ({ ok: true, message: 'legacy ok' }));
  const enqueueBatch = vi.fn<InstantCommandDependencies['enqueueBatch']>(() => ['jterm_1']);
  const routeToTerminal = vi.fn();
  const openModelPicker = vi.fn();
  const readTargets = vi.fn(async () => targets);
  const executeNavigation = vi.fn(async () => ({
    ok: true as const,
    code: 'opened' as const,
    message: 'Opened terminal.',
  }));
  const openFabricSetup = vi.fn();
  const isFabricReady = vi.fn(async () => true);
  const executeFabric = vi.fn(async () => ({
    ok: true as const,
    code: 'opened' as const,
    message: 'Team status completed.',
  }));
  const deps: InstantCommandDependencies = {
    executeLegacy,
    enqueueBatch,
    routeToTerminal,
    openModelPicker,
    readTargets,
    executeNavigation,
    openFabricSetup,
    isFabricReady,
    executeFabric,
  };
  return {
    deps,
    executeLegacy,
    enqueueBatch,
    routeToTerminal,
    openModelPicker,
    readTargets,
    executeNavigation,
    openFabricSetup,
    isFabricReady,
    executeFabric,
  };
}

describe('executeInstantCommand', () => {
  it('delegates legacy commands unchanged', async () => {
    const h = dependencies();
    const command: InstantCommand = { kind: 'legacy', intent: { kind: 'open_schedule' } };
    await expect(executeInstantCommand(command, h.deps)).resolves.toEqual({
      ok: true,
      code: 'legacy',
      message: 'legacy ok',
    });
    expect(h.executeLegacy).toHaveBeenCalledWith(command.intent);
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('opens a bounded CLI through the existing new-terminal queue', async () => {
    const h = dependencies();
    await expect(
      executeInstantCommand({ kind: 'open-agent-cli', provider: 'codex', count: 2 }, h.deps),
    ).resolves.toMatchObject({ ok: true, code: 'queued' });
    expect(h.enqueueBatch).toHaveBeenCalledWith([
      { command: 'codex', label: 'codex', target: 'new' },
      { command: 'codex', label: 'codex', target: 'new' },
    ]);
    expect(h.routeToTerminal).toHaveBeenCalledOnce();
  });

  it('uses the registered executable rather than inventing a CLI command', async () => {
    const h = dependencies();
    await expect(
      executeInstantCommand({ kind: 'open-agent-cli', provider: 'kiro', count: 1 }, h.deps),
    ).resolves.toMatchObject({ ok: true, code: 'queued' });
    expect(h.enqueueBatch).toHaveBeenCalledWith([
      { command: 'kiro-cli', label: 'kiro', target: 'new' },
    ]);
  });

  it('opens the existing picker without selecting a model', async () => {
    const h = dependencies();
    await expect(
      executeInstantCommand({ kind: 'open-model-picker' }, h.deps),
    ).resolves.toMatchObject({ ok: true, code: 'opened' });
    expect(h.openModelPicker).toHaveBeenCalledOnce();
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('dispatches catalog navigation through its canonical authority adapter', async () => {
    const h = dependencies();
    const command: InstantCommand = {
      kind: 'catalog',
      id: 'page.open',
      family: 'navigation',
      authority: 'ui.route',
      safety: 'read',
      slots: { route: 'terminal' },
    };
    await expect(executeInstantCommand(command, h.deps)).resolves.toEqual({
      ok: true,
      code: 'opened',
      message: 'Opened terminal.',
    });
    expect(h.executeNavigation).toHaveBeenCalledWith(
      { id: 'page.open', slots: { route: 'terminal' } },
      undefined,
    );
    expect(h.executeLegacy).not.toHaveBeenCalled();
  });

  it('dispatches typed media slots through only the canonical media authority', async () => {
    const h = dependencies();
    const executeMedia = vi.fn(async () => ({
      ok: true as const,
      code: 'opened' as const,
      message: 'Music volume is 42.',
    }));
    const signal = new AbortController().signal;
    await expect(
      executeInstantCommand(
        {
          kind: 'catalog',
          id: 'music.volume',
          family: 'media',
          authority: 'media.player',
          safety: 'reversible',
          slots: { value: 42 },
        },
        { ...h.deps, executeMedia },
        signal,
      ),
    ).resolves.toEqual({ ok: true, code: 'opened', message: 'Music volume is 42.' });
    expect(executeMedia).toHaveBeenCalledWith({ id: 'music.volume', value: 42 }, signal);
    expect(h.executeLegacy).not.toHaveBeenCalled();
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('opens Fabric setup and dispatches only the enabled read lifecycle through its authority', async () => {
    const h = dependencies();
    await expect(
      executeInstantCommand(
        {
          kind: 'catalog',
          id: 'team.connect',
          family: 'team',
          authority: 'terminal-peer-fabric',
          safety: 'approval',
          slots: {},
        },
        h.deps,
      ),
    ).resolves.toMatchObject({ ok: true, code: 'opened' });
    expect(h.openFabricSetup).toHaveBeenCalledOnce();
    expect(h.isFabricReady).toHaveBeenCalledOnce();

    const context = {
      correlationId: 'team-read-1',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    };
    await executeInstantCommand(
      {
        kind: 'catalog',
        id: 'team.list',
        family: 'team',
        authority: 'terminal-peer-fabric',
        safety: 'read',
        slots: {},
      },
      h.deps,
      undefined,
      context,
    );
    expect(h.executeFabric).toHaveBeenCalledWith({
      id: 'team.list',
      correlationId: 'team-read-1',
      accountId: 'account-a',
      targetIds: [],
    });
  });

  it.each(['team.connect', 'team.message', 'team.broadcast'] as const)(
    'fails %s closed before setup or confirmation when the bundled capability is unavailable',
    async (id) => {
      const h = dependencies();
      h.isFabricReady.mockResolvedValue(false);
      await expect(
        executeInstantCommand(
          {
            kind: 'catalog',
            id,
            family: 'team',
            authority: 'terminal-peer-fabric',
            safety: 'approval',
            slots: {},
          },
          h.deps,
        ),
      ).resolves.toMatchObject({ ok: false, code: 'queue_failed' });
      expect(h.openFabricSetup).not.toHaveBeenCalled();
      expect(h.executeFabric).not.toHaveBeenCalled();
    },
  );

  it('queues exact pane/session refs and reports queued rather than delivered', async () => {
    const h = dependencies();
    await expect(
      executeInstantCommand(
        {
          kind: 'agent-message',
          target: { provider: 'codex', scope: 'one' },
          payload: 'Audit Auth',
        },
        h.deps,
      ),
    ).resolves.toEqual({
      ok: true,
      code: 'queued',
      message: 'Queued command for 1 terminal.',
    });
    expect(h.enqueueBatch).toHaveBeenCalledWith([
      {
        command: 'Audit Auth',
        target: 'refs',
        refs: [
          {
            paneId: 'pane-codex',
            sessionId: 'tty-codex',
            projectId: 'project-a',
            label: 'Codex',
            command: 'codex',
            expectedProcess: codex.processIdentity,
          },
        ],
      },
    ]);
    expect(h.routeToTerminal).toHaveBeenCalledOnce();
  });

  it('fails closed on ambiguous or stale targets and does not queue', async () => {
    const h = dependencies([codex, { ...codex, sessionId: 'tty-2', paneId: 'pane-2', ordinal: 2 }]);
    await expect(
      executeInstantCommand(
        { kind: 'agent-message', target: { provider: 'codex' }, payload: 'audit' },
        h.deps,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'target_ambiguous' });
    expect(h.enqueueBatch).not.toHaveBeenCalled();
  });

  it('submits a multi-open request through one atomic batch authority', async () => {
    const h = dependencies();
    h.enqueueBatch.mockImplementation(() => {
      throw new Error('batch rejected before commit');
    });

    await expect(
      executeInstantCommand({ kind: 'open-agent-cli', provider: 'codex', count: 3 }, h.deps),
    ).resolves.toMatchObject({ ok: false, code: 'queue_failed' });
    expect(h.enqueueBatch).toHaveBeenCalledOnce();
    expect((h.enqueueBatch.mock.calls as unknown[][])[0]?.[0]).toHaveLength(3);
    expect(h.routeToTerminal).not.toHaveBeenCalled();
  });
});

describe('executeInstantCommandWithReceipt', () => {
  const context = {
    correlationId: 'instant-1',
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
  } as const;

  it('deduplicates the same scoped correlation before invoking authority', async () => {
    const h = dependencies();
    const ledger = new InstantCommandLedger();
    const command: InstantCommand = { kind: 'open-agent-cli', provider: 'codex', count: 1 };
    const [first, replay] = await Promise.all([
      executeInstantCommandWithReceipt(command, context, h.deps, ledger),
      executeInstantCommandWithReceipt(command, context, h.deps, ledger),
    ]);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      commandId: 'terminal.open',
      correlationId: 'instant-1',
      status: 'queued',
    });
    expect(h.enqueueBatch).toHaveBeenCalledOnce();
  });

  it('rejects correlation reuse for a different command without a second side effect', async () => {
    const h = dependencies();
    const ledger = new InstantCommandLedger();
    await executeInstantCommandWithReceipt(
      { kind: 'open-agent-cli', provider: 'codex', count: 1 },
      context,
      h.deps,
      ledger,
    );

    await expect(
      executeInstantCommandWithReceipt({ kind: 'open-model-picker' }, context, h.deps, ledger),
    ).resolves.toMatchObject({ status: 'rejected', commandId: 'model.picker.open' });
    expect(h.enqueueBatch).toHaveBeenCalledOnce();
    expect(h.openModelPicker).not.toHaveBeenCalled();
  });

  it('times out by 500 ms and prevents authority invocation after a late target snapshot', async () => {
    vi.useFakeTimers();
    try {
      const h = dependencies();
      h.readTargets.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([codex]), 700)),
      );
      const receiptPromise = executeInstantCommandWithReceipt(
        {
          kind: 'agent-message',
          target: { provider: 'codex' },
          payload: 'audit',
        },
        context,
        h.deps,
        new InstantCommandLedger(),
      );

      await vi.advanceTimersByTimeAsync(500);
      await expect(receiptPromise).resolves.toMatchObject({ status: 'timed_out' });
      await vi.advanceTimersByTimeAsync(200);
      expect(h.enqueueBatch).not.toHaveBeenCalled();
      expect(h.routeToTerminal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a compact clarification receipt for ambiguous targets', async () => {
    const h = dependencies([codex, { ...codex, sessionId: 'tty-2', paneId: 'pane-2', ordinal: 2 }]);
    const receipt = await executeInstantCommandWithReceipt(
      { kind: 'agent-message', target: { provider: 'codex' }, payload: 'audit' },
      context,
      h.deps,
      new InstantCommandLedger(),
    );

    expect(receipt).toEqual({
      commandId: 'agent.message',
      correlationId: 'instant-1',
      status: 'needs_clarification',
      acceptedAtMs: expect.any(Number),
      targetIds: [],
      followUp: {
        kind: 'clarification',
        prompt: 'More than one live terminal matches that target.',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('audit');
  });

  it('returns a truthful bounded confirmation receipt for a confirmation-gated authority', async () => {
    const h = dependencies();
    const deps: InstantCommandDependencies = {
      ...h.deps,
      executeTerminal: vi.fn(async () => ({
        ok: false as const,
        code: 'confirmation_required' as const,
        message: 'Confirm closing this exact terminal.',
      })),
    };
    const receipt = await executeInstantCommandWithReceipt(
      {
        kind: 'catalog',
        id: 'terminal.close',
        family: 'terminal',
        authority: 'terminal.lifecycle',
        safety: 'confirm',
        slots: { selector: { sessionId: 'tty-codex' } },
      },
      context,
      deps,
      new InstantCommandLedger(),
    );

    expect(receipt).toMatchObject({
      commandId: 'terminal.close',
      status: 'needs_confirmation',
      followUp: { kind: 'confirmation', prompt: 'Confirm closing this exact terminal.' },
    });
  });
});

it('reports a generic shell launch as queued, not ready, after existing legacy enqueue succeeds', async () => {
  const h = dependencies();
  const command: InstantCommand = { kind: 'legacy', intent: { kind: 'open_terminals', count: 2 } };
  const receipt = await executeInstantCommandWithReceipt(
    command,
    {
      correlationId: 'shell-two-queue-proof',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    },
    h.deps,
    new InstantCommandLedger(),
  );
  expect(h.executeLegacy).toHaveBeenCalledWith(command.intent);
  expect(receipt.status).toBe('queued');
});

it('uses valid canonical agent identifiers for every terminal in a multi-CLI batch', async () => {
  const { createTerminalContextSession } =
    await import('@/features/terminals/terminalCommandFoundation');
  const h = dependencies();
  await executeInstantCommand({ kind: 'open-agent-cli', provider: 'claude', count: 2 }, h.deps);
  const batch = h.enqueueBatch.mock.calls[0]![0];
  expect(batch).toHaveLength(2);
  for (const [index, item] of batch.entries()) {
    expect(() =>
      createTerminalContextSession({
        version: 1,
        terminalSessionId: `terminal-${index}`,
        paneId: `pane-${index}`,
        projectId: 'project-a',
        activeMapIds: [],
        pinnedEntityIds: [],
        activeSkillIds: [],
        agentSlug: item.label,
        mode: 'persistent',
        updatedAt: 1,
        contextRevision: 0,
      }),
    ).not.toThrow();
  }
});
