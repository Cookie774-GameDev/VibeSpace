/**
 * Stub voice intent classifier for V1.
 *
 * This is a pure, regex-based classifier that runs locally in the browser
 * with zero dependencies. It is meant to power the V1 voice UX shell so the
 * modal can route utterances to the right handler before the Phase 3 sidecar
 * (which will use a Haiku-class model on streaming partials) lands.
 *
 * The patterns mirror the table in `docs/04-voice-jarvis-layer.md` section 7.
 * Order matters: more specific intents are checked before general ones so
 * that e.g. "ask the coder to add buy milk" routes to `agent_route`, not
 * `task_create`.
 */

export type Intent =
  | 'chat'
  | 'task_create'
  | 'task_modify'
  | 'task_complete'
  | 'task_query'
  | 'agent_route'
  | 'app_command'
  | 'dictation'
  | 'memory_recall'
  | 'conversation';

export interface VoiceSlots {
  /** Subject of a task create / modify / complete intent. */
  title?: string;
  /** Natural-language due expression, e.g. "tomorrow 9am" or "Friday at 4pm". */
  due?: string;
  /** Slug of the agent the user is addressing (for agent_route). */
  target_agent?: string;
  /** Free-form query (for memory_recall, task_query, agent_route). */
  query?: string;
  /** Raw command body (for app_command, dictation). */
  command?: string;
}

