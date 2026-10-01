import type { ParsedActionProposal } from './types';
import { defaultWriteFilePath, getCachedDefaultWriteDir } from './defaultWriteDir';
import { isPathInsideRoot } from './filePolicy';

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
  // Strip a leading /surface-name prefix so "/terminals close 5" → "close 5"
  // before keyword matching. Only strips a single word preceded by "/" at the
  // very start to avoid mangling legitimate slash paths.
  const stripped = text.replace(/^\/[a-z][a-z0-9-]*\s+/i, '');
  return stripped.toLowerCase().replace(/\s+/g, ' ').trim();
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

type ExactMultiFileCreateRequest =
  | { kind: 'not_multi' }
  | { kind: 'invalid' }
  | {
      kind: 'valid';
      files: Array<{ path: string; content: string; root?: string }>;
    };

const WINDOWS_RESERVED_LEAF = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]*)?$/i;

function isSafeAbsoluteDirectory(path: string): boolean {
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path);
  if (
    path.length === 0 ||
    path.length > 32_768 ||
    /[\u0000-\u001f]/u.test(path) ||
    !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/u.test(path) ||
    (windowsPath && /[<>"|?*]/u.test(path)) ||
    (windowsPath && /:(?![\\/])/u.test(path.slice(2)))
  ) {
    return false;
  }
  return !path
    .split(/[\\/]/u)
    .some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        (windowsPath && segment.length > 0 && /[. ]$/u.test(segment)),
    );
}

function isSafeLeafFilename(name: string): boolean {
  return (
    name.length <= 255 &&
    name.trim() === name &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/u.test(name) &&
    !name.includes('..') &&
    !/[. ]$/u.test(name) &&
    !WINDOWS_RESERVED_LEAF.test(name)
  );
}

function trustedRootForBase(base: string, defaultWriteDir: string | null): string | null {
  return defaultWriteDir !== null && isPathInsideRoot(base, defaultWriteDir)
    ? defaultWriteDir
    : null;
}

function exactMultiFileEntry(
  base: string,
  name: string,
  content: string,
  root: string | null,
): { path: string; content: string; root?: string } | null {
  const separator = /^[A-Za-z]:[\\/]|^\\\\/u.test(base) ? '\\' : '/';
  const path = `${base}${separator}${name}`;
  if (path.length > 32_768) return null;
  return { path, content, ...(root ? { root } : {}) };
}

function hasExactlyOneTerminalLineEnding(content: string): boolean {
  const lineEnding = content.match(/\r?\n$/u)?.[0];
  if (!lineEnding) return false;
  return !content.slice(0, -lineEnding.length).endsWith('\n');
}

function extractRawMultiFileEntries(
  text: string,
  count: number,
  defaultWriteDir: string | null,
): ExactMultiFileCreateRequest {
  const baseMatches = [
    ...text.matchAll(
      /\bcreate\s+exactly\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+new\s+files?\s+in\s+`([^`\r\n]+)`/giu,
    ),
  ];
  if (baseMatches.length !== 1) return { kind: 'invalid' };
  const base = (baseMatches[0]?.[1] ?? '').replace(/[\\/]+$/u, '');
  if (!isSafeAbsoluteDirectory(base)) return { kind: 'invalid' };

  const declaredRootMatches = [...text.matchAll(/\buse root\s+`([^`\r\n]+)`/giu)];
  if (declaredRootMatches.length > 1) return { kind: 'invalid' };
  if (declaredRootMatches.length === 1) {
    const declaredRoot = (declaredRootMatches[0]?.[1] ?? '').replace(/[\\/]+$/u, '');
    if (!isSafeAbsoluteDirectory(declaredRoot) || !isPathInsideRoot(base, declaredRoot)) {
      return { kind: 'invalid' };
    }
  }

  const markers = [...text.matchAll(/^(\d{2})_([A-Za-z0-9][A-Za-z0-9._ -]*)$/gmu)];
  if (markers.length !== count) return { kind: 'invalid' };

  const seen = new Set<string>();
  const terminalLineEndings = new Set<string>();
  let aggregateContentLength = 0;
  const trustedRoot = trustedRootForBase(base, defaultWriteDir);
  const explicitlyRequiresFinalNewline =
    /\bexact UTF-8 content below,\s*including the final newline\b/iu.test(text);
  const files: Array<{ path: string; content: string; root?: string }> = [];
  for (const [index, marker] of markers.entries()) {
    const name = marker[0] ?? '';
    const ordinal = Number(marker[1]);
    const markerStart = marker.index;
    if (markerStart === undefined) return { kind: 'invalid' };
    let contentStart = markerStart + name.length;
    const markerLineEnding = text.slice(contentStart).match(/^\r?\n/u)?.[0];
    if (!markerLineEnding) return { kind: 'invalid' };
    contentStart += markerLineEnding.length;
    const contentEnd = markers[index + 1]?.index ?? text.length;
    let content = text.slice(contentStart, contentEnd);
    if (index < markers.length - 1) {
      const separator = content.match(/(\r?\n)\1$/u)?.[1];
      if (!separator) return { kind: 'invalid' };
      content = content.slice(0, -separator.length);
    }
    let terminalLineEnding = content.match(/\r?\n$/u)?.[0];
    if (!hasExactlyOneTerminalLineEnding(content)) {
      const canRestoreTrimmedFinalNewline =
        index === markers.length - 1 &&
        explicitlyRequiresFinalNewline &&
        terminalLineEnding === undefined &&
        terminalLineEndings.size === 1;
      if (!canRestoreTrimmedFinalNewline) return { kind: 'invalid' };
      const inferredLineEnding = [...terminalLineEndings][0];
      if (inferredLineEnding === undefined) return { kind: 'invalid' };
      terminalLineEnding = inferredLineEnding;
      content += inferredLineEnding;
    }
    if (terminalLineEnding === undefined) return { kind: 'invalid' };
    terminalLineEndings.add(terminalLineEnding);
    if (terminalLineEndings.size !== 1) return { kind: 'invalid' };
    const collisionKey = name.toLocaleLowerCase('en-US');
    aggregateContentLength += content.length;
    if (
      ordinal !== index + 1 ||
      !isSafeLeafFilename(name) ||
      seen.has(collisionKey) ||
      content.trim().length === 0 ||
      content.length > 200_000 ||
      aggregateContentLength > 1_000_000
    ) {
      return { kind: 'invalid' };
    }
    seen.add(collisionKey);
    const file = exactMultiFileEntry(base, name, content, trustedRoot);
    if (!file) return { kind: 'invalid' };
    files.push(file);
  }

  return { kind: 'valid', files };
}

