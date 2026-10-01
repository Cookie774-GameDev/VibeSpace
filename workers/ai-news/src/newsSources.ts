export type NewsSourceType =
  | 'rss'
  | 'atom'
  | 'github_releases'
  | 'youtube_feed'
  | 'x'
  | 'official_site';

export interface NewsSourceDefinition {
  id: string;
  company: string;
  priority: number;
  enabled: boolean;
  sourceType: NewsSourceType;
  endpoint?: string;
  officialSite?: string;
  xHandle?: string;
  verification: 'official' | 'confirmed';
  rotationGroup: number;
  disabledReason?: string;
  tags?: string[];
}

const release = (
  id: string,
  company: string,
  repository: string,
  priority: number,
  rotationGroup: number,
  tags: string[] = [],
): NewsSourceDefinition => ({
  id,
  company,
  priority,
  enabled: true,
  sourceType: 'github_releases',
  endpoint: `https://github.com/${repository}/releases.atom`,
  officialSite: `https://github.com/${repository}`,
  verification: 'official',
  rotationGroup,
  tags,
});

const x = (
  id: string,
  company: string,
  xHandle: string,
  priority: number,
  rotationGroup: number,
): NewsSourceDefinition => ({
  id,
  company,
  priority,
  enabled: true,
  sourceType: 'x',
  officialSite: `https://x.com/${xHandle}`,
  xHandle,
  verification: 'official',
  rotationGroup,
  tags: ['x'],
});

const unavailableSite = (
  id: string,
  company: string,
  officialSite: string,
  priority: number,
  rotationGroup: number,
  disabledReason: string,
): NewsSourceDefinition => ({
  id,
  company,
  priority,
  enabled: false,
  sourceType: 'official_site',
  officialSite,
  verification: 'official',
  rotationGroup,
  disabledReason,
});

/**
 * Reviewable registry of high-value official AI sources. Disabled entries are
 * intentionally retained so /health can distinguish unsupported capability
 * from a silently missing company. No authenticated HTML scraping is used.
 */
