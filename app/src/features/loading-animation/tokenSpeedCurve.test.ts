import { describe, expect, it } from 'vitest';
import {
  BASELINE_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  easePlaybackRate,
  estimateOutputTokensFromText,
  playbackRateForOutputTps,
} from './tokenSpeedCurve';

describe('playbackRateForOutputTps', () => {
  it('uses baseline before telemetry', () => {
    expect(playbackRateForOutputTps(null)).toBe(BASELINE_PLAYBACK_RATE);
    expect(playbackRateForOutputTps(undefined)).toBe(BASELINE_PLAYBACK_RATE);
    expect(playbackRateForOutputTps(0)).toBe(BASELINE_PLAYBACK_RATE);
  });

  it('maps approved anchor rates', () => {
    expect(playbackRateForOutputTps(20)).toBeCloseTo(0.25, 2);
    expect(playbackRateForOutputTps(50)).toBeCloseTo(0.39, 2);
    expect(playbackRateForOutputTps(200)).toBeCloseTo(0.74, 2);
  });

  it('interpolates between anchors', () => {
    const mid = playbackRateForOutputTps(35);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.39);
  });

  it('clamps extremes', () => {
    expect(playbackRateForOutputTps(0.2)).toBeGreaterThanOrEqual(MIN_PLAYBACK_RATE);
    expect(playbackRateForOutputTps(10_000)).toBe(MAX_PLAYBACK_RATE);
  });

  it('never exceeds 1.0× or falls below minimum for positive TPS', () => {
    for (const tps of [0.5, 1, 20, 50, 200, 500, 900]) {
      const r = playbackRateForOutputTps(tps);
      expect(r).toBeGreaterThanOrEqual(MIN_PLAYBACK_RATE);
      expect(r).toBeLessThanOrEqual(MAX_PLAYBACK_RATE);
    }
  });
});

describe('easePlaybackRate', () => {
  it('moves toward target without overshooting wildly', () => {
    let rate = 0.25;
    for (let i = 0; i < 30; i += 1) {
      rate = easePlaybackRate(rate, 0.74, 100);
    }
    expect(rate).toBeGreaterThan(0.6);
    expect(rate).toBeLessThanOrEqual(0.74);
  });
});

describe('estimateOutputTokensFromText', () => {
  it('returns zero for empty input', () => {
    expect(estimateOutputTokensFromText('')).toBe(0);
    expect(estimateOutputTokensFromText('   ')).toBe(0);
  });

  it('grows with longer text', () => {
    const short = estimateOutputTokensFromText('hello');
    const long = estimateOutputTokensFromText('hello world this is a longer streaming chunk');
    expect(long).toBeGreaterThan(short);
  });
});
