export const LOCAL_AGENT_PREFERENCES_EVENT = 'vibespace:local-agent-preferences';
const LOCAL_AGENT_PREFERENCES_KEY = 'vibespace.local-agent.preferences.v1';
const MAX_PERSISTED_PREFERENCES_CHARS = 512;
const MAX_DISCLOSURE_CHARS = 1_000_000;
const MAX_CATEGORY_CHARS = 64;
const MAX_CATEGORIES = 8;

const DEFAULT_PREFERENCES: Readonly<LocalAgentPreferences> = Object.freeze({
  mode: 'fast',
  cloudEscalationEnabled: false,
});

export type LocalAgentMode = 'fast' | 'deep';

export interface LocalAgentPreferences {
  mode: LocalAgentMode;
  cloudEscalationEnabled: boolean;
}

export interface LocalAgentPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LocalInferenceFailure = 'inference_failed' | 'capability_unavailable';

export type LocalCloudEscalationProposal =
  | Readonly<{ status: 'refused'; reason: 'fully_local' }>
  | Readonly<{ status: 'not_offered'; reason: 'disabled' }>
  | Readonly<{
      status: 'approval_required';
      failure: LocalInferenceFailure;
      providerId: string;
      modelId: string;
      data: Readonly<{
        messageChars: number;
        contextChars: number;
        categories: readonly string[];
      }>;
    }>;

export function readLocalAgentPreferences(
  storage: LocalAgentPreferenceStorage = defaultStorage(),
): LocalAgentPreferences {
  try {
    const raw = storage.getItem(LOCAL_AGENT_PREFERENCES_KEY);
    if (!raw || raw.length > MAX_PERSISTED_PREFERENCES_CHARS) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      (parsed.mode !== 'fast' && parsed.mode !== 'deep') ||
      typeof parsed.cloudEscalationEnabled !== 'boolean'
    ) {
      return { ...DEFAULT_PREFERENCES };
    }
    return {
      mode: parsed.mode,
      cloudEscalationEnabled: parsed.cloudEscalationEnabled,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeLocalAgentPreferences(
  preferences: LocalAgentPreferences,
  storage: LocalAgentPreferenceStorage = defaultStorage(),
): void {
  const normalized: LocalAgentPreferences = {
    mode: preferences.mode === 'deep' ? 'deep' : 'fast',
    cloudEscalationEnabled: preferences.cloudEscalationEnabled === true,
  };
  storage.setItem(LOCAL_AGENT_PREFERENCES_KEY, JSON.stringify({ version: 1, ...normalized }));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<LocalAgentPreferences>(LOCAL_AGENT_PREFERENCES_EVENT, {
        detail: { ...normalized },
      }),
    );
  }
}

function defaultStorage(): LocalAgentPreferenceStorage {
  if (typeof window === 'undefined') {
    return {
      getItem: () => null,
      setItem: () => undefined,
    };
  }
  return window.localStorage;
}

export function localOllamaRequestPolicy(mode: LocalAgentMode): Readonly<{
  think: boolean;
  numPredict: number;
  requiresVerification: boolean;
}> {
  return mode === 'deep'
    ? Object.freeze({ think: true, numPredict: 2_048, requiresVerification: true })
    : Object.freeze({ think: false, numPredict: 512, requiresVerification: false });
}

export function localAgentSystemInstruction(mode: LocalAgentMode): string {
  if (mode === 'deep') {
    return [
      'Deep mode uses a Planner → Executor → Verifier loop for difficult work.',
      'Plan a small sequence, execute tools only through the existing approval and permission system, then verify every claimed result with verifiable evidence.',
      'If execution or verification fails, report the failure instead of claiming completion.',
    ].join(' ');
  }
  return 'Fast mode: Answer directly with minimal reasoning. Use tools only through the existing approval and permission system.';
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_DISCLOSURE_CHARS);
}

function boundedLabel(value: string, maximum = MAX_CATEGORY_CHARS): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, maximum);
}

export function planLocalCloudEscalation(input: {
  offlineMode: boolean;
  enabled: boolean;
  failure: LocalInferenceFailure;
  providerId: string;
  modelId: string;
  data: {
    messageChars: number;
    contextChars: number;
    categories: readonly string[];
  };
}): LocalCloudEscalationProposal {
  if (input.offlineMode) return Object.freeze({ status: 'refused', reason: 'fully_local' });
  if (!input.enabled) return Object.freeze({ status: 'not_offered', reason: 'disabled' });

  const categories = Object.freeze(
    [
      ...new Set(input.data.categories.map((category) => boundedLabel(category)).filter(Boolean)),
    ].slice(0, MAX_CATEGORIES),
  );
  const data = Object.freeze({
    messageChars: boundedCount(input.data.messageChars),
    contextChars: boundedCount(input.data.contextChars),
    categories,
  });
  return Object.freeze({
    status: 'approval_required',
    failure: input.failure,
    providerId: boundedLabel(input.providerId),
    modelId: boundedLabel(input.modelId, 160),
    data,
  });
}

export class LocalCloudEscalationRequiredError extends Error {
  readonly proposal: Extract<LocalCloudEscalationProposal, { status: 'approval_required' }>;

  constructor(proposal: Extract<LocalCloudEscalationProposal, { status: 'approval_required' }>) {
    super(
      `Local execution failed. Cloud escalation to ${proposal.providerId} / ${proposal.modelId} requires your approval before any data is sent.`,
    );
    this.name = 'LocalCloudEscalationRequiredError';
    this.proposal = proposal;
  }
}
