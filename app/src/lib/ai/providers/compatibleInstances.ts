import { makeOpenAICompatibleProvider } from './openai-compatible';
import { activeQwenCompatibleBaseUrl } from '../nativeConnectionProbe';

export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
export const MISTRAL_DEFAULT_MODEL = 'mistral-large-latest';
export const TOGETHER_DEFAULT_MODEL = 'Qwen/Qwen3.5-397B-A17B';
export const XAI_DEFAULT_MODEL = 'grok-4.5';
export const QWEN_DEFAULT_MODEL = 'qwen3.7-plus';
export const ZAI_DEFAULT_MODEL = 'glm-5.1';

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
  transport: 'native',
});

export const deepseekProvider = makeOpenAICompatibleProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  apiKeyStoreKey: 'deepseek',
  defaultModel: DEEPSEEK_DEFAULT_MODEL,
  transport: 'native',
});

export const mistralProvider = makeOpenAICompatibleProvider({
  id: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  apiKeyStoreKey: 'mistral',
  defaultModel: MISTRAL_DEFAULT_MODEL,
  transport: 'native',
});

export const togetherProvider = makeOpenAICompatibleProvider({
  id: 'together',
  name: 'Together',
  baseUrl: 'https://api.together.xyz/v1',
  apiKeyStoreKey: 'together',
  defaultModel: TOGETHER_DEFAULT_MODEL,
  transport: 'native',
});

export const xaiProvider = makeOpenAICompatibleProvider({
  id: 'xai',
  name: 'xAI',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyStoreKey: 'xai',
  defaultModel: XAI_DEFAULT_MODEL,
  transport: 'native',
});

export const qwenProvider = makeOpenAICompatibleProvider({
  id: 'qwen',
  name: 'Qwen / Alibaba Cloud',
  baseUrl: activeQwenCompatibleBaseUrl,
  apiKeyStoreKey: 'qwen',
  defaultModel: QWEN_DEFAULT_MODEL,
  transport: 'native',
});

export const zaiProvider = makeOpenAICompatibleProvider({
  id: 'zai',
  name: 'Z.AI / GLM',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  apiKeyStoreKey: 'zai',
  defaultModel: ZAI_DEFAULT_MODEL,
  transport: 'native',
});
