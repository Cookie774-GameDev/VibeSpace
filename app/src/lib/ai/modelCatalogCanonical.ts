/**
 * Compatibility surface for PR-31 callers while the catalog moves under
 * `lib/ai/catalog`. New code should import the canonical module directly.
 */
export {
  canonicalModelId,
  canonicalProviderModelId,
  dedupeModelMetadata,
  dedupeModelMetadata as dedupeConnectionModels,
  modelRouteLabel,
} from './catalog/canonicalModelCatalog';
export type {
  ModelCatalogSource,
  SimpleModelCatalogRecord,
  SimpleModelCatalogRecord as CanonicalModelRecord,
} from './catalog/canonicalModelCatalog';
