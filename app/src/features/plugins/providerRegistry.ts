import type {
  PluginAuthType,
  PluginField,
  PluginHttpTest,
  PluginManifest,
  PluginStatus,
  PluginTool,
} from './types';

type RegistryPartial = {
  provider?: string;
  description?: string;
  authType?: PluginAuthType;
  fields?: PluginField[];
  status?: PluginStatus;
  docsUrl?: string;
  credentialUrl?: string;
  help?: string;
  tags?: string[];
  setupSteps?: string[];
  supportedFeatures?: string[];
  limitations?: string;
  tools?: PluginTool[];
  httpTest?: PluginHttpTest;
};

const token = (id: string, label: string, placeholder: string, help?: string): PluginField => ({
  id,
  label,
  placeholder,
  help,
  secret: true,
  required: true,
});

const text = (id: string, label: string, placeholder: string, help?: string): PluginField => ({
  id,
  label,
  placeholder,
  help,
  secret: false,
  required: true,
});

const readTool = (name: string, description: string): PluginTool => ({
  name,
  description,
  readOnly: true,
});

const bearerTest = (url: string, tokenField = 'token', labelPath?: string): PluginHttpTest => ({
  url,
  headers: { Authorization: `Bearer {{${tokenField}}}` },
  accountLabelPath: labelPath,
});

const apiKeyHeaderTest = (
  url: string,
  header: string,
  field = 'api_key',
  labelPath?: string,
): PluginHttpTest => ({
  url,
  headers: { [header]: `{{${field}}}` },
  accountLabelPath: labelPath,
});

