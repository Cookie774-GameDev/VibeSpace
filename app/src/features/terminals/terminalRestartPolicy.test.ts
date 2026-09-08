import { describe, expect, it, vi } from 'vitest';
import { confirmTerminalRestart, terminalRestartDecision } from './terminalRestartPolicy';

describe('terminalRestartDecision', () => {
  it.each([
    undefined,
    null,
    'powershell.exe',
    'pwsh',
    'cmd.exe',
    'bash',
    '/bin/zsh',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'fish',
    'nu.exe',
  ])('automatically restores the safe shell %s', (command) => {
    expect(terminalRestartDecision(command)).toEqual({
      kind: 'safe-shell',
      spawnCommand: command ?? undefined,
    });
  });

  it.each([
    'opencode',
    'claude',
    'npm run dev',
    'python worker.py',
    'deploy.ps1',
    'pwsh -NoProfile',
    'unknown-tool',
  ])('defers the side-effecting or unknown command %s', (command) => {
    expect(terminalRestartDecision(command)).toEqual({
      kind: 'confirm',
      spawnCommand: undefined,
      deferredCommand: command,
    });
  });

  it('always defers startup commands even when the pane command is a safe shell', () => {
    expect(terminalRestartDecision('pwsh.exe', 'npm run dev')).toEqual({
      kind: 'confirm',
      spawnCommand: 'pwsh.exe',
      deferredCommand: 'npm run dev',
    });
  });

  it('keeps only the first printable line of a deferred command', () => {
    expect(terminalRestartDecision('pwsh', 'echo safe\rremove-item dangerous')).toEqual({
      kind: 'confirm',
      spawnCommand: 'pwsh',
      deferredCommand: 'echo safe',
    });
  });

  it('requires confirmation for the entire saved startup sequence', () => {
    expect(terminalRestartDecision('pwsh', 'ignored', ['echo first', 'npm run deploy'])).toEqual({
      kind: 'confirm',
      spawnCommand: 'pwsh',
      deferredCommand: 'echo first\nnpm run deploy',
      deferredCommands: ['echo first', 'npm run deploy'],
    });
  });

  it('does not auto-replay a batch with no restorable first line', () => {
    expect(terminalRestartDecision('pwsh', undefined, ['\nnpm run deploy'])).toMatchObject({
      kind: 'confirm',
      deferredCommands: [],
    });
  });

  it('does not auto-replay a singular command with no restorable first line', () => {
    expect(terminalRestartDecision('pwsh', '\nnpm run deploy')).toMatchObject({
      kind: 'confirm',
      deferredCommand: '',
    });
  });

  it.each(['pwsh\n-Command Invoke-Expression unsafe', '/bin/bash\n-c unsafe'])(
    'never treats multiline input as a bare safe shell: %s',
    (command) => {
      expect(terminalRestartDecision(command).kind).toBe('confirm');
    },
  );
});

describe('confirmTerminalRestart', () => {
  it('does not send any saved commands when confirmation is declined', async () => {
    const write = vi.fn();
    await confirmTerminalRestart(['echo first', 'npm run deploy'], {
      confirm: () => false,
      isCurrent: () => true,
      write,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('confirms once and sends each command separately in order', async () => {
    const events: string[] = [];
    const confirm = vi.fn(() => true);
    await confirmTerminalRestart(['echo first', 'npm run deploy'], {
      confirm,
      isCurrent: () => true,
      write: async (command) => {
        events.push(`start:${command}`);
        await Promise.resolve();
        events.push(`done:${command}`);
      },
    });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(['echo first', 'npm run deploy']);
    expect(events).toEqual([
      'start:echo first',
      'done:echo first',
      'start:npm run deploy',
      'done:npm run deploy',
    ]);
  });

  it('stops the sequence if the terminal is replaced while a write is pending', async () => {
    let current = true;
    const write = vi.fn(async () => {
      current = false;
    });
    await confirmTerminalRestart(['echo first', 'npm run deploy'], {
      confirm: () => true,
      isCurrent: () => current,
      write,
    });
    expect(write).toHaveBeenCalledExactlyOnceWith('echo first');
  });

  it('does not prompt or write for empty commands or a closed terminal', async () => {
    const confirm = vi.fn(() => true);
    const write = vi.fn();
    await confirmTerminalRestart([''], { confirm, isCurrent: () => true, write });
    await confirmTerminalRestart(['echo first'], { confirm, isCurrent: () => false, write });
    expect(confirm).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not run subsequent commands after a failed write', async () => {
    const write = vi.fn().mockRejectedValue(new Error('terminal closed'));
    await expect(
      confirmTerminalRestart(['echo first', 'npm run deploy'], {
        confirm: () => true,
        isCurrent: () => true,
        write,
      }),
    ).rejects.toThrow('terminal closed');
    expect(write).toHaveBeenCalledExactlyOnceWith('echo first');
  });
});
