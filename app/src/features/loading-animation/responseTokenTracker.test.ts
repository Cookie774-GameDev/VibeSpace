import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTrackerCount,
  beginResponse,
  clearAllResponseTrackers,
  endResponse,
  getResponseSnapshot,
  noteOutputTokens,
  setResponseLifecycle,
  tickResponse,
} from './responseTokenTracker';

afterEach(() => {
  clearAllResponseTrackers();
});

describe('responseTokenTracker independence', () => {
  it('keeps concurrent responses independent', () => {
    beginResponse('a');
    beginResponse('b');
    noteOutputTokens('a', 50, 'exact');
    noteOutputTokens('b', 5, 'exact');
    // Simulate a short window of tokens
    for (let i = 0; i < 5; i += 1) {
      noteOutputTokens('a', 40, 'exact');
      noteOutputTokens('b', 2, 'exact');
    }
    const sa = tickResponse('a');
    const sb = tickResponse('b');
    expect(sa.smoothedTps).toBeGreaterThan(sb.smoothedTps);
    expect(sa.currentPlaybackRate).toBeGreaterThan(sb.currentPlaybackRate);
  });

  it('starts near baseline before tokens', () => {
    beginResponse('wait');
    const snap = tickResponse('wait');
    expect(snap.currentPlaybackRate).toBeCloseTo(0.25, 2);
    expect(snap.lifecycle).toBe('waiting');
  });

  it('cleans up after endResponse', () => {
    beginResponse('x');
    noteOutputTokens('x', 10);
    expect(activeTrackerCount()).toBe(1);
    endResponse('x');
    expect(activeTrackerCount()).toBe(0);
    expect(getResponseSnapshot('x')).toBeNull();
  });

  it('maps ~50 TPS toward ~0.39× over ticks', () => {
    beginResponse('fast');
    setResponseLifecycle('fast', 'streaming');
    // Dump many tokens in one window to force high TPS.
    noteOutputTokens('fast', 50, 'exact');
    let snap = tickResponse('fast');
    for (let i = 0; i < 40; i += 1) {
      noteOutputTokens('fast', 5, 'exact');
      snap = tickResponse('fast');
    }
    expect(snap.targetPlaybackRate).toBeGreaterThanOrEqual(0.3);
    expect(snap.currentPlaybackRate).toBeGreaterThan(0.25);
  });
});