/** Official provider definitions with real connection probes where possible. */
export const PROVIDER_OVERRIDES: Record<string, RegistryPartial> = {
  openai: {
    provider: 'OpenAI',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 'sk-...', 'Create a secret key with the minimum scopes you need.')],
    credentialUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    status: 'configurable',
    tags: ['ai', 'llm', 'api_key', 'models'],
    setupSteps: [
      'Sign in to the OpenAI platform.',
      'Open API keys and create a new secret key.',
      'Paste the key here and run Test Connection.',
    ],
    supportedFeatures: ['model routing', 'chat context'],
    httpTest: bearerTest('https://api.openai.com/v1/models', 'api_key', 'data.0.owned_by'),
    tools: [readTool('models_context', 'List accessible model families.')],
  },
  anthropic: {
    provider: 'Anthropic',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 'sk-ant-...')],
    credentialUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started',
    status: 'configurable',
    tags: ['ai', 'llm', 'api_key'],
    setupSteps: [
      'Open the Anthropic Console.',
      'Create an API key under Settings → Keys.',
      'Paste the key and test the connection.',
    ],
    supportedFeatures: ['model routing', 'chat context'],
    httpTest: apiKeyHeaderTest('https://api.anthropic.com/v1/models', 'x-api-key', 'api_key'),
    tools: [readTool('models_context', 'Verify Anthropic API access.')],
  },
  groq: {
    provider: 'Groq',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 'gsk_...')],
    credentialUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/quickstart',
    status: 'configurable',
    tags: ['ai', 'llm', 'api_key', 'fast inference'],
    setupSteps: ['Create a GroqCloud API key.', 'Paste it here and test.'],
    supportedFeatures: ['fast inference', 'voice STT'],
    httpTest: bearerTest('https://api.groq.com/openai/v1/models', 'api_key'),
    tools: [readTool('models_context', 'List Groq models.')],
  },
  'google-gemini': {
    provider: 'Google',
    authType: 'api_key',
    fields: [token('api_key', 'Gemini API key', 'AIza...')],
    credentialUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    status: 'configurable',
    tags: ['ai', 'llm', 'google', 'api_key'],
    setupSteps: ['Open Google AI Studio.', 'Create an API key.', 'Paste and test.'],
    supportedFeatures: ['model routing', 'multimodal'],
    httpTest: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?key={{api_key}}',
      accountLabelPath: 'models.0.displayName',
    },
    tools: [readTool('models_context', 'List Gemini models.')],
  },
  perplexity: {
    provider: 'Perplexity',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 'pplx-...')],
    credentialUrl: 'https://www.perplexity.ai/settings/api',
    docsUrl: 'https://docs.perplexity.ai/guides/getting-started',
    status: 'configurable',
    tags: ['ai', 'search', 'api_key'],
    setupSteps: ['Generate a Perplexity API key.', 'Paste and test.'],
    supportedFeatures: ['search-augmented answers'],
    httpTest: bearerTest('https://api.perplexity.ai/models', 'api_key'),
    limitations: 'Uses a minimal API request during testing.',
    tools: [readTool('search_context', 'Search-augmented model access.')],
  },
  'hugging-face': {
    provider: 'Hugging Face',
    authType: 'token',
    fields: [token('token', 'Access token', 'hf_...')],
    credentialUrl: 'https://huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/docs/hub/security-tokens',
    status: 'configurable',
    tags: ['ai', 'models', 'token'],
    setupSteps: ['Create a Hugging Face access token with read access.', 'Paste and test.'],
    supportedFeatures: ['model hub', 'inference'],
    httpTest: bearerTest('https://huggingface.co/api/whoami-v2', 'token', 'name'),
    tools: [readTool('identity', 'Read Hugging Face account identity.')],
  },
  replicate: {
    provider: 'Replicate',
    authType: 'token',
    fields: [token('token', 'API token', 'r8_...')],
    credentialUrl: 'https://replicate.com/account/api-tokens',
    docsUrl: 'https://replicate.com/docs/reference/http',
    status: 'configurable',
    tags: ['ai', 'inference', 'token'],
    setupSteps: ['Create a Replicate API token.', 'Paste and test.'],
    supportedFeatures: ['model inference'],
    httpTest: bearerTest('https://api.replicate.com/v1/account', 'token', 'username'),
    tools: [readTool('account_context', 'Read Replicate account metadata.')],
  },
  cohere: {
    provider: 'Cohere',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/docs/the-cohere-platform',
    status: 'configurable',
    tags: ['ai', 'llm', 'api_key'],
    setupSteps: ['Create a Cohere API key.', 'Paste and test.'],
    supportedFeatures: ['embeddings', 'chat'],
    httpTest: bearerTest('https://api.cohere.com/v1/models', 'api_key'),
    tools: [readTool('models_context', 'List Cohere models.')],
  },
  'mistral-ai': {
    provider: 'Mistral AI',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://console.mistral.ai/api-keys/',
    docsUrl: 'https://docs.mistral.ai/getting-started/quickstart/',
    status: 'configurable',
    tags: ['ai', 'llm', 'api_key'],
    setupSteps: ['Create a Mistral API key.', 'Paste and test.'],
    supportedFeatures: ['chat', 'embeddings'],
    httpTest: bearerTest('https://api.mistral.ai/v1/models', 'api_key'),
    tools: [readTool('models_context', 'List Mistral models.')],
  },
  'together-ai': {
    provider: 'Together AI',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai/docs/quickstart',
    status: 'configurable',
    tags: ['ai', 'inference', 'api_key'],
    setupSteps: ['Create a Together API key.', 'Paste and test.'],
    supportedFeatures: ['open models', 'inference'],
    httpTest: bearerTest('https://api.together.xyz/v1/models', 'api_key'),
    tools: [readTool('models_context', 'List Together models.')],
  },
  openrouter: {
    provider: 'OpenRouter',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 'sk-or-...')],
    credentialUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    status: 'configurable',
    tags: ['ai', 'gateway', 'api_key'],
    setupSteps: ['Create an OpenRouter API key.', 'Paste and test.'],
    supportedFeatures: ['multi-provider routing'],
    httpTest: bearerTest('https://openrouter.ai/api/v1/auth/key', 'api_key', 'data.label'),
    tools: [readTool('routing_context', 'Read OpenRouter key metadata.')],
  },
  elevenlabs: {
    provider: 'ElevenLabs',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://elevenlabs.io/app/settings/api-keys',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/getting-started',
    status: 'configurable',
    tags: ['voice', 'tts', 'api_key'],
    setupSteps: ['Create an ElevenLabs API key.', 'Paste and test.'],
    supportedFeatures: ['text-to-speech'],
    httpTest: apiKeyHeaderTest('https://api.elevenlabs.io/v1/user', 'xi-api-key', 'api_key', 'subscription.tier'),
    tools: [readTool('voice_context', 'Read ElevenLabs account tier.')],
  },
  deepgram: {
    provider: 'Deepgram',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://console.deepgram.com/project/default/keys',
    docsUrl: 'https://developers.deepgram.com/docs/create-additional-api-keys',
    status: 'configurable',
    tags: ['voice', 'stt', 'api_key'],
    setupSteps: ['Create a Deepgram API key.', 'Paste and test.'],
    supportedFeatures: ['speech-to-text'],
    httpTest: apiKeyHeaderTest('https://api.deepgram.com/v1/projects', 'Authorization', 'api_key'),
    tools: [readTool('voice_context', 'List Deepgram projects.')],
  },
  stripe: {
    provider: 'Stripe',
    authType: 'api_key',
    fields: [
      token('secret_key', 'Secret key', 'sk_live_... or sk_test_...', 'Use a restricted key when possible.'),
    ],
    credentialUrl: 'https://dashboard.stripe.com/apikeys',
    docsUrl: 'https://docs.stripe.com/keys',
    status: 'configurable',
    tags: ['payments', 'api_key', 'billing'],
    setupSteps: [
      'Open Stripe Dashboard → Developers → API keys.',
      'Copy the secret key (test or live).',
      'Paste and test.',
    ],
    supportedFeatures: ['billing', 'checkout context'],
    httpTest: bearerTest('https://api.stripe.com/v1/balance', 'secret_key'),
    tools: [readTool('billing_context', 'Read Stripe account balance metadata.')],
  },
  discord: {
    provider: 'Discord',
    authType: 'token',
    fields: [token('token', 'Bot token', '...', 'Create a bot in the Discord Developer Portal.')],
    credentialUrl: 'https://discord.com/developers/applications',
    docsUrl: 'https://discord.com/developers/docs/intro',
    status: 'configurable',
    tags: ['messaging', 'community', 'token'],
    setupSteps: ['Create an application and bot.', 'Copy the bot token.', 'Paste and test.'],
    supportedFeatures: ['messaging', 'community bots'],
    httpTest: bearerTest('https://discord.com/api/v10/users/@me', 'token', 'username'),
    tools: [readTool('identity', 'Read bot identity.')],
  },
  twilio: {
    provider: 'Twilio',
    authType: 'api_key',
    fields: [
      text('account_sid', 'Account SID', 'AC...'),
      token('auth_token', 'Auth token', '...'),
    ],
    credentialUrl: 'https://console.twilio.com/',
    docsUrl: 'https://www.twilio.com/docs/usage/api',
    status: 'configurable',
    tags: ['messaging', 'voice', 'sms'],
    setupSteps: [
      'Copy Account SID and Auth Token from the Twilio Console.',
      'Paste both values and test.',
    ],
    supportedFeatures: ['sms', 'voice', 'calling'],
    httpTest: {
      url: 'https://api.twilio.com/2010-04-01/Accounts/{{account_sid}}.json',
      headers: { Authorization: 'Basic {{basic_auth}}' },
      accountLabelPath: 'friendly_name',
    },
    limitations: 'Credentials are encoded for the test request only; secrets are never logged.',
    tools: [readTool('account_context', 'Read Twilio account metadata.')],
  },
  notion: {
    provider: 'Notion',
    authType: 'token',
    fields: [token('token', 'Integration token', 'secret_...')],
    credentialUrl: 'https://www.notion.so/my-integrations',
    docsUrl: 'https://developers.notion.com/docs/create-a-notion-integration',
    status: 'configurable',
    tags: ['productivity', 'notes', 'token'],
    setupSteps: ['Create an internal integration.', 'Copy the internal integration secret.', 'Share pages with the integration.'],
    supportedFeatures: ['notes', 'databases'],
    httpTest: {
      url: 'https://api.notion.com/v1/users/me',
      headers: {
        Authorization: 'Bearer {{token}}',
        'Notion-Version': '2022-06-28',
      },
      accountLabelPath: 'name',
    },
    tools: [readTool('workspace_context', 'Read Notion bot identity.')],
  },
  linear: {
    provider: 'Linear',
    authType: 'token',
    fields: [token('token', 'Personal API key', 'lin_api_...')],
    credentialUrl: 'https://linear.app/settings/api',
    docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    status: 'configurable',
    tags: ['project management', 'issues', 'token'],
    setupSteps: ['Create a Linear personal API key.', 'Paste and test.'],
    supportedFeatures: ['issues', 'projects'],
    httpTest: {
      method: 'POST',
      url: 'https://api.linear.app/graphql',
      headers: {
        Authorization: '{{token}}',
        'Content-Type': 'application/json',
      },
      body: '{"query":"{ viewer { id name email } }"}',
      accountLabelPath: 'data.viewer.name',
    },
    tools: [readTool('issues_context', 'Read Linear workspace identity.')],
  },
  gitlab: {
    provider: 'GitLab',
    authType: 'token',
    fields: [token('token', 'Personal access token', 'glpat-...')],
    credentialUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    docsUrl: 'https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html',
    status: 'configurable',
    tags: ['developer tools', 'git', 'token'],
    setupSteps: ['Create a personal access token with api scope.', 'Paste and test.'],
    supportedFeatures: ['repositories', 'issues', 'merge requests'],
    httpTest: {
      url: 'https://gitlab.com/api/v4/user',
      headers: { 'PRIVATE-TOKEN': '{{token}}' },
      accountLabelPath: 'username',
    },
    tools: [readTool('identity', 'Read GitLab user identity.')],
  },
  bitbucket: {
    provider: 'Atlassian',
    authType: 'token',
    fields: [token('token', 'API token', '...')],
    credentialUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    docsUrl: 'https://developer.atlassian.com/cloud/bitbucket/rest/intro/',
    status: 'configurable',
    tags: ['developer tools', 'git', 'token'],
    setupSteps: ['Create an Atlassian API token.', 'Paste and test against Bitbucket.'],
    supportedFeatures: ['repositories', 'pull requests'],
    httpTest: bearerTest('https://api.bitbucket.org/2.0/user', 'token', 'username'),
    tools: [readTool('identity', 'Read Bitbucket user identity.')],
  },
  vercel: {
    provider: 'Vercel',
    authType: 'token',
    fields: [token('token', 'Access token', '...')],
    credentialUrl: 'https://vercel.com/account/settings/tokens',
    docsUrl: 'https://vercel.com/docs/rest-api',
    status: 'configurable',
    tags: ['hosting', 'deployment', 'token'],
    setupSteps: ['Create a Vercel access token.', 'Paste and test.'],
    supportedFeatures: ['deployments', 'projects'],
    httpTest: bearerTest('https://api.vercel.com/v2/user', 'token', 'user.username'),
    tools: [readTool('deploy_context', 'Read Vercel user identity.')],
  },
  netlify: {
    provider: 'Netlify',
    authType: 'token',
    fields: [token('token', 'Personal access token', '...')],
    credentialUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    docsUrl: 'https://docs.netlify.com/api/get-started/',
    status: 'configurable',
    tags: ['hosting', 'deployment', 'token'],
    setupSteps: ['Create a Netlify personal access token.', 'Paste and test.'],
    supportedFeatures: ['sites', 'deployments'],
    httpTest: bearerTest('https://api.netlify.com/api/v1/user', 'token', 'email'),
    tools: [readTool('deploy_context', 'Read Netlify user identity.')],
  },
  digitalocean: {
    provider: 'DigitalOcean',
    authType: 'token',
    fields: [token('token', 'Personal access token', 'dop_v1_...')],
    credentialUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    docsUrl: 'https://docs.digitalocean.com/reference/api/',
    status: 'configurable',
    tags: ['cloud', 'hosting', 'token'],
    setupSteps: ['Generate a DigitalOcean personal access token.', 'Paste and test.'],
    supportedFeatures: ['droplets', 'kubernetes'],
    httpTest: bearerTest('https://api.digitalocean.com/v2/account', 'token', 'account.email'),
    tools: [readTool('cloud_context', 'Read DigitalOcean account.')],
  },
  sendgrid: {
    provider: 'Twilio SendGrid',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 'SG....')],
    credentialUrl: 'https://app.sendgrid.com/settings/api_keys',
    docsUrl: 'https://docs.sendgrid.com/ui/account-and-settings/api-keys',
    status: 'configurable',
    tags: ['email', 'api_key'],
    setupSteps: ['Create a SendGrid API key with mail send scope.', 'Paste and test.'],
    supportedFeatures: ['transactional email'],
    httpTest: bearerTest('https://api.sendgrid.com/v3/user/profile', 'api_key', 'username'),
    tools: [readTool('email_context', 'Read SendGrid profile.')],
  },
  resend: {
    provider: 'Resend',
    authType: 'api_key',
    fields: [token('api_key', 'API key', 're_...')],
    credentialUrl: 'https://resend.com/api-keys',
    docsUrl: 'https://resend.com/docs/api-reference/introduction',
    status: 'configurable',
    tags: ['email', 'api_key'],
    setupSteps: ['Create a Resend API key.', 'Paste and test.'],
    supportedFeatures: ['transactional email'],
    httpTest: bearerTest('https://api.resend.com/domains', 'api_key'),
    tools: [readTool('email_context', 'List Resend domains.')],
  },
  posthog: {
    provider: 'PostHog',
    authType: 'api_key',
    fields: [
      text('host', 'PostHog host', 'https://us.posthog.com', 'Use your region host.'),
      token('api_key', 'Personal API key', 'phx_...'),
    ],
    credentialUrl: 'https://us.posthog.com/settings/user-api-keys',
    docsUrl: 'https://posthog.com/docs/api',
    status: 'configurable',
    tags: ['analytics', 'api_key'],
    setupSteps: ['Create a personal API key in PostHog.', 'Paste host and key, then test.'],
    supportedFeatures: ['product analytics'],
    httpTest: {
      url: '{{host}}/api/users/@me/',
      headers: { Authorization: 'Bearer {{api_key}}' },
      accountLabelPath: 'email',
    },
    tools: [readTool('analytics_context', 'Read PostHog user identity.')],
  },
  sentry: {
    provider: 'Sentry',
    authType: 'token',
    fields: [token('token', 'Auth token', 'sntrys_...')],
    credentialUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    docsUrl: 'https://docs.sentry.io/api/auth/',
    status: 'configurable',
    tags: ['analytics', 'errors', 'token'],
    setupSteps: ['Create a Sentry user auth token.', 'Paste and test.'],
    supportedFeatures: ['error monitoring'],
    httpTest: bearerTest('https://sentry.io/api/0/', 'token'),
    tools: [readTool('errors_context', 'Verify Sentry API access.')],
  },
  datadog: {
    provider: 'Datadog',
    authType: 'api_key',
    fields: [
      token('api_key', 'API key', '...'),
      token('app_key', 'Application key', '...'),
    ],
    credentialUrl: 'https://app.datadoghq.com/organization-settings/api-keys',
    docsUrl: 'https://docs.datadoghq.com/api/latest/authentication/',
    status: 'configurable',
    tags: ['analytics', 'observability', 'api_key'],
    setupSteps: [
      'Create Datadog API and application keys.',
      'Paste both and test.',
    ],
    supportedFeatures: ['monitoring', 'logs'],
    httpTest: {
      url: 'https://api.datadoghq.com/api/v1/validate',
      headers: {
        'DD-API-KEY': '{{api_key}}',
        'DD-APPLICATION-KEY': '{{app_key}}',
      },
      acceptEmpty: true,
    },
    tools: [readTool('observability_context', 'Validate Datadog credentials.')],
  },
  airtable: {
    provider: 'Airtable',
    authType: 'token',
    fields: [token('token', 'Personal access token', 'pat...')],
    credentialUrl: 'https://airtable.com/create/tokens',
    docsUrl: 'https://airtable.com/developers/web/guides/personal-access-tokens',
    status: 'configurable',
    tags: ['productivity', 'database', 'token'],
    setupSteps: ['Create an Airtable personal access token.', 'Paste and test.'],
    supportedFeatures: ['tables', 'records'],
    httpTest: bearerTest('https://api.airtable.com/v0/meta/whoami', 'token', 'email'),
    tools: [readTool('records_context', 'Read Airtable identity.')],
  },
  trello: {
    provider: 'Atlassian',
    authType: 'token',
    fields: [
      text('api_key', 'API key', '...'),
      token('token', 'Token', '...'),
    ],
    credentialUrl: 'https://trello.com/power-ups/admin',
    docsUrl: 'https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/',
    status: 'configurable',
    tags: ['project management', 'boards'],
    setupSteps: [
      'Generate a Trello Power-Up API key and user token.',
      'Paste both values and test.',
    ],
    supportedFeatures: ['boards', 'cards'],
    httpTest: {
      url: 'https://api.trello.com/1/members/me?key={{api_key}}&token={{token}}',
      accountLabelPath: 'username',
    },
    tools: [readTool('boards_context', 'Read Trello member identity.')],
  },
  asana: {
    provider: 'Asana',
    authType: 'token',
    fields: [token('token', 'Personal access token', '...')],
    credentialUrl: 'https://app.asana.com/0/my-apps',
    docsUrl: 'https://developers.asana.com/docs/personal-access-token',
    status: 'configurable',
    tags: ['project management', 'tasks', 'token'],
    setupSteps: ['Create an Asana personal access token.', 'Paste and test.'],
    supportedFeatures: ['tasks', 'projects'],
    httpTest: bearerTest('https://app.asana.com/api/1.0/users/me', 'token', 'data.email'),
    tools: [readTool('tasks_context', 'Read Asana user identity.')],
  },
  hubspot: {
    provider: 'HubSpot',
    authType: 'token',
    fields: [token('token', 'Private app access token', 'pat-...')],
    credentialUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    docsUrl: 'https://developers.hubspot.com/docs/api/intro-to-auth',
    status: 'configurable',
    tags: ['crm', 'sales', 'token'],
    setupSteps: ['Create a HubSpot private app and copy the access token.', 'Paste and test.'],
    supportedFeatures: ['crm', 'contacts'],
    httpTest: bearerTest('https://api.hubapi.com/integrations/v1/me', 'token', 'portalId'),
    tools: [readTool('crm_context', 'Read HubSpot portal metadata.')],
  },
  mailchimp: {
    provider: 'Intuit Mailchimp',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...-us1')],
    credentialUrl: 'https://admin.mailchimp.com/account/api/',
    docsUrl: 'https://mailchimp.com/developer/marketing/guides/quick-start/',
    status: 'configurable',
    tags: ['email', 'marketing', 'api_key'],
    setupSteps: ['Copy your Mailchimp API key.', 'Paste and test.'],
    supportedFeatures: ['email marketing', 'audiences'],
    httpTest: {
      url: 'https://{{datacenter}}.api.mailchimp.com/3.0/ping',
      headers: { Authorization: 'Bearer {{api_key}}' },
      acceptEmpty: true,
    },
    limitations: 'Datacenter suffix is parsed from the API key during testing.',
    tools: [readTool('marketing_context', 'Verify Mailchimp API access.')],
  },
  plaid: {
    provider: 'Plaid',
    authType: 'api_key',
    fields: [
      text('client_id', 'Client ID', '...'),
      token('secret', 'Secret', '...'),
    ],
    credentialUrl: 'https://dashboard.plaid.com/developers/keys',
    docsUrl: 'https://plaid.com/docs/api/',
    status: 'needs_credentials',
    tags: ['payments', 'banking', 'api_key'],
    setupSteps: [
      'Copy Plaid client ID and secret for your environment.',
      'Paste them here and save.',
      'Complete institution linking in the Plaid dashboard (Manual Setup Required).',
    ],
    supportedFeatures: ['bank linking'],
    limitations: 'Plaid requires institution linking after API credentials are saved.',
    tools: [readTool('finance_context', 'Bank linking capability metadata.')],
  },
  neon: {
    provider: 'Neon',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://console.neon.tech/app/settings/api-keys',
    docsUrl: 'https://neon.tech/docs/reference/api-reference',
    status: 'configurable',
    tags: ['database', 'postgres', 'api_key'],
    setupSteps: ['Create a Neon API key.', 'Paste and test.'],
    supportedFeatures: ['postgres', 'branches'],
    httpTest: bearerTest('https://console.neon.tech/api/v2/users/me', 'api_key', 'email'),
    tools: [readTool('database_context', 'Read Neon account identity.')],
  },
  planetscale: {
    provider: 'PlanetScale',
    authType: 'token',
    fields: [
      text('org', 'Organization', 'your-org'),
      token('token', 'Service token', 'pscale_tkn_...'),
    ],
    credentialUrl: 'https://app.planetscale.com/settings/service-tokens',
    docsUrl: 'https://api-docs.planetscale.com/reference/service-tokens',
    status: 'configurable',
    tags: ['database', 'mysql', 'token'],
    setupSteps: ['Create a PlanetScale service token.', 'Enter org name and token, then test.'],
    supportedFeatures: ['mysql', 'schema branches'],
    httpTest: bearerTest('https://api.planetscale.com/v1/organizations/{{org}}', 'token', 'name'),
    tools: [readTool('database_context', 'Read PlanetScale organization.')],
  },
  upstash: {
    provider: 'Upstash',
    authType: 'api_key',
    fields: [
      token('email', 'Account email', 'you@example.com', 'Used with API key for management API.'),
      token('api_key', 'Management API key', '...'),
    ],
    credentialUrl: 'https://console.upstash.com/account/api',
    docsUrl: 'https://upstash.com/docs/devops/developer-api/introduction',
    status: 'configurable',
    tags: ['database', 'redis', 'api_key'],
    setupSteps: ['Create an Upstash management API key.', 'Paste email and key, then test.'],
    supportedFeatures: ['redis', 'kafka'],
    httpTest: {
      url: 'https://api.upstash.com/v2/redis/databases',
      headers: {
        Authorization: 'Basic {{basic_email_key}}',
      },
    },
    tools: [readTool('database_context', 'List Upstash Redis databases.')],
  },
  pinecone: {
    provider: 'Pinecone',
    authType: 'api_key',
    fields: [token('api_key', 'API key', '...')],
    credentialUrl: 'https://app.pinecone.io/organizations/keys',
    docsUrl: 'https://docs.pinecone.io/guides/get-started/overview',
    status: 'configurable',
    tags: ['vector', 'database', 'api_key'],
    setupSteps: ['Create a Pinecone API key.', 'Paste and test.'],
    supportedFeatures: ['vector search'],
    httpTest: bearerTest('https://api.pinecone.io/indexes', 'api_key'),
    tools: [readTool('vector_context', 'List Pinecone indexes.')],
  },
};

