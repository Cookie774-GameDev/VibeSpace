/** The existing local provider allowance; planning must describe this same value. */
export function resolveFoundryMaxNewTokens(requested: number | undefined): number {
  return Math.min(512, Math.max(1, requested ?? 320));
}

/** Catalogue provenance is supplied only from the current account-scoped model option. */
export function hasNativeFoundryContextValidation(input: {
  providerId: string;
  modelId: string;
  modelContextLimit: number | undefined;
  contextMetadataSource: string | undefined;
}): boolean {
  return input.providerId === 'foundry' &&
    /^artifact--[A-Za-z0-9_-]{1,64}$/.test(input.modelId) &&
    input.contextMetadataSource === 'foundry_catalog_ceiling' &&
    Number.isSafeInteger(input.modelContextLimit) &&
    input.modelContextLimit! >= 2 && input.modelContextLimit! <= 16_384;
}
