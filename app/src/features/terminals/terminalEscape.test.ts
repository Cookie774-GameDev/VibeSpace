import { describe, it, expect } from 'vitest';
import {
  createTerminalOutputBuffer,
  filterStartupTerminalOutput,
  splitTrailingIncompleteEscape,
  stripOrphanEscapeFragments,
} from './terminalEscape';

describe('splitTrailingIncompleteEscape', () => {
  it('holds a trailing ESC until the sequence completes', () => {
    expect(splitTrailingIncompleteEscape('ready\x1B')).toEqual({
      complete: 'ready',
      pendingEscape: '\x1B',
    });
    expect(splitTrailingIncompleteEscape('ready\x1B]4;0;rgb:2a/20/18\x07')).toEqual({
      complete: 'ready\x1B]4;0;rgb:2a/20/18\x07',
      pendingEscape: '',
    });
  });
});

describe('createTerminalOutputBuffer', () => {
  it('reassembles split OSC palette sequences before emit', () => {
    const buffer = createTerminalOutputBuffer();
    expect(buffer.push('prompt\x1B')).toEqual(['prompt']);
    expect(buffer.push(']4;0;rgb:2a/20/18\x07\r\n')).toEqual([
      '\x1B]4;0;rgb:2a/20/18\x07\r\n',
    ]);
    expect(buffer.flush()).toBe('');
  });

  it('reassembles split CSI sequences before emit', () => {
    const buffer = createTerminalOutputBuffer();
    expect(buffer.push('line\x1B[')).toEqual(['line']);
    expect(buffer.push('0mnext')).toEqual(['\x1B[0mnext']);
  });
});

describe('stripOrphanEscapeFragments', () => {
  it('removes mid-line OSC palette garbage after PowerShell prompts', () => {
    const input = 'PS C:\\Users\\viper>]4;0;rgb:2a2a/2020/1818[0[0[0[';
    expect(stripOrphanEscapeFragments(input)).toBe('PS C:\\Users\\viper>');
  });

  it('removes orphan mouse-tracking CSI fragments', () => {
    const input = 'prompt\n[<35;43;16M[<35;34;14M\nready';
    expect(stripOrphanEscapeFragments(input)).toBe('prompt\n\nready');
  });
});

describe('filterStartupTerminalOutput', () => {
  it('strips startup clears without leaving orphan palette text', () => {
    const input = '\x1B[2J]4;0;rgb:2a/20/18\x07ready';
    expect(filterStartupTerminalOutput(input)).toBe('ready');
  });
});
