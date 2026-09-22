/** Tool discovery only. Existing access, approval and target identity checks
 * remain the authority; this never executes a command or chooses a target. */
export function contextTerminalCoordinationIntent(text: string): 'inspect' | 'deliver' | undefined {
  if (!text || text.length > 200_000) return undefined;
  if (
    /\b(?:no other tools|(?:only use|use only)\s+(?:the\s+)?(?:vibespace_context|context\s+(?:map\s+)?tools?))\b/iu.test(
      text,
    )
  )
    return undefined;
  let visible = '';
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === '`' || char === '\u201c') {
      quote = char === '\u201c' ? '\u201d' : char;
      visible += ' ';
    } else visible += char;
  }
  let result: 'inspect' | undefined;
  const sentences = visible
    .split(/[.!?;\n]/u)
    .filter(
      (sentence) =>
        !/^\s*(?:please\s+)?(?:do not|don't|never|avoid|without|if|when|should|could|would|explain|describe|imagine|yesterday|the\s+(?:guide|documentation|phrase))\b/iu.test(
          sentence,
        ),
    );
  for (const raw of sentences.flatMap((sentence) => sentence.split(/\band\s+/iu))) {
    const clause = raw.trim().replace(/^(?:(?:please|hey|first|then|also)\s+)+/iu, '');
    if (
      /^(?:do not|don't|never|avoid|without|if|when|should|could|would|explain|describe|imagine|yesterday|the\s+(?:guide|documentation|phrase))\b/iu.test(
        clause,
      )
    )
      continue;
    const target = /\b(?:terminals?|workers?|agents?|claude|codex|opencode)\b/iu.test(clause);
    if (
      /^(?:tell|message)\b/iu.test(clause) &&
      !/^tell\s+me\b/iu.test(clause) &&
      (target || /^(?:tell|message)\s+(?:each|both|all)(?:\s+of)?\s+them\b/iu.test(clause))
    )
      return 'deliver';
    if (
      /^(?:send|deliver)\b/iu.test(clause) &&
      target &&
      /\b(?:prompt|message|instruction|work)s?\b/iu.test(clause)
    )
      return 'deliver';
    if (target && /^(?:check|verify|inspect|list)\b/iu.test(clause)) result = 'inspect';
    if (
      target &&
      /^use\b/iu.test(clause) &&
      /\b(?:status|list|identities|readiness)\b/iu.test(clause)
    )
      result = 'inspect';
    if (target && /^(?:compose|draft|prepare)\b/iu.test(clause) && /\bprompts?\b/iu.test(clause))
      result = 'inspect';
  }
  return result;
}

export const COORDINATION_READ_TOOLS: ReadonlySet<string> = new Set([
  'vibespace_context',
  'context.list',
  'context.read',
  'skills.list',
  'terminal.list',
  'terminal.read',
]);
