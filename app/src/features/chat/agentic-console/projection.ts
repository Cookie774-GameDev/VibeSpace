import type { Message, Part } from '@/types';
import { applySecretPolicy } from '@/lib/security/secretDetector';
import type { ChatActivityEvent, ChatActivityKind, ChatActivityStatus } from '../activity/types';

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
    if (part.kind === 'reasoning' && part.text.trim()) {
      blocks.push({
        ...base,
        id: `${sourceId}:reasoning:${index}`,
        kind: 'reasoning',
        text: sanitizeConsoleText(part.text),
      });
      return;
    }
    if (part.kind === 'tool_call') {
      const result = results.get(part.call_id);
      if (result) pairedResults.add(part.call_id);
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
  if (event.diff?.trim()) {
    return {
      id: `${sourceId}:diff`,
      sourceId,
      ts: event.ts,
      kind: 'diff',
      status: event.status,
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
    title: sanitizeConsoleText(event.title, 4096),
    detail: event.detail ? sanitizeConsoleText(event.detail, 128 * 1024) : event.subtitle,
    filePath: event.filePath ? sanitizeConsoleText(event.filePath, 4096) : undefined,
    url: event.url ? sanitizeConsoleText(event.url, 8192) : undefined,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
  };
}

export function projectAgenticTranscript(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  options: { preserveAssistantMessages?: boolean } = {},
): TranscriptBlock[] {
  const seenActivity = new Set<string>();
  const activityBlocks = activity.flatMap((event) => {
    if (seenActivity.has(event.id)) return [];
    seenActivity.add(event.id);
    return [projectActivity(event)];
  });
  return [
    ...messages.flatMap((message) =>
      projectMessage(message, options.preserveAssistantMessages === true),
    ),
    ...activityBlocks,
  ].sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}

export function summarizeAgenticSession(
  messages: readonly Message[],
  activity: readonly ChatActivityEvent[],
  evidence: AgenticSessionEvidence = {},
): AgenticSessionSummary {
  const uniqueFiles = new Set(activity.map((event) => event.filePath).filter(Boolean));
  const started = [
    ...messages.map((message) => message.created_at),
    ...activity.map((event) => event.startedAt ?? event.ts),
  ].filter(Number.isFinite);
  const ended = activity
    .map((event) => event.endedAt)
    .filter((value): value is number => value != null);
  const running = activity.find(
    (event) => event.status === 'running' || event.status === 'pending',
  );
  const hasError = activity.some((event) => event.status === 'error');
  const hasBlocked = activity.some((event) =>
    /blocked|approval|permission/i.test(`${event.status} ${event.title}`),
  );
  const latestActivity = [...activity].sort(
    (left, right) => (right.endedAt ?? right.ts) - (left.endedAt ?? left.ts),
  )[0];
  const hasAssistantAnswer = messages.some(
    (message) => message.role === 'assistant' && textParts(message).length > 0,
  );
  const hasCompletedActivity = activity.some((event) => event.status === 'done');
  const tokenValues = messages.flatMap((message) => {
    const usage = message.usage;
    return usage ? [(usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)] : [];
  });
  const model =
    [...messages]
      .reverse()
      .map((message) => message.usage?.model)
      .find((value): value is string => Boolean(value)) ?? '—';
  const startedAt =
    typeof evidence.startedAt === 'number'
      ? evidence.startedAt
      : started.length
        ? Math.min(...started)
        : '—';
  const endedAt =
    typeof evidence.endedAt === 'number'
      ? evidence.endedAt
      : ended.length
        ? Math.max(...ended)
        : '—';
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
  const inferredStatus: AgenticSessionSummary['status'] = running
    ? 'running'
    : hasError
      ? 'error'
      : hasBlocked
        ? 'blocked'
        : latestActivity?.status === 'cancelled'
          ? 'cancelled'
          : hasCompletedActivity || hasAssistantAnswer
            ? 'done'
            : 'idle';
  const status = mappedStatus ?? inferredStatus;
  return {
    status,
    currentOperation:
      (evidence.currentOperation
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
                ? 'Recovering'
                : status === 'planning'
                  ? 'Planning'
                  : status === 'queued'
                    ? 'Queued'
                    : status === 'partial'
                      ? 'Partially complete'
                      : 'Ready'),
    fileCount: uniqueFiles.size,
    addedLines: activity.reduce((total, event) => total + (event.addedLines ?? 0), 0),
    removedLines: activity.reduce((total, event) => total + (event.removedLines ?? 0), 0),
    tokenCount: tokenValues.length ? tokenValues.reduce((total, value) => total + value, 0) : '—',
    startedAt,
    endedAt,
    durationMs:
      typeof startedAt === 'number' && typeof endedAt === 'number'
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
