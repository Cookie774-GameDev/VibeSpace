/**
 * Deterministic, local NL parser for the Jarvis Assistant command bar.
 *
 * Pure function. No I/O, no network, no async. Lowercases and lightly cleans
 * the input, then walks a most-specific-first pattern table. Falls through
 * to `{ kind: 'unknown' }` so callers can show a hint instead of throwing.
 *
 * Design notes:
 *   - Patterns run top-to-bottom; reorder with care.
 *   - Filler words like "please", "can you", "i want to" are stripped
 *     before matching so users can be polite.
 *   - Trailing punctuation ("!", ".", "?") is stripped.
 *   - `create_event` is matched on the verb only; the heavy lifting (parsing
 *     "friday at 1pm" etc) is delegated to `parseEventInput` at execute time.
 */
import type { AssistantIntent } from './intents';

/** Filler phrases stripped from the start of the input. Order matters: longer first. */
const FILLER_PREFIXES = [
  'i would like to',
  'i want you to',
  'i want to',
  'i need to',
  'could you please',
  'could you',
  'can you please',
  'can you',
  'please',
  "let's",
  'lets',
  'go ahead and',
  'just',
  'kindly',
];

/** Known shell commands recognised in the "open <cmd> in <project>" shorthand. */
const KNOWN_SHELL_COMMANDS = [
  'claude code',
  'claude',
  'gpt',
  'gemini',
  'cursor',
  'opencode',
  'node',
  'python',
  'bash',
  'pwsh',
  'powershell',
  'zsh',
  'fish',
  'cmd',
];

/** Day-relative offsets used by the casual-task due-date hints. */
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_TO_NUM: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Strip filler prefixes, lowercase, and trim. Idempotent.
 */
function clean(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Drop trailing punctuation that wouldn't change meaning.
  s = s.replace(/[!.?]+$/g, '').trim();
  // Strip filler prefixes repeatedly so "please can you ..." also reduces.
  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of FILLER_PREFIXES) {
      if (s.startsWith(filler + ' ')) {
        s = s.slice(filler.length + 1).trim();
        changed = true;
        break;
      }
      if (s === filler) {
        s = '';
        changed = true;
        break;
      }
    }
  }
  // Collapse multiple internal spaces.
  s = s.replace(/\s{2,}/g, ' ');
  return s;
}

/**
 * Hash a name to a stable HSL hue 0..359. Used so freshly-created projects
 * get a colour without the user picking one.
 */
function hueFromName(name: string): number {
  return name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
}

/**
 * Look for a "tomorrow" / "today" / "next monday" suffix on a task title and
 * peel it off, returning the cleaned title and a unix-ms due date.
 *
 * We only recognise the casual phrases — anything richer goes through the
 * Schedule parser via `create_event`.
 */
