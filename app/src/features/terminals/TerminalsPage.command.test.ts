import { describe, expect, it, vi } from 'vitest';
import { commandForAgent } from './TerminalsPage';

vi.mock('./TileGrid', () => ({
  TileGrid: () => null,
}));

describe('commandForAgent', () => {
  it('prefills CLIs for terminal agents that need instruction-file loading at startup', () => {
    expect(commandForAgent('coder')).toBe('claude');
    expect(commandForAgent('builder')).toBe('claude');
    expect(commandForAgent('scout')).toBe('opencode');
    expect(commandForAgent('reviewer')).toBe('opencode');
    expect(commandForAgent('critic')).toBe('opencode');
  });

  it('leaves general Jarvis panes on the user shell', () => {
    expect(commandForAgent('jarvis')).toBeUndefined();
  });
});
