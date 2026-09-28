export type OpenRouterImageOutputModelMetadata = {
  id?: unknown;
  architecture?: { output_modalities?: unknown };
  pricing?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelOutputModalities(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.architecture)) return [];
  const modalities = value.architecture.output_modalities;
  return Array.isArray(modalities)
    ? modalities.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    : [];
}

function isExplicitZeroPrice(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  return /^(?:0+(?:\.0*)?|\.0+)$/u.test(text);
}

/** True only when text+image output and every catalog price are explicitly zero. */
export function isOpenRouterFreeImageOutputModel(value: unknown): boolean {
  const modalities = modelOutputModalities(value);
  if (!modalities.includes('text') || !modalities.includes('image') || !isRecord(value)) return false;
  const pricing = value.pricing;
  if (!isRecord(pricing)) return false;

  const pricingEntries = Object.entries(pricing);
  const hasImagePrice = Object.prototype.hasOwnProperty.call(pricing, 'image') ||
    Object.prototype.hasOwnProperty.call(pricing, 'image_output');
  if (!hasImagePrice || !['prompt', 'completion'].every((key) => Object.hasOwn(pricing, key))) {
    return false;
  }
  return pricingEntries.length > 0 && pricingEntries.every(([, price]) => isExplicitZeroPrice(price));
}

/** Catalog capability projection shared by model discovery and request preflight. */
export function getOpenRouterImageOutputCapabilities(value: unknown): {
  supportsImageOutput: boolean;
  isImageOutputFree: boolean;
} {
  const modalities = modelOutputModalities(value);
  const supportsImageOutput = modalities.includes('text') && modalities.includes('image');
  return {
    supportsImageOutput,
    isImageOutputFree: supportsImageOutput && isOpenRouterFreeImageOutputModel(value),
  };
}
