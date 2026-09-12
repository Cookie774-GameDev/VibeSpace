import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  browserChatRelayStatusStore,
  publishBrowserChatRelayStatus,
  resetBrowserChatRelayStatus,
} from './browserChatRelayStatus';

describe('browserChatRelayStatusStore', () => {
  beforeEach(resetBrowserChatRelayStatus);

  it('publishes global relay state without duplicate notifications', () => {
    const listener = vi.fn();
    const unsubscribe = browserChatRelayStatusStore.subscribe(listener);

    publishBrowserChatRelayStatus('connecting');
    publishBrowserChatRelayStatus('connecting');
    publishBrowserChatRelayStatus('connected');

    expect(browserChatRelayStatusStore.getSnapshot()).toBe('connected');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