type ExactMultiFileReadRequest =
  | { kind: 'not_multi' }
  | { kind: 'invalid' }
  | { kind: 'valid'; paths: readonly string[] };

function extractExactMultiFileReadRequest(text: string): ExactMultiFileReadRequest {
  if (/\bcreate\s+exactly\b/i.test(text)) return { kind: 'not_multi' };
  if (!/\bfiles\.read\b/i.test(text)) return { kind: 'not_multi' };
  if (!/\b(?:read|inspect|review|audit|open|show|load|check)\b/i.test(text)) {
    return { kind: 'not_multi' };
  }
  const paths = [
    ...text.matchAll(
      /\b([A-Za-z]:\\(?:[^\\\s\r\n:*?"<>|]+\\)*[^\\\s\r\n:*?"<>|]+\.[A-Za-z0-9]{1,12})\b/g,
    ),
  ].map((match) => match[1] ?? '');
  const unique = [...new Set(paths.filter((path) => path.length > 0 && path.length <= 32_768))];
  if (unique.length < 2) return { kind: 'not_multi' };
  if (unique.length > 10) return { kind: 'invalid' };
  return { kind: 'valid', paths: unique };
}

function extractExactMultiFileCreateRequest(
  text: string,
  defaultWriteDir: string | null,
): ExactMultiFileCreateRequest {
  const intentMatches = [
    ...text.matchAll(
      /\bcreate\s+exactly\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+new\s+files?\b/giu,
    ),
  ];
  if (intentMatches.length === 0) return { kind: 'not_multi' };
  if (intentMatches.length !== 1) return { kind: 'invalid' };

  const countToken = intentMatches[0]?.[1]?.toLowerCase();
  const count = countToken
    ? /^\d+$/u.test(countToken)
      ? Number(countToken)
      : NUMBER_WORDS[countToken]
    : undefined;
  if (!Number.isSafeInteger(count) || count === undefined) return { kind: 'invalid' };
  if (count === 1) return { kind: 'not_multi' };
  if (count < 2 || count > 10) return { kind: 'invalid' };

  const baseMatches = [...text.matchAll(/^[ \t]*Base directory:[ \t]*"([^"\r\n]+)"[ \t]*$/gimu)];
  if (baseMatches.length === 0) {
    return extractRawMultiFileEntries(text, count, defaultWriteDir);
  }
  if (baseMatches.length !== 1) return { kind: 'invalid' };
  const rawBase = baseMatches[0]?.[1] ?? '';
  if (!isSafeAbsoluteDirectory(rawBase)) return { kind: 'invalid' };
  const base = rawBase.replace(/[\\/]+$/u, '');
  if (!base) return { kind: 'invalid' };

  const blockPattern =
    /(?:^|\r?\n)[ \t]*(\d{1,2})\.[ \t]+Filename:[ \t]+`([^`\r\n]+)`[ \t]*\r?\n```[A-Za-z0-9_-]{0,32}\r?\n([\s\S]*?)(\r?\n)```[ \t]*(?=\r?\n|$)/gu;
  const blocks = [...text.matchAll(blockPattern)];
  const fenceCount = [...text.matchAll(/^[ \t]*```[^\r\n]*$/gmu)].length;
  if (blocks.length !== count || fenceCount !== count * 2) return { kind: 'invalid' };

  const seen = new Set<string>();
  let aggregateContentLength = 0;
  const files: Array<{ path: string; content: string; root?: string }> = [];
  const trustedRoot = trustedRootForBase(base, defaultWriteDir);

  for (const [index, block] of blocks.entries()) {
    const ordinal = Number(block[1]);
    const name = block[2] ?? '';
    const content = `${block[3] ?? ''}${block[4] ?? ''}`;
    const collisionKey = name.toLocaleLowerCase('en-US');
    aggregateContentLength += content.length;
    if (
      ordinal !== index + 1 ||
      !isSafeLeafFilename(name) ||
      seen.has(collisionKey) ||
      content.trim().length === 0 ||
      content.length > 200_000 ||
      aggregateContentLength > 1_000_000
    ) {
      return { kind: 'invalid' };
    }
    seen.add(collisionKey);
    const file = exactMultiFileEntry(base, name, content, trustedRoot);
    if (!file) return { kind: 'invalid' };
    files.push(file);
  }

  return { kind: 'valid', files };
}

