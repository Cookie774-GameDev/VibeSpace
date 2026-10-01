import { describe, expect, it } from 'vitest';
import { NATURE_PROFILE_IDS } from './natureAvatarAssignment';
import { natureAvatarFraming } from './natureAvatarFraming';

describe('nature avatar framing', () => {
  it('centers and enlarges the low teacup art without changing its source image', () => {
    const frame = natureAvatarFraming('10-teacup');
    expect(frame.zoom).toBeGreaterThan(1.15);
    expect(frame.focusY).toBeGreaterThan(0.6);
  });

  it('keeps every original silhouette inside a small square frame', () => {
    for (const id of NATURE_PROFILE_IDS) {
      const { zoom, focusX, focusY, bounds } = natureAvatarFraming(id);
      const [left, top, right, bottom] = bounds;
      expect(0.5 + (left / 1254 - focusX) * zoom).toBeGreaterThanOrEqual(0.045);
      expect(0.5 + (right / 1254 - focusX) * zoom).toBeLessThanOrEqual(0.955);
      expect(0.5 + (top / 1254 - focusY) * zoom).toBeGreaterThanOrEqual(0.045);
      expect(0.5 + (bottom / 1254 - focusY) * zoom).toBeLessThanOrEqual(0.955);
    }
  });

  it('backs off wide animal framing so a circular mask does not cut off the fox or fawn', () => {
    expect(natureAvatarFraming('23-fox-cub').zoom).toBeLessThan(1);
    expect(natureAvatarFraming('27-fawn').zoom).toBeLessThan(0.9);
    expect(natureAvatarFraming('08-origami-bird').zoom).toBeLessThan(1);
  });
});
