import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_NAVIGATION_EVENT,
  requestContextNavigation,
  subscribeContextNavigation,
  type ContextNavigationIntent,
} from './contextNavigation';

describe('Context navigation intents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the overview and exact-map intents through one bounded subscription', () => {
    vi.useFakeTimers();
    const received: ContextNavigationIntent[] = [];
    const unsubscribe = subscribeContextNavigation((intent) => received.push(intent));

    requestContextNavigation({ target: 'overview' });
    requestContextNavigation({ target: 'map', mapId: 'map-ar-outreach' });
    vi.runAllTimers();

    expect(received).toEqual([{ target: 'overview' }, { target: 'map', mapId: 'map-ar-outreach' }]);
    unsubscribe();
  });

  it('ignores malformed or empty exact-map intents', () => {
    const received: ContextNavigationIntent[] = [];
    const unsubscribe = subscribeContextNavigation((intent) => received.push(intent));

    window.dispatchEvent(
      new CustomEvent(CONTEXT_NAVIGATION_EVENT, {
        detail: { target: 'map', mapId: '' },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(CONTEXT_NAVIGATION_EVENT, {
        detail: { target: 'unknown', mapId: 'map-ar-outreach' },
      }),
    );

    expect(received).toEqual([]);
    unsubscribe();
  });

  it('keeps the latest navigation while the lazy Context page mounts and consumes it once', () => {
    vi.useFakeTimers();
    requestContextNavigation({ target: 'map', mapId: 'older-map' });
    requestContextNavigation({ target: 'map', mapId: 'selected-map' });
    vi.runAllTimers();

    const received: ContextNavigationIntent[] = [];
    const unsubscribe = subscribeContextNavigation((intent) => received.push(intent));
    expect(received).toEqual([{ target: 'map', mapId: 'selected-map' }]);
    unsubscribe();

    const replay = vi.fn();
    subscribeContextNavigation(replay)();
    expect(replay).not.toHaveBeenCalled();
  });
});