function extractCasualDue(title: string): { title: string; due_at?: number } {
  const trimmed = title.trim();
  // "tomorrow" / "today" — single-word suffixes.
  const todayMatch = /\s+today$/i.exec(trimmed);
  if (todayMatch) {
    const d = new Date();
    d.setHours(17, 0, 0, 0); // default end-of-workday
    return { title: trimmed.slice(0, todayMatch.index).trim(), due_at: d.getTime() };
  }
  const tomorrowMatch = /\s+tomorrow$/i.exec(trimmed);
  if (tomorrowMatch) {
    const d = new Date(Date.now() + DAY_MS);
    d.setHours(17, 0, 0, 0);
    return { title: trimmed.slice(0, tomorrowMatch.index).trim(), due_at: d.getTime() };
  }
  // "next monday" / "monday" — weekday suffix, optionally prefixed with "next".
  const weekdayMatch = /\s+(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(trimmed);
  if (weekdayMatch) {
    const target = WEEKDAY_TO_NUM[weekdayMatch[1].toLowerCase()];
    const now = new Date();
    const today = now.getDay();
    let delta = target - today;
    if (delta <= 0) delta += 7;
    const d = new Date(now.getTime() + delta * DAY_MS);
    d.setHours(17, 0, 0, 0);
    return { title: trimmed.slice(0, weekdayMatch.index).trim(), due_at: d.getTime() };
  }
  return { title: trimmed };
}

/**
 * Strip optional surrounding quotes from a captured name. Lets users say
 * `create project "Tiger Eye"` without the quotes leaking through.
 */
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Try the "open claude in tiger" shorthand. Distinct from `open_terminals`
 * because there's no count token. Returns null when the shape doesn't match.
 *
 * We pre-sort known commands by length descending so "claude code" beats
 * "claude" (regex would otherwise stop at "claude" and leave "code in ..."
 * dangling).
 */
function tryShellShorthand(s: string): AssistantIntent | null {
  const m = /^(?:open|run|launch|start)\s+(.+?)\s+in\s+(.+?)(?:\s+project)?$/i.exec(s);
  if (!m) return null;
  const cmdRaw = m[1].trim().toLowerCase();
  const projectRaw = unquote(m[2].trim());
  // Validate the command against the known list so we don't misfire on
  // things like "open chat in tiger".
  const sortedCommands = [...KNOWN_SHELL_COMMANDS].sort((a, b) => b.length - a.length);
  const matched = sortedCommands.find((c) => cmdRaw === c);
  if (!matched) return null;
  return { kind: 'open_terminals', count: 1, command: matched, project: projectRaw };
}

/**
 * Parse a single user utterance into one of our discriminated intents.
 *
 * Always returns a value — bad input produces `{ kind: 'unknown', raw }`.
 */
export function parseAssistantInput(raw: string): AssistantIntent {
  const original = raw;
  const s = clean(raw);
  if (!s) return { kind: 'unknown', raw: original };

  // ---- create project ----
  const createProject = /^(?:create|new|make|add)\s+(?:a\s+)?(?:new\s+)?project\s+(?:called\s+|named\s+)?(.+)$/i.exec(s);
  if (createProject) {
    const name = unquote(createProject[1]);
    if (name) return { kind: 'create_project', name, color_hue: hueFromName(name) };
  }

  // ---- switch project ----
  const switchProject = /^(?:switch|go|change|jump|move)\s+(?:to\s+)?project\s+(.+)$/i.exec(s);
  if (switchProject) {
    const name = unquote(switchProject[1]);
    if (name) return { kind: 'switch_project', name };
  }
  // Also: "switch to tiger project" / "open tiger project"
  const switchProjectAlt = /^(?:switch\s+to|go\s+to|jump\s+to|open)\s+(.+?)\s+project$/i.exec(s);
  if (switchProjectAlt) {
    const name = unquote(switchProjectAlt[1]);
    if (name) return { kind: 'switch_project', name };
  }

  // ---- open N terminals ----
  // Most-specific terminal pattern: explicit count.
  const openTerms =
    /^open\s+(\d+)\s+terminals?(?:\s+(?:with|running)\s+(.+?))?(?:\s+in\s+(.+?))?(?:\s+project)?$/i.exec(s);
  if (openTerms) {
    const count = Math.max(1, Number(openTerms[1]) || 1);
    const command = openTerms[2]?.trim();
    const projectRaw = openTerms[3]?.trim();
    return {
      kind: 'open_terminals',
      count,
      command: command || undefined,
      project: projectRaw ? unquote(projectRaw) : undefined,
    };
  }

  // ---- open <shell> in <project> shorthand ----
  const shorthand = tryShellShorthand(s);
  if (shorthand) return shorthand;

  // ---- create chat ----
  // Match "create chat", "new chat", "start a chat", optionally with title and project.
  const createChat =
    /^(?:create|new|make|start)\s+(?:a\s+)?chat(?:\s+(?:called|named|titled)\s+(.+?))?(?:\s+in\s+(.+?))?(?:\s+project)?$/i.exec(s);
  if (createChat) {
    const title = createChat[1] ? unquote(createChat[1]) : undefined;
    const projectRaw = createChat[2]?.trim();
    return {
      kind: 'create_chat',
      title,
      project: projectRaw ? unquote(projectRaw) : undefined,
    };
  }

  // ---- create task / todo ----
  // Forms: "make a todo: X", "create task X", "add todo X", "todo: X"
  const createTask =
    /^(?:(?:create|add|make|new)\s+(?:a\s+)?)?(?:todo|task)(?:\s*[:\-]\s*|\s+)(.+)$/i.exec(s);
  if (createTask) {
    const rawTitle = unquote(createTask[1]);
    if (rawTitle) {
      const { title, due_at } = extractCasualDue(rawTitle);
      // Even after pulling the due-date suffix, there must be SOME title left.
      if (title) return { kind: 'create_task', title, due_at };
    }
  }

  // ---- create event / schedule ----
  // Schedule keyword routes to the Schedule parser at execute time.
  const scheduleMatch = /^(?:schedule|book|add\s+event|new\s+event|create\s+event)\s+(.+)$/i.exec(s);
  if (scheduleMatch) {
    const rest = scheduleMatch[1].trim();
    if (rest) return { kind: 'create_event', raw: rest };
  }

  // ---- ambient mode ----
  const ambient = /^ambient(?:\s+mode)?\s+(on|off|enable|disable)$/i.exec(s);
  if (ambient) {
    const v = ambient[1].toLowerCase();
    return { kind: 'set_ambient', on: v === 'on' || v === 'enable' };
  }

  // ---- fullscreen ----
  if (/^fullscreen$/i.test(s) || /^enter\s+fullscreen$/i.test(s) || /^go\s+fullscreen$/i.test(s)) {
    return { kind: 'set_fullscreen', on: true };
  }
  if (/^exit\s+fullscreen$/i.test(s) || /^leave\s+fullscreen$/i.test(s) || /^unfullscreen$/i.test(s)) {
    return { kind: 'set_fullscreen', on: false };
  }
  if (/^toggle\s+fullscreen$/i.test(s)) {
    return { kind: 'set_fullscreen' };
  }

  // ---- open settings / palette / launcher / schedule ----
  // These come AFTER `open_terminals` and the shell shorthand so we don't
  // swallow project-bound openers.
  if (/^(?:open\s+)?(?:settings|prefs|preferences)$/i.test(s)) {
    return { kind: 'open_settings' };
  }
  if (/^(?:open\s+)?(?:palette|command\s+palette|cmd)$/i.test(s)) {
    return { kind: 'open_palette' };
  }
  if (/^(?:open\s+)?(?:launcher|quick\s+launch|quick\s+launcher)$/i.test(s)) {
    return { kind: 'open_launcher' };
  }
  if (/^(?:open\s+)?(?:schedule|calendar|events)$/i.test(s)) {
    return { kind: 'open_schedule' };
  }

  return { kind: 'unknown', raw: original };
}
