import { listEffortOptions } from './catalog/modelVariants';
import finalBossSkill from '../../../.jarvis/skills/token-final-boss/SKILL.md?raw';
import { ponytailInstructions } from './ponytailInstructions';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'ultra' | 'max';
export type ReasoningMode = 'token-saver' | 'normal' | 'token-final-boss';

export interface ReasoningSelection {
  providerId: string;
  modelId: string;
  connectionId?: string;
}

export interface ReasoningPreference {
  mode: ReasoningMode;
  effortOverride: ReasoningEffort | null;
}

export interface ReasoningCapabilities {
  supportedEfforts: readonly ReasoningEffort[];
  providerOptionKey: string | null;
  wireEffort: (effort: ReasoningEffort) => string;
}

export interface ResolvedReasoningPolicy {
  mode: ReasoningMode;
  selection: ReasoningSelection;
  requestedEffort: ReasoningEffort | null;
  resolvedEffort: ReasoningEffort | null;
  /** Exact provider effort, retained with the response rather than the UI alias. */
  providerEffort?: string | null;
  providerOptions: Record<string, unknown>;
  maxOutputTokens: number | undefined;
  executionInstructions: string;
}

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'ultra', 'max'];
const MODES: readonly ReasoningMode[] = ['token-saver', 'normal', 'token-final-boss'];
const NO_REASONING: ReasoningCapabilities = {
  supportedEfforts: [],
  providerOptionKey: null,
  wireEffort: (effort) => effort,
};

const EXECUTION_INSTRUCTIONS: Readonly<Record<ReasoningMode, string>> = {
  'token-saver': [
    '## Reasoning mode: Token Saver',
    'Keep the selected model. Use the smallest relevant context set, remove duplicate context, and answer concisely.',
    'Use low native reasoning when supported, but never skip mandatory security, approval, correctness, or user acceptance checks.',
    'Do not compress instructions, attachments, patches, schemas, permission decisions, or evidence needed to avoid a false claim.',
    ponytailInstructions,
  ].join('\n'),
  normal: [
    '## Reasoning mode: Normal',
    'Keep the selected model. Use moderate relevant context, the provider default reasoning level, and normal answer detail.',
    'Perform focused verification when the task changes state or makes a correctness claim. Avoid duplicate searches and repeated unchanged checks.',
  ].join('\n'),
  'token-final-boss': [
    '## Reasoning mode: Token Final Boss',
    finalBossSkill.trim(),
  ].join('\n'),
};

export function reasoningModeInstructions(mode: ReasoningMode): string {
  return EXECUTION_INSTRUCTIONS[mode];
}

export function normalizeReasoningPreference(value: unknown): ReasoningPreference {
  if (!value || typeof value !== 'object') return { mode: 'normal', effortOverride: null };
  const record = value as Record<string, unknown>;
  const mode = MODES.includes(record.mode as ReasoningMode)
    ? (record.mode as ReasoningMode)
    : 'normal';
  const effortOverride = EFFORTS.includes(record.effortOverride as ReasoningEffort)
    ? (record.effortOverride as ReasoningEffort)
    : null;
  return { mode, effortOverride };
}

function staticReasoningCapabilities(selection: ReasoningSelection): ReasoningCapabilities {
  const connection = selection.connectionId?.toLowerCase() ?? '';
  let provider = selection.providerId.toLowerCase();
  let model = selection.modelId.toLowerCase();
  if (connection.includes('opencode')) {
    const segments = model.split('/');
    if (
      segments.length === 3 &&
      segments[0] === 'openrouter' &&
      segments[1] === 'openai' &&
      (provider === 'opencode' || provider === 'openrouter')
    ) {
      provider = 'openai';
      model = segments[2]!;
    } else if (segments.length === 2 && segments[0] && segments[1]) {
      const qualifiedProvider = segments[0];
      if (provider === 'opencode' || provider === qualifiedProvider) {
        provider = qualifiedProvider;
        model = segments[1];
      }
    }
  }

  if (provider === 'deepseek' && /v4/.test(model)) {
    return {
      supportedEfforts: ['low', 'medium', 'high', 'ultra'],
      providerOptionKey: 'reasoning_effort',
      wireEffort: (effort) => (effort === 'ultra' ? 'max' : effort === 'minimal' ? 'low' : effort),
    };
  }

  if (provider === 'openai' && model === 'gpt-5.6-luna') {
    return {
      supportedEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      providerOptionKey: 'reasoning_effort',
      // OpenCode exposes Luna's minimal alias as `none`; Codex app-server
      // exposes only low and above, so keep the same UI choice on its lowest
      // supported native effort at the route boundary.
      wireEffort: (effort) =>
        effort === 'minimal' ? (connection.includes('codex') ? 'low' : 'none') : effort,
    };
  }

  if (provider === 'openai' && /^gpt-5(?:\.|$)/.test(model)) {
    const openCodeSurface = connection.includes('opencode') || connection.includes('codex');
    const codexSurface = connection.includes('codex') || model.includes('-sol');
    const sparkSurface = model.includes('spark');
    return {
      supportedEfforts: sparkSurface
        ? ['medium']
        : codexSurface || openCodeSurface
          ? ['low', 'medium', 'high', 'ultra', 'max']
          : ['minimal', 'low', 'medium', 'high', 'ultra'],
      providerOptionKey: 'reasoning_effort',
      wireEffort: (effort) => (effort === 'ultra' ? 'xhigh' : effort),
    };
  }

  if (provider === 'anthropic' && /^claude-(?:opus|sonnet)-4/.test(model)) {
    return {
      supportedEfforts: ['low', 'medium', 'high', 'ultra'],
      providerOptionKey: 'reasoning_effort',
      wireEffort: (effort) => (effort === 'ultra' ? 'max' : effort),
    };
  }

  if (provider === 'google' && model.startsWith('gemini-')) {
    return {
      supportedEfforts: model.startsWith('gemini-3.5')
        ? ['minimal', 'low', 'medium', 'high']
        : ['low', 'medium', 'high'],
      providerOptionKey: 'thinking_level',
      wireEffort: (effort) => effort,
    };
  }

  if (provider === 'groq' && model.includes('gpt-oss')) {
    return {
      supportedEfforts: ['low', 'medium', 'high'],
      providerOptionKey: 'reasoning_effort',
      wireEffort: (effort) => effort,
    };
  }

  if (provider === 'xai' && model.startsWith('grok-4.')) {
    return {
      supportedEfforts: ['low', 'medium', 'high', 'ultra'],
      providerOptionKey: 'reasoning_effort',
      wireEffort: (effort) => (effort === 'ultra' ? 'xhigh' : effort),
    };
  }

  return NO_REASONING;
}

