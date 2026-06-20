import type { ParsedActionProposal } from './types';

let nextFallbackId = 1;

function fallbackCallId(): string {
  return `fb_${Date.now().toString(36)}_${(nextFallbackId++).toString(36)}`;
}

function proposal(
  action_id: string,
  params: Record<string, unknown>,
  rationale: string,
): ParsedActionProposal {
  return {
    call_id: fallbackCallId(),
    action_id,
    params,
    rationale,
  };
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function asksToOpenSettings(text: string): boolean {
  return /\b(open|show|go to|take me to)\b/.test(text) && /\bsettings?\b/.test(text);
}

function asksAboutPlugins(text: string): boolean {
  return /\b(plugin|plugins|connected plugins|connect plugin)\b/.test(text);
}

function asksToBroadcastOpencode(text: string): boolean {
  return (
    /\b(opencode)\b/.test(text) &&
    /\b(all|every|each)\b/.test(text) &&
    /\b(terminals?|panes?)\b/.test(text) &&
    /\b(type|run|send|enter|start)\b/.test(text)
  );
}

const NUMBER_WORDS: Record<string, number> = {
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

function readTerminalCount(value: string | undefined): number | null {
  if (!value) return null;
  const asNumber = /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value];
  if (!Number.isFinite(asNumber)) return null;
  return Math.max(1, Math.min(10, asNumber));
}

function extractBulkOpenTerminalRequest(text: string): { count: number; command?: string } | null {
  const countToken = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const patterns = [
    new RegExp(`\\b(?:open|create|spawn|make|launch|start)\\s+${countToken}\\s+(?:new\\s+)?(?:terminals?|terminal\\s+panes?|panes?)\\b`),
    new RegExp(`\\b${countToken}\\s+(?:new\\s+)?(?:terminals?|terminal\\s+panes?|panes?)\\b.*\\b(?:open|create|spawn|make|launch|start)\\b`),
  ];
  const matched = patterns.map((pattern) => pattern.exec(text)).find(Boolean);
  const count = readTerminalCount(matched?.[1]);
  if (!count) return null;

  const commandMatch = /\b(?:with|running|run|start(?:ing)?|using)\s+(opencode|open-code|claude|codex|gemini)\b/.exec(text);
  const command = commandMatch?.[1]?.replace('open-code', 'opencode');
  return command ? { count, command } : { count };
}

/**
 * Deterministic safety net for tiny/local models that describe app actions in
 * prose but fail to emit the fenced `action` JSON needed to show approval cards.
 *
 * Keep this intentionally narrow: it should only cover obvious app-control
 * requests where a real registered action already exists.
 */
export function inferFallbackActionProposals(
  userText: string,
  assistantText: string,
): ParsedActionProposal[] {
  const user = normalized(userText);
  const assistant = normalized(assistantText);
  const proposals: ParsedActionProposal[] = [];

  if (asksAboutPlugins(user) && (asksToOpenSettings(user) || /\b(show|list|tell)\b/.test(user))) {
    proposals.push(
      proposal(
        'settings.plugins',
        {},
        'Open Settings → Plugins so the user can review connected plugin state.',
      ),
    );
    return proposals;
  }

  if (asksToOpenSettings(user) && /\b(open|settings)\b/.test(assistant)) {
    proposals.push(
      proposal('settings.open', {}, 'Open Settings because the user asked to see it.'),
    );
    return proposals;
  }

  const bulkOpen = extractBulkOpenTerminalRequest(user);
  if (bulkOpen) {
    proposals.push(
      proposal(
        'terminal.bulkOpen',
        bulkOpen.command
          ? { count: bulkOpen.count, command: bulkOpen.command }
          : { count: bulkOpen.count },
        `Open ${bulkOpen.count} terminal pane${bulkOpen.count === 1 ? '' : 's'}${bulkOpen.command ? ` with ${bulkOpen.command}` : ''} after user approval.`,
      ),
    );
    return proposals;
  }

  if (asksToBroadcastOpencode(user)) {
    proposals.push(
      proposal(
        'terminal.sendAll',
        { command: 'opencode' },
        'Send opencode to every existing terminal pane after user approval.',
      ),
    );
  }

  return proposals.slice(0, 3);
}
