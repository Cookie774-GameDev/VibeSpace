import { describe, expect, it, vi } from 'vitest';
import {
  clearTerminalPaneSessionId,
  getTerminalPaneSessionId,
  registerTerminalPaneClearHandler,
  runTerminalPaneClear,
  setTerminalPaneSessionId,
} from './terminalClearRegistry';

describe('terminalClearRegistry', () => {
  it('runs a registered pane clear handler', () => {
    const handler = vi.fn();
    const unregister = registerTerminalPaneClearHandler('pane_a', handler);
    expect(runTerminalPaneClear('pane_a')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runTerminalPaneClear('pane_missing')).toBe(false);
    unregister();
    expect(runTerminalPaneClear('pane_a')).toBe(false);
  });

  it('tracks the live session id per pane', () => {
    setTerminalPaneSessionId('pane_b', 'pty_live');
    expect(getTerminalPaneSessionId('pane_b')).toBe('pty_live');
    clearTerminalPaneSessionId('pane_b');
    expect(getTerminalPaneSessionId('pane_b')).toBeUndefined();
  });
});
