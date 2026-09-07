import { parseAssistantInput } from '@/features/assistant/parse';
import { INSTANT_COMMAND_INDEX } from './catalog';
import { parseOpenCodeLaunch } from './openCodeLaunch';
import type { InstantCommand, InstantInputClassification } from './types';

const MAX_PAYLOAD_LENGTH = 32_768;
const UNSAFE_CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
const FILLERS = [
  'could you please ',
  'can you please ',
  'i would like to ',
  'i want you to ',
  'go ahead and ',
  'could you ',
  'can you ',
  'please ',
  'kindly ',
  'just ',
];

const PROVIDER_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['github copilot cli', 'copilot'],
  ['github copilot', 'copilot'],
  ['claude code', 'claude'],
  ['gemini cli', 'gemini'],
  ['grok build', 'grok'],
  ['qwen code', 'qwen'],
  ['kiro cli', 'kiro'],
  ['open code', 'opencode'],
  ['opencode', 'opencode'],
  ['copilot', 'copilot'],
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['grok', 'grok'],
  ['gemini', 'gemini'],
  ['aider', 'aider'],
  ['qwen', 'qwen'],
  ['kiro', 'kiro'],
  ['cursor', 'cursor'],
  ['gpt', 'gpt'],
];

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function canonicalProviderAlias(raw: string | undefined): string | undefined {
  const normalized = raw?.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  for (const [alias, provider] of PROVIDER_ALIASES) {
    if (normalized === alias || normalized.startsWith(`${alias} `)) return provider;
  }
  return undefined;
}

function stripFiller(raw: string): string {
  let value = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lower = value.toLowerCase();
    for (const filler of FILLERS) {
      if (lower.startsWith(filler)) {
        value = value.slice(filler.length).trimStart();
        changed = true;
        break;
      }
    }
  }
  return value;
}

function validPayload(raw: string | undefined): string | null {
  const payload = raw?.trim();
  if (!payload || payload.length > MAX_PAYLOAD_LENGTH || UNSAFE_CONTROL.test(payload)) return null;
  return payload;
}

function providerFromRouteToken(raw: string | undefined): string | null {
  const provider = canonicalProviderAlias(raw);
  return provider ?? null;
}

function parseCount(raw: string | undefined): number {
  if (!raw) return 1;
  return NUMBER_WORDS[raw.toLowerCase()] ?? Number(raw);
}

function mostSpecificCatalogMatches(source: string) {
  const matches = INSTANT_COMMAND_INDEX.matchWithOffsets(source);
  if (matches.length < 2) return matches;
  const longest = Math.max(...matches.map((match) => match.sourceEnd));
  return matches.filter((match) => match.sourceEnd === longest);
}