function readTerminalCount(value: string | undefined): number | null {
  if (!value) return null;
  const asNumber = /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value];
  if (!Number.isFinite(asNumber)) return null;
  return Math.max(1, Math.min(10, asNumber));
}

function extractBulkOpenTerminalRequest(text: string): { count: number; command?: string } | null {
  const countToken = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const patterns = [
    new RegExp(
      `\\b(?:open|create|spawn|make|launch|start)\\s+${countToken}\\s+(?:new\\s+)?(?:terminals?|terminal\\s+panes?|panes?)\\b`,
    ),
    new RegExp(
      `\\b${countToken}\\s+(?:new\\s+)?(?:terminals?|terminal\\s+panes?|panes?)\\b.*\\b(?:open|create|spawn|make|launch|start)\\b`,
    ),
  ];
  const matched = patterns.map((pattern) => pattern.exec(text)).find(Boolean);
  const count = readTerminalCount(matched?.[1]);
  if (!count) return null;

  const commandMatch =
    /\b(?:with|running|run|start(?:ing)?|using)\s+(opencode|open-code|claude|codex|gemini)\b/.exec(
      text,
    );
  const command = commandMatch?.[1]?.replace('open-code', 'opencode');
  return command ? { count, command } : { count };
}

function extractSimpleOpenTerminalRequest(text: string): boolean {
  if (extractSingleTerminalRunRequest(text)) return false;
  if (extractBulkOpenTerminalRequest(normalized(text))) return false;
  return /\b(?:open|create|spawn|launch|start)\s+(?:me\s+)?(?:a|one|1)?\s*(?:new\s+)?(?:real\s+)?terminals?\b/.test(
    text,
  );
}

function extractSingleTerminalRunRequest(text: string): { command: string } | null {
  const match =
    /\b(?:open|create|start|launch)\s+(?:a|one|1)\s+(?:new\s+)?terminal\b(?:\s+(?:and|then))?\s+(?:run|execute|type)\s+([\s\S]+)$/i.exec(
      text.trim(),
    );
  const command = match?.[1]
    ?.replace(/^(?:this\s+)?exact\s+(?:powershell|shell|terminal)?\s*command\s*:\s*/i, '')
    ?.replace(/\b(?:please|okay|ok)\b[.!?\s]*$/i, '')
    .replace(/[.!?]+$/u, '')
    .trim();
  if (!command || command.length > 4_096) return null;
  return { command };
}

function extractBulkCloseTerminalRequest(text: string): { count: number } | null {
  // "close all terminals" → max 10
  if (
    /\b(?:close|kill|remove|shut\s+down)\s+all\s+(?:terminals?|terminal\s+panes?|panes?)\b/.test(
      text,
    )
  ) {
    return { count: 10 };
  }
  const countToken = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const patterns = [
    new RegExp(
      `\\b(?:close|kill|remove|shut\\s+down)\\s+${countToken}\\s+(?:terminals?|terminal\\s+panes?|panes?)\\b`,
    ),
    new RegExp(
      `\\b${countToken}\\s+(?:terminals?|terminal\\s+panes?|panes?)\\b.*\\b(?:close|kill|remove)\\b`,
    ),
  ];
  const matched = patterns.map((pattern) => pattern.exec(text)).find(Boolean);
  const count = readTerminalCount(matched?.[1]);
  if (!count) return null;
  return { count };
}

