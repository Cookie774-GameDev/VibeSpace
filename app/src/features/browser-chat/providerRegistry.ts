export type BrowserChatProviderId = 'chatgpt' | 'claude' | 'gemini';

export type BrowserChatPageStatus =
  | 'not_opened'
  | 'opening'
  | 'ready'
  | 'external_window'
  | 'system_browser'
  | 'error';

export type BrowserChatToolBridgeStatus =
  | 'not_configured'
  | 'provider_unsupported'
  | 'connected_read_only'
  | 'connected_read_write'
  | 'error';

export interface BrowserChatProviderDefinition {
  readonly id: BrowserChatProviderId;
  readonly label: string;
  readonly homeUrl: `https://${string}`;
  readonly windowLabel: `browser-chat-${BrowserChatProviderId}`;
  readonly profileKey: `browser-chat/${BrowserChatProviderId}`;
  readonly availability: 'available' | 'future';
  readonly surfaceSupport: 'managed_window_with_system_browser_fallback';
  readonly pageStatus: BrowserChatPageStatus;
  readonly toolBridgeStatus: BrowserChatToolBridgeStatus;
  readonly serviceSummary: string;
  readonly privacyUrl: `https://${string}`;
  readonly termsUrl: `https://${string}`;
}

export const BROWSER_CHAT_PROVIDERS: readonly BrowserChatProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: 'chatgpt',
    label: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    windowLabel: 'browser-chat-chatgpt',
    profileKey: 'browser-chat/chatgpt',
    availability: 'available',
    surfaceSupport: 'managed_window_with_system_browser_fallback',
    pageStatus: 'not_opened',
    toolBridgeStatus: 'not_configured',
    serviceSummary: 'The real ChatGPT web experience using your OpenAI account and subscription.',
    privacyUrl: 'https://openai.com/policies/privacy-policy/',
    termsUrl: 'https://openai.com/policies/terms-of-use/',
  }),
  Object.freeze({
    id: 'claude',
    label: 'Claude',
    homeUrl: 'https://claude.ai/',
    windowLabel: 'browser-chat-claude',
    profileKey: 'browser-chat/claude',
    availability: 'future',
    surfaceSupport: 'managed_window_with_system_browser_fallback',
    pageStatus: 'not_opened',
    toolBridgeStatus: 'not_configured',
    serviceSummary: 'The real Claude web experience using your Anthropic account and subscription.',
    privacyUrl: 'https://www.anthropic.com/legal/privacy',
    termsUrl: 'https://www.anthropic.com/legal/consumer-terms',
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini',
    homeUrl: 'https://gemini.google.com/',
    windowLabel: 'browser-chat-gemini',
    profileKey: 'browser-chat/gemini',
    availability: 'future',
    surfaceSupport: 'managed_window_with_system_browser_fallback',
    pageStatus: 'not_opened',
    toolBridgeStatus: 'provider_unsupported',
    serviceSummary: 'The real Gemini web experience using your Google account and plan.',
    privacyUrl: 'https://policies.google.com/privacy',
    termsUrl: 'https://policies.google.com/terms',
  }),
]);

const PROVIDER_IDS = new Set<BrowserChatProviderId>(
  BROWSER_CHAT_PROVIDERS.map((provider) => provider.id),
);

export function isBrowserChatProviderId(value: unknown): value is BrowserChatProviderId {
  return typeof value === 'string' && PROVIDER_IDS.has(value as BrowserChatProviderId);
}

export function browserChatProvider(id: BrowserChatProviderId): BrowserChatProviderDefinition {
  const provider = BROWSER_CHAT_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unsupported Browser Chat provider: ${String(id)}`);
  return provider;
}
