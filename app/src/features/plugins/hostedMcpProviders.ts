/** Official hosted endpoints. OAuth is executed by OpenCode, never by a static login URL. */
export const HOSTED_MCP_PROVIDERS = [
  {
    id: 'supabase',
    name: 'Supabase',
    url: 'https://mcp.supabase.com/mcp?read_only=true',
    docs: 'https://supabase.com/docs/guides/ai-tools/mcp',
  },
  {
    id: 'figma',
    name: 'Figma',
    url: 'https://mcp.figma.com/mcp',
    docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    setup:
      'Figma currently permits approved MCP clients only; VibeSpace must be approved before browser sign-in can complete.',
  },
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'jira',
    name: 'Atlassian',
    url: 'https://mcp.atlassian.com/v2/mcp',
    docs: 'https://atlassian.github.io/atlassian-mcp-server/',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    docs: 'https://mcp.sentry.dev/',
  },
  {
    id: 'canva',
    name: 'Canva',
    url: 'https://mcp.canva.com/mcp',
    docs: 'https://www.canva.dev/docs/apps/mcp/access/',
    setup: 'Canva requires an approved OAuth client and redirect URI before sign-in can complete.',
  },
  {
    id: 'neon',
    name: 'Neon',
    url: 'https://mcp.neon.tech/mcp',
    docs: 'https://neon.com/guides/neon-mcp-server-github-copilot-vs-code',
  },
  {
    id: 'asana',
    name: 'Asana',
    url: 'https://mcp.asana.com/v2/mcp',
    docs: 'https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server',
    setup:
      'Asana requires a registered MCP client ID, client secret and matching callback configured in your OAuth client. Use the existing personal-token connection below until that setup is complete.',
  },
] as const;

export type HostedMcpProvider = (typeof HOSTED_MCP_PROVIDERS)[number];

export function hostedMcpProvider(pluginId: string): HostedMcpProvider | undefined {
  return HOSTED_MCP_PROVIDERS.find(
    (provider) => provider.id === (pluginId === 'confluence' ? 'jira' : pluginId),
  );
}