export const NEWS_SOURCES: readonly NewsSourceDefinition[] = [
  {
    id: 'openai-news',
    company: 'OpenAI',
    priority: 100,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://openai.com/news/rss.xml',
    officialSite: 'https://openai.com/news/',
    verification: 'official',
    rotationGroup: 0,
    tags: ['models', 'api', 'research', 'company'],
  },
  {
    id: 'anthropic-news',
    company: 'Anthropic',
    priority: 100,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://www.anthropic.com/news/rss.xml',
    officialSite: 'https://www.anthropic.com/news',
    verification: 'official',
    rotationGroup: 0,
    tags: ['models', 'api', 'research', 'safety'],
  },
  {
    id: 'google-ai-blog',
    company: 'Google AI',
    priority: 99,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://blog.google/technology/ai/rss/',
    officialSite: 'https://blog.google/technology/ai/',
    verification: 'official',
    rotationGroup: 0,
    tags: ['models', 'products', 'research'],
  },
  {
    id: 'google-deepmind-blog',
    company: 'Google DeepMind',
    priority: 99,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://deepmind.google/blog/rss.xml',
    officialSite: 'https://deepmind.google/discover/blog/',
    verification: 'official',
    rotationGroup: 0,
    tags: ['models', 'research', 'safety'],
  },
  {
    id: 'microsoft-ai-blog',
    company: 'Microsoft AI',
    priority: 95,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://blogs.microsoft.com/ai/feed/',
    officialSite: 'https://blogs.microsoft.com/ai/',
    verification: 'official',
    rotationGroup: 0,
    tags: ['models', 'copilot', 'cloud'],
  },
  {
    id: 'nvidia-generative-ai',
    company: 'NVIDIA',
    priority: 95,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://developer.nvidia.com/blog/category/generative-ai/feed/',
    officialSite: 'https://developer.nvidia.com/blog/category/generative-ai/',
    verification: 'official',
    rotationGroup: 0,
    tags: ['models', 'inference', 'developer-tools'],
  },
  {
    id: 'huggingface-blog',
    company: 'Hugging Face',
    priority: 94,
    enabled: true,
    sourceType: 'rss',
    endpoint: 'https://huggingface.co/blog/feed.xml',
    officialSite: 'https://huggingface.co/blog',
    verification: 'official',
    rotationGroup: 0,
    tags: ['open-models', 'research', 'developer-tools'],
  },
  release('openai-python-releases', 'OpenAI', 'openai/openai-python', 93, 1, ['sdk']),
  release('openai-node-releases', 'OpenAI', 'openai/openai-node', 92, 2, ['sdk']),
  release('anthropic-claude-code-releases', 'Anthropic', 'anthropics/claude-code', 96, 1, [
    'coding-agent',
  ]),
  release('google-python-genai-releases', 'Google AI', 'googleapis/python-genai', 92, 2, [
    'sdk',
  ]),
  release('google-js-genai-releases', 'Google AI', 'googleapis/js-genai', 91, 3, ['sdk']),
  release('meta-llama-models-releases', 'Meta AI', 'meta-llama/llama-models', 91, 1, [
    'open-models',
  ]),
  release('mistral-python-releases', 'Mistral AI', 'mistralai/client-python', 90, 2, ['sdk']),
  release('deepseek-v3-releases', 'DeepSeek', 'deepseek-ai/DeepSeek-V3', 90, 3, [
    'open-models',
  ]),
  release('qwen3-releases', 'Alibaba Qwen', 'QwenLM/Qwen3', 90, 1, ['open-models']),
  release('kimi-k2-releases', 'Moonshot AI', 'MoonshotAI/Kimi-K2', 89, 2, ['open-models']),
  release('glm4-releases', 'Zhipu AI', 'THUDM/GLM-4', 88, 3, ['open-models']),
  release('minimax-text-releases', 'MiniMax', 'MiniMax-AI/MiniMax-Text-01', 87, 1, [
    'open-models',
  ]),
  release('cohere-python-releases', 'Cohere', 'cohere-ai/cohere-python', 87, 2, ['sdk']),
  release('ai21-python-releases', 'AI21 Labs', 'AI21Labs/ai21-python', 85, 3, ['sdk']),
  release('transformers-releases', 'Hugging Face', 'huggingface/transformers', 94, 1, [
    'open-models',
    'developer-tools',
  ]),
  release('groq-python-releases', 'Groq', 'groq/groq-python', 88, 2, ['inference', 'sdk']),
  release(
    'cerebras-cloud-sdk-releases',
    'Cerebras',
    'Cerebras/cerebras-cloud-sdk-python',
    86,
    3,
    ['inference', 'sdk'],
  ),
  release('together-python-releases', 'Together AI', 'togethercomputer/together-python', 86, 1, [
    'inference',
    'sdk',
  ]),
  release('fireworks-python-releases', 'Fireworks AI', 'fireworks-ai/fireworks-ai-python', 85, 2, [
    'inference',
    'sdk',
  ]),
  release('ollama-releases', 'Ollama', 'ollama/ollama', 94, 3, ['local-ai']),
  release('vercel-ai-sdk-releases', 'Vercel AI SDK', 'vercel/ai', 91, 1, ['developer-tools']),
  release('langchain-releases', 'LangChain', 'langchain-ai/langchain', 89, 2, [
    'agents',
    'developer-tools',
  ]),
  release('llamaindex-releases', 'LlamaIndex', 'run-llama/llama_index', 88, 3, [
    'rag',
    'agents',
  ]),
  release('aider-releases', 'Aider', 'Aider-AI/aider', 87, 1, ['coding-agent']),
  release('continue-releases', 'Continue', 'continuedev/continue', 87, 2, ['coding-agent']),
  release('mcp-spec-releases', 'Model Context Protocol', 'modelcontextprotocol/specification', 93, 3, [
    'mcp',
  ]),
  release('mcp-typescript-sdk-releases', 'Model Context Protocol', 'modelcontextprotocol/typescript-sdk', 91, 1, [
    'mcp',
    'sdk',
  ]),
  release('vllm-releases', 'vLLM', 'vllm-project/vllm', 89, 2, ['inference', 'open-source']),
  release('llamacpp-releases', 'llama.cpp', 'ggml-org/llama.cpp', 89, 3, [
    'local-ai',
    'inference',
  ]),
  release('sglang-releases', 'SGLang', 'sgl-project/sglang', 86, 1, ['inference']),
  release('litellm-releases', 'LiteLLM', 'BerriAI/litellm', 86, 2, ['gateway', 'developer-tools']),
  release('crewai-releases', 'CrewAI', 'crewAIInc/crewAI', 84, 3, ['agents']),
  release('pydantic-ai-releases', 'Pydantic AI', 'pydantic/pydantic-ai', 85, 1, ['agents', 'sdk']),
  release('openhands-releases', 'OpenHands', 'All-Hands-AI/OpenHands', 86, 2, ['coding-agent']),
  release('elevenlabs-python-releases', 'ElevenLabs', 'elevenlabs/elevenlabs-python', 82, 3, [
    'audio',
    'sdk',
  ]),
  release('stability-generative-models-releases', 'Stability AI', 'Stability-AI/generative-models', 82, 1, [
    'image',
    'open-models',
  ]),
  release('google-gemma-releases', 'Google AI', 'google-deepmind/gemma', 88, 2, ['open-models']),

  x('openai-x', 'OpenAI', 'OpenAI', 100, 0),
  x('anthropic-x', 'Anthropic', 'AnthropicAI', 100, 1),
  x('deepmind-x', 'Google DeepMind', 'GoogleDeepMind', 99, 2),
  x('xai-x', 'xAI', 'xai', 98, 3),
  x('meta-ai-x', 'Meta AI', 'AIatMeta', 96, 0),
  x('microsoft-ai-x', 'Microsoft AI', 'MicrosoftAI', 94, 1),
  x('nvidia-ai-x', 'NVIDIA', 'NVIDIAAI', 94, 2),
  x('mistral-x', 'Mistral AI', 'MistralAI', 93, 3),
  x('huggingface-x', 'Hugging Face', 'huggingface', 93, 0),
  x('openrouter-x', 'OpenRouter', 'OpenRouterAI', 90, 1),
  x('groq-x', 'Groq', 'GroqInc', 89, 2),
  x('cerebras-x', 'Cerebras', 'CerebrasSystems', 87, 3),
  x('together-x', 'Together AI', 'togethercompute', 87, 0),
  x('fireworks-x', 'Fireworks AI', 'FireworksAI_HQ', 86, 1),
  x('ollama-x', 'Ollama', 'ollama', 91, 2),
  x('cursor-x', 'Cursor', 'cursor_ai', 91, 3),
  x('windsurf-x', 'Windsurf', 'windsurf', 88, 0),
  x('cognition-x', 'Cognition', 'cognition_labs', 89, 1),
  x('replit-x', 'Replit', 'Replit', 87, 2),
  x('vercel-x', 'Vercel', 'vercel', 86, 3),

  unavailableSite(
    'deepseek-official-site',
    'DeepSeek',
    'https://www.deepseek.com/',
    90,
    0,
    'No stable official RSS/Atom endpoint is configured; GitHub releases remain active.',
  ),
  unavailableSite(
    'qwen-official-site',
    'Alibaba Qwen',
    'https://qwenlm.github.io/',
    90,
    1,
    'No stable official RSS/Atom endpoint is configured; GitHub releases remain active.',
  ),
  unavailableSite(
    'kimi-official-site',
    'Moonshot AI',
    'https://www.moonshot.cn/',
    89,
    2,
    'No stable official feed is configured; GitHub releases remain active.',
  ),
  unavailableSite(
    'zhipu-official-site',
    'Zhipu AI',
    'https://www.zhipuai.cn/',
    88,
    3,
    'No stable official feed is configured; GitHub releases remain active.',
  ),
  unavailableSite(
    'minimax-official-site',
    'MiniMax',
    'https://www.minimax.io/',
    87,
    0,
    'No stable official feed is configured; GitHub releases remain active.',
  ),
  unavailableSite(
    'openrouter-official-site',
    'OpenRouter',
    'https://openrouter.ai/announcements',
    90,
    1,
    'No stable unauthenticated RSS/Atom endpoint is configured; official X remains optional.',
  ),
  unavailableSite(
    'cursor-official-site',
    'Cursor',
    'https://www.cursor.com/changelog',
    91,
    2,
    'No stable RSS/Atom endpoint is configured; official X remains optional.',
  ),
  unavailableSite(
    'windsurf-official-site',
    'Windsurf',
    'https://windsurf.com/changelog',
    88,
    3,
    'No stable RSS/Atom endpoint is configured; official X remains optional.',
  ),
  unavailableSite(
    'cognition-official-site',
    'Cognition',
    'https://cognition.ai/blog',
    89,
    0,
    'No stable RSS/Atom endpoint is configured; official X remains optional.',
  ),
  unavailableSite(
    'replit-official-site',
    'Replit',
    'https://blog.replit.com/',
    87,
    1,
    'No stable feed endpoint is configured in the Worker; official X remains optional.',
  ),
  unavailableSite(
    'runway-official-site',
    'Runway',
    'https://runwayml.com/news/',
    82,
    2,
    'No stable official RSS/Atom endpoint is configured.',
  ),
  unavailableSite(
    'perplexity-official-site',
    'Perplexity',
    'https://www.perplexity.ai/hub/blog',
    86,
    3,
    'No stable official RSS/Atom endpoint is configured.',
  ),
  unavailableSite(
    'stability-official-site',
    'Stability AI',
    'https://stability.ai/news',
    82,
    0,
    'No stable official feed is configured; GitHub releases remain active.',
  ),
  unavailableSite(
    'elevenlabs-official-site',
    'ElevenLabs',
    'https://elevenlabs.io/blog',
    82,
    1,
    'No stable official feed is configured; SDK releases remain active.',
  ),
  unavailableSite(
    'modelcontextprotocol-official-site',
    'Model Context Protocol',
    'https://modelcontextprotocol.io/',
    93,
    2,
    'The specification and SDK release feeds are the configured official channels.',
  ),
] as const;

