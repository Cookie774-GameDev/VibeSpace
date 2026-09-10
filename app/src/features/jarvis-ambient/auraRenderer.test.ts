import { describe, it, expect } from 'vitest';
import { auraEnergy, JARVIS_AURA_SENSITIVITY } from './auraRenderer';
import { JARVIS_EDGE_PRESETS as presets } from './presets';
describe('approved native aura settings', () => {
  it('applies5.5x once to both real voice channels and clamps invalid signals', () => {
    expect(JARVIS_AURA_SENSITIVITY).toBe(5.5);
    for (const state of ['listening', 'speaking'] as const) {
      expect(auraEnergy(state, 0.1)).toBe(0.55);
      expect(auraEnergy(state, 0.5)).toBe(1);
      expect(auraEnergy(state, NaN)).toBe(0);
      expect(auraEnergy(state, -1)).toBe(0);
    }
    expect(auraEnergy('working', 1)).toBe(0);
  });
  it('preserves the accepted working speed and alert colors while disabling idle', () => {
    expect(presets.working.periodMs).toBe(6000);
    expect(presets.needs.color).toBe('#a36b00');
    expect(presets.error.color).toBe('#a30818');
    expect(presets.done.color).toBe('#184da6');
    expect(presets.idle.alpha).toBe(0);
  });
});
