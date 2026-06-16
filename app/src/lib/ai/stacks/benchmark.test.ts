import { describe, expect, it } from 'vitest';
import {
  FABLE_5_BASELINE_SCORE,
  HIVE_SIMULATED_BENCHMARKS,
  benchmarkForPreset,
} from './benchmark';

describe('Hive simulated benchmarks', () => {
  it('keeps the Fable 5 baseline explicit', () => {
    expect(FABLE_5_BASELINE_SCORE).toBe(90.7);
  });

  it('marks Quality and Ultra as simulated Fable-beating tiers', () => {
    expect(benchmarkForPreset('quality')).toMatchObject({
      vibeScore: 94.4,
      beatsFable5: true,
      deltaVsFable5: 3.7,
    });
    expect(benchmarkForPreset('ultra')).toMatchObject({
      vibeScore: 94.1,
      beatsFable5: true,
      deltaVsFable5: 3.4,
    });
  });

  it('does not overclaim Fast or Balanced as confirmed Fable-beating', () => {
    expect(benchmarkForPreset('fast')?.beatsFable5).toBe(false);
    expect(benchmarkForPreset('balanced')?.beatsFable5).toBe(false);
    expect(HIVE_SIMULATED_BENCHMARKS.every((item) => item.caveat.length > 0)).toBe(true);
  });
});
