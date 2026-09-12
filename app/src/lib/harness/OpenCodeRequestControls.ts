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
