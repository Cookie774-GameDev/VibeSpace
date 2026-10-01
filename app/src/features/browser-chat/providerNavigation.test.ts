import { describe, expect, it } from 'vitest';

import { normalizeProviderNavigation, validateProviderNavigationUrl } from './providerNavigation';

const TEST_CONVERSATION_ONE = `conversation-${1}`;
const TEST_CONVERSATION_TWO = `conversation-${2}`;
const TEST_CONVERSATION_THREE = `conversation-${3}`;

describe('Browser Chat provider navigation adapters', () => {
  it('treats the registry-owned Claude new-chat URL as home navigation', () => {
    expect(normalizeProviderNavigation('claude', 'https://claude.ai/new')).toEqual({
      provider: 'claude',
      kind: 'home',
      normalizedUrl: 'https://claude.ai/new',
    });
  });

  it.each([
    [
      'chatgpt',
      'https://chatgpt.com/c/conversation-1?temporary-chat=true#fragment',
      {
        provider: 'chatgpt',
        kind: 'conversation',
        conversationKey: TEST_CONVERSATION_ONE,
        normalizedUrl: 'https://chatgpt.com/c/conversation-1',
      },
    ],
    [
      'chatgpt',
      'https://chatgpt.com/g/g-p-project-1/project',
      {
        provider: 'chatgpt',
        kind: 'project',
        projectKey: 'g-p-project-1',
        normalizedUrl: 'https://chatgpt.com/g/g-p-project-1/project',
      },
    ],
    [
      'claude',
      'https://claude.ai/chat/conversation-2',
      {
        provider: 'claude',
        kind: 'conversation',
        conversationKey: TEST_CONVERSATION_TWO,
        normalizedUrl: 'https://claude.ai/chat/conversation-2',
      },
    ],
    [
      'claude',
      'https://claude.ai/project/project-2',
      {
        provider: 'claude',
        kind: 'project',
        projectKey: 'project-2',
        normalizedUrl: 'https://claude.ai/project/project-2',
      },
    ],
    [
      'gemini',
      'https://gemini.google.com/app/conversation-3',
      {
        provider: 'gemini',
        kind: 'conversation',
        conversationKey: TEST_CONVERSATION_THREE,
        normalizedUrl: 'https://gemini.google.com/app/conversation-3',
      },
    ],
  ] as const)(
    'normalizes supported %s top-level navigation without page content',
    (provider, rawUrl, expected) => {
      expect(normalizeProviderNavigation(provider, rawUrl)).toEqual(expected);
    },
  );

  it.each([
    ['chatgpt', 'https://chatgpt.com/'],
    ['claude', 'https://claude.ai/'],
    ['gemini', 'https://gemini.google.com/'],
  ] as const)('recognizes the %s provider home without inventing a binding', (provider, rawUrl) => {
    expect(normalizeProviderNavigation(provider, rawUrl)).toEqual({
      provider,
      kind: 'home',
      normalizedUrl: rawUrl,
    });
  });

  it.each([
    ['chatgpt', 'http://chatgpt.com/c/conversation-1'],
    ['chatgpt', 'https://chatgpt.com.evil.example/c/conversation-1'],
    ['chatgpt', 'https://user:password@chatgpt.com/c/conversation-1'],
    ['claude', 'https://claude.ai:444/chat/conversation-1'],
    ['claude', 'https://claude.ai/settings/profile'],
    ['gemini', 'https://gemini.google.com/share/conversation-1'],
  ] as const)('rejects spoofed or unsupported %s navigation: %s', (provider, rawUrl) => {
    expect(normalizeProviderNavigation(provider, rawUrl)).toBeNull();
  });

  it('validates resume URLs for the required navigation kind', () => {
    expect(
      validateProviderNavigationUrl(
        'chatgpt',
        'https://chatgpt.com/c/conversation-1',
        'conversation',
      ),
    ).toBe('https://chatgpt.com/c/conversation-1');
    expect(() =>
      validateProviderNavigationUrl(
        'chatgpt',
        'https://chatgpt.com/g/g-p-project-1/project',
        'conversation',
      ),
    ).toThrow('browser_chat_provider_navigation_invalid');
  });
});
