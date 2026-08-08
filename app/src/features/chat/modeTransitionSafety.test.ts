import { describe, expect, it } from 'vitest';
import { shouldCancelForLiveModeRestriction } from './modeTransitionSafety';

describe('live interaction-mode restriction safety', () => {
  it.each([
    ['agent', 'plan'],
    ['agent', 'ask'],
    ['plan', 'ask'],
  ] as const)('cancels an active %s → %s restriction', (previousMode, nextMode) => {
    expect(
      shouldCancelForLiveModeRestriction({
        previousMode,
        nextMode,
        running: true,
        cancellationKey: 'message-1',
      }),
    ).toBe(true);
  });

  it.each([
    ['ask', 'plan'],
    ['ask', 'agent'],
    ['plan', 'agent'],
    ['agent', 'agent'],
    ['plan', 'plan'],
    ['ask', 'ask'],
  ] as const)('does not interrupt an active %s → %s non-restriction', (previousMode, nextMode) => {
    expect(
      shouldCancelForLiveModeRestriction({
        previousMode,
        nextMode,
        running: true,
        cancellationKey: 'message-1',
      }),
    ).toBe(false);
  });

  it('does not cancel idle work or emit an unscoped cancellation', () => {
    expect(
      shouldCancelForLiveModeRestriction({
        previousMode: 'agent',
        nextMode: 'ask',
        running: false,
        cancellationKey: 'message-1',
      }),
    ).toBe(false);
    expect(
      shouldCancelForLiveModeRestriction({
        previousMode: 'agent',
        nextMode: 'ask',
        running: true,
        cancellationKey: null,
      }),
    ).toBe(false);
  });
});
