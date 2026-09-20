import type { ResolvedRuntimeControls } from '@/features/chat/runtime/runtimeModelControls';
import type { PerformanceProfile } from '@/features/chat/runtime/performanceProfile';

/** Transport-neutral controls consumed by the persistent OpenCode harness. */
export interface OpenCodeRequestControls {
  connectionId: string;
  providerId: string;
  modelId: string;
  effort?: ResolvedRuntimeControls['effort'];
  variant?: string;
  serviceTier?: ResolvedRuntimeControls['serviceTier'];
  openCodeFastMode?: boolean;
  performance: PerformanceProfile;
  rlmEnabled: boolean;
}

export function buildOpenCodeRequestControls(input: {
  connectionId: string;
  providerId: string;
  modelId: string;
  runtime: ResolvedRuntimeControls;
  performance: PerformanceProfile;
  rlmEnabled: boolean;
}): OpenCodeRequestControls {
  const connectionId = input.connectionId.trim();
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  if (!connectionId || !providerId || !modelId) {
    throw new Error('Exact connectionId, providerId, and modelId are required.');
  }
  return {
    connectionId,
    providerId,
    modelId,
    ...(input.runtime.effort ? { effort: input.runtime.effort } : {}),
    ...(input.runtime.variant ? { variant: input.runtime.variant } : {}),
    ...(input.runtime.serviceTier ? { serviceTier: input.runtime.serviceTier } : {}),
    ...(input.runtime.openCodeFastMode !== undefined
      ? { openCodeFastMode: input.runtime.openCodeFastMode }
      : {}),
    performance: input.performance,
    rlmEnabled: input.rlmEnabled,
  };
}

/**
 * OpenCode's command endpoint accepts one provider-qualified route string.
 * The OpenCode bridge's picker family can carry an already-qualified live ID;
 * explicit provider controls retain their own nested model authority.
 */
export function qualifiedOpenCodeModelRoute(
  controls: Pick<OpenCodeRequestControls, 'connectionId' | 'providerId' | 'modelId'>,
): string {
  const connectionId = controls.connectionId.trim();
  const providerId = controls.providerId.trim();
  const modelId = controls.modelId.trim();
  if (!connectionId || !providerId || !modelId) {
    throw new Error('OpenCode connection, provider, and model are required.');
  }
  // The picker stores the OpenCode bridge family as `opencode` while its live
  // catalog model IDs are qualified by the upstream provider (for example
  // `opencode-go/deepseek...`). Explicit providers such as OpenRouter use a
  // nested upstream model ID and must retain their own provider authority.
  const bridgeQualified = connectionId === 'opencode-cli' && providerId === 'opencode';
  return bridgeQualified && modelId.includes('/') ? modelId : `${providerId}/${modelId}`;
}

/** Convert the exact qualified route to prompt_async's providerID/modelID shape. */
export function openCodePromptModel(
  controls: Pick<OpenCodeRequestControls, 'connectionId' | 'providerId' | 'modelId'>,
): Readonly<{ providerID: string; modelID: string }> {
  const providerId = controls.providerId.trim();
  const modelId = controls.modelId.trim();
  const bridgeQualified =
    controls.connectionId.trim() === 'opencode-cli' && providerId === 'opencode';
  if (!bridgeQualified || !modelId.includes('/')) {
    if (!providerId || !modelId) throw new Error('OpenCode provider and model are required.');
    return Object.freeze({ providerID: providerId, modelID: modelId });
  }
  const route = qualifiedOpenCodeModelRoute(controls);
  const separator = route.indexOf('/');
  if (separator <= 0 || separator === route.length - 1) {
    throw new Error('OpenCode model route is not provider-qualified.');
  }
  return Object.freeze({
    providerID: route.slice(0, separator),
    modelID: route.slice(separator + 1),
  });
}

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toLocaleLowerCase('en-US') || undefined;
}

function sameServiceTier(requested: string | undefined, observed: string | undefined): boolean {
  const left = normalized(requested);
  const right = normalized(observed);
  if (left === right) return true;
  // Current upstream can accept `fast` but report the legacy name `priority`.
  return Boolean(left && right && new Set([left, right]).size === 2 && [left, right].every((v) =>
    v === 'fast' || v === 'priority',
  ));
}

export interface ObservedModelIdentity {
  connectionId: string;
  providerId?: string;
  modelId: string;
  variant?: string;
  serviceTier?: string;
}

/** No silent provider, model, effort/variant, route, or billing-tier fallback. */
export function assertObservedModelMatches(input: {
  requested: ObservedModelIdentity;
  observed: ObservedModelIdentity;
}): void {
  const routeMatches = normalized(input.requested.connectionId) === normalized(input.observed.connectionId);
  const providerMatches = !input.requested.providerId
    || normalized(input.requested.providerId) === normalized(input.observed.providerId);
  const modelMatches = normalized(input.requested.modelId) === normalized(input.observed.modelId);
  const variantMatches = !input.requested.variant
    || normalized(input.requested.variant) === normalized(input.observed.variant);
  const serviceTierMatches = sameServiceTier(input.requested.serviceTier, input.observed.serviceTier);
  if (!routeMatches || !providerMatches || !modelMatches || !variantMatches || !serviceTierMatches) {
    throw new Error(
      `MODEL_IDENTITY_MISMATCH: requested ${input.requested.connectionId}/${input.requested.modelId}`
      + `, observed ${input.observed.connectionId}/${input.observed.modelId}.`,
    );
  }
}
