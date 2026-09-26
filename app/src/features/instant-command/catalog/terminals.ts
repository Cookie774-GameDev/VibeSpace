import type { TerminalSelector } from '../types';
import type {
  CatalogMatch,
  CatalogParseResult,
  CommandAvailability,
  CommandSafety,
} from '../catalogTypes';

export type TerminalAgentCommandInput = Readonly<{
  id: string;
  family: 'terminal' | 'agent';
  aliases: readonly string[];
  authority: string;
  safety: CommandSafety;
  availability: CommandAvailability;
  slotGrammar?: 'none' | 'remainder';
  parseSlots?: (match: CatalogMatch, source: string) => CatalogParseResult;
}>;

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
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
});

const MAX_SELECTOR_LENGTH = 256;
const MAX_SOURCE_LENGTH = 4_096;
const MAX_TERMINAL_ORDINAL = 1_024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const STABLE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function frozenSelector(selector: TerminalSelector): TerminalSelector {
  return Object.freeze(selector);
}

function rejectedSlots(): CatalogParseResult {
  return Object.freeze({
    status: 'rejected' as const,
    reason: 'Name a terminal, then a message.',
  });
}

function parsedSlots(slots: Readonly<Record<string, unknown>>): CatalogParseResult {
  return Object.freeze({ status: 'parsed' as const, slots: Object.freeze(slots) });
}

export function parseTerminalSelectorText(raw: string): TerminalSelector | null {
  if (typeof raw !== 'string' || raw.length > MAX_SELECTOR_LENGTH || CONTROL_CHARACTER.test(raw)) {
    return null;
  }
  const source = raw.trim();
  if (!source) return null;
  if (/^(?:all terminals|every terminal|all agents)$/iu.test(source)) {
    return frozenSelector({ scope: 'all' });
  }
  const ordinal = /^(?:terminal\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/iu.exec(
    source,
  );
  if (ordinal) {
    const token = ordinal[1]!.toLowerCase();
    const value = NUMBER_WORDS[token] ?? Number(token);
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_ORDINAL
      ? frozenSelector({ ordinal: value })
      : null;
  }
  const pane = /^pane\s+(.+)$/iu.exec(source);
  if (pane) return STABLE_TERMINAL_ID.test(pane[1]!) ? frozenSelector({ paneId: pane[1]! }) : null;
  const session = /^session\s+(.+)$/iu.exec(source);
  if (session) {
    return STABLE_TERMINAL_ID.test(session[1]!) ? frozenSelector({ sessionId: session[1]! }) : null;
  }
  if (/^(?:codex|opencode|claude|gemini|copilot)$/iu.test(source)) {
    return frozenSelector({ provider: source.toLowerCase() });
  }
  return frozenSelector({ label: source });
}

function selectorSlots(match: CatalogMatch): CatalogParseResult {
  const selector = parseTerminalSelectorText(match.remainder);
  return selector
    ? parsedSlots({ selector })
    : Object.freeze({ status: 'rejected', reason: 'Name one exact terminal.' });
}

function messageSlots(match: CatalogMatch, source: string): CatalogParseResult {
  if (
    typeof source !== 'string' ||
    source.length > MAX_SOURCE_LENGTH ||
    CONTROL_CHARACTER.test(source) ||
    !Number.isSafeInteger(match.sourceEnd) ||
    match.sourceEnd < 0 ||
    match.sourceEnd > source.length
  ) {
    return rejectedSlots();
  }
  const originalRemainder = source
    .slice(match.sourceEnd)
    .replace(/^\s*:\s*/u, '')
    .trim();
  const boundary = originalRemainder.indexOf(':');
  if (boundary < 1) return rejectedSlots();
  const selector = parseTerminalSelectorText(originalRemainder.slice(0, boundary));
  const payload = originalRemainder.slice(boundary + 1).trim();
  if (!selector || !payload) return rejectedSlots();
  return parsedSlots({ selector, payload });
}

const entries: readonly TerminalAgentCommandInput[] = [
  ['terminal.focus', 'terminal', ['focus terminal'], 'terminal.pane', 'reversible', 'blocked'],
  ['terminal.list', 'terminal', ['list terminals'], 'terminal.snapshot', 'read', 'available'],
  ['terminal.status', 'terminal', ['terminal status'], 'terminal.snapshot', 'read', 'available'],
  ['terminal.split', 'terminal', ['split terminal'], 'terminal.pane', 'reversible', 'blocked'],
  ['terminal.rename', 'terminal', ['rename terminal'], 'terminal.pane', 'reversible', 'blocked'],
  [
    'terminal.move_project',
    'terminal',
    ['move terminal to project'],
    'terminal.project-move',
    'confirm',
    'blocked',
  ],
  [
    'terminal.restart',
    'terminal',
    ['restart terminal'],
    'terminal.lifecycle',
    'confirm',
    'blocked',
  ],
  ['terminal.clear', 'terminal', ['clear terminal'], 'terminal.lifecycle', 'reversible', 'blocked'],
  ['terminal.stop', 'terminal', ['stop terminal'], 'terminal.lifecycle', 'confirm', 'blocked'],
  ['terminal.close', 'terminal', ['close terminal'], 'terminal.lifecycle', 'confirm', 'blocked'],
  [
    'terminal.cancel_queued',
    'terminal',
    ['cancel queued command'],
    'terminal.queue',
    'reversible',
    'blocked',
  ],
  ['agent.message', 'agent', ['message agent'], 'terminal.prompt-delivery', 'approval', 'blocked'],
  [
    'agent.broadcast',
    'agent',
    ['broadcast agents'],
    'terminal.prompt-delivery',
    'approval',
    'blocked',
  ],
  ['agent.status', 'agent', ['agent status'], 'terminal.snapshot', 'read', 'available'],
  [
    'agent.continue',
    'agent',
    ['continue agent'],
    'terminal.prompt-delivery',
    'approval',
    'blocked',
  ],
  ['agent.stop', 'agent', ['stop agent'], 'terminal.lifecycle', 'confirm', 'blocked'],
  ['agent.assign_role', 'agent', ['assign agent role'], 'agent.registry', 'reversible', 'blocked'],
  [
    'agent.give_context',
    'agent',
    ['give context to agent'],
    'context.gateway',
    'approval',
    'blocked',
  ],
].map(([id, family, aliases, authority, safety, availability]) =>
  Object.freeze({
    id,
    family,
    aliases: Object.freeze([...aliases, `/${String(id).replace(/[._]+/gu, '-')}`]),
    authority,
    safety,
    availability,
    slotGrammar: id === 'terminal.list' ? ('none' as const) : ('remainder' as const),
    parseSlots:
      id === 'terminal.list'
        ? () => parsedSlots({})
        : id === 'agent.message' || id === 'agent.broadcast'
          ? messageSlots
          : selectorSlots,
  }),
) as readonly TerminalAgentCommandInput[];

export const TERMINAL_AGENT_COMMAND_INPUTS = Object.freeze(entries);