function parseInstantCommandInternal(input: string): InstantCommand | null {
  if (typeof input !== 'string') return null;
  const launch = parseOpenCodeLaunch(input);
  if (launch) return launch;
  if (!input.trim() || UNSAFE_CONTROL.test(input)) return null;
  const original = stripFiller(input);

  if (/^open\s+(?:an?\s+)?llm[.!?]*$/i.test(original)) {
    return { kind: 'open-model-picker' };
  }

  const openAgent =
    /^open\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(github copilot(?: cli)?|claude code|gemini cli|grok build|qwen code|kiro cli|open code|opencode|copilot|claude|codex|grok|gemini|aider|qwen|kiro)(?:\s+terminals?)?[.!?]*$/i.exec(
      original,
    );
  if (openAgent) {
    const count = parseCount(openAgent[1]);
    const provider = providerFromRouteToken(openAgent[2]);
    if (!provider || count < 1 || count > 10) return null;
    return { kind: 'open-agent-cli', provider, count };
  }

  if (/^open\s+\d+\s+terminals?\b/i.test(original)) {
    const count = Number(/^open\s+(\d+)/i.exec(original)?.[1]);
    if (count < 1 || count > 10) return null;
  }

  const terminalColon =
    /^(?:message|tell)\s+terminal\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*:\s*([\s\S]*)$/i.exec(
      original,
    );
  const terminalTo =
    /^tell\s+terminal\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+to\s+([\s\S]*)$/i.exec(
      original,
    );
  const terminalMatch = terminalColon ?? terminalTo;
  if (terminalMatch) {
    const ordinal = parseCount(terminalMatch[1]);
    const payload = validPayload(terminalMatch[2]);
    if (!payload || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 10) return null;
    return { kind: 'terminal-message', target: { ordinal, scope: 'one' }, payload };
  }

  const providerPrefix =
    /^(github copilot(?: cli)?|claude code|gemini cli|grok build|qwen code|kiro cli|open code|opencode|copilot|claude|codex|grok|gemini|aider|qwen|kiro|cursor|gpt)\s*,\s*([\s\S]*)$/i.exec(
      original,
    );
  if (providerPrefix) {
    const provider = providerFromRouteToken(providerPrefix[1]);
    const payload = validPayload(providerPrefix[2]);
    if (!provider || !payload) return null;
    return { kind: 'agent-message', target: { provider, scope: 'one' }, payload };
  }

  const allProvider =
    /^tell\s+all\s+(github copilot(?: cli)?|claude code|gemini cli|grok build|qwen code|kiro cli|open code|opencode|copilot|claude|codex|grok|gemini|aider|qwen|kiro|cursor|gpt)\s+terminals?\s+to\s+([\s\S]*)$/i.exec(
      original,
    );
  if (allProvider) {
    const provider = providerFromRouteToken(allProvider[1]);
    const payload = validPayload(allProvider[2]);
    if (!provider || !payload) return null;
    return { kind: 'terminal-broadcast', target: { provider, scope: 'all' }, payload };
  }

  const allTerminals = /^tell\s+all\s+terminals?\s+to\s+([\s\S]*)$/i.exec(original);
  if (allTerminals) {
    const payload = validPayload(allTerminals[1]);
    if (!payload) return null;
    return { kind: 'terminal-broadcast', target: { scope: 'all' }, payload };
  }

  const tellProvider =
    /^tell\s+(github copilot(?: cli)?|claude code|gemini cli|grok build|qwen code|kiro cli|open code|opencode|copilot|claude|codex|grok|gemini|aider|qwen|kiro|cursor|gpt)\s+to\s+([\s\S]*)$/i.exec(
      original,
    );
  if (tellProvider) {
    const provider = providerFromRouteToken(tellProvider[1]);
    const payload = validPayload(tellProvider[2]);
    if (!provider || !payload) return null;
    return { kind: 'agent-message', target: { provider, scope: 'one' }, payload };
  }

  // Keep targeted command-shaped input out of the legacy provider parser when
  // its required payload is absent. The legacy grammar otherwise interprets
  // `tell codex to` as the prompt `to`, which would launch a provider terminal
  // instead of failing closed.
  if (
    /^(?:tell\s+(?:github copilot(?: cli)?|claude code|gemini cli|grok build|qwen code|kiro cli|open code|opencode|copilot|claude|codex|grok|gemini|aider|qwen|kiro|cursor|gpt)\s+to|(?:github copilot(?: cli)?|claude code|gemini cli|grok build|qwen code|kiro cli|open code|opencode|copilot|claude|codex|grok|gemini|aider|qwen|kiro|cursor|gpt)\s*,)\s*$/i.test(
      original,
    )
  ) {
    return null;
  }

  if (/^(?:message|tell)\s+(?:him|her|them|it|this|that)\b/i.test(original)) return null;
  if (/^schedule\s+algorithms?\s+explained[.!?]*$/i.test(original)) return null;

  const catalogMatches = mostSpecificCatalogMatches(original);
  if (catalogMatches.length === 1) {
    const match = catalogMatches[0]!;
    if (match.definition.availability !== 'blocked') {
      const parsed = match.definition.parseSlots(match, original);
      if (parsed.status === 'parsed') {
        return {
          kind: 'catalog',
          id: match.definition.id,
          family: match.definition.family,
          authority: match.definition.authority,
          safety: match.definition.safety,
          slots: parsed.slots,
        };
      }
      return null;
    }
  }

  const scheduleAlias = /^create\s+schedule\s+(.+)$/i.exec(original);
  const intent = parseAssistantInput(scheduleAlias ? `schedule ${scheduleAlias[1]}` : original);
  return intent.kind === 'unknown' ? null : { kind: 'legacy', intent };
}

const INSTANT_COMMAND_SHAPE =
  /^(?:open\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:github copilot|claude|codex|opencode|open code|grok|gemini|aider|qwen|kiro|cursor|gpt|llm|terminals?\b)|(?:message|tell)\s+terminal\b|(?:github copilot|claude|codex|opencode|open code|grok|gemini|aider|qwen|kiro|cursor|gpt)\s*,|tell\s+(?:all\s+(?:(?:github copilot|claude|codex|opencode|open code|grok|gemini|aider|qwen|kiro|cursor|gpt)\s+)?terminals?\b|(?:github copilot|claude|codex|opencode|open code|grok|gemini|aider|qwen|kiro|cursor|gpt)\s+to\b))/i;

export function classifyInstantCommandInput(input: string): InstantInputClassification {
  const command = parseInstantCommandInternal(input);
  if (command) return { status: 'matched', command };
  if (typeof input === 'string') {
    const source = stripFiller(input);
    const matches = mostSpecificCatalogMatches(source);
    if (matches.length > 1) {
      return { status: 'rejected', reason: 'That Instant Command is ambiguous.' };
    }
    if (matches.length === 1) {
      const match = matches[0]!;
      if (match.definition.availability === 'blocked') {
        return { status: 'rejected', reason: 'That Instant Command is not available yet.' };
      }
      const parsed = match.definition.parseSlots(match, source);
      if (parsed.status === 'rejected') return { status: 'rejected', reason: parsed.reason };
    }
  }
  if (typeof input === 'string' && INSTANT_COMMAND_SHAPE.test(stripFiller(input))) {
    return { status: 'rejected', reason: 'That Instant Command is incomplete or invalid.' };
  }
  return { status: 'unmatched' };
}

export function parseInstantCommand(input: string): InstantCommand | null {
  const classification = classifyInstantCommandInput(input);
  return classification.status === 'matched' ? classification.command : null;
}
