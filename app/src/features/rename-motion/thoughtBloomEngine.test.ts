import { describe, expect, it } from 'vitest';

import {
  createThoughtBloomParticles,
  getCanvasPixelSize,
  splitTitleGraphemes,
} from './thoughtBloomEngine';

const origins = Array.from({ length: 72 }, (_, index) => ({
  x: index * 4,
  y: 8,
  width: 4,
  height: 12,
}));

describe('thoughtBloomEngine', () => {
  it('preserves Unicode graphemes when preparing animated title characters', () => {
    expect(splitTitleGraphemes('Plan 👩🏽‍💻 café')).toEqual([
      'P',
      'l',
      'a',
      'n',
      ' ',
      '👩🏽‍💻',
      ' ',
      'c',
      'a',
      'f',
      'é',
    ]);
  });

  it('creates deterministic character-local particles without exceeding the hard cap', () => {
    const first = createThoughtBloomParticles(origins, 42);
    const second = createThoughtBloomParticles(origins, 42);

    expect(first).toEqual(second);
    expect(first).toHaveLength(360);
    expect(first.every((particle) => Number.isFinite(particle.x))).toBe(true);
    expect(first.every((particle) => particle.radius >= 0.7 && particle.radius <= 2.8)).toBe(true);
  });

  it('caps canvas backing resolution at two device pixels per CSS pixel', () => {
    expect(getCanvasPixelSize(180.4, 28, 3)).toEqual({
      width: 361,
      height: 56,
      dpr: 2,
    });
    expect(getCanvasPixelSize(0, 0, 1)).toEqual({ width: 1, height: 1, dpr: 1 });
  });
});
