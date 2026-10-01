import type {
  ProviderUsageAdapter,
  ProviderUsageDefinition,
  ProviderUsageSnapshot,
  ProviderUsageUnit,
} from './providerUsageTypes';
import { reconcileProviderAndLocalUsage } from './taskbarUsageModel';

const route = (
  id: string,
  label: string,
  type: ProviderUsageDefinition['routes'][number]['type'],
) => ({ id, label, type }) as const;

export const PROVIDER_USAGE_DEFINITIONS: readonly ProviderUsageDefinition[] = Object.freeze([
  {
    id: 'openai',
    displayName: 'OpenAI',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key'), route('codex', 'Codex CLI', 'cli_bridge')],
    usageCapability: 'partial',
    billingUrl: 'https://platform.openai.com/usage',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key'), route('claude-code', 'Claude Code', 'cli_bridge')],
    usageCapability: 'partial',
  },
  {
    id: 'google-gemini',
    displayName: 'Google Gemini',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key'), route('cli', 'Gemini CLI', 'cli_bridge')],
    usageCapability: 'partial',
  },
  {
    id: 'google-vertex',
    displayName: 'Google Vertex AI',
    category: 'llm',
    routes: [route('cloud', 'Cloud credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'azure-openai',
    displayName: 'Azure OpenAI',
    category: 'llm',
    routes: [route('cloud', 'Azure credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'aws-bedrock',
    displayName: 'AWS Bedrock',
    category: 'llm',
    routes: [route('cloud', 'AWS credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
    billingUrl: 'https://console.deepgram.com/accounts-and-billing',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'supported',
  },
  {
    id: 'together-ai',
    displayName: 'Together AI',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'fireworks-ai',
    displayName: 'Fireworks AI',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'perplexity',
    displayName: 'Perplexity',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'sambanova',
    displayName: 'SambaNova',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'nvidia-nim',
    displayName: 'NVIDIA NIM',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'hugging-face',
    displayName: 'Hugging Face',
    category: 'platform',
    routes: [route('api', 'Access token', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'replicate',
    displayName: 'Replicate',
    category: 'platform',
    routes: [route('api', 'API token', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'cloudflare-workers-ai',
    displayName: 'Cloudflare Workers AI',
    category: 'platform',
    routes: [route('cloud', 'Cloud credential', 'cloud_credential')],
    usageCapability: 'supported',
  },
  {
    id: 'ibm-watsonx',
    displayName: 'IBM watsonx',
    category: 'llm',
    routes: [route('cloud', 'Cloud credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'alibaba-model-studio',
    displayName: 'Alibaba Model Studio',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'moonshot-kimi',
    displayName: 'Moonshot / Kimi',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'zhipu-glm',
    displayName: 'Zhipu / GLM',
    category: 'llm',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'baidu-qianfan',
    displayName: 'Baidu Qianfan',
    category: 'llm',
    routes: [route('cloud', 'Cloud credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'tencent-hunyuan',
    displayName: 'Tencent Hunyuan',
    category: 'llm',
    routes: [route('cloud', 'Cloud credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'volcano-ark',
    displayName: 'Volcano Ark / Doubao',
    category: 'llm',
    routes: [route('cloud', 'Cloud credential', 'cloud_credential')],
    usageCapability: 'partial',
  },
  {
    id: 'deepgram',
    displayName: 'Deepgram',
    category: 'speech',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'assemblyai',
    displayName: 'AssemblyAI',
    category: 'speech',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'partial',
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    category: 'speech',
    routes: [route('api', 'API key', 'api_key')],
    usageCapability: 'supported',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    category: 'llm',
    routes: [route('local', 'Local runtime', 'local_runtime')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'lm-studio',
    displayName: 'LM Studio',
    category: 'llm',
    routes: [route('local', 'Local runtime', 'local_runtime')],
    usageCapability: 'estimate_only',
  },
  {
    id: 'local-openai-compatible',
    displayName: 'Local OpenAI-compatible',
    category: 'llm',
    routes: [route('local', 'Local runtime', 'local_runtime')],
    usageCapability: 'unsupported',
  },
]);

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeProviderUsageSnapshot(
  value: ProviderUsageSnapshot,
): ProviderUsageSnapshot {
  const usageValue = boundedNumber(value.usageValue);
  const usageLimit = boundedNumber(value.usageLimit);
  const explicitPercent = boundedNumber(value.usagePercent);
  const usagePercent =
    explicitPercent !== null
      ? Math.min(100, explicitPercent)
      : usageValue !== null && usageLimit !== null && usageLimit > 0
        ? Math.min(100, (usageValue / usageLimit) * 100)
        : null;
  const localUsageValue = boundedNumber(value.localUsageValue);
  const localUsageUnit = value.localUsageUnit ?? null;
  return Object.freeze({
    ...value,
    providerId: value.providerId.slice(0, 96),
    displayName: value.displayName.slice(0, 80),
    activeRequests: Math.max(0, Math.floor(value.activeRequests)),
    usageValue,
    usageLimit,
    usageUnit: value.usageUnit as ProviderUsageUnit,
    usagePercent,
    localUsageValue,
    localUsageUnit,
    reconciliation:
      value.reconciliation ??
      reconcileProviderAndLocalUsage({
        providerValue: usageValue,
        providerUnit: value.usageUnit,
        localValue: localUsageValue,
        localUnit: localUsageUnit,
      }),
    requestsPerMinute: boundedNumber(value.requestsPerMinute),
    updatedAt: Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : 0,
    connectionState: value.connectionState ?? (value.connected ? 'connected' : 'disconnected'),
    usageCapability: value.usageCapability ?? 'unsupported',
    ...(value.providerFamilyId ? { providerFamilyId: value.providerFamilyId.slice(0, 96) } : {}),
    ...(value.routeId ? { routeId: value.routeId.slice(0, 96) } : {}),
    ...(value.routeLabel ? { routeLabel: value.routeLabel.slice(0, 80) } : {}),
    ...(value.planScope ? { planScope: value.planScope.slice(0, 120) } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode.slice(0, 64) } : {}),
  });
}

export async function refreshProviderUsageAdapters(
  adapters: readonly ProviderUsageAdapter[],
  signal: AbortSignal,
  now = Date.now(),
): Promise<ProviderUsageSnapshot[]> {
  return Promise.all(
    adapters.map(async (adapter): Promise<ProviderUsageSnapshot> => {
      const cached = adapter.getCachedSnapshot();
      try {
        if (!(await adapter.detect())) {
          return normalizeProviderUsageSnapshot({
            providerId: cached?.providerId ?? adapter.id,
            displayName: cached?.displayName ?? adapter.id,
            connected: false,
            hidden: cached?.hidden ?? false,
            activeRequests: 0,
            usageValue: cached?.usageValue ?? null,
            usageLimit: cached?.usageLimit ?? null,
            usageUnit: cached?.usageUnit ?? null,
            usagePercent: cached?.usagePercent ?? null,
            requestsPerMinute: cached?.requestsPerMinute ?? null,
            updatedAt: cached?.updatedAt ?? now,
            freshness: 'offline',
            source: cached ? 'cached' : 'local-events',
          });
        }
        return normalizeProviderUsageSnapshot(await adapter.refreshQuota(signal));
      } catch {
        return normalizeProviderUsageSnapshot({
          providerId: cached?.providerId ?? adapter.id,
          displayName: cached?.displayName ?? adapter.id,
          connected: cached?.connected ?? true,
          hidden: cached?.hidden ?? false,
          activeRequests: cached?.activeRequests ?? 0,
          usageValue: cached?.usageValue ?? null,
          usageLimit: cached?.usageLimit ?? null,
          usageUnit: cached?.usageUnit ?? null,
          usagePercent: cached?.usagePercent ?? null,
          requestsPerMinute: cached?.requestsPerMinute ?? null,
          updatedAt: cached?.updatedAt ?? now,
          freshness: 'error',
          source: cached ? 'cached' : 'local-events',
          errorCode: 'PROVIDER_USAGE_UNAVAILABLE',
        });
      }
    }),
  );
}
