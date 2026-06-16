import type { StackPresetId } from './types';

export const FABLE_5_BASELINE_SCORE = 90.7;

export interface HiveSimulatedBenchmark {
  preset: Exclude<StackPresetId, 'off' | 'custom'>;
  label: string;
  vibeScore: number | null;
  beatsFable5: boolean;
  deltaVsFable5: number | null;
  caveat: string;
}

export const HIVE_SIMULATED_BENCHMARKS: readonly HiveSimulatedBenchmark[] = [
  {
    preset: 'fast',
    label: 'Hive Fast',
    vibeScore: null,
    beatsFable5: false,
    deltaVsFable5: null,
    caveat: 'Not confirmed Fable-beating in the June 2026 simulation.',
  },
  {
    preset: 'balanced',
    label: 'Hive Balanced',
    vibeScore: null,
    beatsFable5: false,
    deltaVsFable5: null,
    caveat: 'Expected stronger than old Balanced, but not confirmed Fable-beating.',
  },
  {
    preset: 'quality',
    label: 'Hive Quality',
    vibeScore: 94.4,
    beatsFable5: true,
    deltaVsFable5: 3.7,
    caveat: 'Deterministic VibeBench simulation, not a live provider benchmark.',
  },
  {
    preset: 'ultra',
    label: 'Hive Ultra',
    vibeScore: 94.1,
    beatsFable5: true,
    deltaVsFable5: 3.4,
    caveat: 'Deterministic VibeBench simulation, not a live provider benchmark.',
  },
] as const;

export function benchmarkForPreset(
  preset: StackPresetId,
): HiveSimulatedBenchmark | null {
  return HIVE_SIMULATED_BENCHMARKS.find((item) => item.preset === preset) ?? null;
}
