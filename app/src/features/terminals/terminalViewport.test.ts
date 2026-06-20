import { describe, expect, it } from 'vitest';
import {
  isTerminalViewportAtBottom,
  shouldAutoFollowTerminalOutput,
  terminalUserHasScrolled,
} from './terminalViewport';

function terminal(viewportY: number, baseY: number) {
  return {
    buffer: {
      active: {
        viewportY,
        baseY,
      },
    },
  };
}

describe('terminal viewport helpers', () => {
  it('detects when the xterm viewport is already at the live bottom', () => {
    expect(isTerminalViewportAtBottom(terminal(100, 100))).toBe(true);
    expect(isTerminalViewportAtBottom(terminal(101, 100))).toBe(true);
    expect(isTerminalViewportAtBottom(terminal(90, 100))).toBe(false);
  });

  it('tracks user scroll intent from the current xterm viewport', () => {
    expect(terminalUserHasScrolled(terminal(90, 100))).toBe(true);
    expect(terminalUserHasScrolled(terminal(100, 100))).toBe(false);
  });

  it('auto-follows output only while the user has not scrolled away or returned to bottom', () => {
    expect(shouldAutoFollowTerminalOutput({
      term: terminal(100, 100),
      userHasScrolled: false,
    })).toBe(true);
    expect(shouldAutoFollowTerminalOutput({
      term: terminal(90, 100),
      userHasScrolled: true,
    })).toBe(false);
    expect(shouldAutoFollowTerminalOutput({
      term: terminal(100, 100),
      userHasScrolled: true,
    })).toBe(true);
  });
});
