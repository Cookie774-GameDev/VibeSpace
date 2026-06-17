import type { ProviderId } from '@/types';
import { nativeFetch } from '@/lib/nativeFetch';
import {
  CHAT_MODEL_OPTIONS,
  defaultModelForProvider,
  getAccessibleModelOptions,
  type ModelOption,
} from './models';
import { HIVE_FRONTIER_MODELS } from './stacks/frontierModels';
import {
  getProviderDisplayName,
  getProviderRegistryEntry,
  isLocalProvider,
  isProviderConnected,
  type ProviderConnectionContext,
} from './providerRegistry';

export type ModelAvailability = 'stable' | 'preview' | 'experimental' | 'deprecated' | 'custom';

export interface RegistryModelOption {
  id: string;
  label: string;
  provider: ProviderId;
  availability: ModelAvailability;
  isCustom?: boolean;
  /** Smaller subtitle shown under the label (usually the raw model id). */
  subtitle?: string;
}

export interface ProviderModelValidation {
  ok: boolean;
  error?: string;
  warning?: string;
  isCustomModel?: boolean;
}

const FRONTIER_LABELS: Record<string, string> = {
  [HIVE_FRONTIER_MODELS.google_flash]: 'Gemini 3.5 Flash',
  [HIVE_FRONTIER_MODELS.google_pro]: 'Gemini 3.1 Pro',
  [HIVE_FRONTIER_MODELS.anthropic_opus]: 'Claude Opus 4.8',
  [HIVE_FRONTIER_MODELS.anthropic_fable]: 'Claude Fable 5',
  [HIVE_FRONTIER_MODELS.openai_flagship]: 'GPT-5.5',
  [HIVE_FRONTIER_MODELS.openai_flagship_pro]: 'GPT-5.5 Pro',
  [HIVE_FRONTIER_MODELS.openai_coding]: 'GPT-5.5 Codex',
  [HIVE_FRONTIER_MODELS.grok]: 'Grok 4.3',
  [HIVE_FRONTIER_MODELS.deepseek_pro]: 'DeepSeek V4 Pro',
  [HIVE_FRONTIER_MODELS.deepseek_flash]: 'DeepSeek V4 Flash',
  [HIVE_FRONTIER_MODELS.mistral_large]: 'Mistral Large',
};

const FRONTIER_BY_PROVIDER: Partial<Record<ProviderId, string[]>> = {
  google: [HIVE_FRONTIER_MODELS.google_flash, HIVE_FRONTIER_MODELS.google_pro],
  anthropic: [HIVE_FRONTIER_MODELS.anthropic_opus, HIVE_FRONTIER_MODELS.anthropic_fable],
  openai: [
    HIVE_FRONTIER_MODELS.openai_flagship,
    HIVE_FRONTIER_MODELS.openai_flagship_pro,
    HIVE_FRONTIER_MODELS.openai_coding,
  ],
  xai: [HIVE_FRONTIER_MODELS.grok],
  deepseek: [HIVE_FRONTIER_MODELS.deepseek_pro, HIVE_FRONTIER_MODELS.deepseek_flash],
  mistral: [HIVE_FRONTIER_MODELS.mistral_large],
  groq: ['llama-3.3-70b-versatile'],
};

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type ModelCacheEntry = {
  fetchedAt: number;
  models: RegistryModelOption[];
  stale: boolean;
  error?: string;
};

const dynamicModelCache = new Map<ProviderId, ModelCacheEntry>();
const inflightFetches = new Map<ProviderId, Promise<RegistryModelOption[]>>();

