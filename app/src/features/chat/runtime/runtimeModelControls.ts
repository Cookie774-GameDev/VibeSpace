import {
  isCombinedVariant,
  isFastVariant,
  listEffortOptions,
  resolveFastMode,
  variantReasoningEffort,
  type EffortLabel,
  type LiveVariant,
  type UpstreamReasoningEffort,
} from '../../../lib/ai/catalog/modelVariants';

export type EffortPreference = EffortLabel;
export type FastModePreference = 'auto' | 'on' | 'off';
export type { LiveVariant as LiveModelVariant, UpstreamReasoningEffort };

export interface LiveModelRuntimeMetadata {
  connectionId: string;
  modelId: string;
  variants: readonly LiveVariant[];
  /** Reasoning can be sent separately from a named model variant. */
  supportsIndependentReasoningEffort?: boolean;
  /** Exact service tiers returned for this connection/model. */
  serviceTiers?: readonly string[];
  /** OpenCode exposes a native subscription/Codex fast control. */
  supportsOpenCodeFastMode?: boolean;
}

export interface RuntimeModelPreferences {
  effort: EffortPreference;
  fastMode: FastModePreference;
}

export interface ResolvedRuntimeControls {
  effort?: UpstreamReasoningEffort;
  variant?: string;
  serviceTier?: 'default' | 'fast';
  openCodeFastMode?: boolean;
  usageWarningRequired?: boolean;
}

export type RuntimeControlResolution =
  | { ok: true; controls: ResolvedRuntimeControls }
  | {
      ok: false;
      code:
        | 'EFFORT_UNSUPPORTED'
        | 'FAST_MODE_UNSUPPORTED'
        | 'CONTROL_COMBINATION_UNSUPPORTED';
      message: string;
      supportedEfforts: readonly EffortPreference[];
      fastModeSupported: boolean;
    };

function exactReasoningVariant(
  effort: UpstreamReasoningEffort,
  metadata: Readonly<LiveModelRuntimeMetadata>,
): LiveVariant | undefined {
  return metadata.variants.find(
    (variant) => variantReasoningEffort(variant) === effort && !isFastVariant(variant),
  );
}

function exactCombinedVariant(
  effort: UpstreamReasoningEffort,
  metadata: Readonly<LiveModelRuntimeMetadata>,
): LiveVariant | undefined {
  return metadata.variants.find(
    (variant) => isCombinedVariant(variant) && variantReasoningEffort(variant) === effort,
  );
}

export function supportedEffortPreferences(
  metadata: Readonly<LiveModelRuntimeMetadata>,
): readonly EffortPreference[] {
  return listEffortOptions(metadata.variants)
    .filter((option) => option.available)
    .map((option) => option.label);
}

export function supportsFastMode(metadata: Readonly<LiveModelRuntimeMetadata>): boolean {
  return resolveFastMode(true, metadata).supported;
}

function resolveEffort(
  preference: EffortPreference,
  metadata: Readonly<LiveModelRuntimeMetadata>,
): UpstreamReasoningEffort | undefined {
  if (preference === 'auto') return undefined;
  const option = listEffortOptions(metadata.variants).find(
    (candidate) => candidate.label === preference && candidate.available,
  );
  return option?.upstreamEffort;
}

/**
 * Resolve exact live controls. `/fast` is provider/Codex fast mode, not a model
 * substitution or a vague client performance preset. Unsupported selections
 * fail before the provider request.
 */
export function resolveRuntimeModelControls(
  preferences: Readonly<RuntimeModelPreferences>,
  metadata: Readonly<LiveModelRuntimeMetadata>,
): RuntimeControlResolution {
  const supportedEfforts = supportedEffortPreferences(metadata);
  const effort = resolveEffort(preferences.effort, metadata);
  if (preferences.effort !== 'auto' && !effort) {
    return {
      ok: false,
      code: 'EFFORT_UNSUPPORTED',
      message: `Effort “${preferences.effort}” is not available for ${metadata.modelId} on ${metadata.connectionId}.`,
      supportedEfforts,
      fastModeSupported: supportsFastMode(metadata),
    };
  }

  const fast = resolveFastMode(preferences.fastMode === 'on', metadata);
  if (preferences.fastMode === 'on' && !fast.supported) {
    return {
      ok: false,
      code: 'FAST_MODE_UNSUPPORTED',
      message: `Fast mode is not available for ${metadata.modelId} on ${metadata.connectionId}. Use /performance responsive to reduce VibeSpace overhead without pretending provider Fast mode is active.`,
      supportedEfforts,
      fastModeSupported: false,
    };
  }

  const controls: ResolvedRuntimeControls = {};
  if (preferences.fastMode === 'off' && (metadata.serviceTiers ?? []).some((tier) =>
    ['fast', 'priority'].includes(tier.trim().toLocaleLowerCase('en-US')),
  )) {
    controls.serviceTier = 'default';
  }

  if (preferences.fastMode === 'on') {
    controls.usageWarningRequired = fast.usageWarningRequired;
    if (fast.transport === 'service-tier') controls.serviceTier = 'fast';
    if (fast.transport === 'opencode-native') controls.openCodeFastMode = true;
    if (fast.transport === 'variant' && fast.upstreamVariant) {
      if (!effort) {
        controls.variant = fast.upstreamVariant;
        return { ok: true, controls };
      }
      const combined = exactCombinedVariant(effort, metadata);
      if (combined) {
        controls.variant = combined.id;
        return { ok: true, controls };
      }
      if (!metadata.supportsIndependentReasoningEffort) {
        return {
          ok: false,
          code: 'CONTROL_COMBINATION_UNSUPPORTED',
          message: `Fast mode and effort “${preferences.effort}” cannot be combined for ${metadata.modelId} on ${metadata.connectionId}.`,
          supportedEfforts,
          fastModeSupported: true,
        };
      }
      controls.variant = fast.upstreamVariant;
      controls.effort = effort;
      return { ok: true, controls };
    }
  }

  if (effort) {
    if (metadata.supportsIndependentReasoningEffort) {
      controls.effort = effort;
    } else {
      const variant = exactReasoningVariant(effort, metadata);
      if (!variant) {
        return {
          ok: false,
          code: 'EFFORT_UNSUPPORTED',
          message: `Effort “${preferences.effort}” has no executable live variant for ${metadata.modelId} on ${metadata.connectionId}.`,
          supportedEfforts,
          fastModeSupported: fast.supported,
        };
      }
      controls.variant = variant.id;
    }
  }

  return { ok: true, controls };
}

export type RuntimeSlashCommand =
  | { kind: 'effort'; value?: EffortPreference | 'status' }
  | { kind: 'fast'; value?: FastModePreference | 'status' };

export function parseRuntimeSlashCommand(input: string): RuntimeSlashCommand | null {
  const tokens = input.trim().toLocaleLowerCase('en-US').split(/\s+/u).filter(Boolean);
  if (tokens[0] === '/effort') {
    if (tokens.length > 2) return null;
    const value = tokens[1];
    if (!value) return { kind: 'effort' };
    if (['auto', 'minimal', 'low', 'medium', 'high', 'ultra', 'max', 'status'].includes(value)) {
      return { kind: 'effort', value: value as EffortPreference | 'status' };
    }
    return null;
  }
  if (tokens[0] === '/fast') {
    if (tokens.length > 2) return null;
    const value = tokens[1];
    if (!value) return { kind: 'fast' };
    if (['auto', 'on', 'off', 'status'].includes(value)) {
      return { kind: 'fast', value: value as FastModePreference | 'status' };
    }
    return null;
  }
  return null;
}