export interface SourceRegistryValidation {
  valid: boolean;
  errors: string[];
  sourceCount: number;
  enabledCount: number;
}

export function validateNewsSourceRegistry(
  sources: readonly NewsSourceDefinition[] = NEWS_SOURCES,
): SourceRegistryValidation {
  const errors: string[] = [];
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const xHandles = new Set<string>();

  if (sources.length < 50 || sources.length > 100) {
    errors.push(`Source count must be between 50 and 100; received ${sources.length}.`);
  }

  for (const source of sources) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(source.id)) errors.push(`Invalid source id: ${source.id}`);
    if (ids.has(source.id)) errors.push(`Duplicate source id: ${source.id}`);
    ids.add(source.id);
    if (!source.company.trim()) errors.push(`Missing company for ${source.id}`);
    if (!Number.isInteger(source.priority) || source.priority < 1 || source.priority > 100) {
      errors.push(`Invalid priority for ${source.id}`);
    }
    if (source.verification !== 'official' && source.verification !== 'confirmed') {
      errors.push(`Invalid verification for ${source.id}`);
    }
    if (source.enabled && source.sourceType !== 'x' && !source.endpoint) {
      errors.push(`Enabled source ${source.id} has no endpoint.`);
    }
    if (source.enabled && source.sourceType === 'x' && !source.xHandle) {
      errors.push(`Enabled X source ${source.id} has no handle.`);
    }
    if (!source.enabled && !source.disabledReason) {
      errors.push(`Disabled source ${source.id} has no reason.`);
    }
    for (const value of [source.endpoint, source.officialSite]) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') errors.push(`Non-HTTPS URL for ${source.id}`);
      } catch {
        errors.push(`Invalid URL for ${source.id}`);
      }
    }
    if (source.endpoint) {
      if (endpoints.has(source.endpoint)) errors.push(`Duplicate endpoint: ${source.endpoint}`);
      endpoints.add(source.endpoint);
    }
    if (source.xHandle) {
      const normalized = source.xHandle.toLowerCase();
      if (xHandles.has(normalized)) errors.push(`Duplicate X handle: ${source.xHandle}`);
      xHandles.add(normalized);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sourceCount: sources.length,
    enabledCount: sources.filter((source) => source.enabled).length,
  };
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Keeps core feeds in every hourly run and rotates the long tail deterministically.
 * X is capped separately because the API is optional and rate-limited.
 */
