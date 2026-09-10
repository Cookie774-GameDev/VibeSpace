import type { JarvisAmbientState } from './types';

export type JarvisEdgePreset = Readonly<{
  color: `#${string}`;
  minBand: number;
  maxBand: number;
  glow: number;
  alpha: number;
  periodMs: number;
  energyGain: number;
  segment: number;
}>;

export const JARVIS_EDGE_PRESETS: Readonly<Record<JarvisAmbientState, JarvisEdgePreset>> =
  Object.freeze({
    idle: {
      color: '#000000',
      minBand: 2,
      maxBand: 2,
      glow: 34,
      alpha: 0,
      periodMs: 0,
      energyGain: 0,
      segment: 0,
    },
    listening: {
      color: '#65beff',
      minBand: 2,
      maxBand: 3,
      glow: 30,
      alpha: 0.84,
      periodMs: 4_800,
      energyGain: 5.5,
      segment: 0.28,
    },
    speaking: {
      color: '#65beff',
      minBand: 2,
      maxBand: 3,
      glow: 34,
      alpha: 0.9,
      periodMs: 4_200,
      energyGain: 5.5,
      segment: 0.3,
    },
    working: {
      color: '#2784ff',
      minBand: 2,
      maxBand: 3,
      glow: 28,
      alpha: 0.9,
      periodMs: 6_000,
      energyGain: 0,
      segment: 0.18,
    },
    needs: {
      color: '#a36b00',
      minBand: 12,
      maxBand: 48,
      glow: 42,
      alpha: 0.9,
      periodMs: 2_200,
      energyGain: 0,
      segment: 1,
    },
    done: {
      color: '#184da6',
      minBand: 2,
      maxBand: 2,
      glow: 30,
      alpha: 0.88,
      periodMs: 1_700,
      energyGain: 0,
      segment: 1,
    },
    error: {
      color: '#a30818',
      minBand: 14,
      maxBand: 58,
      glow: 46,
      alpha: 0.92,
      periodMs: 1_800,
      energyGain: 0,
      segment: 1,
    },
  });
