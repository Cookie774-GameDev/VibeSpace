import type { Message, Part } from '@/types';
import { applySecretPolicy } from '@/lib/security/secretDetector';
import type {
  ChatActivityCategory,
  ChatActivityEvent,
  ChatActivityKind,
  ChatActivityStatus,
} from '../activity/types';

export const MAX_MOUNTED_BLOCKS = 400;
export const TRANSCRIPT_PAGE_SIZE = 100;
export const MAX_DIFF_LINES = 800;
export const MAX_OUTPUT_CHARS = 1024 * 1024;

type BaseBlock = {
  id: string;
  sourceId: string;
  ts: number;
};

export type PromptBlock = BaseBlock & {
  kind: 'prompt';
  message: Message;
  text: string;
};

export type AnswerBlock = BaseBlock & {
  kind: 'answer';
  message: Message;
  text: string;
  agentId?: string;
};

export type ReasoningBlock = BaseBlock & {
  kind: 'reasoning';
  text: string;
};

export type CommandBlock = BaseBlock & {
  kind: 'command';
  tool: string;
  command: string;
  cwd?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  callId: string;
};

export type ToolBlock = BaseBlock & {
  kind: 'tool';
  tool: string;
  args: string;
  output?: string;
  error?: string;
  callId: string;
};

export type ActivityBlock = BaseBlock & {
  kind: 'activity';
  status: ChatActivityStatus;
  activityKind: ChatActivityKind;
  activityCategory?: ChatActivityCategory;
  title: string;
  detail?: string;
  filePath?: string;
  url?: string;
  startedAt?: number;
  endedAt?: number;
};

export type DiffBlock = BaseBlock & {
  kind: 'diff';
  status: ChatActivityStatus;
  activityCategory?: ChatActivityCategory;
  title: string;
  filePath?: string;
  diff: string;
  addedLines?: number;
  removedLines?: number;
};

export type LegacyBlock = BaseBlock & {
  kind: 'legacy';
  message: Message;
};

export type TranscriptBlock =
  | PromptBlock
  | AnswerBlock
  | ReasoningBlock
  | CommandBlock
  | ToolBlock
  | ActivityBlock
  | DiffBlock
  | LegacyBlock;

export type AgenticSessionSummary = {
  status:
    | 'idle'
    | 'queued'
    | 'planning'
    | 'running'
    | 'blocked'
    | 'partial'
    | 'error'
    | 'cancelled'
    | 'recovering'
    | 'done';
  currentOperation: string;
  fileCount: number;
  addedLines: number;
  removedLines: number;
  tokenCount: number | '—';
  tokenProvenance?: 'estimated';
  startedAt: number | '—';
  endedAt: number | '—';
  durationMs: number | '—';
  model: string;
  context: '—';
};

export type AgenticSessionEvidence = {
  status?: string;
  currentOperation?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
};

const INTERACTIVE_PARTS = new Set<Part['kind']>([
  'action_proposal',
  'question_block',
  'question_answer',
  'plan_review',
  'permission_request',
  'agent_card',
  'image',
  'file_ref',
  'jarvis_source_ref',
  'jarvis_artifact_ref',
  'context_inspector',
  'token_optimization_receipt',
  'usage_card',
  'stack_step',
]);

