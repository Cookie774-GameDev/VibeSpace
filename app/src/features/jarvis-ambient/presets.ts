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
      color: '#65beff',
      minBand: 8,
      maxBand: 8,
      glow: 28,
      alpha: 0.8,
      periodMs: 7_200,
      energyGain: 0,
      segment: 0,
    },
    listening: {
      color: '#65beff',
      minBand: 8,
      maxBand: 36,
      glow: 30,
      alpha: 0.84,
      periodMs: 4_800,
      energyGain: 1.5,
      segment: 0.28,
    },
    speaking: {
      color: '#65beff',
      minBand: 8,
      maxBand: 38,
      glow: 34,
      alpha: 0.9,
      periodMs: 4_200,
      energyGain: 1.5,
      segment: 0.3,
    },
    working: {
      color: '#2784ff',
      minBand: 8,
      maxBand: 24,
      glow: 28,
      alpha: 0.9,
      periodMs: 2_400,
      energyGain: 0,
      segment: 0.18,
    },
    needs: {
      color: '#ffbe14',
      minBand: 12,
      maxBand: 48,
      glow: 42,
      alpha: 0.9,
      periodMs: 2_200,
      energyGain: 0,
      segment: 1,
    },
    done: {
      color: '#4c8dff',
      minBand: 10,
      maxBand: 28,
      glow: 30,
      alpha: 0.88,
      periodMs: 1_700,
      energyGain: 0,
      segment: 1,
    },
    error: {
      color: '#ff1f37',
      minBand: 14,
      maxBand: 58,
      glow: 46,
      alpha: 0.92,
      periodMs: 1_800,
      energyGain: 0,
      segment: 1,
    },
  });
