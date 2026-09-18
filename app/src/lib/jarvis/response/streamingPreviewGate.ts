export interface StreamingPreviewState {
  buffered: string;
  visible: string;
  insideFence: boolean;
}

export type StreamingPreviewDecision =
  | {
      allowed: true;
      state: Readonly<StreamingPreviewState>;
      visibleText: string;
    }
  | {
      allowed: false;
      state: Readonly<StreamingPreviewState>;
      reason:
        | 'incomplete_sentence'
        | 'inside_structured_fence'
        | 'secret_signal'
        | 'prompt_leak_signal'
        | 'invalid_structure';
    };

const SECRET_SIGNAL =
  /\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|credential|client[ _-]?secret|private[ _-]?key|bearer\s+\S+)\b/i;
const PROMPT_LEAK_SIGNAL =
  /\b(?:system prompt|hidden (?:prompt|instructions?)|developer message|chain of thought)\b/i;
const ACTION_MACRO = /^\s*\{action\}/im;

function frozenState(
  buffered: string,
  visible: string,
  insideFence: boolean,
): Readonly<StreamingPreviewState> {
  return Object.freeze({ buffered, visible, insideFence });
}

function splitLines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
}

function proseOutsideFences(text: string): {
  prose: string;
  insideFence: boolean;
  invalid: boolean;
} {
  let fenceMarker: '```' | '~~~' | null = null;
  let prose = '';
  for (const line of splitLines(text)) {
    const content = line.replace(/\r?\n$/, '');
    const openingFence = /^[ \t]{0,3}(```|~~~)([^`~\r\n]*)$/.exec(content);
    const tooManyFenceCharacters = /^[ \t]{0,3}(?:`{4,}|~{4,})/.test(content);

    if (fenceMarker) {
      const closingFence = new RegExp(`^[ \\t]{0,3}${fenceMarker}[ \\t]*$`).test(content);
      if (closingFence) fenceMarker = null;
      continue;
    }
    if (
      tooManyFenceCharacters ||
      ((content.includes('```') || content.includes('~~~')) && !openingFence)
    ) {
      return { prose, insideFence: false, invalid: true };
    }
    if (openingFence) {
      fenceMarker = openingFence[1] as '```' | '~~~';
      continue;
    }
    prose += line;
  }
  return { prose, insideFence: fenceMarker !== null, invalid: false };
}

function completeVisibleProse(prose: string): string {
  const boundary = /[.!?\u3002\uFF01\uFF1F](?:["')\]]*)?(?=\s|$)/gu;
  let end = 0;
  for (const match of prose.matchAll(boundary)) {
    end = (match.index ?? 0) + match[0].length;
  }
  return prose.slice(0, end).trim();
}

// A public text channel is not permission to expose an unfinished sensitive
// marker. Hold only ambiguous suffixes, rather than delaying all prose until
// punctuation. The complete-value guards below still inspect every candidate.
const SENSITIVE_PREFIXES = Object.freeze([
  'password', 'passphrase', 'apikey', 'accesstoken', 'refreshtoken',
  'credential', 'clientsecret', 'privatekey', 'bearer',
  'systemprompt', 'hiddenprompt', 'hiddeninstruction', 'hiddeninstructions',
  'developermessage', 'chainofthought',
]);

function publicVisibleProse(prose: string, itemComplete: boolean): string {
  let end = prose.length;
  // Never send an unpaired high surrogate to the DOM while its low surrogate
  // may still arrive, or partial fence/action delimiters before classification.
  if (end > 0 && /[\ud800-\udbff]/u.test(prose.charAt(end - 1))) end -= 1;
  const partialFence = /[`~]{1,2}[ \t]*$/.exec(prose.slice(0, end));
  if (partialFence) end = partialFence.index;
  const brace = prose.lastIndexOf('{', end - 1);
  if (brace >= 0 && '{action}'.startsWith(prose.slice(brace, end).toLowerCase())) end = brace;
  if (!itemComplete) {
    // Every guarded phrase is short; a bounded suffix avoids rescanning the
    // entire part merely to decide whether its last token remains ambiguous.
    const tailStart = Math.max(0, end - 64);
    for (let start = tailStart; start < end; start += 1) {
      if (start > 0 && /[a-z0-9_]/i.test(prose.charAt(start - 1))) continue;
      const candidate = prose.slice(start, end).toLowerCase().replace(/[ _-]/g, '');
      if (candidate && SENSITIVE_PREFIXES.some((marker) => marker.startsWith(candidate))) {
        end = start;
        break;
      }
    }
  }
  return prose.slice(0, end).trim();
}

export function createStreamingPreviewState(): Readonly<StreamingPreviewState> {
  return frozenState('', '', false);
}

export function pushStreamingPreviewChunk(
  state: Readonly<StreamingPreviewState>,
  delta: string,
  options: Readonly<{
    interrupted?: boolean;
    /** Only for the adapter's classified public text channel, never reasoning. */
    publicProgress?: boolean;
    /** A trusted completed-item event, not an arbitrary network chunk boundary. */
    itemComplete?: boolean;
  }> = {},
): StreamingPreviewDecision {
  const buffered = `${state.buffered}${delta}`;
  const parsed = proseOutsideFences(buffered);
  const nextVisible = options.publicProgress
    ? publicVisibleProse(parsed.prose, options.itemComplete === true)
    : options.interrupted ? parsed.prose.trim() : completeVisibleProse(parsed.prose);
  const nextState = frozenState(buffered, nextVisible, parsed.insideFence);
  const blockedState = frozenState(buffered, state.visible, parsed.insideFence);

  if (parsed.invalid || ACTION_MACRO.test(parsed.prose)) {
    return { allowed: false, state: blockedState, reason: 'invalid_structure' };
  }
  if (SECRET_SIGNAL.test(parsed.prose)) {
    return { allowed: false, state: blockedState, reason: 'secret_signal' };
  }
  if (PROMPT_LEAK_SIGNAL.test(parsed.prose)) {
    return { allowed: false, state: blockedState, reason: 'prompt_leak_signal' };
  }
  // Publish already-complete safe prose before the fence while structured bytes
  // remain hidden. Otherwise a same-chunk question marks prose visible without
  // ever delivering it, delaying its message until final response persistence.
  if (parsed.insideFence && (!nextVisible || nextVisible === state.visible)) {
    return { allowed: false, state: blockedState, reason: 'inside_structured_fence' };
  }
  if (!nextVisible || nextVisible === state.visible) {
    return { allowed: false, state: nextState, reason: 'incomplete_sentence' };
  }
  return { allowed: true, state: nextState, visibleText: nextVisible };
}
