import { describe, expect, it } from 'vitest';
import { activeTokenOptimizationMode } from './reasoningModeBridge';

describe('Final Boss optimization isolation', () => {
  it.each(['off', 'saver', 'normal', 'final_boss'] as const)(
    'bypasses optimization and its receipt/budget for %s', (mode) => {
      expect(activeTokenOptimizationMode(mode, 'token-final-boss')).toBe('off');
    },
  );
  it('also respects Final Boss selected in the optimizer control', () => {
    expect(activeTokenOptimizationMode('final_boss', 'normal')).toBe('off');
  });
  it('preserves Saver activation', () => {
    expect(activeTokenOptimizationMode('saver', 'token-saver')).toBe('saver');
  });
});
