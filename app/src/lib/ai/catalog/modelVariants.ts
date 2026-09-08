export type EffortLabel = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'ultra' | 'max';

export type UpstreamReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface LiveVariant {
  id: string;
  label?: string;
  kind?: 'reasoning' | 'latency' | 'combined' | 'other';
  reasoningEffort?: UpstreamReasoningEffort;
  fast?: boolean;
}

export interface EffortOption {
  label: EffortLabel;
  upstreamVariant?: string;
  upstreamEffort?: UpstreamReasoningEffort;
  available: boolean;
  explanation?: string;
}

export class VariantNotAvailableError extends Error {
  readonly code = 'VARIANT_NOT_AVAILABLE';
  constructor(
    readonly requested: EffortLabel,
    readonly modelId: string,
    readonly availableVariants: readonly string[],
  ) {
    super(`Effort ${requested} is not available for ${modelId}`);
  }
}

const EFFORT_CANDIDATES: Readonly<
  Record<Exclude<EffortLabel, 'auto'>, readonly UpstreamReasoningEffort[]>
> = Object.freeze({
  minimal: ['minimal', 'none'],
  low: ['low'],
  medium: ['medium'],
  high: ['high'],
  ultra: ['xhigh'],
  max: ['max'],
});

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function variantReasoningEffort(
  variant: Readonly<LiveVariant>,
): UpstreamReasoningEffort | undefined {
  if (variant.reasoningEffort) return variant.reasoningEffort;
  const id = normalize(variant.id);
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(id)
    ? (id as UpstreamReasoningEffort)
    : undefined;
}

export function isFastVariant(variant: Readonly<LiveVariant>): boolean {
  return variant.fast === true || variant.kind === 'latency' || normalize(variant.id) === 'fast';
}

export function isCombinedVariant(variant: Readonly<LiveVariant>): boolean {
  return (
    variant.kind === 'combined' ||
    (isFastVariant(variant) && Boolean(variantReasoningEffort(variant)))
  );
}

export function listEffortOptions(variants: readonly LiveVariant[], _modelId = ''): EffortOption[] {
  const options: EffortOption[] = [{ label: 'auto', available: true }];
  for (const label of ['minimal', 'low', 'medium', 'high', 'ultra', 'max'] as const) {
    const efforts = EFFORT_CANDIDATES[label];
    const matched = variants.find((variant) => {
      const effort = variantReasoningEffort(variant);
      return effort !== undefined && efforts.includes(effort) && !isFastVariant(variant);
    });
    options.push({
      label,
      ...(matched
        ? { upstreamVariant: matched.id, upstreamEffort: variantReasoningEffort(matched) }
        : {}),
      available: Boolean(matched),
      ...(!matched ? { explanation: 'Not exposed by the selected live model connection.' } : {}),
    });
  }
  return options;
}

/** Resolve an exact named reasoning variant. Auto intentionally emits no override. */
export function resolveEffortVariant(
  modelId: string,
  requested: EffortLabel,
  variants: readonly LiveVariant[],
): string | undefined {
  if (requested === 'auto') return undefined;
  const option = listEffortOptions(variants, modelId).find(
    (candidate) => candidate.label === requested,
  );
  if (!option?.available || !option.upstreamVariant) {
    throw new VariantNotAvailableError(
      requested,
      modelId,
      variants.map((variant) => variant.id),
    );
  }
  return option.upstreamVariant;
}

export function resolveEffortValue(
  modelId: string,
  requested: EffortLabel,
  variants: readonly LiveVariant[],
): UpstreamReasoningEffort | undefined {
  if (requested === 'auto') return undefined;
  const option = listEffortOptions(variants, modelId).find(
    (candidate) => candidate.label === requested,
  );
  if (!option?.available || !option.upstreamEffort) {
    throw new VariantNotAvailableError(
      requested,
      modelId,
      variants.map((variant) => variant.id),
    );
  }
  return option.upstreamEffort;
}

export interface FastCapabilityMetadata {
  connectionId: string;
  modelId: string;
  variants?: readonly LiveVariant[];
  /** API/transport tiers exposed for this exact connection. `priority` is an accepted legacy alias. */
  serviceTiers?: readonly string[];
  /** OpenCode reports a native subscription/Codex fast control independent of model variants. */
  supportsOpenCodeFastMode?: boolean;
  /** The exact live model route has a fixed provider Fast service tier. */
  isFastRoute?: boolean;
}

export type FastTransport = 'service-tier' | 'opencode-native' | 'variant' | 'model-route' | 'off';

export interface FastResolution {
  enabled: boolean;
  supported: boolean;
  transport: FastTransport;
  serviceTier?: 'fast';
  openCodeFastMode?: true;
  upstreamVariant?: string;
  /** Provider/Codex fast mode can consume quota/credits differently. */
  usageWarningRequired: boolean;
}

/**
 * Resolve real provider/Codex fast mode. This never substitutes a faster model and
 * never calls ordinary VibeSpace orchestration “Fast mode”. Use `/performance
 * responsive` for client-side overhead tuning when provider fast is unavailable.
 */
export function resolveFastMode(
  enabled: boolean,
  metadata: FastCapabilityMetadata,
): FastResolution {
  if (!enabled) {
    return { enabled: false, supported: resolveFastMode(true, metadata).supported,
      transport: 'off', usageWarningRequired: false };
  }
  if (metadata.isFastRoute) {
    return { enabled: true, supported: true, transport: 'model-route', usageWarningRequired: true };
  }
  const tiers = new Set((metadata.serviceTiers ?? []).map(normalize));
  if (tiers.has('fast') || tiers.has('priority')) {
    return {
      enabled: true,
      supported: true,
      transport: 'service-tier',
      serviceTier: 'fast',
      usageWarningRequired: true,
    };
  }
  if (metadata.supportsOpenCodeFastMode === true) {
    return {
      enabled: true,
      supported: true,
      transport: 'opencode-native',
      openCodeFastMode: true,
      usageWarningRequired: true,
    };
  }
  const variant =
    (metadata.variants ?? []).find(
      (candidate) => isFastVariant(candidate) && !isCombinedVariant(candidate),
    ) ?? (metadata.variants ?? []).find(isFastVariant);
  if (variant) {
    return {
      enabled: true,
      supported: true,
      transport: 'variant',
      upstreamVariant: variant.id,
      usageWarningRequired: true,
    };
  }
  return {
    enabled: true,
    supported: false,
    transport: 'off',
    usageWarningRequired: false,
  };
}
