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
