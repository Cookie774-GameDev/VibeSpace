export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'ultra';
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
  providerOptions: Record<string, unknown>;
  maxOutputTokens: number | undefined;
  executionInstructions: string;
}

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'ultra'];
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
  ].join('\n'),
  normal: [
    '## Reasoning mode: Normal',
    'Keep the selected model. Use moderate relevant context, the provider default reasoning level, and normal answer detail.',
    'Perform focused verification when the task changes state or makes a correctness claim. Avoid duplicate searches and repeated unchanged checks.',
  ].join('\n'),
  'token-final-boss': [
    '## Reasoning mode: Token Final Boss',
    'Keep the exact selected model and use its highest verified native reasoning level.',
    'For difficult work, privately run this bounded loop before completing:',
    '1. Reread the original user request and identify its concrete acceptance criteria, constraints, and protected boundaries.',
    '2. Inspect the most relevant current evidence, then form a concise implementation or answer plan.',
    '3. Execute through only the available tools and approval-gated actions; inspect every material result instead of assuming success.',
    '4. Verify the changed behavior or factual answer with focused evidence, then critique it against the original request and likely failure paths.',
    '5. Correct material gaps and Re-run the affected verification once; reread the original user request before the final answer.',
    'Stop when the acceptance criteria are proven, evidence is sufficient, required checks pass, or further work would repeat unchanged evidence.',
    'Do not expose private chain-of-thought. Report only the concise result, useful rationale, actions awaiting approval, and verifiable evidence.',
    'Never weaken security, approvals, account isolation, or truthful completion standards to finish faster.',
  ].join('\n'),
};

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
  const provider = selection.providerId.toLowerCase();
  const model = selection.modelId.toLowerCase();
  const connection = selection.connectionId?.toLowerCase() ?? '';

  if (provider === 'deepseek' && /v4/.test(model)) {
    return {
      supportedEfforts: ['low', 'medium', 'high', 'ultra'],
      providerOptionKey: 'reasoning_effort',
      wireEffort: (effort) => (effort === 'ultra' ? 'max' : effort === 'minimal' ? 'low' : effort),
    };
  }

  if (provider === 'openai' && /^gpt-5(?:\.|$)/.test(model)) {
    const openCodeSurface = connection.includes('opencode') || connection.includes('codex');
    const codexSurface = connection.includes('codex') || model.includes('-sol');
    const sparkSurface = model.includes('spark');
    return {
      supportedEfforts: sparkSurface
        ? []
        : codexSurface || openCodeSurface
          ? ['low', 'medium', 'high', 'ultra']
          : ['minimal', 'low', 'medium', 'high', 'ultra'],
      providerOptionKey: sparkSurface ? null : 'reasoning_effort',
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
): ReasoningCapabilities {
  const base = staticReasoningCapabilities(selection);
  if (!liveVariants || liveVariants.length === 0) return base;
  const supported = EFFORTS.filter(
    (effort) => liveVariants.includes(effort) || liveVariants.includes(base.wireEffort(effort)),
  );
  return {
    ...base,
    supportedEfforts: supported,
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
}: {
  selection: ReasoningSelection;
  preference: ReasoningPreference;
  liveVariants?: readonly string[];
}): ResolvedReasoningPolicy {
  const preference = normalizeReasoningPreference(rawPreference);
  const capabilities = getReasoningCapabilities(selection, liveVariants);
  if (
    preference.effortOverride &&
    !capabilities.supportedEfforts.includes(preference.effortOverride)
  ) {
    throw new Error(`OpenCode model variant "${preference.effortOverride}" is unsupported.`);
  }
  const requestedEffort =
    preference.effortOverride ??
    (preference.mode === 'token-saver'
      ? (capabilities.supportedEfforts[0] ?? null)
      : preference.mode === 'token-final-boss'
        ? (capabilities.supportedEfforts.at(-1) ?? null)
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
    providerOptions,
    maxOutputTokens: preference.mode === 'token-saver' ? 2048 : undefined,
    executionInstructions: EXECUTION_INSTRUCTIONS[preference.mode],
  };
}
