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

/** Route ids accepted by `useUIStore.setRoute` (V3 top-level routes). */
type NavRoute = 'chat' | 'terminal' | 'kanban' | 'schedule' | 'agents' | 'context' | 'skills' | 'benchmarks' | 'history' | 'tools' | 'files';

/**
 * Map the noun the user actually typed to the canonical route id. Plurals
 * and singulars collapse: "terminals" → "terminal", "agent" → "agents",
 * "benchmark" → "benchmarks". Unknown inputs default to chat (the patterns
 * below shouldn't reach here with anything outside this set).
 */
const NAV_ROUTE_MAP: Record<string, NavRoute> = {
  chat: 'chat',
  terminal: 'terminal',
  terminals: 'terminal',
  kanban: 'kanban',
  schedule: 'schedule',
  calendar: 'schedule',
  agenda: 'schedule',
  agent: 'agents',
  agents: 'agents',
  context: 'context',
  contexts: 'context',
  skills: 'skills',
  benchmark: 'benchmarks',
  benchmarks: 'benchmarks',
  history: 'history',
  tool: 'tools',
  tools: 'tools',
  file: 'files',
  files: 'files',
  explorer: 'files',
};

function normalizeRoute(raw: string): NavRoute {
  return NAV_ROUTE_MAP[raw.trim().toLowerCase()] ?? 'chat';
}

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

function normalizeTerminalCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  let c = command.trim().toLowerCase();
  c = c.replace(/^(?:each\s+)?(?:with|running)\s+/i, '').trim();
  c = c.replace(/\s+in\s+(?:it|them|each)$/i, '').trim();
  c = c.replace(/^each\s+/i, '').trim();
  return c || undefined;
}