const OAUTH_CATEGORY_DEFAULTS: Partial<RegistryPartial> = {
  authType: 'oauth',
  status: 'needs_credentials',
  fields: [
    text('client_id', 'Client ID', '...'),
    token('client_secret', 'Client secret', '...', 'Stored in the OS keychain only.'),
  ],
  setupSteps: [
    'Create an OAuth application in the provider developer console.',
    'Add the redirect URL shown in the provider docs for desktop apps.',
    'Paste the client ID and secret here.',
    'Complete the browser authorization flow when prompted (Manual Setup Required).',
  ],
  supportedFeatures: ['authenticated context'],
  limitations: 'OAuth approval may require manual setup in the provider console.',
  tools: [readTool('oauth_context', 'OAuth capability metadata after setup.')],
};

const CATEGORY_DEFAULTS: Record<string, Partial<RegistryPartial>> = {
  'Google Workspace': {
    ...OAUTH_CATEGORY_DEFAULTS,
    credentialUrl: 'https://console.cloud.google.com/apis/credentials',
    docsUrl: 'https://developers.google.com/workspace/guides/get-started',
    tags: ['google', 'oauth', 'productivity'],
  },
  'Microsoft 365': {
    ...OAUTH_CATEGORY_DEFAULTS,
    credentialUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    docsUrl: 'https://learn.microsoft.com/graph/auth/',
    tags: ['microsoft', 'oauth', 'productivity'],
  },
  'AI & Data': {
    authType: 'api_key',
    status: 'needs_credentials',
    fields: [token('api_key', 'API key', '...')],
    setupSteps: [
      'Open the provider developer console.',
      'Create an API key or access token.',
      'Paste the credential here and run Test Connection.',
    ],
    supportedFeatures: ['ai context'],
    tags: ['ai', 'api_key'],
    tools: [readTool('capability_context', 'Provider capability metadata.')],
  },
  Payments: {
    authType: 'api_key',
    status: 'needs_credentials',
    fields: [token('secret_key', 'Secret / API key', '...')],
    setupSteps: [
      'Open the provider dashboard developer section.',
      'Create or copy the secret/API key.',
      'Paste and test.',
    ],
    supportedFeatures: ['payments', 'billing'],
    tags: ['payments', 'api_key'],
    tools: [readTool('payments_context', 'Payments capability metadata.')],
  },
  Databases: {
    authType: 'api_key',
    status: 'needs_credentials',
    fields: [
      text('connection_url', 'Connection URL or host', 'postgres://... or https://...'),
      token('credential', 'Password / API key', '...'),
    ],
    setupSteps: [
      'Copy the connection URL or API credentials from your database provider.',
      'Paste them here.',
      'Run Test Connection to validate what can be checked safely.',
    ],
    supportedFeatures: ['database context'],
    tags: ['database'],
    tools: [readTool('database_context', 'Database capability metadata.')],
  },
};

