import { describe, expect, it } from 'vitest';
import type { TokenOptimizationMode } from './contracts';
import { optimizationModePolicy } from './optimizationPolicy';

describe('token optimization mode policy', () => {
  it.each(['off', 'saver', 'normal', 'final_boss'] as const)(
    'does not cap the requested output budget in %s mode',
    (mode: TokenOptimizationMode) => {
      expect(optimizationModePolicy(mode).outputTokenCeiling).toBeNull();
    },
  );

  it('does not request a lower reasoning effort for saver mode', () => {
    expect(optimizationModePolicy('saver').reasoning).toBe('provider_default');
  });
});
