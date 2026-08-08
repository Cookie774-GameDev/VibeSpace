import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLD_START_INTRO_CROSSFADE_MS,
  COLD_START_INTRO_DURATION_MS,
  COLD_START_INTRO_HARD_TIMEOUT_MS,
  COLD_START_INTRO_VIDEO_SRC,
  COLD_START_INTRO_WINDOW_LABEL,
} from './introAsset';

describe('cold-start intro asset contract', () => {
  it('points at the bundled 4K master path and exact timing contracts', () => {
    expect(COLD_START_INTRO_VIDEO_SRC).toBe('/intro/VibeSpace_Pixel_Intro_Enhanced.mp4');
    expect(COLD_START_INTRO_DURATION_MS).toBe(6000);
    expect(COLD_START_INTRO_HARD_TIMEOUT_MS).toBe(8000);
    expect(COLD_START_INTRO_CROSSFADE_MS).toBeGreaterThanOrEqual(120);
    expect(COLD_START_INTRO_CROSSFADE_MS).toBeLessThanOrEqual(180);
    expect(COLD_START_INTRO_WINDOW_LABEL).toBe('cold-start-intro');
  });

  it('ships the full-size 4K master next to the public web root (no 1080p substitute)', () => {
    const assetPath = path.resolve(
      __dirname,
      '../../../public/intro/VibeSpace_Pixel_Intro_Enhanced.mp4',
    );
    expect(existsSync(assetPath)).toBe(true);
    // Master is ~9.3 MiB; reject accidental placeholder stubs.
    expect(statSync(assetPath).size).toBeGreaterThan(8_000_000);
  });
});
