import { describe, expect, it } from 'vitest';
import { shellClearFollowUp, TERMINAL_CLEAR_ESCAPE } from './terminalClear';

describe('terminalClear', () => {
  it('uses a full CSI clear sequence', () => {
    expect(TERMINAL_CLEAR_ESCAPE).toContain('\x1b[2J');
    expect(TERMINAL_CLEAR_ESCAPE).toContain('\x1b[3J');
    expect(TERMINAL_CLEAR_ESCAPE).toContain('\x1b[H');
  });

  it('targets PowerShell with Clear-Host', () => {
    expect(shellClearFollowUp('powershell.exe')).toBe('Clear-Host\r\n');
    expect(shellClearFollowUp('pwsh')).toBe('Clear-Host\r\n');
  });

  it('targets cmd with cls', () => {
    expect(shellClearFollowUp('cmd.exe')).toBe('cls\r');
  });

  it('falls back to clear for other shells', () => {
    expect(shellClearFollowUp('bash')).toBe('clear\r');
    expect(shellClearFollowUp(null)).toBe('clear\r');
  });
});
