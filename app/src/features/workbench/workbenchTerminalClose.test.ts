import { describe, expect, it, vi } from 'vitest';
import { closeWorkbenchTerminalSession } from './workbenchTerminalClose';

const session = {
  sessionId: 'pty-owned',
  projectId: 'project-owned',
  processInstanceId: 'instance-owned',
  pid: 4242,
  processStartedAt: 1700000000,
  runtimeGeneration: 'generation-owned',
};

describe('closeWorkbenchTerminalSession', () => {
  it('stops only the exact live session and process binding before completing', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce({ kind: 'signal_delivered' })
      .mockResolvedValueOnce([]);

    await expect(closeWorkbenchTerminalSession('pty-owned', 'project-owned', invoke)).resolves.toBe(
      'stopped',
    );
    expect(invoke.mock.calls).toEqual([
      ['terminal_list'],
      [
        'terminal_kill',
        {
          sessionId: 'pty-owned',
          expectedBinding: {
            projectId: 'project-owned',
            processInstanceId: 'instance-owned',
            pid: 4242,
            processStartedAt: 1700000000,
            runtimeGeneration: 'generation-owned',
          },
        },
      ],
      ['terminal_list'],
    ]);
  });

  it('does not signal a session attached to a different project', async () => {
    const invoke = vi.fn().mockResolvedValue([session]);
    await expect(
      closeWorkbenchTerminalSession('pty-owned', 'other-project', invoke),
    ).rejects.toThrow(/different project/i);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses an incomplete native process binding', async () => {
    const invoke = vi.fn().mockResolvedValue([{ ...session, processInstanceId: '' }]);
    await expect(
      closeWorkbenchTerminalSession('pty-owned', 'project-owned', invoke),
    ).rejects.toThrow(/process binding/i);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel recoverable if native termination is rejected', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce({ kind: 'delivery_rejected' });
    await expect(
      closeWorkbenchTerminalSession('pty-owned', 'project-owned', invoke),
    ).rejects.toThrow(/did not accept/i);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('accepts an already ended session without signaling another process', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await expect(closeWorkbenchTerminalSession('pty-owned', 'project-owned', invoke)).resolves.toBe(
      'absent',
    );
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('refuses to remove a panel while the session remains active after a signal', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce({ kind: 'signal_delivered' })
      .mockResolvedValueOnce([session]);
    await expect(
      closeWorkbenchTerminalSession('pty-owned', 'project-owned', invoke),
    ).rejects.toThrow(/still active/i);
  });
});
