import type { ProviderId } from '@/types';
import { promotedAdapterForProject } from '@/features/model-foundry/adapterRegistry';
import { nativeFetch } from '@/lib/nativeFetch';
import {
  CHAT_MODEL_OPTIONS,
  defaultModelForProvider,
  getAccessibleModelOptions,
  type ModelOption,
} from './models';
import {
  getProviderDisplayName,
  getProviderRegistryEntry,
  isLocalProvider,
  isProviderConnected,
  PROVIDER_REGISTRY,
  type ProviderConnectionContext,
} from './providerRegistry';
import { setDiscoveredConnectionModels } from './connectionCatalog';
import { verifiedQwenCompatibleBaseUrl } from './nativeConnectionProbe';
import { getOpenRouterImageOutputCapabilities } from './openrouterImageOutput';

const NATIVE_CONNECTION_ID_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  openai: 'openai-api',
  anthropic: 'anthropic-api',
  google: 'google-gemini-api',
  groq: 'groq-api',
  deepseek: 'deepseek-api',
  zai: 'zai-api',
  qwen: 'qwen-api',
  mistral: 'mistral-api',
  together: 'together-api',
  xai: 'xai-api',
  openrouter: 'openrouter-api',
};

export type ModelAvailability =
  | 'stable'
  | 'preview'
  | 'experimental'
  | 'deprecated'
  | 'custom'
  | 'unverified';

export interface RegistryModelOption {
  id: string;
  label: string;
  provider: ProviderId;
  availability: ModelAvailability;
  isCustom?: boolean;
  /** Smaller subtitle shown under the label (usually the raw model id). */
  subtitle?: string;
  /** OpenRouter account-catalog evidence that the model advertises text+image output. */
  supportsImageOutput?: boolean;
  /** True only when all live OpenRouter pricing fields are explicitly zero. */
  isImageOutputFree?: boolean;
}

export interface ProviderModelValidation {
  ok: boolean;
  error?: string;
  warning?: string;
  isCustomModel?: boolean;
}

/** Catalog reads happen outside prompt dispatch and refresh on a bounded five-minute cadence. */
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type ModelCacheEntry = {
  fetchedAt: number;
  models: RegistryModelOption[];
  stale: boolean;
  /** In-memory only; prevents a prior account's result being reused after a key change. */
  credential: string;
  error?: string;
};

const dynamicModelCache = new Map<ProviderId, ModelCacheEntry>();
type InflightModelFetch = {
  credential: string;
  promise: Promise<RegistryModelOption[]>;
};
const inflightFetches = new Map<ProviderId, InflightModelFetch>();

