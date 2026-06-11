import { useEffect, useState } from 'react';
import type { ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
import { GOOGLE_DEFAULT_MODEL } from './providers/google';
import { GROQ_DEFAULT_MODEL } from './providers/groq';
import { OLLAMA_DEFAULT_MODEL } from './providers/ollama';
import { OPENAI_DEFAULT_MODEL } from './providers/openai';

export interface ModelOption {
  provider: ProviderId;
  id: string;
  label: string;
}

export const REAL_CHAT_PROVIDERS: readonly ProviderId[] = [
  'google',
  'groq',
  'openai',
  'anthropic',
  'ollama',
  'local',
  'mock',
];

const CLOUD_KEY_PROVIDERS: readonly ProviderId[] = [
  'google',
  'groq',
  'openai',
  'anthropic',
];

export const CHAT_MODEL_OPTIONS: readonly ModelOption[] = [
  { provider: 'google', id: GOOGLE_DEFAULT_MODEL, label: 'Gemini 2.5 Flash Lite' },
  { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { provider: 'google', id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { provider: 'groq', id: GROQ_DEFAULT_MODEL, label: 'Llama 3.3 70B Versatile' },
  { provider: 'groq', id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
  { provider: 'groq', id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
  { provider: 'openai', id: OPENAI_DEFAULT_MODEL, label: 'GPT-4o Mini' },
  { provider: 'openai', id: 'gpt-4o', label: 'GPT-4o' },
  { provider: 'openai', id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { provider: 'anthropic', id: ANTHROPIC_DEFAULT_MODEL, label: 'Claude 3.5 Sonnet' },
  { provider: 'anthropic', id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  { provider: 'mock', id: 'mock-default', label: 'Mock demo' },
];

// ── Dynamic Ollama model discovery ──────────────────────────────────────

let _discoveredOllama: string[] = [];
let _discoveredListeners: Array<() => void> = [];

/** Replace the set of discovered Ollama model names. Call after each scan. */
export function syncDiscoveredOllamaModels(models: string[]): void {
  _discoveredOllama = [...new Set(models.map((name) => name.trim()).filter(Boolean))];
  _discoveredListeners.forEach((fn) => fn());
}

export function getDiscoveredOllamaModels(): readonly string[] {
  return _discoveredOllama;
}

/** React hook: returns current discovered Ollama models as ModelOption[]. */
export function useOllamaModelOptions(): ModelOption[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    _discoveredListeners.push(listener);
    return () => {
      _discoveredListeners = _discoveredListeners.filter((l) => l !== listener);
    };
  }, []);
  return _discoveredOllama.map((name) => ({ provider: 'ollama' as const, id: name, label: name }));
}

function hasCloudApiKey(
  provider: ProviderId,
  apiKeys: Partial<Record<ProviderId, string>>,
): boolean {
  if (provider === 'mock') return Boolean(apiKeys.mock?.trim());
  if (!CLOUD_KEY_PROVIDERS.includes(provider)) return false;
  return Boolean(apiKeys[provider]?.trim());
}

function localModelsAvailable(): boolean {
  return _discoveredOllama.length > 0;
}

/** Providers the user can actually chat with right now (keys or installed local models). */
export function getAccessibleProviders(
  apiKeys: Partial<Record<ProviderId, string>>,
  offlineMode: boolean,
): ProviderId[] {
  if (offlineMode) {
    return localModelsAvailable() ? ['ollama', 'local'] : [];
  }

  const providers: ProviderId[] = [];
  for (const provider of CLOUD_KEY_PROVIDERS) {
    if (hasCloudApiKey(provider, apiKeys)) providers.push(provider);
  }
  if (hasCloudApiKey('mock', apiKeys)) providers.push('mock');
  if (localModelsAvailable()) {
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
): readonly ModelOption[] {
  const accessible = getAccessibleProviders(apiKeys, offlineMode);
  if (!accessible.includes(provider)) return [];

  if (provider === 'ollama' || provider === 'local') {
    return _discoveredOllama.map((name) => ({
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
  );
}

export function defaultModelForProvider(provider: ProviderId, localModel = OLLAMA_DEFAULT_MODEL): string {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_DEFAULT_MODEL;
    case 'openai':
      return OPENAI_DEFAULT_MODEL;
    case 'google':
      return GOOGLE_DEFAULT_MODEL;
    case 'groq':
      return GROQ_DEFAULT_MODEL;
    case 'ollama':
    case 'local':
      if (localModelsAvailable()) {
        const preferred = localModel.trim();
        if (
          preferred &&
          _discoveredOllama.some(
            (name) =>
              name.toLowerCase() === preferred.toLowerCase() ||
              name.toLowerCase().startsWith(`${preferred.toLowerCase()}:`),
          )
        ) {
          return preferred;
        }
        return _discoveredOllama[0] ?? (localModel || OLLAMA_DEFAULT_MODEL);
      }
      return localModel || OLLAMA_DEFAULT_MODEL;
    default:
      return 'mock-default';
  }
}

export function isRealChatProvider(provider: ProviderId): boolean {
  return REAL_CHAT_PROVIDERS.includes(provider);
}
