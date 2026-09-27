import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { selectionFromOption, type ChatModelSelection } from '@/lib/ai/modelSelection';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';

export type VoiceAgentProvider = 'codex' | 'opencode';
export type VoiceAgentRole = 'main' | 'worker';

export interface VoiceProviderResolution {
  provider: VoiceAgentProvider;
  providerLabel: 'Codex' | 'OpenCode';
  connectionId: string;
  routeId: string;
  modelLabel: string;
  selection: ChatModelSelection;
}

export class VoiceProviderUnavailableError extends Error {
  readonly code = 'voice_provider_unavailable';

  constructor(readonly provider: VoiceAgentProvider) {
    super(`${provider === 'codex' ? 'Codex' : 'OpenCode'} has no available connected voice route.`);
    this.name = 'VoiceProviderUnavailableError';
  }
}

function providerConnectionId(provider: VoiceAgentProvider): string {
  return provider === 'codex' ? CODEX_CLI_CONNECTION.id : OPENCODE_CLI_CONNECTION.id;
}

function providerLabel(provider: VoiceAgentProvider): 'Codex' | 'OpenCode' {
  return provider === 'codex' ? 'Codex' : 'OpenCode';
}

/**
 * Resolve a voice agent's provider through the same live accessible model routes
 * shown by the chat model picker. No provider or model route is synthesized.
 */
export function resolveVoiceProviderSelection(input: {
  provider: VoiceAgentProvider;
  options: readonly ModelPickerOption[];
  preferredSelection?: ChatModelSelection;
}): VoiceProviderResolution {
  const connectionId = providerConnectionId(input.provider);
  const routes = input.options
    .flatMap((option) => option.alternativeRoutes ?? [option])
    .filter(
      (option) =>
        option.available === true &&
        option.connectionId === connectionId &&
        option.connection?.id === connectionId &&
        Boolean(option.modelId.trim()),
    );

  const preferred = input.preferredSelection;
  const selectedRoute =
    (preferred?.mode === 'single'
      ? routes.find(
          (option) =>
            option.connectionId === preferred.connectionId &&
            option.provider === preferred.providerId &&
            option.modelId === preferred.modelId,
        )
      : undefined) ?? routes[0];

  if (!selectedRoute?.connection) {
    throw new VoiceProviderUnavailableError(input.provider);
  }

  const label = providerLabel(input.provider);
  return {
    provider: input.provider,
    providerLabel: label,
    connectionId,
    routeId: selectedRoute.id,
    modelLabel: `${label} · ${selectedRoute.label}`,
    selection: selectionFromOption(
      selectedRoute.provider,
      selectedRoute.modelId,
      selectedRoute.connection,
    ),
  };
}

const PROVIDER_DIRECTIVE_PATTERNS = [
  {
    regex:
      /\b(?:use|route|send|run|switch(?:\s+to)?)\s+(codex|open\s*code)\s+(?:for|as)\s+(?:the\s+)?(main(?:\s+agent)?|worker(?:\s+(?:agent|session))?)\b/giu,
    providerGroup: 1,
    roleGroup: 2,
  },
  {
    regex:
      /\b(?:and|then|also)\s+(codex|open\s*code)\s+(?:for|as)\s+(?:the\s+)?(main(?:\s+agent)?|worker(?:\s+(?:agent|session))?)\b/giu,
    providerGroup: 1,
    roleGroup: 2,
  },
  {
    regex:
      /\b(?:the\s+)?(main(?:\s+agent)?|worker(?:\s+(?:agent|session))?)\s*(?:provider\s*)?(?:should\s+)?(?:use|uses|be|to|:|=)\s*(codex|open\s*code)\b/giu,
    providerGroup: 2,
    roleGroup: 1,
  },
] as const;

const SAVE_DEFAULT_PATTERN =
  /\b(?:please\s+)?(?:save|set|make|remember)\s+(?:(?:these|both|the|this|it)\s+)*(?:(?:main|worker)\s+)?(?:providers?|selections?)?\s*(?:as\s+)?(?:my\s+)?defaults?\b/giu;
const NEGATED_SAVE_PREFIX = /(?:\bdo\s+not|\bdon['’]t|\bnever|\bnot)\s*$/iu;

function normalizeProvider(value: string): VoiceAgentProvider {
  return value.replace(/\s+/gu, '').toLowerCase() === 'codex' ? 'codex' : 'opencode';
}

function normalizeRole(value: string): VoiceAgentRole {
  return value.toLowerCase().startsWith('main') ? 'main' : 'worker';
}

function removeRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  let cursor = 0;
  let output = '';
  for (const range of ordered) {
    if (range.start < cursor) continue;
    output += `${text.slice(cursor, range.start)} `;
    cursor = range.end;
  }
  return `${output}${text.slice(cursor)}`;
}

function cleanTaskText(text: string): string {
  return text
    .replace(/^[\s:;,.-]+/u, '')
    .replace(/[\s:;,-]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface ParsedVoiceProviderOverrides {
  providers: Partial<Record<VoiceAgentRole, VoiceAgentProvider>>;
  taskText: string;
  saveAsDefault: boolean;
}

/**
 * Parse only role-scoped provider commands. Results are request-local; callers
 * must persist a changed default only when `saveAsDefault` is explicitly true.
 */
export function parseVoiceProviderOverrides(text: string): ParsedVoiceProviderOverrides | null {
  const providers: Partial<Record<VoiceAgentRole, VoiceAgentProvider>> = {};
  const directiveRanges: { start: number; end: number }[] = [];

  for (const pattern of PROVIDER_DIRECTIVE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const providerValue = match[pattern.providerGroup];
      const roleValue = match[pattern.roleGroup];
      if (!providerValue || !roleValue || match.index === undefined) continue;
      const role = normalizeRole(roleValue);
      const provider = normalizeProvider(providerValue);
      const existing = providers[role];
      if (existing && existing !== provider) return null;
      providers[role] = provider;
      directiveRanges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  if (Object.keys(providers).length === 0) return null;

  const saveRanges: { start: number; end: number }[] = [];
  let saveAsDefault = false;
  SAVE_DEFAULT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SAVE_DEFAULT_PATTERN)) {
    if (match.index === undefined) continue;
    const prefix = text.slice(Math.max(0, match.index - 20), match.index);
    if (NEGATED_SAVE_PREFIX.test(prefix)) continue;
    saveAsDefault = true;
    saveRanges.push({ start: match.index, end: match.index + match[0].length });
  }

  return {
    providers,
    taskText: cleanTaskText(removeRanges(text, [...directiveRanges, ...saveRanges])),
    saveAsDefault,
  };
}
