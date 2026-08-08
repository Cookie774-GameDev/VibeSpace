import type { ProviderCapabilities, ProviderConnection } from './types';

function capabilities(overrides: Partial<ProviderCapabilities>): Readonly<ProviderCapabilities> {
  return Object.freeze({
    text: true,
    images: false,
    files: false,
    tools: false,
    modelSelection: true,
    structuredOutput: false,
    streaming: true,
    cancellation: true,
    resumeSession: false,
    systemPrompt: true,
    workingDirectory: false,
    usage: true,
    subscriptionQuota: false,
    localOnly: false,
    ...overrides,
  });
}

function nativeConnection(input: {
  id: string;
  adapterId: string;
  providerId: string;
  displayName: string;
  authSource?: string;
  capabilities?: Partial<ProviderCapabilities>;
}): Readonly<ProviderConnection> {
  return Object.freeze({
    id: input.id,
    adapterId: input.adapterId,
    providerId: input.providerId,
    displayName: input.displayName,
    mode: 'native-api' as const,
    authSource: input.authSource ?? 'api-key',
    capabilities: capabilities(input.capabilities ?? {}),
    promptTransport: 'native-system' as const,
    enabled: true,
  });
}

export const OPENAI_API_CONNECTION = nativeConnection({
  id: 'openai-api',
  adapterId: 'openai-native',
  providerId: 'openai',
  displayName: 'OpenAI API',
  capabilities: { images: true },
});

export const ANTHROPIC_API_CONNECTION = nativeConnection({
  id: 'anthropic-api',
  adapterId: 'anthropic-native',
  providerId: 'anthropic',
  displayName: 'Anthropic API',
  capabilities: { images: true },
});

export const GEMINI_API_CONNECTION = nativeConnection({
  id: 'google-gemini-api',
  adapterId: 'google-native',
  providerId: 'google',
  displayName: 'Gemini API',
  capabilities: { images: true },
});

export const VERTEX_API_CONNECTION = nativeConnection({
  id: 'google-vertex',
  adapterId: 'google-vertex-native',
  providerId: 'google',
  displayName: 'Google Vertex AI',
  authSource: 'google-application-default-credentials',
  capabilities: { images: true },
});

export const XAI_API_CONNECTION = nativeConnection({
  id: 'xai-api',
  adapterId: 'xai-native',
  providerId: 'xai',
  displayName: 'xAI API',
});

export const DEEPSEEK_API_CONNECTION = nativeConnection({
  id: 'deepseek-api',
  adapterId: 'deepseek-native',
  providerId: 'deepseek',
  displayName: 'DeepSeek API',
});

export const ZAI_API_CONNECTION = nativeConnection({
  id: 'zai-api',
  adapterId: 'zai-native',
  providerId: 'zai',
  displayName: 'Z.AI / GLM API',
});

export const QWEN_API_CONNECTION = nativeConnection({
  id: 'qwen-api',
  adapterId: 'qwen-native',
  providerId: 'qwen',
  displayName: 'Qwen API',
});

export const OLLAMA_LOCAL_CONNECTION: Readonly<ProviderConnection> = Object.freeze({
  id: 'ollama-local',
  adapterId: 'ollama-local',
  providerId: 'ollama',
  displayName: 'Ollama Local',
  mode: 'local' as const,
  authSource: 'local-runtime',
  // Images: vision-capable tags receive real multimodal payloads; text-only
  // tags are still gated by modelSupportsVision / selectionSupportsVision.
  // Files: paths are injected as local context (never cloud-uploaded).
  capabilities: capabilities({
    images: true,
    files: true,
    localOnly: true,
    subscriptionQuota: false,
  }),
  promptTransport: 'native-system',
  enabled: true,
});

export const NATIVE_AND_LOCAL_CONNECTIONS = Object.freeze([
  OPENAI_API_CONNECTION,
  ANTHROPIC_API_CONNECTION,
  GEMINI_API_CONNECTION,
  VERTEX_API_CONNECTION,
  XAI_API_CONNECTION,
  DEEPSEEK_API_CONNECTION,
  ZAI_API_CONNECTION,
  QWEN_API_CONNECTION,
  OLLAMA_LOCAL_CONNECTION,
]);
