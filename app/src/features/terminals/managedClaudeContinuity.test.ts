import { describe, expect, it, vi } from 'vitest';
import { prepareManagedClaudeContinuity } from './managedClaudeContinuity';

const scope = {
  accountId: 'account-a',
  projectId: 'project-a',
  paneId: 'pane-a',
  cwd: 'C:\\project',
  restore: true,
};
describe('managed Claude terminal continuity', () => {
  it('uses the exact native binding for a recovered Claude pane', async () => {
    const prepare = vi.fn().mockResolvedValue({
      state: 'resume',
      startupCommand: 'claude --resume 123 --plugin-dir continuity-plugin',
    });
    expect(
      await prepareManagedClaudeContinuity(
        { ...scope, startupCommand: 'claude', command: 'pwsh' },
        prepare,
      ),
    ).toEqual({
      state: 'resume',
      startupCommand: 'claude --resume 123 --plugin-dir continuity-plugin',
    });
    expect(prepare).toHaveBeenCalledWith('terminal_claude_continuity_prepare', {
      ...scope,
      shell: 'pwsh',
    });
  });
  it('adds capture to a new managed Claude pane without resuming a different pane', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValue({ state: 'new', startupCommand: 'claude --plugin-dir continuity-plugin' });
    expect(
      (
        await prepareManagedClaudeContinuity(
          { ...scope, restore: false, command: 'claude' },
          prepare,
        )
      )?.state,
    ).toBe('new');
    expect(prepare).toHaveBeenCalledWith('terminal_claude_continuity_prepare', {
      ...scope,
      restore: false,
      shell: undefined,
    });
  });
  it.each([
    { command: 'npm run deploy' },
    { command: 'pwsh', startupCommand: 'claude; deploy' },
    { command: 'claude --continue' },
    { command: 'claude', startupCommands: ['claude', 'npm publish'] },
    { command: 'claude', accountId: '' },
  ])('never rewrites arbitrary commands or missing identity: %j', async (override) => {
    const prepare = vi.fn();
    expect(await prepareManagedClaudeContinuity({ ...scope, ...override }, prepare)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
  it('keeps normal confirmation when no provider binding exists or native support is unavailable', async () => {
    for (const prepare of [
      vi.fn().mockResolvedValue({ state: 'unavailable' }),
      vi.fn().mockRejectedValue(new Error('old build')),
    ]) {
      expect(
        await prepareManagedClaudeContinuity({ ...scope, command: 'claude' }, prepare),
      ).toBeNull();
    }
  });
  it('never treats an unbound new conversation as a recovered session', async () => {
    const prepare = vi.fn().mockResolvedValue({ state: 'new', startupCommand: 'claude' });
    expect(
      await prepareManagedClaudeContinuity({ ...scope, command: 'claude' }, prepare),
    ).toBeNull();
  });
  it('scopes projectless panes and lets the native shell resolve its normal home directory', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValue({ state: 'new', startupCommand: 'claude --plugin-dir continuity-plugin' });
    expect(
      await prepareManagedClaudeContinuity(
        { ...scope, restore: false, projectId: null, cwd: undefined, command: 'claude' },
        prepare,
      ),
    ).not.toBeNull();
    expect(prepare).toHaveBeenCalledWith('terminal_claude_continuity_prepare', {
      accountId: scope.accountId,
      projectId: '__default__',
      paneId: scope.paneId,
      cwd: null,
      restore: false,
      shell: undefined,
    });
  });
  it('does not stall terminal startup when native preparation stops responding', async () => {
    vi.useFakeTimers();
    try {
      const pending = prepareManagedClaudeContinuity(
        { ...scope, command: 'claude' },
        () => new Promise(() => {}),
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
