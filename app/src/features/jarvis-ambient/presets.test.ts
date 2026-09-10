import { describe, expect, it } from 'vitest';

import { JARVIS_EDGE_PRESETS } from './presets';

describe('Jarvis edge aura presets', () => {
  it('uses one solid hue per state with approved timings', () => {
    expect(JARVIS_EDGE_PRESETS.listening.color).toBe('#65beff');
    expect(JARVIS_EDGE_PRESETS.speaking.color).toBe('#65beff');
    expect(JARVIS_EDGE_PRESETS.working.color).toBe('#2784ff');
    expect(JARVIS_EDGE_PRESETS.needs.color).toBe('#a36b00');
    expect(JARVIS_EDGE_PRESETS.error.color).toBe('#a30818');
    expect(JARVIS_EDGE_PRESETS.working.periodMs).toBe(6_000);
    expect(JARVIS_EDGE_PRESETS.needs.periodMs).toBe(2_200);
    expect(JARVIS_EDGE_PRESETS.error.periodMs).toBe(1_800);
  });

  it('keeps speech visibly more reactive than the idle baseline', () => {
    expect(JARVIS_EDGE_PRESETS.listening.energyGain).toBe(5.5);
    expect(JARVIS_EDGE_PRESETS.speaking.energyGain).toBe(5.5);
    expect(JARVIS_EDGE_PRESETS.listening.maxBand).toBeGreaterThan(
      JARVIS_EDGE_PRESETS.listening.minBand,
    );
  });
});