export function getReasoningCapabilities(
  selection: ReasoningSelection,
  liveVariants?: readonly string[],
  liveVariantsAuthoritative = false,
): ReasoningCapabilities {
  const base = staticReasoningCapabilities(selection);
  if (liveVariants === undefined || (liveVariants.length === 0 && !liveVariantsAuthoritative)) return base;
  const options = listEffortOptions(liveVariants.map((id) => ({ id })), selection.modelId)
    .filter((option) => option.available && option.label !== 'auto');
  const supported = options.map((option) => option.label as ReasoningEffort);
  return {
    ...base,
    supportedEfforts: supported,
    wireEffort: (effort) => options.find((option) => option.label === effort)?.upstreamEffort ?? base.wireEffort(effort),
    // Live variants prove effort availability, not a provider-specific API key.
    // Native OpenCode routes carry the resolved effort through runtimeSettings.
    providerOptionKey: supported.length > 0 ? base.providerOptionKey : null,
  };
}

export function sanitizeReasoningProviderOptions(
  selection: ReasoningSelection,
  rawOptions: Record<string, unknown> | undefined,
): Record<string, string> {
  const capabilities = getReasoningCapabilities(selection);
  const key = capabilities.providerOptionKey;
  if (!key || !rawOptions) return {};
  const value = rawOptions[key];
  if (typeof value !== 'string') return {};
  const allowed = new Set(
    capabilities.supportedEfforts.map((effort) => capabilities.wireEffort(effort)),
  );
  return allowed.has(value) ? { [key]: value } : {};
}

export function resolveReasoningPolicy({
  selection,
  preference: rawPreference,
  liveVariants,
  liveVariantsAuthoritative = false,
}: {
  selection: ReasoningSelection;
  preference: ReasoningPreference;
  liveVariants?: readonly string[];
  liveVariantsAuthoritative?: boolean;
}): ResolvedReasoningPolicy {
  const preference = normalizeReasoningPreference(rawPreference);
  const capabilities = getReasoningCapabilities(selection, liveVariants, liveVariantsAuthoritative);
  if (
    preference.mode !== 'token-final-boss' && preference.effortOverride &&
    !capabilities.supportedEfforts.includes(preference.effortOverride)
  ) {
    throw new Error(`OpenCode model variant "${preference.effortOverride}" is unsupported.`);
  }
  const requestedEffort =
    preference.mode === 'token-final-boss'
      ? (capabilities.supportedEfforts.at(-1) ?? null)
      : preference.effortOverride ??
    (preference.mode === 'token-saver'
      ? (capabilities.supportedEfforts[0] ?? null)
      : null);
  const resolvedEffort = requestedEffort;
  const providerOptions =
    resolvedEffort && capabilities.providerOptionKey
      ? { [capabilities.providerOptionKey]: capabilities.wireEffort(resolvedEffort) }
      : {};

  return {
    mode: preference.mode,
    selection,
    requestedEffort,
    resolvedEffort,
    providerEffort: resolvedEffort ? capabilities.wireEffort(resolvedEffort) : null,
    providerOptions,
    maxOutputTokens: preference.mode === 'token-saver' ? 2048 : undefined,
    executionInstructions: EXECUTION_INSTRUCTIONS[preference.mode],
  };
}
