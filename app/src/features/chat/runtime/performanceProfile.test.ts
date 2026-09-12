import { describe, expect, it } from 'vitest';
import { parsePerformanceCommand, performancePolicy } from './performanceProfile';

describe('performance profiles', () => {
  it('keeps model and effort invariant in every profile', () => {
    for (const profile of ['responsive', 'balanced', 'quality'] as const) {
      expect(performancePolicy(profile)).toMatchObject({
        modelIdPreserved: true,
        effortPreserved: true,
      });
    }
  });

  it('parses strict performance commands without pretending to be provider Fast mode', () => {
    expect(parsePerformanceCommand('/performance quality')).toEqual({
      kind: 'performance',
      value: 'quality',
    });
    expect(parsePerformanceCommand('/performance')).toEqual({ kind: 'performance' });
    expect(parsePerformanceCommand('/performance turbo')).toBeNull();
  });
});
