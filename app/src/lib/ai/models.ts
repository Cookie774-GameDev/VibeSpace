import { useEffect, useMemo, useState } from 'react';
import type { ProviderId } from '@/types';
import type { PlanId } from '@/lib/entitlements';
import { useAuthStore } from '@/stores/auth';
import { OLLAMA_LOCAL_CONNECTION } from './adapters/nativeCatalog';
import { ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
import { GOOGLE_DEFAULT_MODEL } from './providers/google';
import { GROQ_DEFAULT_MODEL } from './providers/groq';
import { OLLAMA_DEFAULT_MODEL } from './providers/ollama';
import { OPENAI_DEFAULT_MODEL } from './providers/openai';
import {
  OPENROUTER_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
  MISTRAL_DEFAULT_MODEL,
  TOGETHER_DEFAULT_MODEL,
  XAI_DEFAULT_MODEL,
  QWEN_DEFAULT_MODEL,
  ZAI_DEFAULT_MODEL,
} from './providers/compatibleInstances';

export interface ModelOption {
  provider: ProviderId;
  id: string;
  label: string;
  /** Conservative active-catalog context capacity. Omitted when not verified. */
  contextWindowTokens?: number;
  /** Maximum exact input/output USD rate per million tokens from the embedded snapshot. */
  maximumCostPerMillionUsd?: number;
  /** Pricing provenance. Present only for exact model-level embedded metadata. */
  costMetadataSource?: 'embedded_snapshot';
}

export const REAL_CHAT_PROVIDERS: readonly ProviderId[] = [
  'google',
  'groq',
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'zai',
  'mistral',
  'together',
  'xai',
  'qwen',
  'ollama',
  'local',
];

const CLOUD_KEY_PROVIDERS: readonly ProviderId[] = [
  'google',
  'groq',
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'zai',
  'mistral',
  'together',
  'xai',
  'qwen',
];

export const CHAT_MODEL_OPTIONS: readonly ModelOption[] = [
  {
    provider: 'google',
    id: GOOGLE_DEFAULT_MODEL,
    label: 'Gemini 3.6 Flash',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'google',
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindowTokens: 1_048_576,
    maximumCostPerMillionUsd: 2.5,
    costMetadataSource: 'embedded_snapshot',
  },
  { provider: 'google', id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  {
    provider: 'google',
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    contextWindowTokens: 1_048_576,
    maximumCostPerMillionUsd: 9,
    costMetadataSource: 'embedded_snapshot',
  },
  {
    provider: 'google',
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    contextWindowTokens: 1_000_000,
  },
  { provider: 'google', id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
  { provider: 'google', id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { provider: 'google', id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { provider: 'google', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { provider: 'google', id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { provider: 'google', id: 'gemma-4-31b-it', label: 'Gemma 4 31B IT' },
  { provider: 'google', id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B IT' },
  {
    provider: 'groq',
    id: GROQ_DEFAULT_MODEL,
    label: 'GPT-OSS 20B (Groq)',
    contextWindowTokens: 131_072,
  },
  {
    provider: 'groq',
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    contextWindowTokens: 131_072,
  },
  { provider: 'groq', id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B (Groq)' },
  { provider: 'groq', id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7 (Groq)' },
  {
    provider: 'openai',
    id: OPENAI_DEFAULT_MODEL,
    label: 'GPT-5.6 Terra',
  },
  {
    provider: 'openai',
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    contextWindowTokens: 1_000_000,
  },
  { provider: 'openai', id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
  {
    provider: 'openai',
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'anthropic',
    id: ANTHROPIC_DEFAULT_MODEL,
    label: 'Claude Sonnet 5',
  },
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    contextWindowTokens: 200_000,
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'deepseek',
    id: DEEPSEEK_DEFAULT_MODEL,
    label: 'DeepSeek V4 Flash',
    contextWindowTokens: 128_000,
  },
  {
    provider: 'deepseek',
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindowTokens: 128_000,
  },
  {
    provider: 'zai',
    id: ZAI_DEFAULT_MODEL,
    label: 'GLM 5.3',
    contextWindowTokens: 200_000,
  },
  ...[
    'glm-5.2',
    'glm-5.1',
    'glm-5-turbo',
    'glm-5',
    'glm-4.7',
    'glm-4.7-flash',
    'glm-4.7-flashx',
    'glm-4.6',
    'glm-4.5',
    'glm-4.5-air',
    'glm-4.5-x',
    'glm-4.5-airx',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
  ].map((id) => ({ provider: 'zai' as const, id, label: id.toUpperCase() })),
  {
    provider: 'openrouter',
    id: OPENROUTER_DEFAULT_MODEL,
    label: 'OpenRouter Auto',
  },
  {
    provider: 'mistral',
    id: MISTRAL_DEFAULT_MODEL,
    label: 'Mistral Medium 3.5',
    contextWindowTokens: 128_000,
  },
  ...[
    'zai-glm-5-2',
    'mistral-large-latest',
    'mistral-small-latest',
    'codestral-latest',
    'ministral-14b-latest',
    'ministral-8b-latest',
    'ministral-3b-latest',
    'mistral-medium-3-5',
    'mistral-small-2603',
    'mistral-large-2512',
    'codestral-2508',
    'ministral-14b-2512',
    'ministral-8b-2512',
    'ministral-3b-2512',
  ].map((id) => ({ provider: 'mistral' as const, id, label: id })),
  {
    provider: 'together',
    id: TOGETHER_DEFAULT_MODEL,
    label: 'Qwen 3.7 Plus (Together)',
    contextWindowTokens: 262_144,
  },
  ...[
    'thinkingmachines/Inkling',
    'thinkingmachines/Inkling-Small',
    'MiniMaxAI/MiniMax-M3',
    'Qwen/Qwen3.8-2.4T-A95B',
    'Qwen/Qwen3.7-Max',
    'Qwen/Qwen3.6-Plus',
    'Qwen/Qwen3.5-9B',
    'Qwen/Qwen2.5-7B-Instruct-Turbo',
    'moonshotai/Kimi-K3',
    'moonshotai/Kimi-K2.7-Code',
    'zai-org/GLM-5.2',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'deepseek-ai/DeepSeek-V4-Pro',
    'deepseek-ai/DeepSeek-V4-Flash-0731',
    'deepseek-ai/DeepSeek-V4-Pro-0813',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'google/gemma-4-31B-it',
    'google/gemma-3n-E4B-it',
    'pearl-ai/gemma-4-31b-it',
    'Prism-ML/Ternary-Bonsai-27B',
    'meta-models/Muse-Glimmer-30B',
  ].map((id) => ({ provider: 'together' as const, id, label: id })),
  {
    provider: 'xai',
    id: XAI_DEFAULT_MODEL,
    label: 'Grok 4.6',
  },
  { provider: 'xai', id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning' },
  { provider: 'xai', id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 Non-Reasoning' },
  { provider: 'xai', id: 'grok-4.20-multi-agent-0309', label: 'Grok 4.20 Multi-Agent' },
  { provider: 'xai', id: 'grok-4.5', label: 'Grok 4.5' },
  {
    provider: 'xai',
    id: 'grok-4.3',
    label: 'Grok 4.3',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'qwen',
    id: 'qwen3.8-max',
    label: 'Qwen 3.8 Max',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'qwen',
    id: 'qwen3.7-max',
    label: 'Qwen 3.7 Max',
  },
  { provider: 'qwen', id: 'qwen3.7-flash', label: 'Qwen 3.7 Flash' },
  { provider: 'qwen', id: 'qwen3.7-flash-2026-07-15', label: 'Qwen 3.7 Flash (2026-07-15)' },
  { provider: 'qwen', id: 'qwen3.7-max-preview', label: 'Qwen 3.7 Max Preview' },
  { provider: 'qwen', id: 'qwen3.7-max-2026-05-20', label: 'Qwen 3.7 Max (2026-05-20)' },
  { provider: 'qwen', id: 'qwen3.7-max-2026-05-17', label: 'Qwen 3.7 Max (2026-05-17)' },
  {
    provider: 'qwen',
    id: 'qwen3.7-max-2026-06-08',
    label: 'Qwen 3.7 Max (2026-06-08)',
  },
  {
    provider: 'qwen',
    id: QWEN_DEFAULT_MODEL,
    label: 'Qwen 3.7 Plus',
  },
  {
    provider: 'qwen',
    id: 'qwen3.7-plus-2026-05-26',
    label: 'Qwen 3.7 Plus (2026-05-26)',
  },
  {
    provider: 'qwen',
    id: 'qwen3.6-plus',
    label: 'Qwen 3.6 Plus',
  },
  {
    provider: 'qwen',
    id: 'qwen3.6-plus-2026-04-02',
    label: 'Qwen 3.6 Plus (2026-04-02)',
  },
  {
    provider: 'qwen',
    id: 'qwen3.6-flash',
    label: 'Qwen 3.6 Flash',
  },
  {
    provider: 'qwen',
    id: 'qwen3.6-flash-2026-04-16',
    label: 'Qwen 3.6 Flash (2026-04-16)',
  },
];

// ── Dynamic Ollama model discovery ──────────────────────────────────────

let _discoveredOllama: string[] = [];
let _foundryModels: Array<{ id: string; label: string; method?: string }> = [];
function foundryScope(): string {
  const state = useAuthStore.getState();
  return state.cloudSession?.user_id ?? state.localUserId ?? 'local';
}
let _foundryScope = '';
let _foundryHydrationScope = '';
let _foundryHydrationGeneration = 0;
let _discoveredListeners: Array<() => void> = [];
let _foundryHydration: Promise<void> | null = null;

/** Replace the set of discovered Ollama model names. Call after each scan. */
export function syncDiscoveredOllamaModels(models: string[]): void {
  _discoveredOllama = [...new Set(models.map((name) => name.trim()).filter(Boolean))];
  _discoveredListeners.forEach((fn) => fn());
}

export function getDiscoveredOllamaModels(): readonly string[] {
  return _discoveredOllama;
}

export function syncFoundryModelOptions(
  models: ReadonlyArray<{ id: string; label: string; method?: string }>,
  scope = foundryScope(),
): void {
  if (scope !== foundryScope()) return;
  _foundryScope = scope;
  _foundryModels = models
    .map((model) => ({ id: model.id.trim(), label: model.label.trim(), method: model.method }))
    .filter(
      (model, index, all) =>
        /^(?:artifact--|foundry:)[A-Za-z0-9_-]{1,64}$/.test(model.id) &&
        Boolean(model.label) &&
        all.findIndex((candidate) => candidate.id === model.id) === index,
    );
  _discoveredListeners.forEach((fn) => fn());
}

export function getOllamaModelOptions(): ModelOption[] {
  return [
    ...(_foundryScope === foundryScope() ? _foundryModels : [])
      .filter((model) => model.id.startsWith('foundry:') || model.method === 'knowledge')
      .map((model) => ({
        provider: 'ollama' as const,
        id:
          model.method === 'knowledge' && model.id.startsWith('artifact--')
            ? `foundry:${model.id.slice('artifact--'.length)}`
            : model.id,
        label: model.label,
      })),
    ..._discoveredOllama.map((name) => ({
      provider: 'ollama' as const,
      id: name,
      label: name,
    })),
  ];
}

export function getFoundryModelOptions(): ModelOption[] {
  if (_foundryScope !== foundryScope()) return [];
  return _foundryModels
    .filter((model) => model.id.startsWith('artifact--') && model.method !== 'knowledge')
    .map((model) => ({ provider: 'foundry', id: model.id, label: model.label }));
}

function hydrateFoundryModelOptions(): Promise<void> {
  const scope = foundryScope();
  if (_foundryHydration && _foundryHydrationScope === scope) return _foundryHydration;
  const generation = ++_foundryHydrationGeneration;
  _foundryHydrationScope = scope;
  _foundryHydration = (async () => {
    const { foundryModelOptions, loadJobs } = await import('@/features/model-foundry/modelHub');
    let jobs = typeof window === 'undefined' ? [] : loadJobs(window.localStorage);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const nativeJobs = await invoke<unknown>('model_foundry_list_jobs');
      if (Array.isArray(nativeJobs)) jobs = nativeJobs;
    } catch {
      // Browser preview and an unavailable native host use the durable snapshot.
    }
    if (generation === _foundryHydrationGeneration)
      syncFoundryModelOptions(foundryModelOptions(jobs), scope);
  })().finally(() => {
    if (generation === _foundryHydrationGeneration) _foundryHydration = null;
  });
  return _foundryHydration;
}

/** React hook: returns current discovered Ollama models as ModelOption[]. */
export function useOllamaModelOptions(): ModelOption[] {
  const scope = useAuthStore(
    (state) => state.cloudSession?.user_id ?? state.localUserId ?? 'local',
  );
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    _discoveredListeners.push(listener);
    void hydrateFoundryModelOptions();
    return () => {
      _discoveredListeners = _discoveredListeners.filter((l) => l !== listener);
    };
  }, [scope]);
  return useMemo(
    () => getOllamaModelOptions(),
    [
      _discoveredOllama.length,
      scope,
      _discoveredOllama.join('\0'),
      _foundryModels.length,
      _foundryModels.map((model) => `${model.id}\0${model.label}\0${model.method}`).join('\u0001'),
    ],
  );
}

/** Native Foundry weights retain their provider instead of becoming Ollama/CLI aliases. */
export function useFoundryModelOptions(): ModelOption[] {
  const scope = useAuthStore(
    (state) => state.cloudSession?.user_id ?? state.localUserId ?? 'local',
  );
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    _discoveredListeners.push(listener);
    void hydrateFoundryModelOptions();
    return () => {
      _discoveredListeners = _discoveredListeners.filter((entry) => entry !== listener);
    };
  }, [scope]);
  return useMemo(
    () => getFoundryModelOptions(),
    [
      scope,
      _foundryModels.map((model) => `${model.id}\0${model.label}\0${model.method}`).join('\u0001'),
    ],
  );
}

function hasCloudApiKey(
  provider: ProviderId,
  apiKeys: Partial<Record<ProviderId, string>>,
): boolean {
  if (provider === 'mock') return Boolean(apiKeys.mock?.trim());
  if (!CLOUD_KEY_PROVIDERS.includes(provider)) return false;
  return Boolean(apiKeys[provider]?.trim());
}

function resolveLocalModelNames(_localDefault = ''): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  for (const name of _discoveredOllama) add(name);
  return names;
}

function localModelsAvailable(localDefault = ''): boolean {
  return resolveLocalModelNames(localDefault).length > 0;
}

export { localModelsAvailable };

function planIncludesHostedChat(plan: PlanId): boolean {
  return plan !== 'free';
}

/** Subscription-hosted providers available via `stack-complete` edge proxy. */
const HOSTED_STACK_PROVIDERS: ProviderId[] = [
  'google',
  'deepseek',
  'openai',
  'anthropic',
  'groq',
  'mistral',
  'openrouter',
  'xai',
];

/** Providers the user can actually chat with right now (keys, local models, or paid hosted). */
export function getAccessibleProviders(
  apiKeys: Partial<Record<ProviderId, string>>,
  offlineMode: boolean,
  plan: PlanId = 'free',
  localDefault = '',
): ProviderId[] {
  if (offlineMode) {
    return localModelsAvailable(localDefault) ? ['ollama', 'local'] : [];
  }

  const providers: ProviderId[] = [];
  for (const provider of CLOUD_KEY_PROVIDERS) {
    if (hasCloudApiKey(provider, apiKeys)) providers.push(provider);
  }
  if (planIncludesHostedChat(plan)) {
    for (const provider of HOSTED_STACK_PROVIDERS) {
      if (!providers.includes(provider)) providers.push(provider);
    }
  }
  if (localModelsAvailable(localDefault)) {
    providers.push('ollama', 'local');
  }
  return providers;
}

/** Model options for a provider, filtered to what the user can run. */
export function getAccessibleModelOptions(
  provider: ProviderId,
  apiKeys: Partial<Record<ProviderId, string>>,
  offlineMode: boolean,
  localDefault = OLLAMA_DEFAULT_MODEL,
  plan: PlanId = 'free',
): readonly ModelOption[] {
  const accessible = getAccessibleProviders(apiKeys, offlineMode, plan, localDefault);
  if (!accessible.includes(provider)) return [];

  if (provider === 'ollama' || provider === 'local') {
    return resolveLocalModelNames(localDefault).map((name) => ({
      provider: 'ollama' as const,
      id: name,
      label: name,
    }));
  }

  return CHAT_MODEL_OPTIONS.filter((option) => option.provider === provider);
}

/** Select a local model for chat; optionally force fully-local offline mode. */
export function selectLocalModelForChat(modelName: string, enableOffline = false): void {
  const trimmed = modelName.trim();
  if (!trimmed) return;
  const auth = useAuthStore.getState();
  auth.setDefaultLocalModel(trimmed);
  auth.setDefaultProvider('ollama');
  auth.setSelectedModel('ollama', trimmed);
  auth.setSelectedModel('local', trimmed);
  // Pin the composer chat selection to Ollama so send validation and the
  // runtime actually use the local model (not a stale Google/Hive pick).
  auth.setChatModelSelection({
    mode: 'single',
    providerId: 'ollama',
    modelId: trimmed,
    connectionId: OLLAMA_LOCAL_CONNECTION.id,
    connectionMode: OLLAMA_LOCAL_CONNECTION.mode,
    authSource: OLLAMA_LOCAL_CONNECTION.authSource,
    capabilities: OLLAMA_LOCAL_CONNECTION.capabilities,
  });
  if (enableOffline) auth.setOfflineMode(true);
}

/** After a catalog download completes, connect the model and enable local chat. */
export function connectLocalModelToChat(modelName: string): void {
  selectLocalModelForChat(modelName, true);
}

export function getModelOptions(provider: ProviderId): readonly ModelOption[] {
  const auth = useAuthStore.getState();
  return getAccessibleModelOptions(
    provider,
    auth.apiKeys,
    auth.offlineMode,
    auth.defaultLocalModel,
    auth.plan,
  );
}

export function defaultModelForProvider(
  provider: ProviderId,
  localModel = OLLAMA_DEFAULT_MODEL,
): string {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_DEFAULT_MODEL;
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'google':
      return GOOGLE_DEFAULT_MODEL;
    case 'groq':
      return GROQ_DEFAULT_MODEL;
    case 'deepseek':
      return DEEPSEEK_DEFAULT_MODEL;
    case 'zai':
      return ZAI_DEFAULT_MODEL;
    case 'openrouter':
      return OPENROUTER_DEFAULT_MODEL;
    case 'mistral':
      return MISTRAL_DEFAULT_MODEL;
    case 'together':
      return TOGETHER_DEFAULT_MODEL;
    case 'xai':
      return XAI_DEFAULT_MODEL;
    case 'qwen':
      return QWEN_DEFAULT_MODEL;
    case 'ollama':
    case 'local':
      if (localModelsAvailable(localModel)) {
        const preferred = localModel.trim();
        const names = resolveLocalModelNames(localModel);
        if (
          preferred &&
          names.some(
            (name) =>
              name.toLowerCase() === preferred.toLowerCase() ||
              name.toLowerCase().startsWith(`${preferred.toLowerCase()}:`),
          )
        ) {
          return preferred;
        }
        return names[0] ?? (localModel || OLLAMA_DEFAULT_MODEL);
      }
      return localModel || OLLAMA_DEFAULT_MODEL;
    default:
      return 'mock-default';
  }
}

export function isRealChatProvider(provider: ProviderId): boolean {
  return REAL_CHAT_PROVIDERS.includes(provider);
}
