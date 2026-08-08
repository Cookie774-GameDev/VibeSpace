import { describe, expect, it } from 'vitest';
import {
  TOKEN_BOSS_DURATION_MS,
  TOKEN_BOSS_HAMMER_HEAD_DISTANCE,
  TOKEN_BOSS_HIT_STOP_MS,
  TOKEN_BOSS_IMPACT_MS,
  TOKEN_BOSS_REFERENCE_SEED,
  TOKEN_BOSS_SPARK_COUNT,
  TOKEN_BOSS_USAGE_DRAIN_END_MS,
  tokenBossUsagePercentAt,
} from './renderer';

describe('Token Boss timing', () => {
  it('keeps the approved 4.72 second duration and 2.60 second impact', () => {
    expect(TOKEN_BOSS_DURATION_MS).toBe(4_720);
    expect(TOKEN_BOSS_IMPACT_MS).toBe(2_600);
    expect(TOKEN_BOSS_HIT_STOP_MS).toBe(78);
    expect(TOKEN_BOSS_HAMMER_HEAD_DISTANCE).toBe(240);
  });

  it('uses the supplied deterministic reference profile', () => {
    expect(TOKEN_BOSS_REFERENCE_SEED).toBe(9_042_026);
    expect(TOKEN_BOSS_SPARK_COUNT).toBe(34);
    expect(TOKEN_BOSS_USAGE_DRAIN_END_MS).toBe(4_480);
  });

  it('linearly drains only the cinematic meter from exactly 100 to exactly 0', () => {
    expect(tokenBossUsagePercentAt(0)).toBe(100);
    expect(tokenBossUsagePercentAt(1_120)).toBe(75);
    expect(tokenBossUsagePercentAt(2_240)).toBe(50);
    expect(tokenBossUsagePercentAt(TOKEN_BOSS_IMPACT_MS)).toBe(42);
    expect(tokenBossUsagePercentAt(TOKEN_BOSS_USAGE_DRAIN_END_MS)).toBe(0);
    expect(tokenBossUsagePercentAt(TOKEN_BOSS_DURATION_MS)).toBe(0);
  });
});
