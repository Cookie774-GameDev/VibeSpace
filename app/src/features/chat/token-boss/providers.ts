export type TokenBossProviderId =
  | 'codex'
  | 'gemini'
  | 'chatgpt'
  | 'claude'
  | 'grok'
  | 'deepseek'
  | 'qwen'
  | 'llama'
  | 'kimi'
  | 'mistral'
  | 'perplexity'
  | 'cohere'
  | 'minimax'
  | 'nemotron'
  | 'ollama';

export interface TokenBossProvider {
  id: TokenBossProviderId;
  name: string;
  symbol: string;
  code: string;
  accent: string;
  accent2: string;
  tagline: string;
}

export interface CurrentModelContext {
  providerId?: string;
  providerName?: string;
  connectionId?: string;
  modelId?: string;
  modelName?: string;
  runtimeId?: string;
}

export const TOKEN_BOSS_PROVIDERS: readonly TokenBossProvider[] = Object.freeze([
  {
    id: 'codex',
    name: 'Codex',
    symbol: 'C',
    code: 'CX',
    accent: '#73e7ed',
    accent2: '#f0b66d',
    tagline: 'Coding token · forged execution coin',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    symbol: 'G',
    code: 'GM',
    accent: '#8ab4ff',
    accent2: '#d6b8ff',
    tagline: 'Gemini token · weekly usage demolition',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    symbol: 'GPT',
    code: 'GPT',
    accent: '#79e3bc',
    accent2: '#c8ffe7',
    tagline: 'ChatGPT token · weekly usage demolition',
  },
  {
    id: 'claude',
    name: 'Claude',
    symbol: 'CL',
    code: 'CL',
    accent: '#e39a72',
    accent2: '#ffd1b5',
    tagline: 'Claude token · weekly usage demolition',
  },
  {
    id: 'grok',
    name: 'Grok',
    symbol: 'X',
    code: 'GX',
    accent: '#e7edf4',
    accent2: '#91a2b4',
    tagline: 'Grok token · weekly usage demolition',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    symbol: 'DS',
    code: 'DS',
    accent: '#6aa7ff',
    accent2: '#bfd8ff',
    tagline: 'DeepSeek token · open-model finisher',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    symbol: 'Q',
    code: 'QW',
    accent: '#bd8cff',
    accent2: '#ead8ff',
    tagline: 'Qwen token · open-model finisher',
  },
  {
    id: 'llama',
    name: 'Llama',
    symbol: 'L',
    code: 'LM',
    accent: '#77baff',
    accent2: '#ffd18c',
    tagline: 'Llama token · open-model finisher',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    symbol: 'K',
    code: 'KM',
    accent: '#63ddd2',
    accent2: '#c2fff8',
    tagline: 'Kimi token · context-window crusher',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    symbol: 'M',
    code: 'MI',
    accent: '#ff9e55',
    accent2: '#ffd0a6',
    tagline: 'Mistral token · open-model finisher',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    symbol: 'P',
    code: 'PX',
    accent: '#5fd0c9',
    accent2: '#d4fffb',
    tagline: 'Perplexity token · research usage crusher',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    symbol: 'CO',
    code: 'CO',
    accent: '#ff8e88',
    accent2: '#ffd0cc',
    tagline: 'Cohere token · enterprise usage crusher',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    symbol: 'MM',
    code: 'MM',
    accent: '#ff77bb',
    accent2: '#ffd0e8',
    tagline: 'MiniMax token · multimodal finisher',
  },
  {
    id: 'nemotron',
    name: 'Nemotron',
    symbol: 'N',
    code: 'NM',
    accent: '#b8e35c',
    accent2: '#efffc1',
    tagline: 'Nemotron token · open-model finisher',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    symbol: 'O',
    code: 'OL',
    accent: '#f2e8d5',
    accent2: '#aeb8c6',
    tagline: 'Ollama token · local-model finisher',
  },
]);

const PROVIDER_BY_ID = new Map(TOKEN_BOSS_PROVIDERS.map((provider) => [provider.id, provider]));

function normalizedSignals(context: CurrentModelContext): string[] {
  return [
    context.providerId,
    context.providerName,
    context.connectionId,
    context.modelId,
    context.modelName,
    context.runtimeId,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
}

function containsAny(signals: readonly string[], aliases: readonly string[]): boolean {
  return signals.some((signal) => aliases.some((alias) => signal.includes(alias)));
}

function provider(id: TokenBossProviderId): TokenBossProvider {
  return PROVIDER_BY_ID.get(id)!;
}

export function resolveTokenBossProvider(context: CurrentModelContext): TokenBossProvider | null {
  const signals = normalizedSignals(context);
  if (signals.length === 0) return null;

  const explicitLocalRuntime = [context.runtimeId, context.connectionId, context.providerId]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => /(^|[-_:./\s])ollama($|[-_:./\s])|^ollama$/i.test(value));
  if (explicitLocalRuntime) return provider('ollama');

  // Codex must precede the generic OpenAI/GPT family.
  if (containsAny(signals, ['codex'])) return provider('codex');
  if (containsAny(signals, ['gemini', 'google ai', 'google'])) return provider('gemini');
  if (containsAny(signals, ['chatgpt', 'openai', 'gpt-'])) return provider('chatgpt');
  if (containsAny(signals, ['claude', 'anthropic'])) return provider('claude');
  if (containsAny(signals, ['grok', 'xai', 'x.ai'])) return provider('grok');
  if (containsAny(signals, ['deepseek', 'deepsea'])) return provider('deepseek');
  if (containsAny(signals, ['qwen', 'alibaba', 'dashscope', 'quinn'])) return provider('qwen');
  if (containsAny(signals, ['llama', 'meta'])) return provider('llama');
  if (containsAny(signals, ['kimi', 'moonshot'])) return provider('kimi');
  if (containsAny(signals, ['mistral', 'mixtral'])) return provider('mistral');
  if (containsAny(signals, ['perplexity', 'pplx', 'sonar'])) return provider('perplexity');
  if (containsAny(signals, ['cohere', 'command-r'])) return provider('cohere');
  if (containsAny(signals, ['minimax', 'mini-max', 'mini max'])) return provider('minimax');
  if (containsAny(signals, ['nemotron', 'nvidia'])) return provider('nemotron');

  return null;
}

export function getTokenBossProvider(id: TokenBossProviderId): TokenBossProvider {
  return provider(id);
}
