import { buildCatalogEntry } from './providerRegistry';
import type { PluginManifest, PluginStatus } from './types';

const token = (id: string, label: string, placeholder: string, help?: string) => ({
  id,
  label,
  placeholder,
  help,
  secret: true,
  required: true,
});

const text = (id: string, label: string, placeholder: string, help?: string) => ({
  id,
  label,
  placeholder,
  help,
  secret: false,
  required: true,
});

const IMPLEMENTED_BASE: PluginManifest[] = [
  {
    id: 'github',
    name: 'GitHub',
    provider: 'GitHub',
    description: 'Repositories, issues, pull requests, actions, and authenticated account context.',
    category: 'Developer Tools',
    authType: 'token',
    fields: [
      token(
        'token',
        'Personal access token',
        'github_pat_...',
        'Use a fine-grained token with only the repositories and permissions VibeSpace needs.',
      ),
    ],
    status: 'implemented',
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    credentialUrl: 'https://github.com/settings/personal-access-tokens',
    help: 'Create a fine-grained personal access token. VibeSpace tests it against the authenticated-user endpoint and never exposes it to terminals.',
    tags: ['developer tools', 'git', 'token', 'repositories'],
    setupSteps: [
      'Open GitHub Settings → Developer settings → Personal access tokens.',
      'Create a fine-grained token with the repositories you need.',
      'Paste the token here and run Test Connection.',
    ],
    supportedFeatures: ['repositories', 'issues', 'pull requests', 'actions'],
    tools: [
      {
        name: 'identity',
        description: 'Read the connected GitHub account identity.',
        readOnly: true,
      },
      {
        name: 'repository_context',
        description: 'Describe repository capabilities available through this connection.',
        readOnly: true,
      },
    ],
    httpTest: {
      url: 'https://api.github.com/user',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer {{token}}',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      accountLabelPath: 'login',
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    provider: 'Figma',
    description: 'Design files, components, comments, variables, and design-system context.',
    category: 'Design',
    authType: 'token',
    fields: [
      token(
        'token',
        'Personal access token',
        'figd_...',
        'Create a personal access token in Figma settings.',
      ),
    ],
    status: 'implemented',
    docsUrl: 'https://www.figma.com/developers/api#access-tokens',
    credentialUrl: 'https://www.figma.com/developers/api#access-tokens',
    help: 'Use a Figma personal access token. The connection test reads only the current user profile.',
    tags: ['design', 'token', 'components'],
    setupSteps: [
      'Open Figma → Settings → Security → Personal access tokens.',
      'Generate a token and paste it here.',
      'Run Test Connection.',
    ],
    supportedFeatures: ['design files', 'components', 'comments'],
    tools: [
      {
        name: 'identity',
        description: 'Read the connected Figma account identity.',
        readOnly: true,
      },
      {
        name: 'design_context',
        description: 'Expose the connector capability set to project agents.',
        readOnly: true,
      },
    ],
    httpTest: {
      url: 'https://api.figma.com/v1/me',
      headers: { 'X-Figma-Token': '{{token}}' },
      accountLabelPath: 'email',
    },
  },
  {
    id: 'supabase',
    name: 'Supabase',
    provider: 'Supabase',
    description: 'Database, authentication, storage, edge functions, and project API context.',
    category: 'Databases',
    authType: 'api_key',
    fields: [
      text('url', 'Project URL', 'https://your-project.supabase.co'),
      token(
        'key',
        'Project API key',
        'sb_publishable_... or service role key',
        'Prefer a publishable/anon key for read-only context. Service-role keys are highly privileged.',
      ),
    ],
    status: 'implemented',
    docsUrl: 'https://supabase.com/docs/guides/api/api-keys',
    credentialUrl: 'https://supabase.com/dashboard/project/_/settings/api-keys',
    help: 'Enter the project URL and an API key. VibeSpace calls the REST root to validate the pair.',
    tags: ['database', 'auth', 'storage', 'api_key'],
    setupSteps: [
      'Open your Supabase project → Settings → API.',
      'Copy the project URL and publishable/anon key.',
      'Paste both values and test.',
    ],
    supportedFeatures: ['database', 'auth', 'storage', 'edge functions'],
    tools: [
      {
        name: 'connection_info',
        description: 'Read safe project endpoint metadata.',
        readOnly: true,
      },
      {
        name: 'schema_context',
        description: 'Describe available database connector capabilities.',
        readOnly: true,
      },
    ],
    httpTest: {
      url: '{{url}}/rest/v1/',
      headers: { apikey: '{{key}}', Authorization: 'Bearer {{key}}' },
      acceptEmpty: true,
    },
  },
  {
    id: 'shopify',
    name: 'Shopify',
    provider: 'Shopify',
    description: 'Store catalog, orders, customers, themes, and Admin API context.',
    category: 'Ecommerce',
    authType: 'token',
    fields: [
      text('store', 'Store domain', 'your-store.myshopify.com'),
      token(
        'token',
        'Admin API access token',
        'shpat_...',
        'Use a custom app token with minimum required Admin API scopes.',
      ),
    ],
    status: 'implemented',
    docsUrl:
      'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin',
    credentialUrl: 'https://admin.shopify.com/store/settings/apps/development',
    help: 'Enter the permanent myshopify.com domain and a custom-app Admin API token.',
    tags: ['ecommerce', 'token', 'orders'],
    setupSteps: [
      'Create a custom app in the Shopify admin.',
      'Install it and copy the Admin API access token.',
      'Enter store domain and token, then test.',
    ],
    supportedFeatures: ['catalog', 'orders', 'customers'],
    tools: [
      { name: 'shop_identity', description: 'Read connected shop identity.', readOnly: true },
      {
        name: 'commerce_context',
        description: 'Describe available Shopify capabilities.',
        readOnly: true,
      },
    ],
    httpTest: {
      url: 'https://{{store}}/admin/api/2026-04/shop.json',
      headers: { 'X-Shopify-Access-Token': '{{token}}' },
      accountLabelPath: 'shop.name',
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    provider: 'Slack',
    description: 'Workspace, channels, messages, users, and collaboration context.',
    category: 'Communication',
    authType: 'token',
    fields: [
      token(
        'token',
        'Bot or user token',
        'xoxb-... or xoxp-...',
        'Use the narrowest OAuth scopes required for your workspace.',
      ),
    ],
    status: 'implemented',
    docsUrl: 'https://api.slack.com/authentication/token-types',
    credentialUrl: 'https://api.slack.com/apps',
    help: 'Enter a Slack bot or user token. VibeSpace validates it with auth.test.',
    tags: ['messaging', 'collaboration', 'token'],
    setupSteps: [
      'Create a Slack app at api.slack.com/apps.',
      'Install it to your workspace and copy the bot token.',
      'Paste the token and test.',
    ],
    supportedFeatures: ['channels', 'messages', 'users'],
    tools: [
      {
        name: 'identity',
        description: 'Read workspace and authenticated identity.',
        readOnly: true,
      },
      {
        name: 'workspace_context',
        description: 'Describe available Slack capabilities.',
        readOnly: true,
      },
    ],
    httpTest: {
      method: 'POST',
      url: 'https://slack.com/api/auth.test',
      headers: {
        Authorization: 'Bearer {{token}}',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      accountLabelPath: 'team',
    },
  },
  {
    id: 'mock-connector',
    name: 'VibeSpace Mock Connector',
    provider: 'VibeSpace',
    description: 'Deterministic local connector for testing plugin setup and tool dispatch.',
    category: 'Developer Tools',
    authType: 'none',
    fields: [],
    status: 'implemented',
    help: 'No credentials required. Use this connector to verify the plugin runtime without network access.',
    tags: ['developer tools', 'local', 'testing'],
    setupSteps: ['Click Connect — no credentials are required.'],
    supportedFeatures: ['local testing'],
    tools: [
      { name: 'ping', description: 'Return a deterministic local response.', readOnly: true },
      { name: 'list_tools', description: 'List this connector manifest tools.', readOnly: true },
    ],
  },
];

export const PLUGIN_CATALOG_TARGET = 112;

type CatalogCandidate = { name: string; category: string };

/** Curated connectors with real probes or OAuth connect flows — no placeholder-only entries. */
const PRIORITY_CANDIDATES: CatalogCandidate[] = [
  // Developer Tools (8)
  { name: 'GitLab', category: 'Developer Tools' },
  { name: 'Bitbucket', category: 'Developer Tools' },
  { name: 'Sourcegraph', category: 'Developer Tools' },
  { name: 'Postman', category: 'Developer Tools' },
  { name: 'Algolia', category: 'Developer Tools' },
  { name: 'LaunchDarkly', category: 'Developer Tools' },
  // Cloud & Hosting (7)
  { name: 'Vercel', category: 'Cloud & Hosting' },
  { name: 'Netlify', category: 'Cloud & Hosting' },
  { name: 'Cloudflare', category: 'Cloud & Hosting' },
  { name: 'DigitalOcean', category: 'Cloud & Hosting' },
  { name: 'Heroku', category: 'Cloud & Hosting' },
  { name: 'Railway', category: 'Cloud & Hosting' },
  { name: 'Render', category: 'Cloud & Hosting' },
  // Databases (7)
  { name: 'MongoDB Atlas', category: 'Databases' },
  { name: 'Neon', category: 'Databases' },
  { name: 'PlanetScale', category: 'Databases' },
  { name: 'Turso', category: 'Databases' },
  { name: 'Upstash', category: 'Databases' },
  { name: 'Pinecone', category: 'Databases' },
  { name: 'Qdrant', category: 'Databases' },
  { name: 'Weaviate', category: 'Databases' },
  // Productivity (4)
  { name: 'Notion', category: 'Productivity' },
  { name: 'Airtable', category: 'Productivity' },
  { name: 'Coda', category: 'Productivity' },
  { name: 'Miro', category: 'Productivity' },
  // Project Management (6)
  { name: 'Linear', category: 'Project Management' },
  { name: 'Jira', category: 'Project Management' },
  { name: 'Trello', category: 'Project Management' },
  { name: 'Asana', category: 'Project Management' },
  { name: 'ClickUp', category: 'Project Management' },
  { name: 'Shortcut', category: 'Project Management' },
  // Communication (5)
  { name: 'Discord', category: 'Communication' },
  { name: 'Twilio', category: 'Communication' },
  { name: 'Telegram', category: 'Communication' },
  { name: 'Zendesk', category: 'Communication' },
  { name: 'Intercom', category: 'Communication' },
  // Google Workspace (12)
  { name: 'Gmail', category: 'Google Workspace' },
  { name: 'Google Calendar', category: 'Google Workspace' },
  { name: 'Google Drive', category: 'Google Workspace' },
  { name: 'Google Sheets', category: 'Google Workspace' },
  { name: 'Google Docs', category: 'Google Workspace' },
  { name: 'Google Slides', category: 'Google Workspace' },
  { name: 'Google Forms', category: 'Google Workspace' },
  { name: 'Google Contacts', category: 'Google Workspace' },
  { name: 'Google Chat', category: 'Google Workspace' },
  { name: 'Google Analytics', category: 'Google Workspace' },
  { name: 'Google Search Console', category: 'Google Workspace' },
  { name: 'YouTube', category: 'Google Workspace' },
  // Microsoft 365 (12)
  { name: 'Outlook', category: 'Microsoft 365' },
  { name: 'OneDrive', category: 'Microsoft 365' },
  { name: 'SharePoint', category: 'Microsoft 365' },
  { name: 'Excel', category: 'Microsoft 365' },
  { name: 'Word', category: 'Microsoft 365' },
  { name: 'PowerPoint', category: 'Microsoft 365' },
  { name: 'Microsoft Planner', category: 'Microsoft 365' },
  { name: 'Microsoft Forms', category: 'Microsoft 365' },
  { name: 'Dynamics 365', category: 'Microsoft 365' },
  { name: 'Power BI', category: 'Microsoft 365' },
  { name: 'Microsoft Graph', category: 'Microsoft 365' },
  { name: 'OneNote', category: 'Microsoft 365' },
  // Ecommerce (3)
  { name: 'WooCommerce', category: 'Ecommerce' },
  { name: 'BigCommerce', category: 'Ecommerce' },
  { name: 'Klaviyo', category: 'Ecommerce' },
  // Payments (6)
  { name: 'Stripe', category: 'Payments' },
  { name: 'Square', category: 'Payments' },
  { name: 'Paddle', category: 'Payments' },
  { name: 'Lemon Squeezy', category: 'Payments' },
  { name: 'Chargebee', category: 'Payments' },
  { name: 'Wise', category: 'Payments' },
  // Sales & Marketing (4)
  { name: 'Salesforce', category: 'Sales & Marketing' },
  { name: 'HubSpot', category: 'Sales & Marketing' },
  { name: 'Pipedrive', category: 'Sales & Marketing' },
  { name: 'Mailchimp', category: 'Sales & Marketing' },
  { name: 'Segment', category: 'Sales & Marketing' },
  // Analytics (6)
  { name: 'Sentry', category: 'Analytics' },
  { name: 'Datadog', category: 'Analytics' },
  { name: 'PostHog', category: 'Analytics' },
  { name: 'Grafana', category: 'Analytics' },
  { name: 'New Relic', category: 'Analytics' },
  { name: 'Mixpanel', category: 'Analytics' },
  // AI & Data (13)
  { name: 'OpenAI', category: 'AI & Data' },
  { name: 'Anthropic', category: 'AI & Data' },
  { name: 'Google Gemini', category: 'AI & Data' },
  { name: 'Perplexity', category: 'AI & Data' },
  { name: 'Hugging Face', category: 'AI & Data' },
  { name: 'Replicate', category: 'AI & Data' },
  { name: 'Cohere', category: 'AI & Data' },
  { name: 'Mistral AI', category: 'AI & Data' },
  { name: 'Groq', category: 'AI & Data' },
  { name: 'Together AI', category: 'AI & Data' },
  { name: 'OpenRouter', category: 'AI & Data' },
  { name: 'ElevenLabs', category: 'AI & Data' },
  { name: 'Deepgram', category: 'AI & Data' },
  // Content & CMS (4)
  { name: 'WordPress', category: 'Content & CMS' },
  { name: 'Contentful', category: 'Content & CMS' },
  { name: 'Sanity', category: 'Content & CMS' },
  { name: 'Strapi', category: 'Content & CMS' },
  // Infrastructure (3)
  { name: 'Docker', category: 'Infrastructure' },
  { name: 'Terraform Cloud', category: 'Infrastructure' },
  { name: 'Pulumi', category: 'Infrastructure' },
  // Email & Messaging (4)
  { name: 'Resend', category: 'Email & Messaging' },
  { name: 'SendGrid', category: 'Email & Messaging' },
  { name: 'Postmark', category: 'Email & Messaging' },
  { name: 'Mailgun', category: 'Email & Messaging' },
  // Files (2)
  { name: 'Dropbox', category: 'Files' },
  { name: 'Box', category: 'Files' },
];

function isVerifiedCatalogEntry(plugin: PluginManifest): boolean {
  return plugin.status === 'implemented' || plugin.status === 'configurable';
}

const implementedIds = new Set(IMPLEMENTED_BASE.map((plugin) => plugin.id));
const GENERATED_TARGET = PLUGIN_CATALOG_TARGET - IMPLEMENTED_BASE.length;

const GENERATED: PluginManifest[] = PRIORITY_CANDIDATES.map(({ name, category }) =>
  buildCatalogEntry(name, category),
)
  .filter((plugin) => !implementedIds.has(plugin.id))
  .filter(isVerifiedCatalogEntry)
  .slice(0, GENERATED_TARGET);

export const PLUGIN_CATALOG: readonly PluginManifest[] = [...IMPLEMENTED_BASE, ...GENERATED];

export function getPluginManifest(id: string): PluginManifest | undefined {
  return PLUGIN_CATALOG.find((plugin) => plugin.id === id);
}

export function validatePluginCatalog(catalog = PLUGIN_CATALOG): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const plugin of catalog) {
    if (
      !plugin.id ||
      !plugin.name ||
      !plugin.description ||
      !plugin.category ||
      !plugin.provider ||
      !plugin.help ||
      plugin.setupSteps.length === 0 ||
      plugin.tags.length === 0
    ) {
      errors.push(`${plugin.id || '<missing-id>'}: missing required metadata`);
    }
    if (ids.has(plugin.id)) errors.push(`${plugin.id}: duplicate id`);
    ids.add(plugin.id);
    const fieldIds = new Set<string>();
    for (const field of plugin.fields) {
      if (!field.id || !field.label) errors.push(`${plugin.id}: invalid field`);
      if (fieldIds.has(field.id)) errors.push(`${plugin.id}: duplicate field ${field.id}`);
      fieldIds.add(field.id);
    }
    if (plugin.status === 'implemented' && plugin.tools.length === 0) {
      errors.push(`${plugin.id}: implemented plugin has no tools`);
    }
    if (plugin.status === 'planned') {
      errors.push(`${plugin.id}: legacy planned status is not allowed`);
    }
    if (
      (plugin.status === 'implemented' || plugin.status === 'configurable') &&
      !plugin.httpTest &&
      plugin.authType !== 'none' &&
      plugin.authType !== 'oauth'
    ) {
      errors.push(`${plugin.id}: connectable plugin missing httpTest`);
    }
  }
  return errors;
}

export function catalogStats(catalog = PLUGIN_CATALOG) {
  const byStatus = (status: PluginStatus) => catalog.filter((p) => p.status === status).length;
  return {
    total: catalog.length,
    implemented: byStatus('implemented'),
    configurable: byStatus('configurable'),
    needsCredentials: byStatus('needs_credentials'),
    blocked: byStatus('blocked'),
    withHttpTest: catalog.filter((p) => Boolean(p.httpTest)).length,
  };
}
