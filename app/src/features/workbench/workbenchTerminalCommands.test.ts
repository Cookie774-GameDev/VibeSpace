import { describe, expect, it, vi } from 'vitest';
import {
  deliverWorkbenchTerminalCommand,
  subscribeWorkbenchTerminalCommands,
} from './workbenchTerminalCommands';
describe('Workbench terminal command delivery', () => {
  it('delivers once to exact live identity and rejects stale, foreign and unmounted targets', () => {
    const ref = { paneId: 'pane', sessionId: 'session', projectId: 'project' };
    const receive = vi.fn();
    const stop = subscribeWorkbenchTerminalCommands(() => ref, receive);
    try {
      expect(deliverWorkbenchTerminalCommand('FASTER', [ref, ref])).toBe(1);
      expect(receive).toHaveBeenCalledOnce();
      expect(receive).toHaveBeenCalledWith({
        command: 'FASTER',
        id: expect.any(Number),
        target: ref,
      });
      expect(
        deliverWorkbenchTerminalCommand('FASTER', [
          { ...ref, sessionId: 'old' },
          { ...ref, projectId: 'other' },
        ]),
      ).toBe(0);
    } finally {
      stop();
    }
    expect(deliverWorkbenchTerminalCommand('FASTER', [ref])).toBe(0);
  });
});