export interface VoiceIntent {
  intent: Intent;
  slots: VoiceSlots;
  /** Original input text (trimmed) - useful for downstream LLM fallback. */
  text: string;
  /** Heuristic confidence 0..1. Cheap signal for "did the regex actually fit". */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Patterns (anchored unless noted; keep lowercase or use /i)
// ---------------------------------------------------------------------------

const RX = {
  task_complete:
    /^(done with|mark .+ (done|complete)|i (?:just )?(?:did|sent|finished))\b/i,
  task_create:
    /^(add\b|remind me to\b|put .+ on (?:my )?list\b|create a task\b|jarvis,?\s*add\b)/i,
  task_query: /^((?:what's on|what is on|show me|list)\s+(?:my\s+)?(?:list|tasks|todo)|what'?s overdue)\b/i,
  task_modify_verb: /^(move|change|reschedule|update)\s+the\b/i,
  task_modify_priority: /\bmake\s+.+\s+(urgent|important|high)\b/i,
  agent_route_ask: /^(?:ask|tell)\s+the\s+(\w+)\b/i,
  agent_route_at: /^@(\w+)\s/,
  memory_recall:
    /^(what did|do you remember|find\s+.+\s+from|pull up)\b/i,
  dictation: /^(type|dictate|write)\s+(?:this|the following)\s+into\b/i,
  app_command: /^(open|switch to|go to|mute|enable|disable)\b/i,
} as const;

// Time / due expression - intentionally generous, intentionally not strict.
// We're just trying to peel a "Friday at 4pm" or "tomorrow 9am" off the title.
const DUE_RX =
  /\b(today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|next\s+week|this\s+week|this\s+(?:morning|afternoon|evening)|in\s+\d+\s+(?:min|minute|minutes|hr|hour|hours|day|days|week|weeks))\b(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i;

const PRIORITY_RX = /\b(urgent|important|high\s+priority|asap|today)\b/i;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

function emptyIntent(text: string): VoiceIntent {
  return { intent: 'chat', slots: {}, text, confidence: 0 };
}

export function classify(input: string): VoiceIntent {
  const text = (input ?? '').trim();
  if (!text) return emptyIntent('');

  // 1. task_complete - "done with X", "mark X done", "I finished X"
  if (RX.task_complete.test(text)) {
    return {
      intent: 'task_complete',
      slots: { title: extractCompleteTitle(text) },
      text,
      confidence: 0.85,
    };
  }

  // 2. task_create - "add X", "remind me to X", "put X on my list"
  if (RX.task_create.test(text)) {
    const { title, due } = extractCreate(text);
    return {
      intent: 'task_create',
      slots: { title, due },
      text,
      confidence: 0.9,
    };
  }

  // 3. task_query - "what's on my list", "what's overdue"
  if (RX.task_query.test(text)) {
    return {
      intent: 'task_query',
      slots: { query: text },
      text,
      confidence: 0.85,
    };
  }

  // 4. task_modify - "move/change/reschedule the X" or "make X urgent"
  if (RX.task_modify_verb.test(text) || RX.task_modify_priority.test(text)) {
    return {
      intent: 'task_modify',
      slots: { title: text },
      text,
      confidence: 0.7,
    };
  }

  // 5. agent_route - "ask the coder ..." / "@coder ..."
  const askMatch = text.match(RX.agent_route_ask);
  if (askMatch) {
    return {
      intent: 'agent_route',
      slots: {
        target_agent: askMatch[1].toLowerCase(),
        query: text.slice(askMatch[0].length).replace(/^[\s,:.-]+/, '').trim(),
      },
      text,
      confidence: 0.9,
    };
  }
  const atMatch = text.match(RX.agent_route_at);
  if (atMatch) {
    return {
      intent: 'agent_route',
      slots: {
        target_agent: atMatch[1].toLowerCase(),
        query: text.slice(atMatch[0].length).trim(),
      },
      text,
      confidence: 0.95,
    };
  }

  // 6. memory_recall - "what did we decide about X", "do you remember X"
  if (RX.memory_recall.test(text)) {
    return {
      intent: 'memory_recall',
      slots: { query: text },
      text,
      confidence: 0.8,
    };
  }

  // 7. dictation - "type this into the active app"
  if (RX.dictation.test(text)) {
    return {
      intent: 'dictation',
      slots: { command: text },
      text,
      confidence: 0.85,
    };
  }

  // 8. app_command - "open project Acme", "switch to council mode"
  if (RX.app_command.test(text)) {
    return {
      intent: 'app_command',
      slots: { command: text },
      text,
      confidence: 0.75,
    };
  }

  // Default: free-form chat
  return { ...emptyIntent(text), intent: 'chat', confidence: 0.4 };
}

// ---------------------------------------------------------------------------
// Slot extractors
// ---------------------------------------------------------------------------

function extractCreate(text: string): { title: string; due?: string } {
  // Strip leading trigger phrase
  let body = text
    .replace(/^(add|remind me to|put|create a task|jarvis,?\s*add)\s+/i, '')
    .trim();

  // Strip trailing "to/on (my) list" suffix
  body = body.replace(/\s+(?:on|to)\s+(?:my\s+)?(?:list|todo|tasks)\b\s*$/i, '');

  // Pull off the first time/date expression we find
  let due: string | undefined;
  const dueMatch = body.match(DUE_RX);
  if (dueMatch && dueMatch.index !== undefined) {
    due = dueMatch[0].trim().replace(/\s+/g, ' ');
    body = (body.slice(0, dueMatch.index) + body.slice(dueMatch.index + dueMatch[0].length)).trim();
  }

  // Strip priority keywords from the title - they live separately upstream
  body = body.replace(PRIORITY_RX, '').replace(/\s+/g, ' ').trim();

  return { title: body || text, due };
}

function extractCompleteTitle(text: string): string {
  // Try to peel off the trigger phrase to leave just the subject
  let body = text;

  // "done with X" → X
  let m = body.match(/^done with\s+(.+)$/i);
  if (m) return m[1].trim();

  // "mark X (done|complete)" → X
  m = body.match(/^mark\s+(.+?)\s+(done|complete)\b/i);
  if (m) return m[1].trim();

  // "i (just) (did|sent|finished) X" → X
  m = body.match(/^i\s+(?:just\s+)?(?:did|sent|finished)\s+(.+)$/i);
  if (m) return m[1].trim();

  return body.trim();
}

/**
 * Public API surface. Intent classification is exposed as an object with a
 * `classify` method (rather than a bare function) to leave room for future
 * methods like `setLocale`, `learn`, etc. without breaking the contract.
 */
export const IntentClassifier = {
  classify,
};
