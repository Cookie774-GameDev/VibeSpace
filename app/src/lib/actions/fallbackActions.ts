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

function extractSimpleOpenTerminalRequest(text: string): boolean {
  if (
    /\b(?:open|create|start|launch)\s+(?:a|one|1)\s+(?:new\s+)?terminal\b(?:\s+(?:and|then))?\s+(?:run|execute|type)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (extractBulkOpenTerminalRequest(normalized(text))) return false;
  return /\b(?:open|create|spawn|launch|start)\s+(?:me\s+)?(?:a|one|1)?\s*(?:new\s+)?(?:real\s+)?terminals?\b/.test(
    text,
  );
}

function extractSingleCliStartRequest(text: string): { cli: string } | null {
  const match =
    /\b(?:open|create|start|launch)\s+(?:a|one|1)\s+(?:new\s+)?terminal\b(?:\s+(?:and|then))?\s+(?:run|execute|type)\s+(opencode|open-code|claude(?:\s+code)?|codex|gemini)\b/i.exec(
      text.trim(),
    );
  const cli = match?.[1]?.toLowerCase().replace('open-code', 'opencode').replace(/\s+code$/, '');
  return cli ? { cli } : null;
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
export function inferFallbackActionProposals(
  userText: string,
  assistantText: string,
  options: { workingDirectory?: string | null } = {},
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

  const singleCliStart = extractSingleCliStartRequest(userText);
  if (singleCliStart) {
    proposals.push(
      proposal(
        'terminal.start_cli',
        singleCliStart,
        `Start the native ${singleCliStart.cli} CLI in a new terminal after user approval.`,
      ),
    );
    return proposals;
  }

  if (extractSimpleOpenTerminalRequest(user)) {
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

  return proposals.slice(0, 3);
}
