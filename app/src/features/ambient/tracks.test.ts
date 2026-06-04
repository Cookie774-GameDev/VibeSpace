import { describe, expect, it } from 'vitest';
import {
  FREE_AMBIENT_TRACK,
  getPlayableAmbientTrack,
  planAllowsAmbientTrack,
} from './tracks';

describe('ambient track entitlements', () => {
  it('allows calm and soothing tracks on the free tier', () => {
    expect(planAllowsAmbientTrack('calm-focus', 'free')).toBe(true);
    expect(planAllowsAmbientTrack('soothing-rain', 'free')).toBe(true);
  });

  it('locks premium music on free and unlocks it on paid tiers', () => {
    expect(planAllowsAmbientTrack('lofi-night', 'free')).toBe(false);
    expect(planAllowsAmbientTrack('rap-instrumental', 'free')).toBe(false);
    expect(planAllowsAmbientTrack('lofi-night', 'starter')).toBe(true);
    expect(planAllowsAmbientTrack('rap-instrumental', 'pro')).toBe(true);
  });

  it('falls back to the free calm track when a locked track is persisted', () => {
    expect(getPlayableAmbientTrack('lofi-night', 'free')).toBe(FREE_AMBIENT_TRACK);
    expect(getPlayableAmbientTrack('lofi-night', 'ultra')).toBe('lofi-night');
  });
});