export function selectNewsSourcesForRun(
  scheduledAt: string,
  {
    maxSources = 24,
    maxX = 2,
    sources = NEWS_SOURCES,
  }: {
    maxSources?: number;
    maxX?: number;
    sources?: readonly NewsSourceDefinition[];
  } = {},
): NewsSourceDefinition[] {
  const hour = new Date(scheduledAt).toISOString().slice(0, 13);
  const enabled = sources.filter((source) => source.enabled);
  const core = enabled
    .filter((source) => source.sourceType !== 'x' && source.priority >= 94)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const rotatingFeeds = enabled
    .filter((source) => source.sourceType !== 'x' && source.priority < 94)
    .sort((left, right) => {
      const leftOrder = hash32(`${hour}:${left.rotationGroup}:${left.id}`);
      const rightOrder = hash32(`${hour}:${right.rotationGroup}:${right.id}`);
      return leftOrder - rightOrder || right.priority - left.priority || left.id.localeCompare(right.id);
    });
  const xSources = enabled
    .filter((source) => source.sourceType === 'x')
    .sort((left, right) => {
      const leftOrder = hash32(`${hour}:x:${left.rotationGroup}:${left.id}`);
      const rightOrder = hash32(`${hour}:x:${right.rotationGroup}:${right.id}`);
      return leftOrder - rightOrder || right.priority - left.priority || left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(0, maxX));

  const chosen: NewsSourceDefinition[] = [];
  const add = (source: NewsSourceDefinition) => {
    if (chosen.length >= Math.max(1, maxSources)) return;
    if (!chosen.some((entry) => entry.id === source.id)) chosen.push(source);
  };
  core.forEach(add);
  rotatingFeeds.forEach(add);
  xSources.forEach(add);
  return chosen.slice(0, Math.max(1, maxSources));
}
