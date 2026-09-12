import { BROWSER_CHAT_CAPABILITIES, type BrowserChatCapabilityId } from './permissionRegistry';

export type ChatGptProviderCapabilityTier = 'unknown' | 'read_fetch_only' | 'full_mcp_beta';

export const CHATGPT_PROVIDER_CAPABILITY_LABELS: Readonly<
  Record<ChatGptProviderCapabilityTier, string>
> = Object.freeze({
  unknown: 'Write support not verified · using read/fetch only',
  read_fetch_only: 'Read/fetch only · compatible with ChatGPT Pro',
  full_mcp_beta: 'Full MCP beta · ChatGPT Business, Enterprise, or Edu',
});

const READ_CAPABILITIES = Object.freeze(
  BROWSER_CHAT_CAPABILITIES.filter((capability) => !capability.mutates).map(
    (capability) => capability.id,
  ),
);
const FULL_CAPABILITIES = Object.freeze(
  BROWSER_CHAT_CAPABILITIES.map((capability) => capability.id),
);

export function providerCapabilitiesForTier(
  tier: ChatGptProviderCapabilityTier,
): readonly BrowserChatCapabilityId[] {
  return tier === 'full_mcp_beta' ? FULL_CAPABILITIES : READ_CAPABILITIES;
}
