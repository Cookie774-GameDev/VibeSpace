import { describe, expect, it } from 'vitest';
import { normalizeCodexAccountUsage } from './codexAccountUsage';

describe('Codex app-server account usage', () => {
  it('uses provider-reported dynamic windows instead of hardcoded quota labels', () => {
    expect(
      normalizeCodexAccountUsage({
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 123 },
            secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 456 },
            credits: { balance: 12_430 },
            planType: 'plus',
          },
        },
        tokenUsage: { summary: { tokens: 900 } },
        updatedAt: 789,
        source: 'codex-app-server',
      }),
    ).toEqual({
      windows: [
        {
          label: '5h',
          usedPercent: 42,
          remainingPercent: 58,
          windowDurationMins: 300,
          resetsAt: 123,
        },
        {
          label: 'Weekly',
          usedPercent: 17,
          remainingPercent: 83,
          windowDurationMins: 10_080,
          resetsAt: 456,
        },
      ],
      creditsRemaining: 12_430,
      planType: 'plus',
      tokens: 900,
      updatedAt: 789,
      source: 'codex-app-server',
      freshness: 'live',
    });
  });
});
