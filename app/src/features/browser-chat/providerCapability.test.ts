import { describe, expect, it } from 'vitest';
import { BROWSER_CHAT_CAPABILITIES } from './permissionRegistry';
import {
  CHATGPT_PROVIDER_CAPABILITY_LABELS,
  providerCapabilitiesForTier,
} from './providerCapability';

describe('Browser Chat provider capability tiers', () => {
  it('fails unknown and read-only ChatGPT workspaces down to read/fetch capabilities', () => {
    for (const tier of ['unknown', 'read_fetch_only'] as const) {
      const capabilities = providerCapabilitiesForTier(tier);
      expect(capabilities).toContain('files.read');
      expect(capabilities).toContain('files.search');
      expect(capabilities).toContain('mcp.list');
      expect(capabilities).not.toContain('files.modify');
      expect(capabilities).not.toContain('terminal.execute');
      expect(capabilities).not.toContain('mcp.invoke');
    }
  });

  it('allows the full local catalog only for explicitly verified full MCP beta support', () => {
    expect(providerCapabilitiesForTier('full_mcp_beta')).toEqual(
      BROWSER_CHAT_CAPABILITIES.map((capability) => capability.id),
    );
    expect(CHATGPT_PROVIDER_CAPABILITY_LABELS.unknown).toMatch(/not verified/i);
    expect(CHATGPT_PROVIDER_CAPABILITY_LABELS.full_mcp_beta).toMatch(/Business|Enterprise|Edu/i);
  });
});
