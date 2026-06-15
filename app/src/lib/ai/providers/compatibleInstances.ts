import { makeOpenAICompatibleProvider } from './openai-compatible';

export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
export const MISTRAL_DEFAULT_MODEL = 'mistral-large-latest';
export const TOGETHER_DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
export const XAI_DEFAULT_MODEL = 'grok-2-1212';

export const openrouterProvider = makeOpenAICompatibleProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyStoreKey: 'openrouter',
  defaultModel: OPENROUTER_DEFAULT_MODEL,
  extraHeaders: {
    'HTTP-Referer': 'https://vibespace.app',
    'X-Title': 'VibeSpace',
  },
});

export const deepseekProvider = makeOpenAICompatibleProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  apiKeyStoreKey: 'deepseek',
  defaultModel: DEEPSEEK_DEFAULT_MODEL,
});

export const mistralProvider = makeOpenAICompatibleProvider({
  id: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  apiKeyStoreKey: 'mistral',
  defaultModel: MISTRAL_DEFAULT_MODEL,
});

export const togetherProvider = makeOpenAICompatibleProvider({
  id: 'together',
  name: 'Together',
  baseUrl: 'https://api.together.xyz/v1',
  apiKeyStoreKey: 'together',
  defaultModel: TOGETHER_DEFAULT_MODEL,
});

export const xaiProvider = makeOpenAICompatibleProvider({
  id: 'xai',
  name: 'xAI',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyStoreKey: 'xai',
  defaultModel: XAI_DEFAULT_MODEL,
});
