import type { BrowserChatProviderId } from './providerRegistry';

export type ProviderNavigationKind = 'home' | 'conversation' | 'project';

export type ProviderNavigationMetadata = {
  readonly provider: BrowserChatProviderId;
  readonly kind: ProviderNavigationKind;
  readonly normalizedUrl: string;
  readonly conversationKey?: string;
  readonly projectKey?: string;
};

type ProviderNavigationAdapter = {
  readonly hostname: string;
  parse(pathname: string): Omit<ProviderNavigationMetadata, 'provider' | 'normalizedUrl'> | null;
};

const SAFE_KEY = '[A-Za-z0-9_-]+';

const ADAPTERS: Readonly<Record<BrowserChatProviderId, ProviderNavigationAdapter>> = {
  chatgpt: {
    hostname: 'chatgpt.com',
    parse(pathname) {
      if (pathname === '/') return { kind: 'home' };
      const directConversation = new RegExp(`^/c/(${SAFE_KEY})/?$`).exec(pathname);
      if (directConversation) {
        return { kind: 'conversation', conversationKey: directConversation[1] };
      }
      const project = new RegExp(`^/g/(${SAFE_KEY})/project/?$`).exec(pathname);
      if (project) return { kind: 'project', projectKey: project[1] };
      const projectConversation = new RegExp(`^/g/(${SAFE_KEY})/c/(${SAFE_KEY})/?$`).exec(pathname);
      if (projectConversation) {
        return {
          kind: 'conversation',
          projectKey: projectConversation[1],
          conversationKey: projectConversation[2],
        };
      }
      return null;
    },
  },
  claude: {
    hostname: 'claude.ai',
    parse(pathname) {
      if (pathname === '/' || pathname === '/new') return { kind: 'home' };
      const match = new RegExp(`^/(chat|project)/(${SAFE_KEY})/?$`).exec(pathname);
      if (!match) return null;
      return match[1] === 'chat'
        ? { kind: 'conversation', conversationKey: match[2] }
        : { kind: 'project', projectKey: match[2] };
    },
  },
  gemini: {
    hostname: 'gemini.google.com',
    parse(pathname) {
      if (pathname === '/') return { kind: 'home' };
      const conversation = new RegExp(`^/app/(${SAFE_KEY})/?$`).exec(pathname);
      return conversation ? { kind: 'conversation', conversationKey: conversation[1] } : null;
    },
  },
};

export function normalizeProviderNavigation(
  provider: BrowserChatProviderId,
  rawUrl: string,
): ProviderNavigationMetadata | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const adapter = ADAPTERS[provider];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== adapter.hostname ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  const parsed = adapter.parse(url.pathname);
  if (!parsed) return null;
  return {
    provider,
    ...parsed,
    normalizedUrl: `${url.origin}${url.pathname}`,
  };
}

export function validateProviderNavigationUrl(
  provider: BrowserChatProviderId,
  rawUrl: string,
  requiredKind: ProviderNavigationKind,
): string {
  const navigation = normalizeProviderNavigation(provider, rawUrl);
  if (!navigation || navigation.kind !== requiredKind) {
    throw new Error('browser_chat_provider_navigation_invalid');
  }
  return navigation.normalizedUrl;
}
