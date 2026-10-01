import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginBrowserChatToolCall,
  browserChatToolActivityStore,
  clearBrowserChatToolActivity,
  finishBrowserChatToolCall,
  publishBrowserChatToolCatalog,
} from './browserChatToolActivity';

describe('Browser Chat tool activity truth store', () => {
  beforeEach(() => clearBrowserChatToolActivity());

  it('publishes a normalized account-scoped catalog without arguments or roots', () => {
    publishBrowserChatToolCatalog({
      accountId: 'account-a',
      toolNames: ['fs.read', 'fs.list', 'fs.read'],
      now: 100,
    });

    expect(browserChatToolActivityStore.getSnapshot()).toEqual({
      version: 1,
      accountId: 'account-a',
      advertisedTools: ['fs.list', 'fs.read'],
      activeCalls: [],
      lastResult: null,
      updatedAt: 100,
    });
    expect(JSON.stringify(browserChatToolActivityStore.getSnapshot())).not.toContain('C:\\');
  });

  it('tracks concurrent calls and retains only a bounded result summary', () => {
    publishBrowserChatToolCatalog({
      accountId: 'account-a',
      toolNames: ['fs.list', 'fs.read'],
      now: 100,
    });
    beginBrowserChatToolCall({
      accountId: 'account-a',
      callId: 'call_123456789012',
      toolName: 'fs.read',
      now: 110,
    });
    beginBrowserChatToolCall({
      accountId: 'account-a',
      callId: 'call_abcdefghijkl',
      toolName: 'fs.list',
      now: 120,
    });
    expect(browserChatToolActivityStore.getSnapshot().activeCalls).toHaveLength(2);

    finishBrowserChatToolCall({
      accountId: 'account-a',
      callId: 'call_123456789012',
      ok: false,
      errorCode: 'LOCAL_READ_DENIED',
      elapsedMs: 25,
      now: 135,
    });
    expect(browserChatToolActivityStore.getSnapshot()).toMatchObject({
      activeCalls: [{ callId: 'call_abcdefghijkl', toolName: 'fs.list' }],
      lastResult: {
        callId: 'call_123456789012',
        toolName: 'fs.read',
        ok: false,
        errorCode: 'LOCAL_READ_DENIED',
        elapsedMs: 25,
        finishedAt: 135,
      },
    });
  });

  it('fails closed on wrong-account, unadvertised, replayed, and malformed events', () => {
    publishBrowserChatToolCatalog({
      accountId: 'account-a',
      toolNames: ['fs.read'],
      now: 100,
    });
    expect(() =>
      beginBrowserChatToolCall({
        accountId: 'account-b',
        callId: 'call_123456789012',
        toolName: 'fs.read',
        now: 110,
      }),
    ).toThrow(/account/u);
    expect(() =>
      beginBrowserChatToolCall({
        accountId: 'account-a',
        callId: 'call_123456789012',
        toolName: 'shell.run',
        now: 110,
      }),
    ).toThrow(/advertised/u);
    beginBrowserChatToolCall({
      accountId: 'account-a',
      callId: 'call_123456789012',
      toolName: 'fs.read',
      now: 110,
    });
    expect(() =>
      beginBrowserChatToolCall({
        accountId: 'account-a',
        callId: 'call_123456789012',
        toolName: 'fs.read',
        now: 120,
      }),
    ).toThrow(/replayed/u);
    expect(() =>
      finishBrowserChatToolCall({
        accountId: 'account-a',
        callId: 'call_123456789012',
        ok: false,
        errorCode: 'C:\\private\\secret',
        elapsedMs: 10,
        now: 130,
      }),
    ).toThrow(/result/u);
    expect(() =>
      finishBrowserChatToolCall({
        accountId: 'account-a',
        callId: 'call_123456789012',
        ok: true,
        elapsedMs: 30_001,
        now: 30_112,
      }),
    ).not.toThrow();
  });

  it('notifies subscribers and clears only the matching account', () => {
    const listener = vi.fn();
    const unsubscribe = browserChatToolActivityStore.subscribe(listener);
    publishBrowserChatToolCatalog({
      accountId: 'account-a',
      toolNames: [],
      now: 100,
    });
    clearBrowserChatToolActivity('account-b');
    expect(browserChatToolActivityStore.getSnapshot().accountId).toBe('account-a');
    clearBrowserChatToolActivity('account-a');
    expect(browserChatToolActivityStore.getSnapshot().accountId).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
