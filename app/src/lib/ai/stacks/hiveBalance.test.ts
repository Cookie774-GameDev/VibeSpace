/**
 * Tests for the Hive Balance preset (the single exposed Hive product).
 *
 * Hive Balance pipeline: Gemini 3.5 Flash High → MiniMax-M3 →
 * GLM-5.2 → DeepSeek V4 Pro Max → GPT-5.4 mini xhigh.
 * Pricing: $4.38 / 1M input · $19.97 / 1M output.
 *
 * Also tests old-preset coercion so stale localStorage values never crash.
 */

import { describe, it, expect } from 'vitest';
import { stepsForPreset, coerceToExposedPreset, HIVE_BALANCE_PRICING } from './presets';

describe('Hive Balance pipeline', () => {
  it('stepsForPreset(balanced) returns the 5-step Hive Balance pipeline', () => {
    const steps = stepsForPreset('balanced', 'general');
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.model)).toEqual([
      'gemini-3.5-flash-high',
      'minimax/minimax-m3',
      'zhipuai/glm-5.2',
      'deepseek-v4-pro-max',
      'gpt-5.4-mini',
    ]);
  });

  it('all steps have non-empty ids, labels, and systemAppend', () => {
    const steps = stepsForPreset('balanced', 'general');
    for (const step of steps) {
      expect(step.id.length).toBeGreaterThan(0);
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.systemAppend.length).toBeGreaterThan(0);
    }
  });

  it('stepsForPreset(off) returns empty steps', () => {
    expect(stepsForPreset('off', 'general')).toHaveLength(0);
  });

  it('exports HIVE_BALANCE_PRICING with correct per-million token prices', () => {
    expect(HIVE_BALANCE_PRICING.inputPer1M).toBeCloseTo(4.38, 2);
    expect(HIVE_BALANCE_PRICING.outputPer1M).toBeCloseTo(19.97, 2);
  });
});

describe('coerceToExposedPreset', () => {
  it('passes through balanced unchanged', () => {
    expect(coerceToExposedPreset('balanced')).toBe('balanced');
  });

  it('passes through off unchanged', () => {
    expect(coerceToExposedPreset('off')).toBe('off');
  });

  it('coerces fast → balanced', () => {
    expect(coerceToExposedPreset('fast')).toBe('balanced');
  });

  it('coerces quality → balanced', () => {
    expect(coerceToExposedPreset('quality')).toBe('balanced');
  });

  it('coerces ultra → balanced', () => {
    expect(coerceToExposedPreset('ultra')).toBe('balanced');
  });

  it('coerces custom → balanced', () => {
    expect(coerceToExposedPreset('custom')).toBe('balanced');
  });

  it('coerces unknown string → off', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(coerceToExposedPreset('hive-v1' as any)).toBe('off');
  });
});
