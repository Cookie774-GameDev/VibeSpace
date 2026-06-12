import { describe, expect, it } from 'vitest';
import { buildFontSizeCycle, nextFontSize } from './PaneToolbar';

describe('nextFontSize', () => {
  it('wraps to the settings baseline instead of fixed 10px', () => {
    expect(nextFontSize(20, 13)).toBe(13);
    expect(nextFontSize(20, 15)).toBe(15);
  });

  it('builds a cycle with the baseline first', () => {
    expect(buildFontSizeCycle(13)).toEqual([13, 11, 12, 14, 16, 18, 20]);
    expect(buildFontSizeCycle(15)).toEqual([15, 11, 12, 13, 14, 16, 18, 20]);
  });

  it('steps through the cycle in order', () => {
    let size = 13;
    const seen = new Set<number>();
    for (let i = 0; i < 7; i += 1) {
      seen.add(size);
      size = nextFontSize(size, 13);
    }
    expect(seen).toEqual(new Set([13, 11, 12, 14, 16, 18, 20]));
    expect(size).toBe(13);
  });
});
