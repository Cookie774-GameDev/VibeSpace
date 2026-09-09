import { describe, expect, it } from 'vitest';
import { CLASSIFIED_PLUGIN_CATALOG } from './catalog';
import { HOSTED_MCP_PROVIDERS, hostedMcpProvider } from './hostedMcpProviders';

describe('hosted provider routes and credential recovery', () => {
  it.each(HOSTED_MCP_PROVIDERS)(
    '$name uses an HTTPS endpoint without embedded credentials',
    (provider) => {
      const endpoint = new URL(provider.url);
      expect(endpoint.protocol).toBe('https:');
      expect(endpoint.username + endpoint.password + endpoint.hash).toBe('');
      expect(hostedMcpProvider(provider.id)).toBe(provider);
    },
  );

  it('preserves verified manual fallbacks for API connectors, including OAuth alternatives', () => {
    const ids = [
      'github',
      'figma',
      'notion',
      'linear',
      'sentry',
      'asana',
      'jira',
      'intercom',
      'slack',
      'airtable',
    ];
    for (const id of ids) {
      const provider = CLASSIFIED_PLUGIN_CATALOG.find((item) => item.id === id);
      expect(provider, id).toBeDefined();
      expect(provider!.authorizationCapability.kind, id).toMatch(
        /manual_fallback|provider_hosted_oauth/,
      );
      expect(
        provider!.fields.some((field) => field.secret && field.required),
        id,
      ).toBe(true);
      expect(provider!.httpTest, id).toBeDefined();
    }
  });

  it('does not invent an OAuth shortcut for an unknown catalog entry', () => {
    expect(hostedMcpProvider('unknown-provider')).toBeUndefined();
    expect(hostedMcpProvider('confluence')).toBe(hostedMcpProvider('jira'));
  });
});
