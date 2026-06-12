import type { PluginManifest } from './types';

/**
 * Simple Icons slugs (https://simpleicons.org) for official brand marks.
 * Keys match `PluginManifest.id`.
 */
export const PLUGIN_SIMPLE_ICON_SLUG: Record<string, string> = {
  github: 'github',
  figma: 'figma',
  supabase: 'supabase',
  shopify: 'shopify',
  slack: 'slack',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
  sourcegraph: 'sourcegraph',
  postman: 'postman',
  algolia: 'algolia',
  launchdarkly: 'launchdarkly',
  vercel: 'vercel',
  netlify: 'netlify',
  cloudflare: 'cloudflare',
  digitalocean: 'digitalocean',
  heroku: 'heroku',
  railway: 'railway',
  render: 'render',
  'mongodb-atlas': 'mongodb',
  neon: 'neon',
  planetscale: 'planetscale',
  turso: 'turso',
  upstash: 'upstash',
  pinecone: 'pinecone',
  qdrant: 'qdrant',
  weaviate: 'weaviate',
  notion: 'notion',
  airtable: 'airtable',
  coda: 'coda',
  miro: 'miro',
  linear: 'linear',
  jira: 'jira',
  trello: 'trello',
  asana: 'asana',
  clickup: 'clickup',
  shortcut: 'shortcut',
  discord: 'discord',
  twilio: 'twilio',
  telegram: 'telegram',
  zendesk: 'zendesk',
  intercom: 'intercom',
  gmail: 'gmail',
  'google-calendar': 'googlecalendar',
  'google-drive': 'googledrive',
  'google-sheets': 'googlesheets',
  'google-docs': 'googledocs',
  'google-slides': 'googleslides',
  'google-forms': 'googleforms',
  'google-contacts': 'googlecontacts',
  'google-chat': 'googlechat',
  'google-analytics': 'googleanalytics',
  'google-search-console': 'googlesearchconsole',
  youtube: 'youtube',
  outlook: 'microsoftoutlook',
  onedrive: 'onedrive',
  sharepoint: 'microsoftsharepoint',
  excel: 'microsoftexcel',
  word: 'microsoftword',
  powerpoint: 'microsoftpowerpoint',
  'microsoft-planner': 'microsoftplanner',
  'microsoft-forms': 'microsoftforms',
  'dynamics-365': 'dynamics365',
  'power-bi': 'powerbi',
  'microsoft-graph': 'microsoft',
  onenote: 'microsoftonenote',
  woocommerce: 'woocommerce',
  bigcommerce: 'bigcommerce',
  klaviyo: 'klaviyo',
  stripe: 'stripe',
  square: 'square',
  paddle: 'paddle',
  'lemon-squeezy': 'lemonsqueezy',
  chargebee: 'chargebee',
  wise: 'wise',
  salesforce: 'salesforce',
  hubspot: 'hubspot',
  pipedrive: 'pipedrive',
  mailchimp: 'mailchimp',
  segment: 'segment',
  sentry: 'sentry',
  datadog: 'datadog',
  posthog: 'posthog',
  grafana: 'grafana',
  'new-relic': 'newrelic',
  mixpanel: 'mixpanel',
  openai: 'openai',
  anthropic: 'anthropic',
  'google-gemini': 'googlegemini',
  perplexity: 'perplexity',
  'hugging-face': 'huggingface',
  replicate: 'replicate',
  cohere: 'cohere',
  'mistral-ai': 'mistral',
  groq: 'groq',
  'together-ai': 'together',
  openrouter: 'openrouter',
  elevenlabs: 'elevenlabs',
  deepgram: 'deepgram',
  wordpress: 'wordpress',
  contentful: 'contentful',
  sanity: 'sanity',
  strapi: 'strapi',
  docker: 'docker',
  'terraform-cloud': 'terraform',
  pulumi: 'pulumi',
  resend: 'resend',
  sendgrid: 'sendgrid',
  postmark: 'postmark',
  mailgun: 'mailgun',
  dropbox: 'dropbox',
  box: 'box',
  plaid: 'plaid',
};

/** Domains for favicon fallback when Simple Icons does not carry the mark. */
const PLUGIN_DOMAIN_OVERRIDES: Record<string, string> = {
  'mock-connector': 'openapi.org',
  shortcut: 'shortcut.com',
  openrouter: 'openrouter.ai',
  neon: 'neon.tech',
  'google-search-console': 'search.google.com',
};

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function getPluginLogoDomain(
  plugin: Pick<PluginManifest, 'id' | 'credentialUrl' | 'docsUrl'>,
): string | undefined {
  return (
    PLUGIN_DOMAIN_OVERRIDES[plugin.id] ??
    domainFromUrl(plugin.credentialUrl) ??
    domainFromUrl(plugin.docsUrl)
  );
}

/** Ordered logo URLs — official Simple Icons first, then provider favicon. */
export function getPluginLogoSources(
  plugin: Pick<PluginManifest, 'id' | 'credentialUrl' | 'docsUrl'>,
): string[] {
  const urls: string[] = [];
  const slug = PLUGIN_SIMPLE_ICON_SLUG[plugin.id];
  if (slug) urls.push(`https://cdn.simpleicons.org/${slug}`);
  const domain = getPluginLogoDomain(plugin);
  if (domain) {
    urls.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`);
  }
  return urls;
}
