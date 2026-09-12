import { HarnessError } from './errors';
import type {
  HarnessModel,
  HarnessModelPricing,
  HarnessModelSelection,
  HarnessProvider,
} from './types';

const MAX_PROVIDERS = 256;
const MAX_MODELS_PER_PROVIDER = 4_096;
const MAX_PROVIDER_ID = 256;
const MAX_MODEL_ID = 512;
const MAX_DISPLAY_NAME = 512;
const MAX_PRICE_PER_MILLION_TOKENS = 1_000_000;

type UnknownRecord = Record<string, unknown>;

export interface OpenCodeSelectionInput extends HarnessModelSelection {
  connectionId?: string;
  runtimeProviderId?: string;
}

export interface ReconciledHarnessModel extends HarnessModel {
  available: boolean;
  runtimeModelId?: string;
  dynamic?: boolean;
}

export interface ReconciledHarnessProvider {
  id: string;
  name: string;
  available: boolean;
  runtimeProviderId?: string;
  dynamic?: boolean;
  models: readonly ReconciledHarnessModel[];
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function boundedIdentity(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const identity = value.trim();
  if (!identity || identity.length > maximum || /[\u0000-\u001f\u007f]/.test(identity)) {
    return undefined;
  }
  return identity;
}

function boundedName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return name ? name.slice(0, MAX_DISPLAY_NAME) : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function exactKeys(record: UnknownRecord, required: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

function boundedPrice(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PRICE_PER_MILLION_TOKENS
    ? value
    : undefined;
}

function liveModelVariants(model: UnknownRecord): readonly string[] | undefined {
  const raw = model.variants;
  if (Array.isArray(raw)) {
    const variants = raw.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    return variants.length > 0 ? Object.freeze(variants) : undefined;
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  const variants = Object.keys(record).filter((key) => key.length > 0 && key.length <= 32);
  return variants.length > 0 ? Object.freeze(variants) : undefined;
}

function modelPricing(value: unknown): Readonly<HarnessModelPricing> | undefined {
  const cost = asRecord(value);
  if (!cost || !exactKeys(cost, ['input', 'output', 'cache'])) return undefined;
  const cache = asRecord(cost.cache);
  if (!cache || !exactKeys(cache, ['read', 'write'])) return undefined;

  const input = boundedPrice(cost.input);
  const output = boundedPrice(cost.output);
  const cacheRead = boundedPrice(cache.read);
  const cacheWrite = boundedPrice(cache.write);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ input, output, cacheRead, cacheWrite });
}

export function parseOpenCodeProviderResponse(value: unknown): readonly HarnessProvider[] {
  const response = asRecord(value);
  if (!response || !Array.isArray(response.providers)) return [];

  const seenProviders = new Set<string>();
  const providers: HarnessProvider[] = [];
  for (const candidate of response.providers.slice(0, MAX_PROVIDERS)) {
    const provider = asRecord(candidate);
    const id = provider && boundedIdentity(provider.id, MAX_PROVIDER_ID);
    const models = provider && asRecord(provider.models);
    if (!provider || !id || !models || seenProviders.has(id)) continue;
    seenProviders.add(id);

    const seenModels = new Set<string>();
    const parsedModels: HarnessModel[] = [];
    for (const [rawId, rawModel] of Object.entries(models).slice(0, MAX_MODELS_PER_PROVIDER)) {
      const modelId = boundedIdentity(rawId, MAX_MODEL_ID);
      const model = asRecord(rawModel);
      if (!modelId || !model || seenModels.has(modelId)) continue;
      seenModels.add(modelId);

      const limit = asRecord(model.limit);
      const modalities = asRecord(model.modalities);
      const inputModalities = Array.isArray(modalities?.input) ? modalities.input : undefined;
      const contextWindowTokens = positiveInteger(limit?.context);
      const pricing = modelPricing(model.cost);
      const supportsImages =
        typeof model.attachment === 'boolean'
          ? model.attachment
          : inputModalities
            ? inputModalities.includes('image')
            : undefined;
      const supportsTools = typeof model.tool_call === 'boolean' ? model.tool_call : undefined;
      const variants = liveModelVariants(model);
      parsedModels.push({
        id: modelId,
        name: boundedName(model.name, modelId),
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        ...(typeof supportsImages === 'boolean' ? { supportsImages } : {}),
        ...(typeof supportsTools === 'boolean' ? { supportsTools } : {}),
        ...(variants ? { variants } : {}),
        ...(pricing ? { pricing } : {}),
      });
    }

    providers.push({
      id,
      name: boundedName(provider.name, id),
      models: parsedModels,
      connected: true,
    });
  }
  return providers;
}

function runtimeProviderId(input: {
  providerId: string;
  connectionId?: string;
  runtimeProviderId?: string;
}): string {
  if (input.runtimeProviderId) return input.runtimeProviderId;
  if (input.connectionId === 'google-vertex') return 'google-vertex';
  if (input.providerId === 'local') return 'ollama';
  if (input.providerId === 'bedrock') return 'amazon-bedrock';
  return input.providerId;
}

export function resolveOpenCodeSelection(
  input: OpenCodeSelectionInput,
  providers: readonly HarnessProvider[],
): HarnessModelSelection {
  const resolvedProviderId = runtimeProviderId(input);
  const provider = providers.find((candidate) => candidate.id === resolvedProviderId);
  if (!provider) {
    throw new HarnessError({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: `Provider "${input.providerId}" is not available through OpenCode.`,
      repair: 'Connect this provider or select an available provider.',
      recoverable: true,
    });
  }
  if (!provider.models.some((model) => model.id === input.modelId)) {
    throw new HarnessError({
      code: 'MODEL_NOT_AVAILABLE',
      message: `Model "${input.modelId}" is not available for "${provider.id}".`,
      repair: 'Refresh models or select an available model.',
      recoverable: true,
    });
  }
  return { providerId: provider.id, modelId: input.modelId };
}

/** True when the live/cached catalog already contains this exact selection. */
export function catalogContainsSelection(
  input: OpenCodeSelectionInput,
  providers: readonly HarnessProvider[],
): boolean {
  try {
    resolveOpenCodeSelection(input, providers);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trusted one-provider catalog for a user-selected model so a send is not
 * blocked on OpenCode's full /config/providers scan. The selected identity is
 * still sent unchanged; OpenCode rejects it if the runtime truly lacks it.
 */
export function trustedCatalogForSelection(
  input: OpenCodeSelectionInput,
): readonly HarnessProvider[] {
  const modelId = boundedIdentity(input.modelId, MAX_MODEL_ID);
  if (!modelId) return [];
  const id = runtimeProviderId(input);
  return Object.freeze([
    {
      id,
      name: boundedName(input.providerId, id),
      models: Object.freeze([{ id: modelId, name: boundedName(modelId, modelId) }]),
      connected: true,
    },
  ]);
}

export function reconcileHarnessProviderCatalog(
  catalog: readonly HarnessProvider[],
  runtime: readonly HarnessProvider[],
): readonly ReconciledHarnessProvider[] {
  const reconciled: ReconciledHarnessProvider[] = catalog.map((productProvider) => {
    const runtimeId = runtimeProviderId({ providerId: productProvider.id });
    const liveProvider = runtime.find((candidate) => candidate.id === runtimeId);
    const liveModels = new Map(
      liveProvider?.models.map((model) => [model.id, model] as const) ?? [],
    );
    const productModelIds = new Set(productProvider.models.map((model) => model.id));
    const models: ReconciledHarnessModel[] = productProvider.models.map((productModel) => {
      const liveModel = liveModels.get(productModel.id);
      return {
        ...(liveModel ?? {}),
        ...productModel,
        available: Boolean(liveModel),
        ...(liveModel ? { runtimeModelId: liveModel.id } : {}),
      };
    });
    for (const liveModel of liveProvider?.models ?? []) {
      if (productModelIds.has(liveModel.id)) continue;
      models.push({
        ...liveModel,
        available: true,
        runtimeModelId: liveModel.id,
        dynamic: true,
      });
    }
    return {
      id: productProvider.id,
      name: productProvider.name,
      available: Boolean(liveProvider),
      ...(liveProvider ? { runtimeProviderId: liveProvider.id } : {}),
      models,
    };
  });

  const catalogRuntimeIds = new Set(
    catalog.map((provider) => runtimeProviderId({ providerId: provider.id })),
  );
  for (const liveProvider of runtime) {
    if (catalogRuntimeIds.has(liveProvider.id)) continue;
    reconciled.push({
      id: liveProvider.id,
      name: liveProvider.name,
      available: true,
      runtimeProviderId: liveProvider.id,
      dynamic: true,
      models: liveProvider.models.map((model) => ({
        ...model,
        available: true,
        runtimeModelId: model.id,
        dynamic: true,
      })),
    });
  }
  return reconciled;
}