const COMMAND_TOOLS = /(?:^|[._:/-])(shell|terminal|command|exec|powershell|bash)(?:$|[._:/-])/i;
const ANSI_CSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
const CONTROL_EXCEPT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export function sanitizeConsoleText(value: string, maxChars = MAX_OUTPUT_CHARS): string {
  const clean = value
    .replace(ANSI_CSI, '')
    .replace(CONTROL_EXCEPT_TEXT, '')
    .replace(/\r\n?/g, '\n');
  const redacted = applySecretPolicy(clean, 'redact').text ?? '';
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars - 20))}\n… output truncated`;
}

export type UnifiedDiffLine = {
  text: string;
  kind: 'meta' | 'context' | 'add' | 'remove';
  oldLine?: number;
  newLine?: number;
};

export function formatUnifiedDiffLines(diff: string): UnifiedDiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return diff.split('\n').map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, kind: 'meta' };
    }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('\\')) {
      return { text, kind: 'meta' };
    }
    if (text.startsWith('+')) {
      const line = { text, kind: 'add' as const, newLine };
      if (newLine != null) newLine += 1;
      return line;
    }
    if (text.startsWith('-')) {
      const line = { text, kind: 'remove' as const, oldLine };
      if (oldLine != null) oldLine += 1;
      return line;
    }
    if (oldLine == null || newLine == null) return { text, kind: 'meta' };
    const line = { text, kind: 'context' as const, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function stringifyPayload(value: unknown, maxChars = MAX_OUTPUT_CHARS): string | undefined {
  if (value == null) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return sanitizeConsoleText(text, maxChars);
}

function textParts(message: Message): string {
  return message.parts
    .filter((part): part is Extract<Part, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function hasInteractiveParts(message: Message): boolean {
  return message.parts.some((part) => INTERACTIVE_PARTS.has(part.kind));
}

function commandFromArgs(args: Record<string, unknown>): { command?: string; cwd?: string } {
  const command = ['command', 'cmd', 'script', 'input'].find(
    (key) => typeof args[key] === 'string',
  );
  const cwd = ['cwd', 'workingDirectory', 'workdir'].find((key) => typeof args[key] === 'string');
  return {
    command: command ? sanitizeConsoleText(String(args[command]), 64 * 1024) : undefined,
    cwd: cwd ? sanitizeConsoleText(String(args[cwd]), 4096) : undefined,
  };
}

function commandResultEvidence(result: unknown): {
  output?: string;
  exitCode?: number;
  durationMs?: number;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { output: stringifyPayload(result) };
  }
  const record = result as Record<string, unknown>;
  const outputKey = ['stdout', 'output', 'text'].find((key) => typeof record[key] === 'string');
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const output = [outputKey ? String(record[outputKey]) : '', stderr].filter(Boolean).join('\n');
  const exitCodeValue = record.exitCode ?? record.exit_code ?? record.code;
  const durationValue = record.durationMs ?? record.duration_ms ?? record.elapsed_ms;
  return {
    output: output ? sanitizeConsoleText(output) : stringifyPayload(result),
    exitCode: typeof exitCodeValue === 'number' ? exitCodeValue : undefined,
    durationMs: typeof durationValue === 'number' ? durationValue : undefined,
  };
}

function boundedDiff(diff: string): string {
  const clean = sanitizeConsoleText(diff, MAX_OUTPUT_CHARS);
  const lines = clean.split('\n');
  if (lines.length <= MAX_DIFF_LINES) return clean;
  return `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… diff truncated`;
}

function projectMessage(message: Message, preserveAssistantMessages: boolean): TranscriptBlock[] {
  const sourceId = `message:${message.id}`;
  if (
    hasInteractiveParts(message) ||
    message.role === 'system' ||
    (preserveAssistantMessages && message.role === 'assistant')
  ) {
    return [
      {
        id: `${sourceId}:legacy`,
        sourceId,
        ts: message.created_at,
        kind: 'legacy',
        message,
      },
    ];
  }

  if (message.role === 'user') {
    const text = textParts(message);
    return text
      ? [
          {
            id: `${sourceId}:prompt`,
            sourceId,
            ts: message.created_at,
            kind: 'prompt',
            message,
            text: sanitizeConsoleText(text),
          },
        ]
      : [{ id: `${sourceId}:legacy`, sourceId, ts: message.created_at, kind: 'legacy', message }];
  }

  const results = new Map(
    message.parts
      .filter((part): part is Extract<Part, { kind: 'tool_result' }> => part.kind === 'tool_result')
      .map((part) => [part.call_id, part]),
  );
  const pairedResults = new Set<string>();
  const blocks: TranscriptBlock[] = [];

  message.parts.forEach((part, index) => {
    const base = {
      sourceId,
      ts: message.created_at + index / 1000,
    };
    if (part.kind === 'text' && part.text.trim()) {
      blocks.push({
        ...base,
        id: `${sourceId}:answer:${index}`,
        kind: 'answer',
        message,
        text: sanitizeConsoleText(part.text),
        agentId: message.agent_id,
      });
      return;
    }
    if (part.kind === 'reasoning') {
      if (index !== message.parts.findIndex(item => item.kind === 'reasoning')) return;
      blocks.push({
        ...base,
        id: `${sourceId}:reasoning`,
        kind: 'reasoning',
        text: sanitizeConsoleText(message.parts.flatMap(item => item.kind === 'reasoning' ? [item.text] : []).join('\n\n')),
      });
      return;
    }
    if (part.kind === 'tool_call') {
      const result = results.get(part.call_id);
      if (result) pairedResults.add(part.call_id);
      const change = result?.result && typeof result.result === 'object'
        ? result.result as Record<string, unknown> : undefined;
      if (/^(edit|write|apply_patch)$/.test(part.tool) && change?.status === 'completed' &&
          !result?.error && typeof change.diff === 'string' && change.diff.trim()) {
        const diff = boundedDiff(change.diff);
        const lines = formatUnifiedDiffLines(diff);
        const filePath = typeof part.args.path === 'string' ? part.args.path : undefined;
        blocks.push({ ...base, id: `${sourceId}:diff:${part.call_id}`, kind: 'diff', status: 'done',
          title: 'Edited files', filePath, diff,
          addedLines: lines.filter(line => line.kind === 'add').length,
          removedLines: lines.filter(line => line.kind === 'remove').length });
      }
      const command = commandFromArgs(part.args);
      if (COMMAND_TOOLS.test(part.tool) && command.command) {
        const evidence = commandResultEvidence(result?.result);
        blocks.push({
          ...base,
          id: `${sourceId}:command:${part.call_id}`,
          kind: 'command',
          tool: part.tool,
          command: command.command,
          cwd: command.cwd,
          output: evidence.output,
          error: result?.error ? sanitizeConsoleText(result.error) : undefined,
          exitCode: evidence.exitCode,
          durationMs: evidence.durationMs,
          callId: part.call_id,
        });
      } else {
        blocks.push({
          ...base,
          id: `${sourceId}:tool:${part.call_id}`,
          kind: 'tool',
          tool: sanitizeConsoleText(part.tool, 512),
          args: stringifyPayload(part.args, 128 * 1024) ?? '{}',
          output: stringifyPayload(result?.result),
          error: result?.error ? sanitizeConsoleText(result.error) : undefined,
          callId: part.call_id,
        });
      }
      return;
    }
    if (part.kind === 'tool_result' && !pairedResults.has(part.call_id)) {
      blocks.push({
        ...base,
        id: `${sourceId}:tool-result:${part.call_id}`,
        kind: 'tool',
        tool: 'Tool result',
        args: '{}',
        output: stringifyPayload(part.result),
        error: part.error ? sanitizeConsoleText(part.error) : undefined,
        callId: part.call_id,
      });
    }
  });

  return blocks.length
    ? blocks
    : [{ id: `${sourceId}:legacy`, sourceId, ts: message.created_at, kind: 'legacy', message }];
}

function projectActivity(event: ChatActivityEvent): TranscriptBlock {
  const sourceId = `activity:${event.id}`;
  if (event.category === 'thinking' && event.messageId) {
    return { id: `message:${event.messageId}:reasoning`, sourceId: `message:${event.messageId}`, ts: event.ts, kind: 'reasoning', text: sanitizeConsoleText(event.detail ?? '') };
  }
  if (event.diff?.trim()) {
    return {
      id: `${sourceId}:diff`,
      sourceId,
      ts: event.ts,
      kind: 'diff',
      status: event.status,
      activityCategory: event.category,
      title: sanitizeConsoleText(event.title, 4096),
      filePath: event.filePath ? sanitizeConsoleText(event.filePath, 4096) : undefined,
      diff: boundedDiff(event.diff),
      addedLines: event.addedLines,
      removedLines: event.removedLines,
    };
  }
  return {
    id: `${sourceId}:activity`,
    sourceId,
    ts: event.ts,
    kind: 'activity',
    status: event.status,
    activityKind: event.kind,
    activityCategory: event.category,
    title: sanitizeConsoleText(event.title, 4096),
    detail: event.detail ? sanitizeConsoleText(event.detail, 128 * 1024) : event.subtitle,
    filePath: event.filePath ? sanitizeConsoleText(event.filePath, 4096) : undefined,
    url: event.url ? sanitizeConsoleText(event.url, 8192) : undefined,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
  };
}

function compareTranscriptBlocks(left: TranscriptBlock, right: TranscriptBlock): number {
  return left.ts - right.ts || left.id.localeCompare(right.id);
}

function isOrderedTranscript(blocks: readonly TranscriptBlock[]): boolean {
  for (let index = 1; index < blocks.length; index += 1) {
    if (compareTranscriptBlocks(blocks[index - 1]!, blocks[index]!) > 0) return false;
  }
  return true;
}

function mergeOrderedTranscripts(
  left: readonly TranscriptBlock[],
  right: readonly TranscriptBlock[],
): TranscriptBlock[] {
  const merged = new Array<TranscriptBlock>(left.length + right.length);
  let leftIndex = 0;
  let rightIndex = 0;
  let outputIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (compareTranscriptBlocks(left[leftIndex]!, right[rightIndex]!) <= 0) {
      merged[outputIndex] = left[leftIndex]!;
      leftIndex += 1;
    } else {
      merged[outputIndex] = right[rightIndex]!;
      rightIndex += 1;
    }
    outputIndex += 1;
  }
  while (leftIndex < left.length) {
    merged[outputIndex] = left[leftIndex]!;
    leftIndex += 1;
    outputIndex += 1;
  }
  while (rightIndex < right.length) {
    merged[outputIndex] = right[rightIndex]!;
    rightIndex += 1;
    outputIndex += 1;
  }
  return merged;
}

export function projectAgenticTranscript(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  options: { preserveAssistantMessages?: boolean } = {},
): TranscriptBlock[] {
  const messageBlocks = messages.flatMap((message) =>
    projectMessage(message, options.preserveAssistantMessages === true),
  );
  const activityBlocks = dedupeActivity(activity, messages).map(projectActivity);
  if (isOrderedTranscript(messageBlocks) && isOrderedTranscript(activityBlocks)) {
    return mergeOrderedTranscripts(messageBlocks, activityBlocks);
  }
  return [...messageBlocks, ...activityBlocks].sort(compareTranscriptBlocks);
}

type ProjectedMessageShape = {
  count: number;
  firstTs: number;
  lastTs: number;
};

function projectedMessageShape(
  message: Message,
  preserveAssistantMessages: boolean,
): ProjectedMessageShape {
  if (message.parts.some(part => part.kind === 'tool_result' && part.result &&
      typeof part.result === 'object' && 'diff' in part.result)) {
    const blocks = projectMessage(message, preserveAssistantMessages);
    return { count: blocks.length, firstTs: blocks[0]!.ts, lastTs: blocks.at(-1)!.ts };
  }
  if (
    hasInteractiveParts(message) ||
    message.role === 'system' ||
    message.role === 'user' ||
    (preserveAssistantMessages && message.role === 'assistant')
  ) {
    return { count: 1, firstTs: message.created_at, lastTs: message.created_at };
  }

  const resultIds = new Set(
    message.parts.flatMap((part) => (part.kind === 'tool_result' ? [part.call_id] : [])),
  );
  const pairedResults = new Set<string>();
  let count = 0;
  let hasReasoning = false;
  let firstIndex = 0;
  let lastIndex = 0;
  const record = (index: number) => {
    if (count === 0) firstIndex = index;
    lastIndex = index;
    count += 1;
  };
  message.parts.forEach((part, index) => {
    if (part.kind === 'text' || part.kind === 'reasoning') {
      if (part.kind === 'reasoning') {
        if (!hasReasoning) record(index);
        hasReasoning = true;
      } else if (part.text.trim()) record(index);
      return;
    }
    if (part.kind === 'tool_call') {
      if (resultIds.has(part.call_id)) pairedResults.add(part.call_id);
      record(index);
      return;
    }
    if (part.kind === 'tool_result' && !pairedResults.has(part.call_id)) record(index);
  });
  if (count === 0) return { count: 1, firstTs: message.created_at, lastTs: message.created_at };
  return {
    count,
    firstTs: message.created_at + firstIndex / 1000,
    lastTs: message.created_at + lastIndex / 1000,
  };
}

function activityDiffKey(event: ChatActivityEvent): string {
  return event.messageId && event.providerCallId
    ? `message:${event.messageId}:diff:${event.providerCallId}` : `activity:${event.id}:diff`;
}

function dedupeActivity(activity: readonly ChatActivityEvent[], messages: readonly Message[] = []): ChatActivityEvent[] {
  const seen = new Set<string>();
  const persisted = new Set<string>();
  for (const message of messages) {
    if (message.parts.some(part => part.kind === 'reasoning')) persisted.add(`message:${message.id}:reasoning`);
    const edits = new Set(message.parts.flatMap(part => part.kind === 'tool_call' &&
      /^(edit|write|apply_patch)$/.test(part.tool) ? [part.call_id] : []));
    for (const part of message.parts) {
      if (part.kind === 'tool_result' && edits.has(part.call_id) && !part.error &&
          part.result && typeof part.result === 'object' && 'status' in part.result &&
          part.result.status === 'completed' && 'diff' in part.result && typeof part.result.diff === 'string') {
        persisted.add(`message:${message.id}:diff:${part.call_id}`);
      }
    }
  }
  return activity.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return !(event.diff && persisted.has(activityDiffKey(event))) &&
      !(event.category === 'thinking' && event.messageId && persisted.has(`message:${event.messageId}:reasoning`));
  });
}

function activityProjectionId(event: ChatActivityEvent): string {
  if (event.category === 'thinking' && event.messageId) return `message:${event.messageId}:reasoning`;
  return `activity:${event.id}:${event.diff?.trim() ? 'diff' : 'activity'}`;
}

function isOrderedActivity(activity: readonly ChatActivityEvent[]): boolean {
  for (let index = 1; index < activity.length; index += 1) {
    const previous = activity[index - 1]!;
    const current = activity[index]!;
    const order =
      previous.ts - current.ts ||
      activityProjectionId(previous).localeCompare(activityProjectionId(current));
    if (order > 0) return false;
  }
  return true;
}

export function projectAgenticTranscriptWindow(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  mountedCount = MAX_MOUNTED_BLOCKS,
  options: { preserveAssistantMessages?: boolean } = {},
): { visible: readonly TranscriptBlock[]; remaining: number; total: number } {
  const count = Math.max(0, Math.floor(mountedCount));
  const preserveAssistantMessages = options.preserveAssistantMessages === true;
  const messageShapes = messages.map((message) =>
    projectedMessageShape(message, preserveAssistantMessages),
  );
  const uniqueActivity = dedupeActivity(activity, messages);
  const messageTotal = messageShapes.reduce((total, shape) => total + shape.count, 0);
  const total = messageTotal + uniqueActivity.length;
  const messagesOrdered = messageShapes.every(
    (shape, index) => index === 0 || shape.firstTs > messageShapes[index - 1]!.lastTs,
  );

  if (!messagesOrdered || !isOrderedActivity(uniqueActivity)) {
    const full = projectAgenticTranscript(messages, activity, options);
    const windowed = windowTranscriptBlocks(full, count);
    return { ...windowed, total: full.length };
  }
  if (count === 0 || total === 0) return { visible: [], remaining: total, total };

  let messageStart = messages.length;
  let selectedMessageBlocks = 0;
  while (messageStart > 0 && selectedMessageBlocks < count) {
    messageStart -= 1;
    selectedMessageBlocks += messageShapes[messageStart]!.count;
  }
  const selectedActivity = uniqueActivity.slice(-count);
  const projectedTail = projectAgenticTranscript(
    messages.slice(messageStart),
    selectedActivity,
    options,
  );
  const visible = windowTranscriptBlocks(projectedTail, count).visible;
  return {
    visible,
    remaining: Math.max(0, total - visible.length),
    total,
  };
}

export function summarizeAgenticSession(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  evidence: AgenticSessionEvidence = {},
): AgenticSessionSummary {
  const uniqueFiles = new Set<string>();
  let earliestStartedAt: number | undefined;
  let latestEndedAt: number | undefined;
  let running: ChatActivityEvent | undefined;
  let latestActivity: ChatActivityEvent | undefined;
  let latestActivityAt: number | undefined;
  let hasError = false;
  let hasBlocked = false;
  let hasCompletedActivity = false;
  let addedLines = 0;
  let removedLines = 0;
  const countedDiffs = new Set<string>();

  for (const event of dedupeActivity(activity)) {
    if (event.filePath) uniqueFiles.add(event.filePath);
    const eventStartedAt = event.startedAt ?? event.ts;
    if (
      Number.isFinite(eventStartedAt) &&
      (earliestStartedAt === undefined || eventStartedAt < earliestStartedAt)
    ) {
      earliestStartedAt = eventStartedAt;
    }
    if (event.endedAt != null) {
      latestEndedAt =
        latestEndedAt === undefined ? event.endedAt : Math.max(latestEndedAt, event.endedAt);
    }
    if (!running && (event.status === 'running' || event.status === 'pending')) running = event;
    hasError ||= event.status === 'error';
    hasBlocked ||= /blocked|approval|permission/i.test(`${event.status} ${event.title}`);
    hasCompletedActivity ||= event.status === 'done';
    if (event.status === 'done') {
      const diffKey = event.diff ? activityDiffKey(event) : undefined;
      if (!diffKey || !countedDiffs.has(diffKey)) {
        addedLines += event.addedLines ?? 0;
        removedLines += event.removedLines ?? 0;
        if (diffKey) countedDiffs.add(diffKey);
      }
    }

    const completedAt = event.endedAt ?? event.ts;
    if (latestActivity === undefined || completedAt > (latestActivityAt as number)) {
      latestActivity = event;
      latestActivityAt = completedAt;
    }
  }

  let hasAssistantAnswer = false;
  let latestUserAt = -Infinity;
  let latestAnswerAt = -Infinity;
  let latestFailureNoticeAt = -Infinity;
  let hasTokenUsage = false;
  let hasUnavailableTokenUsage = false;
  let tokenCount = 0;
  let hasEstimatedTokens = false;
  let model = '—';
  for (const message of messages) {
    if (message.role === 'user') latestUserAt = Math.max(latestUserAt, message.created_at);
    // Older saved turns have only this canonical application system notice.
    // Never interpret provider/user prose as a runtime terminal state.
    if (message.role === 'system' && message.parts.some(part => part.kind === 'text' &&
      /^The reply could not (?:start|finish)\. Check the selected model and request settings, then try again\.$/.test(part.text))) {
      latestFailureNoticeAt = Math.max(latestFailureNoticeAt, message.created_at);
    }
    const hasResponse = message.role === 'assistant' &&
      (textParts(message).length > 0 || message.parts.some(part => part.kind === 'plan_review'));
    if (hasResponse) {
      latestAnswerAt = Math.max(latestAnswerAt, message.created_at);
    }
    for (const part of message.parts) {
      if (part.kind === 'tool_call' && typeof part.args.path === 'string') {
        uniqueFiles.add(part.args.path);
      }
    }
    if (message.parts.some(part => part.kind === 'tool_result')) {
      // Summary accounting is independent of interactive cards that retain the
      // complete message in the transcript (for example a saved source reference).
      const toolEvidence = { ...message, parts: message.parts.filter(part =>
        part.kind === 'tool_call' || part.kind === 'tool_result') };
      for (const block of projectMessage(toolEvidence, false)) {
        if (block.kind !== 'diff' || block.status !== 'done') continue;
        const key = block.id;
        if (countedDiffs.has(key)) continue;
        countedDiffs.add(key);
        addedLines += block.addedLines ?? 0;
        removedLines += block.removedLines ?? 0;
      }
    }
    if (
      Number.isFinite(message.created_at) &&
      (earliestStartedAt === undefined || message.created_at < earliestStartedAt)
    ) {
      earliestStartedAt = message.created_at;
    }
    if (hasResponse) {
      hasAssistantAnswer = true;
    }
    const usage = message.usage;
    if (usage?.model) model = usage.model;
    // Approval cards are application notices, not additional model turns.
    // Preserve unavailable usage for every actual answer, including mixed rows.
    const permissionNotice = usage == null && message.parts.length > 0 &&
      message.parts.every(part => part.kind === 'permission_request');
    if (message.role === 'assistant' && !permissionNotice) {
      const input = usage?.input_tokens;
      const output = usage?.output_tokens;
      if (usage?.provenance !== 'unavailable' && typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 &&
          typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) {
        hasTokenUsage = true;
        tokenCount += Number.isSafeInteger(usage?.total_tokens) && usage!.total_tokens! >= 0 ? usage!.total_tokens! : input + output;
        hasEstimatedTokens ||= usage?.provenance === 'estimated';
      } else {
        hasUnavailableTokenUsage = true;
      }
    }
  }
  const evidenceStatus = String(evidence.status ?? '').toLowerCase();
  const mappedStatus: AgenticSessionSummary['status'] | undefined =
    /awaiting|blocked|approval|permission/.test(evidenceStatus)
      ? 'blocked'
      : /cancel/.test(evidenceStatus)
        ? 'cancelled'
        : /recover/.test(evidenceStatus)
          ? 'recovering'
          : /partial/.test(evidenceStatus)
            ? 'partial'
            : /planning/.test(evidenceStatus)
              ? 'planning'
              : /queued|pending/.test(evidenceStatus)
                ? 'queued'
                : /fail|error/.test(evidenceStatus)
                  ? 'error'
                  : /running|streaming|active/.test(evidenceStatus)
                    ? 'running'
                    : /done|complete|success/.test(evidenceStatus)
                      ? 'done'
                      : undefined;
  // A terminal snapshot can remain selected while the next turn prepares.
  // It must not own the new turn's status, operation, or elapsed-time fields.
  const staleTerminalEvidence =
    mappedStatus !== undefined &&
    ['done', 'error', 'cancelled', 'partial'].includes(mappedStatus) &&
    typeof evidence.endedAt === 'number' &&
    Number.isFinite(evidence.endedAt) &&
    evidence.endedAt < latestUserAt;
  if (Number.isFinite(latestUserAt)) {
    // Earlier activity can survive a cancelled pre-send job or view recovery.
    // Keep its accounting above, but let only this turn determine live status.
    const currentActivity = dedupeActivity(activity).filter((event) =>
      (event.startedAt ?? event.ts) >= latestUserAt);
    running = currentActivity.filter((event) =>
      event.status === 'running' || event.status === 'pending')
      .sort((left, right) => right.ts - left.ts)[0];
    hasError = currentActivity.some((event) => event.status === 'error');
    hasBlocked = currentActivity.some((event) => /blocked|approval|permission/i.test(`${event.status} ${event.title}`));
    hasCompletedActivity = currentActivity.some((event) => event.status === 'done');
    latestActivity = currentActivity.sort((left, right) =>
      (right.endedAt ?? right.ts) - (left.endedAt ?? left.ts))[0];
  }
  const hasCurrentFailureNotice = latestFailureNoticeAt >= latestUserAt &&
    latestFailureNoticeAt > latestAnswerAt;
  const inferredStatus: AgenticSessionSummary['status'] = running
    ? 'running'
    : hasError || hasCurrentFailureNotice
      ? 'error'
      : latestActivity?.status === 'cancelled'
        ? 'cancelled'
        : hasBlocked
          ? 'blocked'
          : (hasAssistantAnswer || staleTerminalEvidence) && latestUserAt > latestAnswerAt
            ? 'recovering'
            : hasCompletedActivity || hasAssistantAnswer
              ? 'done'
              : 'idle';
  const status = staleTerminalEvidence ? inferredStatus : (mappedStatus ?? inferredStatus);
  const startedAt = staleTerminalEvidence
    ? latestUserAt
    : typeof evidence.startedAt === 'number' ? evidence.startedAt : (earliestStartedAt ?? '—');
  const endedAt = staleTerminalEvidence
    ? '—'
    : typeof evidence.endedAt === 'number' ? evidence.endedAt : (latestEndedAt ?? '—');
  return {
    status,
    currentOperation:
      (!staleTerminalEvidence && evidence.currentOperation
        ? sanitizeConsoleText(evidence.currentOperation, 4096)
        : undefined) ??
      (running?.title ? sanitizeConsoleText(running.title, 4096) : undefined) ??
      (status === 'error'
        ? 'Run failed'
        : status === 'blocked'
          ? 'Awaiting approval'
          : status === 'cancelled'
            ? (latestActivity?.title ?? 'Cancelled')
            : status === 'done'
              ? 'Complete'
              : status === 'recovering'
                ? 'Checking saved request status'
                : status === 'planning'
                  ? 'Planning'
                  : status === 'queued'
                    ? 'Queued'
                    : status === 'partial'
                      ? 'Partially complete'
                      : 'Ready'),
    fileCount: uniqueFiles.size,
    addedLines,
    removedLines,
    tokenCount: hasTokenUsage && !hasUnavailableTokenUsage ? tokenCount : '—',
    ...(hasEstimatedTokens ? { tokenProvenance: 'estimated' as const } : {}),
    startedAt,
    endedAt,
    durationMs:
      !['running', 'queued', 'planning', 'recovering'].includes(status) &&
      typeof startedAt === 'number' && typeof endedAt === 'number' && endedAt >= startedAt
        ? Math.max(0, endedAt - startedAt)
        : '—',
    model: sanitizeConsoleText(evidence.model ?? model, 1024),
    context: '—',
  };
}

export function windowTranscriptBlocks(
  blocks: readonly TranscriptBlock[],
  mountedCount = MAX_MOUNTED_BLOCKS,
): { visible: readonly TranscriptBlock[]; remaining: number } {
  const count = Math.max(0, Math.min(blocks.length, mountedCount));
  return {
    visible: blocks.slice(blocks.length - count),
    remaining: Math.max(0, blocks.length - count),
  };
}
