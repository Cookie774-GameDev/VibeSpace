import { describe, expect, it, vi } from 'vitest';
import type { LiveTerminalTarget } from '../types';
import { executeTerminalCommand, type TerminalCommandAuthorityPort } from './terminalCommands';

const target: LiveTerminalTarget = {
  paneId: 'pane_2',
  sessionId: 'sess_2',
  ordinal: 2,
  provider: 'codex',
  label: 'Reviewer',
  projectId: 'proj',
  processIdentity: {
    projectId: 'proj',
    processInstanceId: 'proc_2',
    pid: 202,
    processStartedAt: 20,
    runtimeGeneration: 'generation_3',
  },
};

function authority(): TerminalCommandAuthorityPort {
  return {
    readTargets: vi.fn(async () => [target]),
    consumeConfirmation: vi.fn(async () => true),
    dispatch: vi.fn(async () => ({
      ok: true as const,
      code: 'queued' as const,
      message: 'Queued.',
    })),
  };
}

describe('executeTerminalCommand', () => {
  it('returns status from the verified live snapshot without dispatching a side effect', async () => {
    const port = authority();
    await expect(
      executeTerminalCommand({ id: 'terminal.status', slots: { selector: { ordinal: 2 } } }, port),
    ).resolves.toEqual({
      ok: true,
      code: 'opened',
      message: 'Terminal 2 is available (Codex, pane pane_2, session sess_2).',
    });
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed on ambiguous targets and active prompt interlocks', async () => {
    const port = authority();
    vi.mocked(port.readTargets).mockResolvedValue([
      target,
      { ...target, paneId: 'pane_3', sessionId: 'sess_3', ordinal: 3 },
    ]);
    await expect(
      executeTerminalCommand(
        { id: 'agent.status', slots: { selector: { provider: 'codex' } } },
        port,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'target_ambiguous' });

    await expect(
      executeTerminalCommand(
        {
          id: 'agent.message',
          slots: { selector: { ordinal: 2 }, payload: 'continue' },
          promptState: 'approval',
        },
        authority(),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'target_not_ready' });
  });

  it('requires a bound confirmation before destructive lifecycle dispatch', async () => {
    const port = authority();
    await expect(
      executeTerminalCommand({ id: 'terminal.close', slots: { selector: { ordinal: 2 } } }, port),
    ).resolves.toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it('consumes an exact nonce-bound lifecycle confirmation once', async () => {
    const port = authority();
    vi.mocked(port.consumeConfirmation!).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const request = {
      id: 'terminal.close',
      slots: { selector: { ordinal: 2 } },
      confirmation: { commandId: 'terminal.close', targetId: 'sess_2', nonce: 'close_once' },
    };

    await expect(executeTerminalCommand(request, port)).resolves.toMatchObject({ ok: true });
    await expect(executeTerminalCommand(request, port)).resolves.toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'That terminal confirmation is expired or already used.',
    });
    expect(port.dispatch).toHaveBeenCalledOnce();
  });

  it('fails closed when confirmation consumption crosses the deadline', async () => {
    const port = authority();
    const deadline = new AbortController();
    vi.mocked(port.consumeConfirmation!).mockImplementationOnce(async () => {
      deadline.abort();
      return true;
    });

    await expect(
      executeTerminalCommand(
        {
          id: 'terminal.stop',
          slots: { selector: { ordinal: 2 } },
          confirmation: { commandId: 'terminal.stop', targetId: 'sess_2', nonce: 'stop_once' },
        },
        port,
        deadline.signal,
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'The instant command deadline elapsed.',
    });
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it('redacts snapshot and dispatch authority exceptions', async () => {
    const port = authority();
    vi.mocked(port.readTargets).mockRejectedValueOnce(new Error('private snapshot detail'));
    const snapshotFailure = await executeTerminalCommand({ id: 'terminal.list', slots: {} }, port);
    expect(snapshotFailure).toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Terminal command failed.',
    });
    expect(JSON.stringify(snapshotFailure)).not.toContain('private snapshot detail');

    vi.mocked(port.dispatch).mockRejectedValueOnce(new Error('private dispatch detail'));
    const dispatchFailure = await executeTerminalCommand(
      { id: 'terminal.clear', slots: { selector: { ordinal: 2 } } },
      port,
    );
    expect(dispatchFailure).toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Terminal command failed.',
    });
    expect(JSON.stringify(dispatchFailure)).not.toContain('private dispatch detail');
  });

  it.each([
    'terminal.destroy',
    'terminal.open\u0000',
    `terminal.${'x'.repeat(100)}`,
    'terminal.run_saved_command',
  ])(
    'rejects an unknown or malformed command before reading targets: %s',
    async (id) => {
      const port = authority();
      await expect(
        executeTerminalCommand({ id, slots: { selector: { ordinal: 2 } } }, port),
      ).resolves.toEqual({
        ok: false,
        code: 'queue_failed',
        message: 'Unknown terminal command.',
      });
      expect(port.readTargets).not.toHaveBeenCalled();
      expect(port.dispatch).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown prompt states before reading or dispatching', async () => {
    const port = authority();
    await expect(
      executeTerminalCommand(
        {
          id: 'agent.message',
          slots: { selector: { ordinal: 2 }, payload: 'continue' },
          promptState: 'idle' as never,
        },
        port,
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'target_not_ready',
      message: 'Terminal prompt state is unavailable.',
    });
    expect(port.readTargets).not.toHaveBeenCalled();
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [target, { ...target, paneId: 'pane_3', ordinal: 3 }],
    [target, { ...target, sessionId: 'sess_3', ordinal: 3 }],
    [{ ...target, sessionId: '', ordinal: 2 }],
    Array.from({ length: 1_025 }, (_, index) => ({
      ...target,
      sessionId: `sess_${index}`,
      paneId: `pane_${index}`,
      ordinal: index + 1,
    })),
  ])('fails closed on corrupt or unbounded live-target snapshots', async (...targets) => {
    const port = authority();
    vi.mocked(port.readTargets).mockResolvedValueOnce(targets.flat() as LiveTerminalTarget[]);

    await expect(executeTerminalCommand({ id: 'terminal.list', slots: {} }, port)).resolves.toEqual(
      {
        ok: false,
        code: 'queue_failed',
        message: 'Terminal snapshot is unavailable.',
      },
    );
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it('classifies a malformed runtime confirmation as confirmation-required', async () => {
    const port = authority();
    await expect(
      executeTerminalCommand(
        {
          id: 'terminal.close',
          slots: { selector: { ordinal: 2 } },
          confirmation: {
            commandId: 'terminal.close',
            targetId: 'sess_2',
            nonce: 42 as unknown as string,
          },
        },
        port,
      ),
    ).resolves.toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'Confirm this exact terminal action before it runs.',
    });
    expect(port.consumeConfirmation).not.toHaveBeenCalled();
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, code: 'queue_failed', message: 'Contradictory.' },
    { ok: false, code: 'queued', message: 'Contradictory.' },
    { ok: true, code: 'invented', message: 'Invented.' },
    { ok: true, code: 'queued', message: '' },
    { ok: true, code: 'queued', message: 'bad\u0000receipt' },
  ])('does not project malformed dispatch receipts: $code', async (receipt) => {
    const port = authority();
    vi.mocked(port.dispatch).mockResolvedValueOnce(receipt as never);

    await expect(
      executeTerminalCommand({ id: 'terminal.clear', slots: { selector: { ordinal: 2 } } }, port),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Terminal authority receipt is unavailable.',
    });
  });
});
