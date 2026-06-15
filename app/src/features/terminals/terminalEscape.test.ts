import { describe, it, expect } from 'vitest';
import {
  createTerminalOutputBuffer,
  filterStartupTerminalOutput,
  findAltScreenEnter,
  splitTrailingIncompleteEscape,
  stripConPtyStartupClears,
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
    const input = 'PS C:\\Users\\devuser>]4;0;rgb:2a2a/2020/1818[0[0[0[';
    expect(stripOrphanEscapeFragments(input)).toBe('PS C:\\Users\\devuser>');
  });

  it('removes orphan mouse-tracking CSI fragments', () => {
    const input = 'prompt\n[<35;43;16M[<35;34;14M\nready';
    expect(stripOrphanEscapeFragments(input)).toBe('prompt\n\nready');
  });

  it('removes screenshot-style mouse report fragments that lost the opening bracket', () => {
    const input = 'prompt\nM[<35;27;14M[<35;28;14M[<35;29;14M\nready';
    expect(stripOrphanEscapeFragments(input)).toBe('prompt\n\nready');
  });

  it('removes orphan palette payload text after a restored PowerShell prompt', () => {
    const input = 'PS C:\\Users\\viper> efeffefeffefefeffefefeffef[0[I[0';
    expect(stripOrphanEscapeFragments(input)).toBe('PS C:\\Users\\viper> ');
  });
});

describe('filterStartupTerminalOutput', () => {
  it('strips startup clears without leaving orphan palette text', () => {
    const input = '\x1B[2J]4;0;rgb:2a/20/18\x07ready';
    expect(filterStartupTerminalOutput(input)).toBe('ready');
  });

  it('preserves cursor-home on fresh panes so the shell prompt lands at the top', () => {
    const conPtyStartup = '\x1B[2J\x1B[H\x1B[?25lPS C:\\repo> ';
    const filtered = filterStartupTerminalOutput(conPtyStartup, {
      stripCursorPositioning: false,
    });
    expect(filtered).toContain('\x1B[H');
    expect(filtered).toBe('\x1B[H\x1B[?25lPS C:\\repo> ');
  });

  it('strips cursor-home repositioning so a fresh prompt cannot overwrite restored lines', () => {
    // Regression: ConPTY attach emits clear + cursor-home; without the CUP
    // strip the prompt painted at the top of the viewport, overwriting the
    // replayed transcript ("content morphed around / deleted" after reload).
    const conPtyStartup = '\x1B[2J\x1B[H\x1B[?25lPS C:\\repo> ';
    const filtered = filterStartupTerminalOutput(conPtyStartup);
    expect(filtered).toBe('\x1B[?25lPS C:\\repo> ');
    expect(filtered).not.toContain('[H');
  });

  it('strips parameterised CUP/HVP, VPA and scroll-region sequences', () => {
    expect(stripConPtyStartupClears('\x1B[3;7Hx')).toBe('x');
    expect(stripConPtyStartupClears('\x1B[12;1fx')).toBe('x');
    expect(stripConPtyStartupClears('\x1B[5dx')).toBe('x');
    expect(stripConPtyStartupClears('\x1B[1;24rx')).toBe('x');
  });

  it('keeps colour and cursor-visibility sequences intact', () => {
    const input = '\x1B[33mwarn\x1B[0m\x1B[?25h';
    expect(filterStartupTerminalOutput(input)).toBe(input);
  });
});

describe('findAltScreenEnter', () => {
  it('locates the alt-screen-buffer enter sequence', () => {
    expect(findAltScreenEnter('plain output')).toBe(-1);
    expect(findAltScreenEnter('boot\x1B[?1049h\x1B[2Jtui')).toBe(4);
    expect(findAltScreenEnter('\x1B[?47hlegacy')).toBe(0);
    expect(findAltScreenEnter('\x1B[?1047hlegacy')).toBe(0);
  });

  it('does not match the alt-screen *leave* sequence', () => {
    expect(findAltScreenEnter('\x1B[?1049l')).toBe(-1);
  });
});
