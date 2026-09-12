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
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'google',
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    contextWindowTokens: 1_000_000,
  },
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
  {
    provider: 'groq',
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B (Groq)',
    contextWindowTokens: 128_000,
  },
  {
    provider: 'openai',
    id: OPENAI_DEFAULT_MODEL,
    label: 'GPT-5.1',
  },
  {
    provider: 'openai',
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindowTokens: 128_000,
  },
  {
    provider: 'openai',
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    contextWindowTokens: 128_000,
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
  {
    provider: 'openai',
    id: 'gpt-5.5-pro',
    label: 'GPT-5.5 Pro',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.5-codex',
    label: 'GPT-5.5 Codex',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
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
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindowTokens: 200_000,
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
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
    id: 'glm-5.1',
    label: 'GLM 5.1',
    contextWindowTokens: 200_000,
  },
  {
    provider: 'openrouter',
    id: OPENROUTER_DEFAULT_MODEL,
    label: 'OpenRouter Auto',
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (OR)',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'mistral',
    id: MISTRAL_DEFAULT_MODEL,
    label: 'Mistral Large',
    contextWindowTokens: 128_000,
  },
  {
    provider: 'together',
    id: TOGETHER_DEFAULT_MODEL,
    label: 'Qwen 3.5 397B A17B (Together)',
    contextWindowTokens: 262_144,
  },
  {
    provider: 'xai',
    id: XAI_DEFAULT_MODEL,
    label: 'Grok 4.5',
  },
  {
    provider: 'xai',
    id: 'grok-4.3',
    label: 'Grok 4.3',
    contextWindowTokens: 1_000_000,
  },
  {
    provider: 'qwen',
    id: 'qwen3.7-max',
    label: 'Qwen 3.7 Max',
  },
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
  {
    provider: 'qwen',
    id: 'qwen3.6-27b',
    label: 'Qwen 3.6 27B',
  },
  {
    provider: 'qwen',
    id: 'qwen3-coder-next',
    label: 'Qwen3 Coder Next',
  },
];

// ── Dynamic Ollama model discovery ──────────────────────────────────────

let _discoveredOllama: string[] = [];
let _foundryModels: Array<{ id: string; label: string }> = [];
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
  models: ReadonlyArray<{ id: string; label: string }>,
): void {
  _foundryModels = models
    .map((model) => ({ id: model.id.trim(), label: model.label.trim() }))
    .filter(
      (model, index, all) =>
        model.id.startsWith('foundry:') &&
        Boolean(model.label) &&
        all.findIndex((candidate) => candidate.id === model.id) === index,
    );
  _discoveredListeners.forEach((fn) => fn());
}

export function getOllamaModelOptions(): ModelOption[] {
  return [
    ..._foundryModels.map((model) => ({
      provider: 'ollama' as const,
      id: model.id,
      label: model.label,
    })),
    ..._discoveredOllama.map((name) => ({
      provider: 'ollama' as const,
      id: name,
      label: name,
    })),
  ];
}

function hydrateFoundryModelOptions(): Promise<void> {
  if (_foundryHydration) return _foundryHydration;
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
    syncFoundryModelOptions(foundryModelOptions(jobs));
  })();
  return _foundryHydration;
}

/** React hook: returns current discovered Ollama models as ModelOption[]. */
export function useOllamaModelOptions(): ModelOption[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    _discoveredListeners.push(listener);
    void hydrateFoundryModelOptions();
    return () => {
      _discoveredListeners = _discoveredListeners.filter((l) => l !== listener);
    };
  }, []);
  return useMemo(
    () => getOllamaModelOptions(),
    [
      _discoveredOllama.length,
      _discoveredOllama.join('\0'),
      _foundryModels.length,
      _foundryModels.map((model) => `${model.id}\0${model.label}`).join('\u0001'),
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
      return 'glm-5.1';
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