const GENERIC_DEFAULT: Partial<RegistryPartial> = {
  authType: 'token',
  status: 'needs_credentials',
  fields: [token('token', 'API token or key', '...')],
  setupSteps: [
    'Open the official developer console for this service.',
    'Create an API token or key with the minimum required scopes.',
    'Paste the credential here.',
    'Run Test Connection.',
  ],
  supportedFeatures: ['integration context'],
  tags: ['integration'],
  tools: [readTool('capability_context', 'Integration capability metadata.')],
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function defaultDescription(name: string, category: string): string {
  return `${name} integration for ${category.toLowerCase()} workflows, agent context, and MCP-style tools.`;
}

function mergeManifest(
  id: string,
  name: string,
  category: string,
  override?: RegistryPartial,
  categoryDefault?: Partial<RegistryPartial>,
): PluginManifest {
  const base = { ...GENERIC_DEFAULT, ...categoryDefault, ...override };
  const provider = base.provider ?? name;
  const status = base.status ?? 'needs_credentials';
  const authType = base.authType ?? 'token';
  const fields = base.fields ?? GENERIC_DEFAULT.fields ?? [];
  const docsUrl = base.docsUrl;
  const credentialUrl = base.credentialUrl ?? docsUrl;
  const setupSteps = base.setupSteps ?? GENERIC_DEFAULT.setupSteps ?? [];
  const tags = [...new Set([...(base.tags ?? []), category.toLowerCase(), authType])];
  const tools = base.tools ?? [readTool('capability_context', `${name} capability metadata.`)];
  const description = base.description ?? defaultDescription(name, category);
  const help =
    base.help ??
    (status === 'needs_credentials'
      ? 'Manual setup may be required. Follow the steps below, use the official credential link, then test the connection.'
      : 'Enter credentials from the official provider console, then test the connection.');

  return {
    id,
    name,
    description,
    category,
    provider,
    authType,
    fields,
    status,
    docsUrl,
    credentialUrl,
    help,
    tools,
    tags,
    setupSteps,
    supportedFeatures: base.supportedFeatures ?? ['integration context'],
    limitations: base.limitations,
    httpTest: base.httpTest,
  };
}

export function buildCatalogEntry(name: string, category: string): PluginManifest {
  const id = slugify(name);
  return mergeManifest(id, name, category, PROVIDER_OVERRIDES[id], CATEGORY_DEFAULTS[category]);
}

export function pluginSearchBlob(plugin: PluginManifest, connectionState?: string): string {
  return [
    plugin.name,
    plugin.provider,
    plugin.description,
    plugin.category,
    plugin.authType,
    plugin.status,
    connectionState ?? '',
    plugin.help,
    plugin.limitations ?? '',
    ...plugin.tags,
    ...plugin.supportedFeatures,
    ...plugin.fields.map((field) => `${field.label} ${field.id}`),
    ...plugin.setupSteps,
  ]
    .join(' ')
    .toLowerCase();
}
