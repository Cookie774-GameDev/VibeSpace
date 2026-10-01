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

function safeIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isCompleteZeroPricing(value: unknown): value is HarnessModelPricing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pricing = value as Record<string, unknown>;
  const keys = Object.keys(pricing);
  if (
    keys.length !== 4 ||
    !['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => keys.includes(key))
  ) {
    return false;
  }
  return (
    pricing.input === 0 &&
    pricing.output === 0 &&
    pricing.cacheRead === 0 &&
    pricing.cacheWrite === 0
  );
}

function isFreeModel(model: HarnessModel): boolean {
  return safeIdentity(model.id, MAX_MODEL_ID) && isCompleteZeroPricing(model.pricing);
}

function isEarlier(
  candidate: HarnessModelSelection,
  current: HarnessModelSelection | null,
): boolean {
  return (
    current === null ||
    candidate.providerId < current.providerId ||
    (candidate.providerId === current.providerId && candidate.modelId < current.modelId)
  );
}

export function selectCurrentFreeHarnessModel(
  providers: readonly HarnessProvider[],
): HarnessModelSelection | null {
  let selected: HarnessModelSelection | null = null;
  for (const provider of providers.slice(0, MAX_PROVIDERS)) {
    if (
      provider.connected !== true ||
      !safeIdentity(provider.id, MAX_PROVIDER_ID) ||
      !Array.isArray(provider.models)
    ) {
      continue;
    }
    for (const model of provider.models.slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (!isFreeModel(model)) continue;
      const candidate = { providerId: provider.id, modelId: model.id };
      if (isEarlier(candidate, selected)) selected = candidate;
    }
  }
  return selected ? Object.freeze(selected) : null;
}

export function isCurrentFreeHarnessModel(
  selection: HarnessModelSelection,
  providers: readonly HarnessProvider[],
): boolean {
  if (
    !safeIdentity(selection.providerId, MAX_PROVIDER_ID) ||
    !safeIdentity(selection.modelId, MAX_MODEL_ID)
  ) {
    return false;
  }
  return providers
    .slice(0, MAX_PROVIDERS)
    .some(
      (provider) =>
        provider.connected === true &&
        provider.id === selection.providerId &&
        safeIdentity(provider.id, MAX_PROVIDER_ID) &&
        Array.isArray(provider.models) &&
        provider.models
          .slice(0, MAX_MODELS_PER_PROVIDER)
          .some((model) => model.id === selection.modelId && isFreeModel(model)),
    );
}
