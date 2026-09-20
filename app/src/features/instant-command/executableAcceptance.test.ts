import { describe, expect, it, vi } from 'vitest';
import {
  executeNavigationCommand,
  type NavigationAuthorityPort,
} from './authorities/navigationCommands';
import { executeScheduleCommand } from './authorities/scheduleCommands';
import {
  executeTerminalCommand,
  type TerminalCommandAuthorityPort,
} from './authorities/terminalCommands';
import { INSTANT_COMMAND_INDEX } from './catalog';
import { InstantCommandLedger } from './commandLedger';
import { executeInstantCommandWithReceipt, type InstantCommandDependencies } from './execute';
import { parseInstantCommand } from './parse';
import type { InstantCommand, LiveTerminalTarget } from './types';

const opencodeTarget: LiveTerminalTarget = {
  paneId: 'pane-opencode',
  sessionId: 'session-opencode',
  projectId: 'project-a',
  ordinal: 1,
  provider: 'opencode',
  label: 'OpenCode',
  processIdentity: {
    projectId: 'project-a',
    processInstanceId: 'process-opencode',
    pid: 4242,
    processStartedAt: 1_788_000_000_000,
    runtimeGeneration: 'runtime-opencode-1',
  },
};

function commandDependencies() {
  const enqueueBatch = vi.fn(() => ['queued-command-1']);
  const routeToTerminal = vi.fn();
  const deps: InstantCommandDependencies = {
    executeLegacy: vi.fn(async () => ({ ok: true, message: 'Legacy command completed.' })),
    enqueueBatch,
    routeToTerminal,
    openModelPicker: vi.fn(),
    readTargets: vi.fn(async () => [opencodeTarget]),
    executeNavigation: vi.fn(async () => ({
      ok: true as const,
      code: 'opened' as const,
      message: 'Opened.',
    })),
    openFabricSetup: vi.fn(),
    isFabricReady: vi.fn(async () => false),
    executeFabric: vi.fn(async () => ({
      ok: false as const,
      code: 'queue_failed' as const,
      message: 'Fabric unavailable.',
    })),
  };
  return { deps, enqueueBatch, routeToTerminal };
}

function parsed(source: string): InstantCommand {
  const command = parseInstantCommand(source);
  expect(command).not.toBeNull();
  return command!;
}

async function withinReceiptBudget<T>(task: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await task();
  expect(performance.now() - startedAt).toBeLessThanOrEqual(500);
  return result;
}

function context(correlationId: string) {
  return {
    correlationId,
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
  } as const;
}

function navigationPort(): NavigationAuthorityPort {
  return {
    openRoute: vi.fn(),
    hasSelectedAgent: vi.fn(() => false),
    hasSelectedProject: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    openPalette: vi.fn(),
    openLauncher: vi.fn(),
    setFullscreen: vi.fn(async (enabled) => enabled),
  };
}

describe('executable Instant Command acceptance matrix', () => {
  it.each([
    ['open-codex', 'open Codex', 'codex'],
    ['open-opencode', 'open OpenCode', 'opencode'],
  ] as const)(
    '%s queues the exact registered CLI with a truthful receipt',
    async (_, source, provider) => {
      const h = commandDependencies();
      const receipt = await withinReceiptBudget(() =>
        executeInstantCommandWithReceipt(
          parsed(source),
          context(`accept-${provider}`),
          h.deps,
          new InstantCommandLedger(),
        ),
      );

      expect(receipt).toMatchObject({ commandId: 'terminal.open', status: 'queued' });
      expect(h.enqueueBatch).toHaveBeenCalledWith([
        { command: provider, label: provider, target: 'new' },
      ]);
      expect(h.routeToTerminal).toHaveBeenCalledOnce();
    },
  );

  it('message-opencode-exactly-once replays one truthful receipt without a second enqueue', async () => {
    const h = commandDependencies();
    const ledger = new InstantCommandLedger();
    const command = parsed('tell OpenCode to Review API.ts');
    const executionContext = context('accept-opencode-message');
    const first = await withinReceiptBudget(() =>
      executeInstantCommandWithReceipt(command, executionContext, h.deps, ledger),
    );
    const replay = await withinReceiptBudget(() =>
      executeInstantCommandWithReceipt(command, executionContext, h.deps, ledger),
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ commandId: 'agent.message', status: 'queued' });
    expect(JSON.stringify(first)).not.toContain('Review API.ts');
    expect(h.enqueueBatch).toHaveBeenCalledOnce();
    expect(h.enqueueBatch).toHaveBeenCalledWith([
      {
        command: 'Review API.ts',
        target: 'refs',
        refs: [
          expect.objectContaining({
            paneId: 'pane-opencode',
            sessionId: 'session-opencode',
            projectId: 'project-a',
            command: 'opencode',
          }),
        ],
      },
    ]);
  });

  it('connect-providers-securely opens the existing Connections chooser', async () => {
    const source = '/connect';
    const match = INSTANT_COMMAND_INDEX.matchWithOffsets(source)[0]!;
    const slots = match.definition.parseSlots(match, source);
    expect(slots).toEqual({ status: 'parsed', slots: { section: 'connections' } });
    const port = navigationPort();
    const result = await withinReceiptBudget(() =>
      executeNavigationCommand(
        { id: match.definition.id, slots: slots.status === 'parsed' ? slots.slots : {} },
        port,
      ),
    );

    expect(result).toEqual({ ok: true, code: 'opened', message: 'Opened provider connections.' });
    expect(port.openSettings).toHaveBeenCalledWith('connections');
    expect(JSON.stringify(result)).not.toMatch(/api[_ -]?key|password|bearer/iu);
  });

  it('terminal-list reads the verified target snapshot without dispatch', async () => {
    const port: TerminalCommandAuthorityPort = {
      readTargets: vi.fn(async () => [opencodeTarget]),
      consumeConfirmation: vi.fn(async () => false),
      dispatch: vi.fn(async () => ({
        ok: true as const,
        code: 'queued' as const,
        message: 'Queued.',
      })),
    };
    const result = await withinReceiptBudget(() =>
      executeTerminalCommand({ id: 'terminal.list', slots: {} }, port),
    );

    expect(result).toMatchObject({ ok: true, code: 'opened' });
    expect(result.message).toBe('1 terminal is available.');
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it('schedule-list reads the canonical schedule repository without mutation', async () => {
    const port = {
      list: vi.fn(async () => [{ id: 'schedule-1', name: 'Release Audit', revision: 1 }]),
      open: vi.fn(async () => undefined),
      mutate: vi.fn(async () => undefined),
      runNow: vi.fn(async () => ({
        before: { recurrenceAnchor: '2026-09-01T09:00:00Z', occurrenceCount: 1 },
        after: { recurrenceAnchor: '2026-09-01T09:00:00Z', occurrenceCount: 1 },
      })),
    };
    const result = await withinReceiptBudget(() =>
      executeScheduleCommand({ id: 'schedule.list' }, port),
    );

    expect(result).toEqual({ ok: true, code: 'opened', message: '1 schedules.' });
    expect(port.mutate).not.toHaveBeenCalled();
    expect(port.runNow).not.toHaveBeenCalled();
  });
});
