import { describe, expect, it } from 'vitest';

import {
  BROWSER_CHAT_PROVIDERS,
  browserChatProvider,
  isBrowserChatProviderId,
} from './providerRegistry';

describe('Browser Chat provider registry', () => {
  it('contains only the three approved provider-owned consumer surfaces', () => {
    expect(BROWSER_CHAT_PROVIDERS.map((provider) => [provider.id, provider.label])).toEqual([
      ['chatgpt', 'ChatGPT'],
      ['claude', 'Claude'],
      ['gemini', 'Gemini'],
    ]);
  });

  it('ships ChatGPT now and keeps Claude and Gemini visibly gated as future providers', () => {
    expect(browserChatProvider('chatgpt').availability).toBe('available');
    expect(browserChatProvider('claude').availability).toBe('future');
    expect(browserChatProvider('gemini').availability).toBe('future');
  });

  it('uses fixed HTTPS homes and unique isolated local profiles', () => {
    const profileKeys = new Set<string>();

    for (const provider of BROWSER_CHAT_PROVIDERS) {
      expect(new URL(provider.homeUrl).protocol).toBe('https:');
      expect(provider.homeUrl).toBe(browserChatProvider(provider.id).homeUrl);
      expect(provider.windowLabel).toBe(`browser-chat-${provider.id}`);
      expect(provider.profileKey).toBe(`browser-chat/${provider.id}`);
      expect(profileKeys.has(provider.profileKey)).toBe(false);
      profileKeys.add(provider.profileKey);
    }
  });

  it('keeps page support separate from truthful tool-bridge support', () => {
    for (const provider of BROWSER_CHAT_PROVIDERS) {
      expect(provider.surfaceSupport).toBe('managed_window_with_system_browser_fallback');
      expect(provider.pageStatus).toBe('not_opened');
      expect(provider.toolBridgeStatus).toMatch(/not_configured|provider_unsupported/);
      expect(provider.toolBridgeStatus).not.toBe('connected_read_write');
    }
  });

  it('rejects arbitrary provider identifiers', () => {
    expect(isBrowserChatProviderId('chatgpt')).toBe(true);
    expect(isBrowserChatProviderId('https://evil.invalid')).toBe(false);
    expect(() => browserChatProvider('other' as never)).toThrow(/unsupported browser chat/i);
  });
});
