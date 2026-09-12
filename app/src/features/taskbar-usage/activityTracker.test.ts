import { describe, expect, it, vi } from 'vitest';
import { createProviderActivityTracker } from './activityTracker';

describe('provider activity tracker', () => {
  it('counts real in-flight requests by provider and makes completion idempotent', () => {
    const tracker = createProviderActivityTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    const finishOpenAi = tracker.begin('openai');
    const finishCodex = tracker.begin('codex');
    expect(tracker.snapshot()).toEqual({ total: 2, byProvider: { codex: 1, openai: 1 } });

    finishOpenAi();
    finishOpenAi();
    expect(tracker.snapshot()).toEqual({ total: 1, byProvider: { codex: 1 } });

    finishCodex();
    expect(tracker.snapshot()).toEqual({ total: 0, byProvider: {} });
    expect(listener).toHaveBeenCalled();
  });
});
