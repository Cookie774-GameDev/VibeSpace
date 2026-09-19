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

type InternalPreviewState = Readonly<{
  pendingPublic: string;
  securityTail: string;
  blockedReason?: 'secret_signal' | 'prompt_leak_signal' | 'invalid_structure';
  fullParseCount: number;
  fastChunkCount: number;
}>;

const INTERNAL = new WeakMap<Readonly<StreamingPreviewState>, InternalPreviewState>();
const SECURITY_TAIL_CHARS = 256;

function defaultInternal(state?: Readonly<StreamingPreviewState>): InternalPreviewState {
  return Object.freeze({
    pendingPublic: '',
    securityTail: state?.buffered.slice(-SECURITY_TAIL_CHARS) ?? '',
    fullParseCount: 0,
    fastChunkCount: 0,
  });
}

function internalOf(state: Readonly<StreamingPreviewState>): InternalPreviewState {
  return INTERNAL.get(state) ?? defaultInternal(state);
}
function frozenState(
  buffered: string,
  visible: string,
  insideFence: boolean,
  internal: InternalPreviewState = defaultInternal(),
): Readonly<StreamingPreviewState> {
  const state = Object.freeze({ buffered, visible, insideFence });
  INTERNAL.set(state, internal);
  return state;
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

function includeLeadingSeparator(text: string, index: number): number {
  let start = index;
  while (start > 0 && /[ \t\r\n]/u.test(text.charAt(start - 1))) start -= 1;
  return start;
}

function fastPublicBoundary(prose: string, itemComplete: boolean): number {
  let end = prose.length;
  if (end > 0 && /[\ud800-\udbff]/u.test(prose.charAt(end - 1))) {
    end = includeLeadingSeparator(prose, end - 1);
  }
  const partialFence = /[`~]{1,2}[ \t]*$/.exec(prose.slice(0, end));
  if (partialFence) end = includeLeadingSeparator(prose, partialFence.index);
  const brace = prose.lastIndexOf('{', end - 1);
  if (brace >= 0 && '{action}'.startsWith(prose.slice(brace, end).toLowerCase())) {
    end = includeLeadingSeparator(prose, brace);
  }
  if (!itemComplete) {
    const tailStart = Math.max(0, end - 64);
    for (let start = tailStart; start < end; start += 1) {
      if (start > 0 && /[a-z0-9_]/i.test(prose.charAt(start - 1))) continue;
      const candidate = prose.slice(start, end).toLowerCase().replace(/[ _-]/g, '');
      if (candidate && SENSITIVE_PREFIXES.some((marker) => marker.startsWith(candidate))) {
        end = includeLeadingSeparator(prose, start);
        break;
      }
    }
  }
  if (!itemComplete && end === prose.length) {
    while (end > 0 && /[ \t\r\n]/u.test(prose.charAt(end - 1))) end -= 1;
  }
  return end;
}

function deltaRequiresFullParse(delta: string): boolean {
  return (
    delta.includes('\n') ||
    delta.includes('\r') ||
    delta.includes('`') ||
    delta.includes('~') ||
    delta.includes('{') ||
    delta.includes('}')
  );
}

function classifySecurityTail(
  text: string,
): InternalPreviewState['blockedReason'] | undefined {
  if (ACTION_MACRO.test(text)) return 'invalid_structure';
  if (SECRET_SIGNAL.test(text)) return 'secret_signal';
  if (PROMPT_LEAK_SIGNAL.test(text)) return 'prompt_leak_signal';
  return undefined;
}

function nextSecurityTail(previous: string, delta: string): string {
  return (previous + delta).slice(-SECURITY_TAIL_CHARS);
}

function blockedStateWithReason(
  buffered: string,
  visible: string,
  insideFence: boolean,
  internal: InternalPreviewState,
  reason: NonNullable<InternalPreviewState['blockedReason']>,
): Readonly<StreamingPreviewState> {
  return frozenState(
    buffered,
    visible,
    insideFence,
    Object.freeze({ ...internal, blockedReason: reason }),
  );
}

function pushFastPublicProgress(
  state: Readonly<StreamingPreviewState>,
  delta: string,
  itemComplete: boolean,
): StreamingPreviewDecision | null {
  const internal = internalOf(state);
  if (
    state.insideFence ||
    deltaRequiresFullParse(delta) ||
    /[`~{}]/u.test(internal.pendingPublic)
  ) {
    return null;
  }
  const buffered = state.buffered + delta;
  const securityTail = nextSecurityTail(internal.securityTail, delta);
  const candidate = internal.pendingPublic + delta;
  const reason = internal.blockedReason ?? classifySecurityTail(securityTail);
  if (reason) {
    const blockedInternal = Object.freeze({
      ...internal,
      pendingPublic: candidate,
      securityTail,
      blockedReason: reason,
      fastChunkCount: internal.fastChunkCount + 1,
    });
    return {
      allowed: false,
      state: frozenState(buffered, state.visible, false, blockedInternal),
      reason,
    };
  }

  const boundary = fastPublicBoundary(candidate, itemComplete);
  const publishable = candidate.slice(0, boundary);
  const pendingPublic = candidate.slice(boundary);
  const nextVisible = (state.visible + publishable).trim();
  const nextState = frozenState(
    buffered,
    nextVisible,
    false,
    Object.freeze({
      pendingPublic,
      securityTail,
      fullParseCount: internal.fullParseCount,
      fastChunkCount: internal.fastChunkCount + 1,
    }),
  );
  if (!nextVisible || nextVisible === state.visible) {
    return { allowed: false, state: nextState, reason: 'incomplete_sentence' };
  }
  return { allowed: true, state: nextState, visibleText: nextVisible };
}
function publicVisibleProse(prose: string, itemComplete: boolean): string {
  return prose.slice(0, fastPublicBoundary(prose, itemComplete)).trim();
}

export function createStreamingPreviewState(): Readonly<StreamingPreviewState> {
  return frozenState('', '', false);
}

export function streamingPreviewGateStats(
  state: Readonly<StreamingPreviewState>,
): Readonly<{ fullParseCount: number; fastChunkCount: number; pendingChars: number }> {
  const internal = internalOf(state);
  return Object.freeze({
    fullParseCount: internal.fullParseCount,
    fastChunkCount: internal.fastChunkCount,
    pendingChars: internal.pendingPublic.length,
  });
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
  if (options.publicProgress && !options.interrupted) {
    const fast = pushFastPublicProgress(state, delta, options.itemComplete === true);
    if (fast) return fast;
  }

  const previousInternal = internalOf(state);
  const buffered = `${state.buffered}${delta}`;
  const parsed = proseOutsideFences(buffered);
  const itemComplete = options.itemComplete === true;
  const nextVisible = options.publicProgress
    ? publicVisibleProse(parsed.prose, itemComplete)
    : options.interrupted ? parsed.prose.trim() : completeVisibleProse(parsed.prose);
  const publicBoundary = options.publicProgress && !parsed.insideFence
    ? fastPublicBoundary(parsed.prose, itemComplete)
    : parsed.prose.length;
  const fallbackInternal: InternalPreviewState = Object.freeze({
    pendingPublic:
      options.publicProgress && !parsed.insideFence
        ? parsed.prose.slice(publicBoundary)
        : '',
    securityTail: parsed.prose.slice(-SECURITY_TAIL_CHARS),
    fullParseCount: previousInternal.fullParseCount + 1,
    fastChunkCount: previousInternal.fastChunkCount,
  });
  const nextState = frozenState(
    buffered,
    nextVisible,
    parsed.insideFence,
    fallbackInternal,
  );
  const blockedState = frozenState(
    buffered,
    state.visible,
    parsed.insideFence,
    fallbackInternal,
  );

  if (parsed.invalid || ACTION_MACRO.test(parsed.prose)) {
    return { allowed: false, state: blockedStateWithReason(buffered, state.visible, parsed.insideFence, fallbackInternal, 'invalid_structure'), reason: 'invalid_structure' };
  }
  if (SECRET_SIGNAL.test(parsed.prose)) {
    return { allowed: false, state: blockedStateWithReason(buffered, state.visible, parsed.insideFence, fallbackInternal, 'secret_signal'), reason: 'secret_signal' };
  }
  if (PROMPT_LEAK_SIGNAL.test(parsed.prose)) {
    return { allowed: false, state: blockedStateWithReason(buffered, state.visible, parsed.insideFence, fallbackInternal, 'prompt_leak_signal'), reason: 'prompt_leak_signal' };
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