interface OrchestrationRequest {
  closeExisting: boolean;
  command?: string;
  roles: Array<{ count: number; agentSlug: string; prompt?: string }>;
}

function slugifyRole(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\bagents?\b/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Detect full terminal-orchestration requests like:
 * "Close all terminals in project, open 10 new terminals, open Claude code in
 * each one, and then put five as a code agent and another five as a code
 * reviewer agent. For the five code reviewer agents, type this prompt: you
 * are a code reviewer. For the code agents, type this prompt: please find
 * any security vulnerabilities."
 *
 * Must run BEFORE the plain bulk open/close detectors so the whole plan
 * lands in ONE approval card instead of two partial ones.
 */
function extractOrchestrationRequest(text: string): OrchestrationRequest | null {
  const countToken = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const openMatch = new RegExp(`\\bopen\\s+${countToken}\\s+(?:new\\s+)?terminals?\\b`).exec(text);
  const openCount = readTerminalCount(openMatch?.[1]);
  if (!openCount) return null;

  // Role split: "put five as a code agent and another five as a code reviewer agent"
  const rolePattern = new RegExp(
    `\\b${countToken}\\s+(?:of\\s+them\\s+)?as\\s+(?:an?\\s+)?([a-z][a-z ]{1,40}?)\\s+agents?\\b`,
    'g',
  );
  const roles: Array<{ count: number; agentSlug: string; label: string; prompt?: string }> = [];
  for (const match of text.matchAll(rolePattern)) {
    const count = readTerminalCount(match[1]);
    const label = (match[2] ?? '').trim();
    const agentSlug = slugifyRole(label);
    if (!count || !agentSlug) continue;
    roles.push({ count, agentSlug, label });
  }
  if (roles.length < 2) return null;

  // Prompts: "for the [five] code reviewer agents, type this prompt: ..."
  const promptPattern =
    /for\s+the\s+(?:\w+\s+)?([a-z][a-z ]{1,40}?)\s+agents?[,:]?\s*(?:please\s+)?(?:type|use|give(?:\s+them)?|send)\s+(?:this|the)\s+prompt[.:]?\s*([^.]+(?:\.[^]*?)?)(?=\s+for\s+the\s+|\s*$)/gi;
  for (const match of text.matchAll(promptPattern)) {
    const slug = slugifyRole((match[1] ?? '').trim());
    const prompt = (match[2] ?? '').trim().replace(/[.\s]+$/, '');
    if (!slug || !prompt) continue;
    // Prefer an exact slug match; otherwise take the LONGEST fuzzy match so
    // "code reviewer" prompts never land on the shorter "code" role.
    const role =
      roles.find((entry) => entry.agentSlug === slug) ??
      roles
        .filter((entry) => slug.includes(entry.agentSlug) || entry.agentSlug.includes(slug))
        .sort((a, b) => b.agentSlug.length - a.agentSlug.length)[0];
    if (role) role.prompt = prompt;
  }

  const commandMatch =
    /\b(?:open|run|start|launch)\s+(claude(?:\s+code)?|opencode|open-code|codex|gemini)\b/.exec(
      text,
    );
  const command = commandMatch
    ? commandMatch[1]!.replace(/\s+code$/, '').replace('open-code', 'opencode')
    : undefined;

  const closeExisting = /\bclose\s+all\s+(?:the\s+)?terminals?\b/.test(text);
  const total = roles.reduce((sum, role) => sum + role.count, 0);
  if (total > 10 || total !== openCount) {
    // Counts disagree or exceed the pane cap - stay conservative and let
    // the simpler detectors (or the model) handle it instead of guessing.
    return null;
  }
  return {
    closeExisting,
    command,
    roles: roles.map(({ count, agentSlug, prompt }) => ({ count, agentSlug, prompt })),
  };
}

function nextWholeHour(): number {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.getTime();
}

function requestedScheduleTime(text: string): number {
  const relativeDay = /\btomorrow\b/i.test(text) ? 1 : 0;
  const time = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!time) return nextWholeHour();
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return nextWholeHour();
  if (time[3]?.toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (time[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  const date = new Date();
  date.setDate(date.getDate() + relativeDay);
  date.setHours(hour, minute, 0, 0);
  if (relativeDay === 0 && date.getTime() <= Date.now()) return nextWholeHour();
  return date.getTime();
}

function extractScheduleCreateRequest(
  text: string,
): { title: string; prompt: string; startAtMs: number; recurrence: string } | null {
  const lower = normalized(text);
  const explicitSchedule = /\b(?:schedules?|scheduled)\b/.test(lower);
  const temporalRecurrence =
    /\b(?:daily|weekly|monthly|morning|evening|night|weekdays)\b/.test(lower) ||
    /\bevery\s+(?:morning|days?|evening|night|weeks?|months?|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      lower,
    );
  if (!explicitSchedule && !temporalRecurrence) return null;
  if (!/\b(make|create|schedule|run|remind|check|summarize|review)\b/.test(lower)) return null;
  const recurrence = /\bmonthly\b|\bevery\s+months?\b/.test(lower)
    ? 'monthly'
    : /\bweekly|weekdays|friday|monday|tuesday|wednesday|thursday|saturday|sunday\b|\bevery\s+weeks?\b/.test(
          lower,
        )
      ? 'weekly'
      : /\bdaily|morning|evening|night\b|\bevery\s+days?\b/.test(lower)
        ? 'daily'
        : 'once';
  const namedTitle = text.match(/\b(?:schedule\s+)?named\s+["“]([^"”]+)["”]/i)?.[1]?.trim();
  const title =
    namedTitle ||
    text
      .replace(/\b(make|create)\s+(?:a\s+)?schedule\s+(?:to|for)?\b/i, '')
      .replace(
        /\bevery\s+(morning|day|evening|night|week|month|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i,
        '',
      )
      .trim()
      .slice(0, 80) ||
    'Jarvis task';
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    prompt: lower,
    startAtMs: requestedScheduleTime(text),
    recurrence,
  };
}

/**
 * Question-block answer dumps look like:
 *   "What do you want this skill to do?: make a reminder skill"
 * Those must NOT re-open the Make with Jarvis creator — they are already
 * inside the creator flow and should draft fields instead.
 */
export function isJarvisCreatorWizardAnswerDump(text: string): boolean {
  const t = text.toLowerCase();
  if (/\bwhat do you want this (skill|agent) to do\b/.test(t)) return true;
  if (/\bhow should it behave in detail\b/.test(t)) return true;
  if (/\bjarvis_creator_(skill|agent)\b/.test(t)) return true;
  if (/\b(make|create) this (skill|agent) with jarvis\b/.test(t)) return true;
  // Multi-line "prompt: answer" dumps from QuestionBlockCard
  const qaLines = text.split(/\r?\n/).filter((line) => /^.+:\s*\S+/.test(line.trim()));
  if (qaLines.length >= 2 && /\b(skill|agent)\b/i.test(text)) return true;
  return false;
}

export function extractCreatorStartRequest(text: string): { kind: 'agent' | 'skill' } | null {
  if (isJarvisCreatorWizardAnswerDump(text)) return null;
  const directRequest =
    /\b(?:make|create|build|draft|write|generate)\s+(?:(?:me|us)\s+)?(?:(?:an?|the|new)\s+)?(?:(?:jarvis|vibespace)\s+)?(agent|skill)s?\b/i.exec(
      text,
    );
  if (!directRequest) return null;
  return directRequest[1]?.toLowerCase() === 'skill' ? { kind: 'skill' } : { kind: 'agent' };
}

function extractAgentRunRequest(text: string): { task: string; agentId: string } | null {
  const request = text.trim();
  if (!/\b(?:spawn|run|launch|start)\s+(?:one|1|a)\s+(?:sub-?agent|child agent)\b/i.test(request)) {
    return null;
  }
  const agentId = /\b(?:saved\s+)?agent\s+id\s+(agt_[A-Za-z0-9_-]+)\b/i.exec(request)?.[1];
  const delegatedTask =
    /\b(?:sub-?agent|child agent)\s+to\s+([\s\S]+?)(?=\s+Use the saved agent id\b)/i.exec(
      request,
    )?.[1];
  if (!agentId || !delegatedTask) return null;
  const sourceExcerpt = /\bSource excerpt(?:\s+from\s+[^:]+)?:\s*([\s\S]+)$/i.exec(request)?.[0];
  const task = `${delegatedTask.trim()} The child must use installed local Ollama Llama 3.2, must not edit files or use the network, and must not spawn more children.${sourceExcerpt ? ` ${sourceExcerpt.trim()}` : ''}`;
  if (task.length > 50_000) return null;
  return { task, agentId };
}

/**
 * Deterministic safety net for tiny/local models that describe app actions in
 * prose but fail to emit the fenced `action` JSON needed to show approval cards.
 *
 * Keep this intentionally narrow: it should only cover obvious app-control
 * requests where a real registered action already exists.
 */
/**
 * Tiny local models often emit a valid `command.run` (or other non-file)
 * card for an explicit files.create request. Prefer the deterministic
 * files.create fallback so Test03-style write turns stay on the approved
 * filesystem path.
 */
export function shouldReplaceModelActionsWithFileCreateFallback(
  modelActionIds: readonly string[],
  fallbackProposals: readonly { action_id: string }[],
): boolean {
  if (fallbackProposals.length === 0) return false;
  if (!fallbackProposals.every((proposal) => proposal.action_id === 'files.create')) {
    return false;
  }
  const modelFileCreates = modelActionIds.filter((id) => id === 'files.create').length;
  return fallbackProposals.length > modelFileCreates;
}

export function shouldReplaceModelActionsWithFileReadFallback(
  modelActionIds: readonly string[],
  fallbackProposals: readonly { action_id: string }[],
): boolean {
  if (fallbackProposals.length === 0) return false;
  if (!fallbackProposals.every((proposal) => proposal.action_id === 'files.read')) {
    return false;
  }
  const modelFileReads = modelActionIds.filter((id) => id === 'files.read').length;
  return fallbackProposals.length > modelFileReads;
}

export function inferFallbackActionProposals(
  userText: string,
  assistantText: string,
): ParsedActionProposal[] {
  const user = normalized(userText);
  const assistant = normalized(assistantText);
  const proposals: ParsedActionProposal[] = [];

  // Creator question responses are structured draft input, not standalone
  // app-action intent. Do not let words such as "create" or "read a file"
  // escape the wizard into filesystem approvals.
  if (isJarvisCreatorWizardAnswerDump(userText)) return proposals;
  // Protected Context turns expose only the bounded Context gateway. Never
  // reinterpret incidental slash text (for example "title/path") or model
  // narration as a separate filesystem approval.
  if (/^\s*Call the real `vibespace_context` function\b/u.test(userText)) {
    return proposals;
  }

  const defaultWriteDir = getCachedDefaultWriteDir();
  const exactMultiFileCreate = extractExactMultiFileCreateRequest(userText, defaultWriteDir);
  if (exactMultiFileCreate.kind === 'invalid') return proposals;
  if (exactMultiFileCreate.kind === 'valid') {
    return exactMultiFileCreate.files.map((file) =>
      proposal('files.create', file, `Write ${file.path} after user approval.`),
    );
  }
  const exactMultiFileRead = extractExactMultiFileReadRequest(userText);
  if (exactMultiFileRead.kind === 'invalid') return proposals;
  if (exactMultiFileRead.kind === 'valid') {
    return exactMultiFileRead.paths.map((path) =>
      proposal('files.read', { path }, `Read ${path} after user approval.`),
    );
  }

  const agentRun = extractAgentRunRequest(userText);
  if (agentRun) {
    proposals.push(
      proposal(
        'agent.run',
        agentRun,
        `Run the exact saved agent ${agentRun.agentId} with the bounded task after user approval.`,
      ),
    );
    return proposals;
  }

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

  const creatorStart = extractCreatorStartRequest(user);
  if (creatorStart) {
    proposals.push(
      proposal(
        'creator.start',
        { kind: creatorStart.kind },
        `Open the Make with Jarvis ${creatorStart.kind} creator after user approval.`,
      ),
    );
    return proposals;
  }

  const orchestration = extractOrchestrationRequest(user);
  if (orchestration) {
    const summary = orchestration.roles
      .map((role) => `${role.count} × ${role.agentSlug}`)
      .join(', ');
    proposals.push(
      proposal(
        'terminal.orchestrate',
        {
          closeExisting: orchestration.closeExisting,
          ...(orchestration.command ? { command: orchestration.command } : {}),
          rolesJson: JSON.stringify(orchestration.roles),
        },
        `${orchestration.closeExisting ? 'Close all project terminals, then open' : 'Open'} ${orchestration.roles.reduce((sum, role) => sum + role.count, 0)} terminals${orchestration.command ? ` running ${orchestration.command}` : ''} (${summary}); role prompts are delivered through AGENTS.md after user approval.`,
      ),
    );
    return proposals;
  }

  const singleTerminalRun = extractSingleTerminalRunRequest(userText);
  if (singleTerminalRun) {
    proposals.push(
      proposal(
        'terminal.run',
        singleTerminalRun,
        `Open one terminal pane and run ${singleTerminalRun.command} after user approval.`,
      ),
    );
    return proposals;
  }

  if (extractSimpleOpenTerminalRequest(userText)) {
    proposals.push(
      proposal(
        'terminal.bulkOpen',
        { count: 1 },
        'Open one new terminal pane after user approval.',
      ),
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

  const bulkClose = extractBulkCloseTerminalRequest(user);
  if (bulkClose) {
    proposals.push(
      proposal(
        'terminal.bulkClose',
        { count: bulkClose.count },
        `Close ${bulkClose.count === 10 ? 'all' : String(bulkClose.count)} terminal pane${bulkClose.count === 1 ? '' : 's'} after user approval.`,
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

  const scheduleCreate = extractScheduleCreateRequest(userText);
  if (scheduleCreate) {
    proposals.push(
      proposal(
        'schedule.create',
        scheduleCreate,
        'Create a real Jarvis schedule after user approval.',
      ),
    );
  }

  const fileRead = extractFileReadRequest(userText);
  if (fileRead) {
    proposals.push(
      proposal('files.read', { path: fileRead.path }, `Read ${fileRead.path} after user approval.`),
    );
  }

  const fileEdit = extractFileEditRequest(userText);
  if (fileEdit) {
    proposals.push(
      proposal(
        'files.edit',
        { path: fileEdit.path, content: fileEdit.content },
        `Replace ${fileEdit.path} after user approval.`,
      ),
    );
    return proposals;
  }

  const fileWrite = extractFileWriteRequest(userText, assistantText, {
    defaultDir: defaultWriteDir,
  });
  if (fileWrite) {
    const usesDefaultRoot =
      defaultWriteDir !== null && isPathInsideRoot(fileWrite.path, defaultWriteDir);
    proposals.push(
      proposal(
        'files.create',
        {
          path: fileWrite.path,
          content: fileWrite.content,
          ...(usesDefaultRoot ? { root: defaultWriteDir } : {}),
        },
        `Write ${fileWrite.path} after user approval.`,
      ),
    );
  }

  return proposals.slice(0, 3);
}

export function extractFileEditRequest(userText: string): { path: string; content: string } | null {
  const raw = userText.trim();
  if (
    !/\b(?:update|replace|overwrite|edit|modify)\b/i.test(raw) ||
    !/\b(?:existing|entire|whole|contents?)\b/i.test(raw)
  ) {
    return null;
  }
  const pathMatch =
    raw.match(/["'“”]((?:[A-Za-z]:[\\/][^"'“”]+|\\\\[^"'“”]+|\/[^"'“”]+))["'“”]/) ||
    raw.match(/\b((?:[A-Za-z]:[\\/][^\s"'“”]+|\\\\[^\s"'“”]+|\/[^\s"'“”]+))/);
  const path = pathMatch?.[1]?.replace(/[.,;:]+$/, '').trim();
  if (!path || path.length > 32_768) return null;
  const contentMatch = raw.match(
    /\b(?:contents?\s+with|contains?|containing|says?)\s+exactly\s*:\s*([\s\S]+)$/i,
  );
  const content = contentMatch?.[1]?.trim();
  if (content === undefined || content.length > 1_000_000) return null;
  return { path, content };
}

export function extractFileReadRequest(userText: string): { path: string } | null {
  const raw = userText.trim();
  const pathMatch =
    raw.match(/["'“”]((?:[A-Za-z]:[\\/][^"'“”]+|\\\\[^"'“”]+|\/[^"'“”]+))["'“”]/) ||
    raw.match(/\b((?:[A-Za-z]:[\\/][^\s"'“”]+|\\\\[^\s"'“”]+|\/[^\s"'“”]+))/);
  const intentText = pathMatch ? raw.replace(pathMatch[0], ' ') : raw;
  if (!/\b(read|inspect|review|audit|open|show|load|check)\b/i.test(intentText)) return null;
  if (!/\b(file|path|contents?|directly)\b/i.test(intentText) && !/\.[a-z0-9]{1,12}\b/i.test(raw)) {
    return null;
  }
  let path = pathMatch?.[1]?.replace(/[.,;:]+$/, '').trim();
  if (!path || path.length > 32_768) return null;
  const pathLeaf = path.split(/[\\/]/).at(-1) ?? '';
  if (!/\.[a-z0-9]{1,12}$/i.test(pathLeaf)) {
    const directoryPath = path;
    const requestedFilename = [
      ...raw.matchAll(/\b([A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]{1,12})\b/g),
    ]
      .map((match) => match[1])
      .find((filename) => filename && !directoryPath.includes(filename));
    if (requestedFilename) {
      path = `${directoryPath.replace(/[\\/]+$/u, '')}${directoryPath.includes('\\') ? '\\' : '/'}${requestedFilename}`;
    }
  }
  if (path.length > 32_768) return null;
  return { path };
}

/**
 * Infer a files.create proposal when the user clearly asks to create a text
 * file. Absolute path preferred; if missing, use the general default folder
 * (the allowed Jarvis Projects root). Tiny local models often refuse in prose
 * instead of emitting the action block — this is the safety net.
 */
export function extractFileWriteRequest(
  userText: string,
  assistantText = '',
  options?: { defaultDir?: string | null },
): { path: string; content: string } | null {
  const raw = userText.trim();
  if (!raw) return null;
  const pathMatch =
    raw.match(/["'“”]((?:[A-Za-z]:[\\/][^"'“”]+|\\\\[^"'“”]+|\/[^"'“”]+))["'“”]/) ||
    raw.match(/\b((?:[A-Za-z]:[\\/][^\s"'“”]+|\\\\[^\s"'“”]+|\/[^\s"'“”]+))/);
  // A path is data, not intent. In particular, read targets such as
  // native-write-proof.txt must not manufacture a second files.create action.
  const intentText = pathMatch ? raw.replace(pathMatch[0], ' ') : raw;
  const lower = intentText.toLowerCase();
  if (
    /\b(?:make|perform)\s+no\s+(?:edits?|changes?)\b/i.test(raw) ||
    /\b(?:do not|don't)\s+(?:edit|write|create|modify)\b/i.test(raw)
  ) {
    return null;
  }
  if (
    /\b(?:ledger|status summary|qualification report)\b/i.test(raw) &&
    /\b(?:pass|fail|present|absent)\b/i.test(raw) &&
    !/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'“”]+/u.test(raw)
  ) {
    return null;
  }

  // Must look like a create/write intent
  if (!/\b(make|create|write|save|generate|draft)\b/.test(lower)) return null;
  if (!/\b(file|txt|document|story|note|script)\b/.test(lower) && !/\.[a-z0-9]{1,8}\b/i.test(raw)) {
    // still allow "write X to C:\path\file.txt"
    if (!/\b(to|at|into|here)\b/.test(lower)) return null;
  }

  // Absolute Windows / UNC / POSIX path, optionally quoted
  let path: string;
  if (pathMatch?.[1]) {
    path = pathMatch[1].replace(/[.,;:]+$/, '').trim();
    if (!path) return null;
    // If path is a directory (no extension), invent a sensible filename
    if (!/\.[a-z0-9]{1,12}$/i.test(path.split(/[\\/]/).pop() || '')) {
      const wantsTxt = /\b(txt|text|story|note|document)\b/i.test(raw);
      const name = wantsTxt ? 'jarvis-note.txt' : 'jarvis-file.txt';
      path = path.replace(/[\\/]+$/, '') + (path.includes('\\') ? `\\${name}` : `/${name}`);
    }
  } else {
    // No path given — place a general file in the default write folder
    if (!/\b(file|txt|document|story|note|script)\b/.test(lower)) return null;
    const wantsTxt = /\b(txt|text|story|note|document)\b/i.test(raw);
    const name = wantsTxt ? 'jarvis-note.txt' : 'jarvis-file.txt';
    path = defaultWriteFilePath(name, options?.defaultDir ?? getCachedDefaultWriteDir());
  }

  // Content: after "write/about" or remaining prose without the path/make-file boilerplate
  let content = '';
  const pathToken = pathMatch?.[0] ?? '';
  const explicitContentMatch = raw.match(
    /\b(?:that\s+)?(?:contains?|containing|says?)\s+(?:exactly\s*)?:\s*([\s\S]+)$/i,
  );
  const aboutMatch =
    explicitContentMatch ??
    raw.match(/\b(?:write|about|with|containing|that says?)\b[:\s]+([\s\S]+)/i);
  if (aboutMatch?.[1]) {
    content = explicitContentMatch
      ? explicitContentMatch[1].trim()
      : aboutMatch[1]
          .replace(pathToken, ' ')
          .replace(/["'“”]/g, ' ')
          .replace(/\bok(ay)?\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
  }

  if (!content || content.length < 8) {
    // Strip path and boilerplate; use leftover as content seed
    content = raw
      .replace(pathToken, ' ')
      .replace(
        /\b(make|create|write|save|generate|draft)\b[\s\S]{0,40}\b(file|txt|document)\b/gi,
        ' ',
      )
      .replace(/\b(right\s+here|here|okay|please|and)\b/gi, ' ')
      .replace(/["'“”]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!content) {
    content = 'Created by Jarvis.';
  }

  // If the model already refused, still propose the write so the user can Approve
  void assistantText;

  // Cap content for safety
  if (content.length > 200_000) content = content.slice(0, 200_000);

  return { path, content };
}