function parseTerminalCount(raw: string | undefined): number {
  if (!raw) return 1;
  const normalized = raw.trim().toLowerCase();
  const words: Record<string, number> = {
    a: 1,
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
  const numeric = words[normalized] ?? Number(normalized);
  return Math.min(10, Math.max(1, numeric || 1));
}

function matchKnownShellCommand(raw: string): string | undefined {
  const cmd = raw.trim().toLowerCase();
  const sortedCommands = [...KNOWN_SHELL_COMMANDS].sort((a, b) => b.length - a.length);
  return sortedCommands.find((candidate) => cmd === candidate);
}

function splitProjectSuffix(commandRaw: string): { command: string; project?: string } {
  const inProject = /^(.+?)\s+(?:in|inside)\s+project\s+(.+)$/i.exec(commandRaw.trim());
  if (inProject) {
    return {
      command: inProject[1].trim(),
      project: unquote(inProject[2].trim()),
    };
  }
  return { command: commandRaw.trim() };
}

function parseDurationWord(value: string): number | null {
  const words: Record<string, number> = {
    a: 1,
    an: 1,
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
    eleven: 11,
    twelve: 12,
  };
  const normalized = value.trim().toLowerCase();
  if (normalized in words) return words[normalized];
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseTimerDuration(raw: string): { durationMinutes: number; durationSeconds?: number } | null {
  const text = raw.replace(/-/g, ' ').toLowerCase();
  const matches = [
    ...text.matchAll(
      /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/g,
    ),
  ];
  if (matches.length === 0) return null;

  let totalSeconds = 0;
  for (const match of matches) {
    const amount = parseDurationWord(match[1]);
    if (!amount || amount <= 0) continue;
    const unit = match[2];
    if (/^h/.test(unit)) totalSeconds += amount * 3600;
    else if (/^m/.test(unit)) totalSeconds += amount * 60;
    else totalSeconds += amount;
  }

  if (totalSeconds <= 0) return null;
  const durationMinutes = Math.floor(totalSeconds / 60);
  const durationSeconds = totalSeconds % 60;
  return { durationMinutes, ...(durationSeconds > 0 ? { durationSeconds } : {}) };
}

function tryClockIntent(s: string): AssistantIntent | null {
  const timerBefore =
    /^(?:set|start|create|make)(?:\s+me)?\s+(?:a\s+|an\s+)?(.+?)\s+timer(?:\s+(?:called|named)\s+(.+))?$/i.exec(s);
  if (timerBefore) {
    const duration = parseTimerDuration(timerBefore[1]);
    if (duration) return { kind: 'clock_timer', ...duration, label: timerBefore[2] ? unquote(timerBefore[2]) : undefined };
  }

  const timerAfter =
    /^(?:set|start|create|make)(?:\s+me)?\s+(?:a\s+|an\s+)?timer\s+(?:for\s+)?(.+?)(?:\s+(?:called|named)\s+(.+))?$/i.exec(s);
  if (timerAfter) {
    const duration = parseTimerDuration(timerAfter[1]);
    if (duration) return { kind: 'clock_timer', ...duration, label: timerAfter[2] ? unquote(timerAfter[2]) : undefined };
  }

  const alarm =
    /^(?:set|create|make)(?:\s+me)?\s+(?:a\s+|an\s+)?alarm\s+(?:for|at)\s+(.+?)(?:\s+(?:called|named)\s+(.+))?$/i.exec(s);
  if (alarm) {
    return { kind: 'clock_alarm', time: alarm[1].trim(), label: alarm[2] ? unquote(alarm[2]) : undefined };
  }

  return null;
}

function tryOpenTerminalRunChain(raw: string): AssistantIntent | null {
  const s = clean(raw);
  const match =
    /^(?:open|start|launch)\s+(?:(a|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(?:new\s+)?terminals?\s+(?:and\s+then|then|and)\s+(?:type|run|execute|start|launch)\s+(.+)$/i.exec(s);
  if (!match) return null;
  const count = parseTerminalCount(match[1]);
  const { command, project } = splitProjectSuffix(match[2]);
  const normalizedCommand = normalizeTerminalCommand(command);
  if (!normalizedCommand) return null;
  return { kind: 'open_terminals', count, command: normalizedCommand, project };
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
  const matched = matchKnownShellCommand(cmdRaw);
  if (!matched) return null;
  return { kind: 'open_terminals', count: 1, command: matched, project: projectRaw };
}

/**
 * Parse one command segment into one of our discriminated intents.
 * Multi-step splitting lives in the exported wrapper below so recursive
 * parsing never nests `multi_step` inside `multi_step`.
 */
function parseSingleAssistantInput(raw: string): AssistantIntent {
  const original = raw;
  const s = clean(raw);
  if (!s) return { kind: 'unknown', raw: original };

  const openTerminalRunChain = tryOpenTerminalRunChain(s);
  if (openTerminalRunChain) return openTerminalRunChain;

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
    const count = parseTerminalCount(openTerms[1]);
    const command = normalizeTerminalCommand(openTerms[2]);
    const projectRaw = openTerms[3]?.trim();
    return {
      kind: 'open_terminals',
      count,
      command,
      project: projectRaw ? unquote(projectRaw) : undefined,
    };
  }

  const openOneTerm =
    /^open\s+(?:(a|one)\s+)?(?:new\s+)?terminals?(?:\s+(?:with|running)\s+(.+?))?(?:(?:\s+(?:in|inside)\s+project\s+(.+))|(?:\s+in\s+(.+?)\s+project))?$/i.exec(s);
  if (openOneTerm) {
    const count = parseTerminalCount(openOneTerm[1]);
    const command = normalizeTerminalCommand(openOneTerm[2]);
    const projectRaw = openOneTerm[3]?.trim() || openOneTerm[4]?.trim();
    return {
      kind: 'open_terminals',
      count,
      command,
      project: projectRaw ? unquote(projectRaw) : undefined,
    };
  }

  const openKnownShell = /^(?:open|run|launch|start)\s+(.+?)(?:\s+(?:terminal|pane))?$/i.exec(s);
  if (openKnownShell) {
    const command = matchKnownShellCommand(openKnownShell[1]);
    if (command) return { kind: 'open_terminals', count: 1, command };
  }

  // ---- run command in all terminals ----
  const runAllTerms = /^(?:run|start|launch|execute)\s+(.+?)\s+in\s+(?:all|every|any)\s+terminals?$/i.exec(s);
  if (runAllTerms) {
    const command = runAllTerms[1]?.trim();
    if (command) return { kind: 'run_in_terminals', command, target: 'all' };
  }

  const createCustomCommand = /^(?:create|make|add|save)\s+(?:a\s+)?(?:custom\s+)?(?:command|tool|action)\s+(.+?)\s+(?:to\s+run|that\s+runs|as)\s+(.+)$/i.exec(s);
  if (createCustomCommand) {
    const name = unquote(createCustomCommand[1]);
    const command = createCustomCommand[2]?.trim();
    if (name && command) return { kind: 'create_custom_command', name, command };
  }

  const runCustomCommand = /^(?:run|use|execute|start)\s+(?:my\s+)?(?:custom\s+)?(?:command|tool|action)\s+(.+)$/i.exec(s);
  if (runCustomCommand) {
    const name = unquote(runCustomCommand[1]);
    if (name) return { kind: 'run_custom_command', name };
  }

  const askProvider = /^(?:ask|tell|have)\s+(opencode|claude|codex|cursor|gemini|gpt|openai|anthropic|google|groq)\s+(?:to\s+)?(.+)$/i.exec(s);
  if (askProvider) {
    const provider = askProvider[1]?.trim();
    const prompt = askProvider[2]?.trim();
    if (provider && prompt) return { kind: 'ask_provider', provider, prompt };
  }

  if (/^(?:give|send)\s+(?:all\s+)?terminals?\s+(?:all\s+)?(?:the\s+)?context$/i.test(s)) {
    return { kind: 'give_terminals_context' };
  }

  if (/^(?:create|make|generate|build)\s+(?:project\s+)?(?:context\s+)?(?:map|skill\s*tree|tree)$/i.test(s)) {
    return { kind: 'create_context_map' };
  }

  if (/^(?:center|recenter|reset|find)\s+(?:the\s+)?(?:project\s+)?(?:context\s+)?map$/i.test(s)) {
    return { kind: 'recenter_context_map' };
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

  const callMe = /^(?:call\s+me|phone\s+me|give\s+me\s+a\s+call)(?:\s+(?:at|on|about|for)\s+)?(.+)$/i.exec(s);
  if (callMe) {
    const rest = callMe[1]?.trim() || 'now';
    return { kind: 'schedule_call', raw: `Jarvis call: ${rest}` };
  }

  const messageMe = /^(?:message|text|sms)\s+me(?:\s*[:\-]\s*|\s+)(.+)$/i.exec(s);
  if (messageMe) {
    const text = unquote(messageMe[1]);
    if (text) return { kind: 'send_phone_message', text };
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

  // ---- navigate to a top-level V3 route ----
  // Placed BEFORE the open settings/palette/launcher/schedule block: those
  // patterns only match their exact words, so the two sets don't overlap,
  // but ordering preserves the spec's "navigate-first" intent.
  // Strict form: any of the four nav verbs, no "my", no trailing "please".
  const navStrict =
    /^(?:open|go to|show|switch to)\s+(terminal(?:s)?|kanban|context(?:s)?|skills|benchmarks?|history|agents?|tools?|files?|explorer|chat)$/i.exec(s);
  if (navStrict) {
    return { kind: 'navigate', route: normalizeRoute(navStrict[1]) };
  }
  // Polite form: only "open"/"show", optional "my", optional trailing "please".
  const navPolite =
    /^(?:open|show)\s+(?:my\s+)?(terminal(?:s)?|kanban|context(?:s)?|skills|benchmarks?|history|agents?|tools?|files?|explorer|chat)\s*(?:please)?$/i.exec(s);
  if (navPolite) {
    return { kind: 'navigate', route: normalizeRoute(navPolite[1]) };
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

  // ---- inspector / sidebar toggles ----
  if (/^(?:close|hide|toggle)\s+(?:the\s+)?(?:right\s+)?(?:side\s+)?(?:bar\s+)?(?:inspector|panel)/i.test(s)) {
    return { kind: 'navigate', route: 'chat' }; // triggers inspector close via UI
  }
  if (/^(?:show|open|toggle)\s+(?:the\s+)?(?:right\s+)?(?:side\s+)?(?:bar\s+)?(?:inspector|panel)/i.test(s)) {
    return { kind: 'navigate', route: 'chat' }; // triggers inspector open via UI
  }

  // ---- wellness / break ----
  if (/^(?:take\s+)?(?:a\s+)?(?:break|rest|pause)|start\s+(?:a\s+)?break/i.test(s)) {
    return { kind: 'set_ambient', on: true }; // triggers wellness
  }
  if (/^(?:end|stop|finish|close)\s+(?:the\s+)?(?:break|rest|pause)/i.test(s)) {
    return { kind: 'set_ambient', on: false };
  }

  // ---- quick task creation shortcuts ----
  if (/^(?:new|add|create)\s+(?:a\s+)?task[:\s]+(.+)$/i.test(s)) {
    const title = s.replace(/^(?:new|add|create)\s+(?:a\s+)?task[:\s]+/i, '').trim();
    if (title) {
      const { title: cleanTitle, due_at } = extractCasualDue(title);
      if (cleanTitle) return { kind: 'create_task', title: cleanTitle, due_at };
    }
  }

  // ---- ambient toggle ----
  if (/^(?:turn\s+)?(?:on|off)\s+ambient(?:\s+mode)?$/i.test(s)) {
    const isOn = /on/i.test(s);
    return { kind: 'set_ambient', on: isOn };
  }
  if (/^toggle\s+ambient(?:\s+mode)?$/i.test(s)) {
    return { kind: 'set_ambient', on: true }; // toggle handled in execute
  }

  // ---- fuzzy fallback: suggest closest command ----
  const suggestions = suggestClosestCommands(original);
  if (suggestions.length > 0) {
    return { kind: 'unknown', raw: original, suggestions };
  }

  return { kind: 'unknown', raw: original };
}

/**
 * Known command patterns for fuzzy suggestion. When the assistant doesn't
 * match any regex, we fuzzy-compare the sanitised user input against each
 * pattern's keywords and suggest the closest ones.
 */
const COMMAND_SUGGESTIONS = [
  { keywords: 'create project', example: 'create project tiger' },
  { keywords: 'switch to project', example: 'switch to tiger project' },
  { keywords: 'create chat', example: 'create chat called planning' },
  { keywords: 'open terminals', example: 'open 4 terminals with opencode' },
  { keywords: 'open terminal', example: 'open 4 terminals with opencode' },
  { keywords: 'run in all terminals', example: 'run npm test in all terminals' },
  { keywords: 'create command', example: 'create command dev server to run npm run dev' },
  { keywords: 'run command', example: 'run command dev server' },
  { keywords: 'ask provider', example: 'ask claude to fix the tests' },
  { keywords: 'create context map', example: 'create context map' },
  { keywords: 'recenter context map', example: 'recenter context map' },
  { keywords: 'give terminals context', example: 'give all terminals all context' },
  { keywords: 'create task', example: 'make a todo: ship the launcher tomorrow' },
  { keywords: 'todo', example: 'make a todo: verify the release' },
  { keywords: 'schedule', example: 'schedule standup friday at 1pm' },
  { keywords: 'call me', example: 'call me at 3pm' },
  { keywords: 'message me', example: 'message me: build is done' },
  { keywords: 'fullscreen', example: 'fullscreen' },
  { keywords: 'exit fullscreen', example: 'exit fullscreen' },
  { keywords: 'ambient', example: 'ambient mode on' },
  { keywords: 'open settings', example: 'open settings' },
  { keywords: 'open palette', example: 'open palette' },
  { keywords: 'open launcher', example: 'open launcher' },
  { keywords: 'open schedule', example: 'open schedule' },
  { keywords: 'open files', example: 'open files' },
  { keywords: 'open kanban', example: 'open kanban' },
  { keywords: 'open context', example: 'open context' },
  { keywords: 'open history', example: 'open history' },
  { keywords: 'open tools', example: 'open tools' },
  { keywords: 'open agents', example: 'open agents' },
  { keywords: 'open benchmarks', example: 'show benchmarks' },
  { keywords: 'break', example: 'start a break' },
  { keywords: 'rest', example: 'take a rest' },
  { keywords: 'pause', example: 'take a pause' },
  { keywords: 'close inspector', example: 'close the inspector' },
  { keywords: 'hide inspector', example: 'hide the right panel' },
  { keywords: 'show inspector', example: 'show the inspector' },
  { keywords: 'toggle inspector', example: 'toggle the inspector' },
];

function suggestClosestCommands(raw: string): string[] {
  const s = raw.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  if (s.length < 2) return [];
  const scored = COMMAND_SUGGESTIONS
    .map((entry) => {
      const kws = entry.keywords.split(' ').filter(Boolean);
      let hits = 0;
      for (const kw of kws) {
        if (s.includes(kw)) hits++;
      }
      return { ...entry, hits };
    })
    .filter((e) => e.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 3).map((e) => e.example);
}

/**
 * Parse a user utterance into one intent. Supports simple multi-step plans
 * separated by "then" / "and then" while preserving the existing single-
 * command vocabulary.
 */
export function parseAssistantInput(raw: string): AssistantIntent {
  const openTerminalRunChain = tryOpenTerminalRunChain(raw);
  if (openTerminalRunChain) return openTerminalRunChain;

  const parts = raw
    .split(/\s+(?:and\s+then|then)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parseSingleAssistantInput(raw);
  const steps = parts.map(parseSingleAssistantInput);
  return { kind: 'multi_step', steps };
}
