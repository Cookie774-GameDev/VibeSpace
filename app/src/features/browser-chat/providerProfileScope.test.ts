import { describe, expect, it } from 'vitest';

import {
  getOrCreateBrowserChatAccountProfileKey,
  isBrowserChatAccountProfileKey,
  scopedProviderProfileKey,
} from './providerProfileScope';

describe('Browser Chat account profile scope', () => {
  it('creates stable opaque and account-distinct provider profile keys', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = getOrCreateBrowserChatAccountProfileKey('account-a', storage);
    const repeated = getOrCreateBrowserChatAccountProfileKey('account-a', storage);
    const second = getOrCreateBrowserChatAccountProfileKey('account-b', storage);

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(isBrowserChatAccountProfileKey(first)).toBe(true);
    expect(first).not.toContain('account-a');
    expect(scopedProviderProfileKey('browser-chat/chatgpt', first)).toBe(
      `browser-chat/chatgpt/${first}`,
    );
  });

  it('rejects malformed account and profile authorities', () => {
    expect(() => getOrCreateBrowserChatAccountProfileKey('')).toThrow(
      'browser_chat_profile_account_invalid',
    );
    expect(() => getOrCreateBrowserChatAccountProfileKey('../account')).toThrow(
      'browser_chat_profile_account_invalid',
    );
    expect(isBrowserChatAccountProfileKey('profile_account-a')).toBe(false);
    expect(() =>
      scopedProviderProfileKey(
        'browser-chat/unknown',
        `profile_${'a'.repeat(64)}`,
      ),
    ).toThrow('browser_chat_provider_profile_invalid');
  });
});
