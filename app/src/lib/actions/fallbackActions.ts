import type { ParsedActionProposal } from './types';
import { defaultWriteFilePath, getCachedDefaultWriteDir } from './defaultWriteDir';

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

function extractSingleTerminalRunRequest(text: string): { command: string } | null {
  const match =
    /\b(?:open|create|start|launch)\s+(?:a|one|1)\s+(?:new\s+)?terminal\b(?:\s+(?:and|then))?\s+(?:run|execute|type)\s+([\s\S]+)$/i.exec(
      text.trim(),
    );
  const command = match?.[1]
    ?.replace(
      /^(?:this\s+)?exact\s+(?:powershell|shell|terminal)?\s*command\s*:\s*/i,
      '',
    )
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

function extractScheduleCreateRequest(
  text: string,
): { title: string; prompt: string; startAtMs: number; recurrence: string } | null {
  if (!/\b(schedule|scheduled|every|daily|weekly|monthly|morning|evening|night)\b/.test(text))
    return null;
  if (!/\b(make|create|schedule|run|remind|check|summarize|review)\b/.test(text)) return null;
  const recurrence = /\bmonthly\b/.test(text)
    ? 'monthly'
    : /\bweekly|friday|monday|tuesday|wednesday|thursday|saturday|sunday\b/.test(text)
      ? 'weekly'
      : /\bdaily|every morning|every day|morning|evening|night\b/.test(text)
        ? 'daily'
        : 'once';
  const title =
    text
      .replace(/\b(make|create)\s+(?:a\s+)?schedule\s+(?:to|for)?\b/i, '')
      .replace(
        /\bevery\s+(morning|day|evening|night|week|month|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i,
        '',
      )
      .trim()
      .slice(0, 80) || 'Jarvis task';
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    prompt: text,
    startAtMs: nextWholeHour(),
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

function extractCreatorStartRequest(text: string): { kind: 'agent' | 'skill' } | null {
  if (isJarvisCreatorWizardAnswerDump(text)) return null;
  if (!/\b(make|create|build|draft|write|generate)\b/.test(text)) return null;
  const agentIndex = text.search(/\bagents?\b/);
  const skillIndex = text.search(/\bskills?\b/);
  if (agentIndex < 0 && skillIndex < 0) return null;
  if (agentIndex >= 0 && skillIndex >= 0) {
    return agentIndex <= skillIndex ? { kind: 'agent' } : { kind: 'skill' };
  }
  return agentIndex >= 0 ? { kind: 'agent' } : { kind: 'skill' };
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

  const scheduleCreate = extractScheduleCreateRequest(user);
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

  const fileWrite = extractFileWriteRequest(userText, assistantText, {
    defaultDir: getCachedDefaultWriteDir(),
  });
  if (fileWrite) {
    proposals.push(
      proposal(
        'files.create',
        { path: fileWrite.path, content: fileWrite.content },
        `Write ${fileWrite.path} after user approval.`,
      ),
    );
  }

  return proposals.slice(0, 3);
}

export function extractFileReadRequest(userText: string): { path: string } | null {
  const raw = userText.trim();
  const pathMatch =
    raw.match(/["'“”]((?:[A-Za-z]:[\\/][^"'“”]+|\\\\[^"'“”]+|\/[^"'“”]+))["'“”]/) ||
    raw.match(/\b((?:[A-Za-z]:[\\/][^\s"'“”]+|\\\\[^\s"'“”]+|\/[^\s"'“”]+))/);
  const intentText = pathMatch ? raw.replace(pathMatch[0], ' ') : raw;
  if (!/\b(read|inspect|open|show|load|check)\b/i.test(intentText)) return null;
  if (
    !/\b(file|path|contents?|directly)\b/i.test(intentText) &&
    !/\.[a-z0-9]{1,12}\b/i.test(raw)
  ) {
    return null;
  }
  let path = pathMatch?.[1]?.replace(/[.,;:]+$/, '').trim();
  if (!path || path.length > 32_768) return null;
  const pathLeaf = path.split(/[\\/]/).at(-1) ?? '';
  if (!/\.[a-z0-9]{1,12}$/i.test(pathLeaf)) {
    const directoryPath = path;
    const requestedFilename = [...raw.matchAll(/\b([A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]{1,12})\b/g)]
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
 * (Downloads/Documents/VibeSpace). Tiny local models often refuse in prose
 * instead of emitting the action block — this is the safety net.
 */
export function extractFileWriteRequest(
  userText: string,
  assistantText = '',
  options?: { defaultDir?: string | null },
): { path: string; content: string } | null {
  const raw = userText.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
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
  const pathMatch =
    raw.match(/["'“”]((?:[A-Za-z]:[\\/][^"'“”]+|\\\\[^"'“”]+|\/[^"'“”]+))["'“”]/) ||
    raw.match(/\b((?:[A-Za-z]:[\\/][^\s"'“”]+|\\\\[^\s"'“”]+|\/[^\s"'“”]+))/);

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