export function sanitizeModelIdForInput(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

function sanitizeModelId(raw: string): string {
  return sanitizeModelIdForInput(raw);
}

function toRegistryOption(option: ModelOption, availability: ModelAvailability = 'stable'): RegistryModelOption {
  return {
    id: option.id,
    label: option.label,
    provider: option.provider,
    availability,
    subtitle: option.id,
  };
}

function frontierOptionsForProvider(providerId: ProviderId): RegistryModelOption[] {
  const ids = FRONTIER_BY_PROVIDER[providerId] ?? [];
  return ids.map((id) => ({
    id,
    label: FRONTIER_LABELS[id] ?? id,
    provider: providerId,
    availability: 'preview' as const,
    subtitle: id,
  }));
}

function staticOptionsForProvider(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
): RegistryModelOption[] {
  return getAccessibleModelOptions(
    providerId,
    ctx.apiKeys,
    ctx.offlineMode,
    ctx.defaultLocalModel ?? '',
    ctx.plan,
  ).map((option) => toRegistryOption(option));
}

function mergeModelOptions(
  providerId: ProviderId,
  lists: RegistryModelOption[][],
  savedModelId?: string,
): RegistryModelOption[] {
  const seen = new Set<string>();
  const merged: RegistryModelOption[] = [];
  const add = (option: RegistryModelOption) => {
    const key = option.id.toLowerCase();
    if (seen.has(key)) return;
    if (option.provider !== providerId) return;
    seen.add(key);
    merged.push(option);
  };

  for (const list of lists) {
    for (const option of list) add(option);
  }

  const saved = savedModelId ? sanitizeModelId(savedModelId) : '';
  if (saved && !seen.has(saved.toLowerCase())) {
    const known = CHAT_MODEL_OPTIONS.find(
      (option) => option.provider === providerId && option.id.toLowerCase() === saved.toLowerCase(),
    );
    merged.push({
      id: saved,
      label: known?.label ?? `Custom: ${saved}`,
      provider: providerId,
      availability: 'custom',
      isCustom: true,
      subtitle: saved,
    });
  }

  return merged;
}

/** Resolve dropdown models for a provider (static + frontier + cached dynamic + saved custom). */
export function getModelsForProvider(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
  savedModelId?: string,
): RegistryModelOption[] {
  if (!isProviderConnected(providerId, ctx) && !isLocalProvider(providerId)) {
    return [];
  }

  const staticModels = staticOptionsForProvider(providerId, ctx);
  const frontier = frontierOptionsForProvider(providerId);
  const cached = dynamicModelCache.get(providerId)?.models ?? [];

  return mergeModelOptions(providerId, [frontier, staticModels, cached], savedModelId);
}

export function getModelLabelForProvider(
  providerId: ProviderId,
  modelId: string,
  ctx: ProviderConnectionContext,
): string {
  const options = getModelsForProvider(providerId, ctx, modelId);
  return options.find((option) => option.id === modelId)?.label ?? modelId;
}

export function modelBelongsToProvider(providerId: ProviderId, modelId: string): boolean {
  const id = sanitizeModelId(modelId);
  if (!id) return false;
  const staticMatch = CHAT_MODEL_OPTIONS.some(
    (option) => option.provider === providerId && option.id.toLowerCase() === id.toLowerCase(),
  );
  if (staticMatch) return true;
  const frontier = FRONTIER_BY_PROVIDER[providerId] ?? [];
  return frontier.some((candidate) => candidate.toLowerCase() === id.toLowerCase());
}

export function validateProviderModelSelection(
  providerId: ProviderId,
  modelId: string,
  ctx: ProviderConnectionContext,
  opts?: { allowCustom?: boolean },
): ProviderModelValidation {
  const trimmed = sanitizeModelId(modelId);
  if (!trimmed) {
    return {
      ok: false,
      error: `Select a ${getProviderDisplayName(providerId)} model for this step.`,
    };
  }

  if (!isProviderConnected(providerId, ctx) && !isLocalProvider(providerId)) {
    return {
      ok: false,
      error: `${getProviderDisplayName(providerId)} API key is required before you can use ${getProviderDisplayName(providerId)} models.`,
    };
  }

  const catalogOptions = getModelsForProvider(providerId, ctx);
  const match = catalogOptions.find((option) => option.id.toLowerCase() === trimmed.toLowerCase());

  if (!match) {
    if (opts?.allowCustom && trimmed) {
      return {
        ok: true,
        isCustomModel: true,
        warning: 'Custom model ID — may fail if unsupported.',
      };
    }
    return {
      ok: false,
      error: `This model is not available for ${getProviderDisplayName(providerId)}.`,
    };
  }

  if (match.isCustom) {
    return {
      ok: true,
      isCustomModel: true,
      warning: 'Saved model is not in the current catalog. It is preserved as a custom model.',
    };
  }

  if (match.availability === 'deprecated') {
    return {
      ok: true,
      warning: 'This model may be deprecated. Choose a newer model before production use.',
    };
  }

  return { ok: true };
}

export function resolveModelOnProviderChange(
  nextProvider: ProviderId,
  currentModel: string,
  ctx: ProviderConnectionContext,
): string {
  const options = getModelsForProvider(nextProvider, ctx, currentModel);
  const keep = options.find((option) => option.id.toLowerCase() === sanitizeModelId(currentModel).toLowerCase());
  if (keep && !keep.isCustom) return keep.id;
  return options.find((option) => !option.isCustom)?.id ?? defaultModelForProvider(nextProvider, ctx.defaultLocalModel);
}

export function getProviderModelCacheState(providerId: ProviderId): {
  stale: boolean;
  error?: string;
  fetchedAt?: number;
} {
  const entry = dynamicModelCache.get(providerId);
  if (!entry) return { stale: false };
  const expired = Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS;
  return { stale: entry.stale || expired, error: entry.error, fetchedAt: entry.fetchedAt };
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    return await nativeFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseOpenAiCompatibleModels(
  providerId: ProviderId,
  payload: { data?: Array<{ id?: string }> },
): RegistryModelOption[] {
  const rows = payload.data ?? [];
  return rows
    .map((row) => row.id?.trim())
    .filter((id): id is string => Boolean(id))
    .filter((id) => !id.includes('embed') && !id.includes('whisper') && !id.includes('tts'))
    .slice(0, 40)
    .map((id) => ({
      id,
      label: id,
      provider: providerId,
      availability: 'stable' as const,
      subtitle: id,
    }));
}

function parseGoogleModels(payload: { models?: Array<{ name?: string; displayName?: string }> }): RegistryModelOption[] {
  const rows: RegistryModelOption[] = [];
  for (const row of payload.models ?? []) {
    const raw = row.name?.replace(/^models\//, '').trim();
    if (!raw) continue;
    rows.push({
      id: raw,
      label: row.displayName?.trim() || FRONTIER_LABELS[raw] || raw,
      provider: 'google',
      availability: raw.includes('preview') || raw.includes('exp') ? 'preview' : 'stable',
      subtitle: raw,
    });
  }
  return rows.slice(0, 40);
}

async function fetchModelsFromProvider(
  providerId: ProviderId,
  apiKey: string,
): Promise<RegistryModelOption[]> {
  switch (providerId) {
    case 'openai': {
      const res = await timedFetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseOpenAiCompatibleModels(providerId, await res.json());
    }
    case 'anthropic': {
      const res = await timedFetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
      const rows: RegistryModelOption[] = [];
      for (const row of json.data ?? []) {
        const id = row.id?.trim();
        if (!id) continue;
        rows.push({
          id,
          label: row.display_name?.trim() || id,
          provider: 'anthropic',
          availability: 'stable',
          subtitle: id,
        });
      }
      return rows.slice(0, 40);
    }
    case 'google': {
      const res = await timedFetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseGoogleModels(await res.json());
    }
    case 'groq':
    case 'openrouter': {
      const base =
        providerId === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://openrouter.ai/api/v1/models';
      const res = await timedFetch(base, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseOpenAiCompatibleModels(providerId, await res.json());
    }
    default:
      return [];
  }
}

/** Fetch provider models from API when supported; falls back to static catalog on failure. */
export async function loadProviderModels(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
  opts?: { force?: boolean },
): Promise<RegistryModelOption[]> {
  const entry = getProviderRegistryEntry(providerId);
  if (!entry?.supportsDynamicListing) {
    return getModelsForProvider(providerId, ctx);
  }

  const cached = dynamicModelCache.get(providerId);
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS &&
    cached.models.length > 0
  ) {
    return getModelsForProvider(providerId, ctx);
  }

  const apiKey = ctx.apiKeys[providerId]?.trim();
  if (!apiKey && !isLocalProvider(providerId)) {
    return getModelsForProvider(providerId, ctx);
  }

  const inflight = inflightFetches.get(providerId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const dynamic = apiKey ? await fetchModelsFromProvider(providerId, apiKey) : [];
      dynamicModelCache.set(providerId, {
        fetchedAt: Date.now(),
        models: dynamic,
        stale: false,
      });
      return getModelsForProvider(providerId, ctx);
    } catch (err) {
      dynamicModelCache.set(providerId, {
        fetchedAt: Date.now(),
        models: cached?.models ?? [],
        stale: true,
        error: err instanceof Error ? err.message : 'fetch failed',
      });
      return getModelsForProvider(providerId, ctx);
    } finally {
      inflightFetches.delete(providerId);
    }
  })();

  inflightFetches.set(providerId, promise);
  return promise;
}

export function refreshProviderModels(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
): Promise<RegistryModelOption[]> {
  return loadProviderModels(providerId, ctx, { force: true });
}

/** Clear dynamic cache — used in tests. */
export function resetProviderModelCache(): void {
  dynamicModelCache.clear();
  inflightFetches.clear();
}
