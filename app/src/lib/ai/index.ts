/**
 * Public surface of the AI layer. Anything outside `lib/ai/` should import
 * from here, never reach into a provider file directly.
 */
export type {
  LLMRole,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  TokenUsage,
  CostRates,
} from './types';
export { COST_RATES, ratesFor, estimateCost, estimateInputTokens } from './types';

export { runAgent } from './router';
export { runStack, VIBE_HIVE_LABELS, STACK_PRESET_LABELS, classifyStackTask } from './stacks';
export type { StackPresetId, StackRunResult, StackStepSpec } from './stacks';
export {
  startRuntimeListener,
  type RuntimeBindings,
  type SendDetail,
  type CancelDetail,
  type RuntimeOptions,
} from './runtime';

export { mockProvider } from './providers/mock';
export { anthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
export { openaiProvider, OPENAI_DEFAULT_MODEL } from './providers/openai';
export { googleProvider, GOOGLE_DEFAULT_MODEL } from './providers/google';
export { groqProvider, GROQ_DEFAULT_MODEL } from './providers/groq';
export {
  ollamaProvider,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_BASE,
  ollamaBaseUrl,
  listOllamaModels,
  listOllamaModelInfo,
  isOllamaReachable,
  ensureOllamaReadySilent,
  assertAllowedOllamaEndpoint,
  waitForOllamaReachable,
  pullOllamaModel,
  validateModelName,
} from './providers/ollama';
export type { OllamaModelInfo, OllamaPullProgress, OllamaEnsureStatus } from './providers/ollama';

export {
  CHAT_MODEL_OPTIONS,
  getModelOptions,
  getAccessibleProviders,
  getAccessibleModelOptions,
  connectLocalModelToChat,
  selectLocalModelForChat,
  getDiscoveredOllamaModels,
  defaultModelForProvider,
  isRealChatProvider,
  syncDiscoveredOllamaModels,
  useOllamaModelOptions,
} from './models';
export {
  useAccessibleChatModels,
  buildModelPickerGroups,
  MODEL_PROVIDER_LABELS,
} from './useAccessibleChatModels';
export { LOCAL_MODEL_CATALOG } from './localModelCatalog';