export function sanitizeModelIdForInput(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

function sanitizeModelId(raw: string): string {
  return sanitizeModelIdForInput(raw);
}

function toRegistryOption(
  option: ModelOption,
  availability: ModelAvailability = 'stable',
): RegistryModelOption {
  return {
    id: option.id,
    label: option.label,
    provider: option.provider,
    availability,
    subtitle: option.id,
  };
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

  return merged;
}

/** Resolve dropdown models from the current authenticated provider catalog. */
export function getModelsForProvider(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
  _savedModelId?: string,
): RegistryModelOption[] {
  if (!isProviderConnected(providerId, ctx) && !isLocalProvider(providerId)) {
    return [];
  }

  const credential = ctx.apiKeys[providerId]?.trim() ?? '';
  const cachedEntry = dynamicModelCache.get(providerId);
  const cached =
    cachedEntry && (isLocalProvider(providerId) || cachedEntry.credential === credential)
      ? cachedEntry.models
      : [];
  if (cached.length > 0) {
    return mergeModelOptions(providerId, [cached]);
  }
  // A dynamic provider's static list is useful for migrations and validation,
  // but it is not an authorization result. Showing it in the picker makes an
  // unsigned-in account look like it can run every historical model.
  if (
    getProviderRegistryEntry(providerId)?.supportsDynamicListing &&
    !isLocalProvider(providerId)
  ) {
    return [];
  }
  const staticModels = staticOptionsForProvider(providerId, ctx).map((option) => ({
    ...option,
    availability: 'unverified' as const,
  }));
  return mergeModelOptions(providerId, [staticModels]);
}

export function getModelLabelForProvider(
  providerId: ProviderId,
  modelId: string,
  ctx: ProviderConnectionContext,
): string {
  if (providerId === 'foundry') {
    const match = /^([A-Za-z0-9_-]{1,64})--([A-Za-z0-9_-]{1,64})$/.exec(modelId);
    if (match && typeof window !== 'undefined') {
      try {
        const adapter = promotedAdapterForProject(window.localStorage, match[1]!);
        if (adapter?.jobId === match[2] && adapter.projectName?.trim()) {
          return adapter.projectName.trim();
        }
      } catch {
        // Storage access is optional; fall back to the opaque adapter id.
      }
    }
    return `VibeModel adapter · ${modelId}`;
  }
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
  return (dynamicModelCache.get(providerId)?.models ?? []).some(
    (option) => option.id.toLowerCase() === id.toLowerCase(),
  );
}

export function validateProviderModelSelection(
  providerId: ProviderId,
  modelId: string,
  ctx: ProviderConnectionContext,
  _opts?: { allowCustom?: boolean },
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
    return {
      ok: false,
      error: `This model is not available for ${getProviderDisplayName(providerId)}.`,
    };
  }

  if (match.availability === 'deprecated') {
    return {
      ok: true,
      warning: 'This model may be deprecated. Choose a newer model before production use.',
    };
  }

  if (match.availability === 'unverified') {
    return {
      ok: true,
      warning: 'STALE / UNVERIFIED catalog. Refresh models before treating this ID as current.',
    };
  }

  return { ok: true };
}

export function resolveSelectedModelOrDisable(
  providerId: ProviderId,
  selectedModelId: string,
  ctx: ProviderConnectionContext,
): { status: 'available' | 'missing'; modelId: string; error?: string } {
  const trimmed = sanitizeModelId(selectedModelId);
  if (!trimmed) {
    return {
      status: 'missing',
      modelId: '',
      error: `Select a ${getProviderDisplayName(providerId)} model.`,
    };
  }
  const match = getModelsForProvider(providerId, ctx).find(
    (option) => option.id.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match) return { status: 'available', modelId: match.id };
  return {
    status: 'missing',
    modelId: trimmed,
    error: `${trimmed} is no longer available for ${getProviderDisplayName(providerId)}. Choose another model.`,
  };
}

export function resolveModelOnProviderChange(
  nextProvider: ProviderId,
  currentModel: string,
  ctx: ProviderConnectionContext,
): string {
  const options = getModelsForProvider(nextProvider, ctx, currentModel);
  const keep = options.find(
    (option) => option.id.toLowerCase() === sanitizeModelId(currentModel).toLowerCase(),
  );
  if (keep && !keep.isCustom) return keep.id;
  return (
    options.find((option) => !option.isCustom)?.id ??
    defaultModelForProvider(nextProvider, ctx.defaultLocalModel)
  );
}

export function getProviderModelCacheState(providerId: ProviderId): {
  stale: boolean;
  error?: string;
  fetchedAt?: number;
} {
  const entry = dynamicModelCache.get(providerId);
  if (!entry) return { stale: false };
  const expired = Date.now() - entry.fetchedAt > MODEL_CATALOG_REFRESH_INTERVAL_MS;
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

interface OpenAiCompatibleModelRow {
  id?: string;
  type?: string;
  capabilities?: { completion_chat?: boolean };
  architecture?: { output_modalities?: unknown };
  pricing?: Record<string, unknown>;
}

function isOpenAiCompatibleModelRow(value: unknown): value is OpenAiCompatibleModelRow {
  return typeof value === 'object' && value !== null;
}

const NON_CHAT_MODEL_ID_SEGMENT_RE =
  /(?:^|[./_-])(?:agents?|asr|audio|computer[._-]?use|deep[._-]?research|embed(?:ding)?s?|image|livetranslate|moderation|realtime|rerank|speech|transcri(?:be|ption)|translat(?:e|ion)|tts|video|whisper)(?:$|[./_-])/iu;

function isChatTransportCompatibleModelId(id: string): boolean {
  return !NON_CHAT_MODEL_ID_SEGMENT_RE.test(id);
}

function parseOpenAiCompatibleModels(
  providerId: ProviderId,
  payload: { data?: unknown[] } | unknown[],
): RegistryModelOption[] {
  const rows = (Array.isArray(payload) ? payload : (payload.data ?? [])).filter(
    isOpenAiCompatibleModelRow,
  );
  return rows
    .filter(
      (row) => !row.type || row.type === 'chat' || row.type === 'language' || row.type === 'code',
    )
    .filter((row) => row.capabilities?.completion_chat !== false)
    .filter((row) => {
      const id = row.id?.trim();
      if (!id) return false;
      if (providerId !== 'openrouter') return isChatTransportCompatibleModelId(id);
      const imageOutput = getOpenRouterImageOutputCapabilities(row).supportsImageOutput;
      return isChatTransportCompatibleModelId(id) || imageOutput;
    })
    .sort((left, right) => {
      if (providerId !== 'openrouter') return 0;
      const leftFreeImage = getOpenRouterImageOutputCapabilities(left).isImageOutputFree ? 1 : 0;
      const rightFreeImage = getOpenRouterImageOutputCapabilities(right).isImageOutputFree ? 1 : 0;
      return rightFreeImage - leftFreeImage;
    })
    .slice(0, 40)
    .map((row) => {
      const id = row.id!.trim();
      const option: RegistryModelOption = {
        id,
        label: id,
        provider: providerId,
        availability: 'stable',
        subtitle: id,
      };
      if (providerId === 'openrouter') {
        Object.assign(option, getOpenRouterImageOutputCapabilities(row));
      }
      return option;
    });
}

function parseGoogleModels(payload: {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: unknown;
  }>;
}): RegistryModelOption[] {
  const rows: RegistryModelOption[] = [];
  for (const row of payload.models ?? []) {
    const raw = row.name?.replace(/^models\//, '').trim();
    if (!raw) continue;
    if (!isChatTransportCompatibleModelId(raw)) continue;
    const methods = Array.isArray(row.supportedGenerationMethods)
      ? row.supportedGenerationMethods.filter(
          (method): method is string => typeof method === 'string',
        )
      : [];
    if (
      methods.length > 0 &&
      !methods.some((method) => method === 'generateContent' || method === 'streamGenerateContent')
    ) {
      continue;
    }
    rows.push({
      id: raw,
      label: row.displayName?.trim() || raw,
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
    case 'openrouter':
    case 'deepseek':
    case 'zai':
    case 'mistral':
    case 'together':
    case 'xai':
    case 'qwen': {
      const endpoints: Record<string, string> = {
        groq: 'https://api.groq.com/openai/v1/models',
        openrouter: 'https://openrouter.ai/api/v1/models/user',
        deepseek: 'https://api.deepseek.com/models',
        zai: 'https://api.z.ai/api/paas/v4/models',
        mistral: 'https://api.mistral.ai/v1/models',
        together: 'https://api.together.xyz/models',
        xai: 'https://api.x.ai/v1/language-models',
        qwen: '',
      };
      const base =
        providerId === 'qwen'
          ? (() => {
              const verified = verifiedQwenCompatibleBaseUrl();
              if (!verified) {
                throw new Error('Qwen has no authenticated endpoint for the current credential.');
              }
              return `${verified}/models`;
            })()
          : endpoints[providerId];
      if (!base) return [];
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

  const apiKey = ctx.apiKeys[providerId]?.trim() ?? '';
  const cachedEntry = dynamicModelCache.get(providerId);
  const cached =
    cachedEntry && (isLocalProvider(providerId) || cachedEntry.credential === apiKey)
      ? cachedEntry
      : undefined;
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.fetchedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS &&
    cached.models.length > 0
  ) {
    return getModelsForProvider(providerId, ctx);
  }

  if (!apiKey && !isLocalProvider(providerId)) {
    inflightFetches.delete(providerId);
    dynamicModelCache.delete(providerId);
    const connectionId = NATIVE_CONNECTION_ID_BY_PROVIDER[providerId];
    if (connectionId) setDiscoveredConnectionModels(connectionId, []);
    return getModelsForProvider(providerId, ctx);
  }

  const inflight = inflightFetches.get(providerId);
  if (inflight?.credential === apiKey) return inflight.promise;
  const connectionId = NATIVE_CONNECTION_ID_BY_PROVIDER[providerId];
  if ((inflight && inflight.credential !== apiKey) || (cachedEntry && !cached)) {
    if (connectionId) setDiscoveredConnectionModels(connectionId, []);
  }
  // The latest discovery owns publication. A reconnect must neither inherit
  // an earlier account's promise nor let its delayed response restore models.
  const fetch: InflightModelFetch = { credential: apiKey, promise: Promise.resolve([]) };

  const promise = (async () => {
    try {
      const dynamic = await (apiKey ? fetchModelsFromProvider(providerId, apiKey) : Promise.resolve([]));
      if (inflightFetches.get(providerId) !== fetch) return [];
      dynamicModelCache.set(providerId, {
        fetchedAt: Date.now(),
        models: dynamic,
        stale: false,
        credential: apiKey,
      });
      if (connectionId) {
        setDiscoveredConnectionModels(
          connectionId,
          dynamic.map((model) => ({
            id: model.id,
            label: model.label,
            source: 'provider_list' as const,
            lastVerifiedAt: Date.now(),
          })),
        );
      }
      return getModelsForProvider(providerId, ctx);
    } catch (err) {
      if (inflightFetches.get(providerId) !== fetch) return [];
      dynamicModelCache.set(providerId, {
        fetchedAt: Date.now(),
        models: cached?.models ?? [],
        stale: true,
        credential: apiKey,
        error: err instanceof Error ? err.message : 'fetch failed',
      });
      return getModelsForProvider(providerId, ctx);
    } finally {
      if (inflightFetches.get(providerId) === fetch) inflightFetches.delete(providerId);
    }
  })();

  fetch.promise = promise;
  inflightFetches.set(providerId, fetch);
  return promise;
}

export function refreshProviderModels(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
): Promise<RegistryModelOption[]> {
  return loadProviderModels(providerId, ctx, { force: true });
}

export type ConnectedProviderCatalogRefreshResult = {
  providerId: ProviderId;
  status: 'refreshed' | 'failed';
};

/**
 * Refresh each connected BYOK catalog without sending a prompt or blocking a model request.
 * A small worker pool avoids spiking user/provider rate limits when several accounts are linked.
 */
export async function refreshConnectedProviderModels(
  ctx: ProviderConnectionContext,
): Promise<readonly ConnectedProviderCatalogRefreshResult[]> {
  if (ctx.offlineMode) return [];
  const providerIds = PROVIDER_REGISTRY.filter(
    (entry) =>
      entry.supportsDynamicListing &&
      !isLocalProvider(entry.id) &&
      Boolean(ctx.apiKeys[entry.id]?.trim()),
  ).map((entry) => entry.id);
  const results = new Map<ProviderId, ConnectedProviderCatalogRefreshResult>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < providerIds.length) {
      const providerId = providerIds[nextIndex++]!;
      await refreshProviderModels(providerId, ctx);
      results.set(providerId, {
        providerId,
        status: getProviderModelCacheState(providerId).error ? 'failed' : 'refreshed',
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, providerIds.length) }, worker));
  return providerIds.map((providerId) => results.get(providerId)!);
}

/** Clear dynamic cache — used in tests. */
export function resetProviderModelCache(): void {
  dynamicModelCache.clear();
  inflightFetches.clear();
}
