export const CONTEXT_SOURCE_KINDS = [
  'chat_message',
  'file',
  'file_version',
  'terminal',
  'agent_trace',
  'tool_call',
  'git',
  'task',
  'schedule',
  'skill',
  'agent',
  'artifact',
  'browser_import',
  'context_note',
  'other',
] as const;

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

export interface ContextRecord {
  id: string;
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  sourceKind: ContextSourceKind;
  sourceId: string;
  parentSourceId?: string;
  createdAt: number;
  updatedAt?: number;
  contentHash: string;
  contentRef: string;
  title?: string;
  path?: string;
  gitCommit?: string;
  trustLevel: string;
  sensitivity?: string;
  deletedAt?: number;
}

export interface ContextPointer {
  id: string;
  recordId: string;
  lineStart?: number;
  lineEnd?: number;
  byteStart?: number;
  byteEnd?: number;
  messageId?: string;
  eventId?: string;
  toolCallId?: string;
  sourceVersion: string;
  contentHash: string;
}

export type ContextPointerBounds =
  | Readonly<{ kind: 'bytes'; start: number; end: number }>
  | Readonly<{ kind: 'lines'; start: number; end: number }>;

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 4_096;

export class ContextContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ContextContractError';
  }
}

function contract(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ContextContractError(code);
}

function requiredText(value: unknown, code: string, maximum = MAX_TEXT_LENGTH): string {
  contract(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximum &&
      value.trim() === value &&
      !CONTROL.test(value),
    code,
  );
  return value;
}

function optionalText(value: unknown, code: string, maximum = MAX_TEXT_LENGTH): string | undefined {
  return value === undefined ? undefined : requiredText(value, code, maximum);
}

function timestamp(value: unknown, code: string): number {
  contract(Number.isSafeInteger(value) && (value as number) >= 0, code);
  return value as number;
}

function optionalTimestamp(value: unknown, code: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, code);
}

function contentHash(value: unknown): string {
  contract(typeof value === 'string' && SHA256.test(value), 'content_hash_invalid');
  return value;
}

export function createContextRecord(input: ContextRecord): Readonly<ContextRecord> {
  contract(CONTEXT_SOURCE_KINDS.includes(input.sourceKind), 'source_kind_invalid');
  const createdAt = timestamp(input.createdAt, 'created_at_invalid');
  const updatedAt = optionalTimestamp(input.updatedAt, 'updated_at_invalid');
  const deletedAt = optionalTimestamp(input.deletedAt, 'deleted_at_invalid');
  contract(updatedAt === undefined || updatedAt >= createdAt, 'updated_at_before_created_at');
  contract(
    deletedAt === undefined || deletedAt >= (updatedAt ?? createdAt),
    'deleted_at_before_current_version',
  );

  return Object.freeze({
    id: requiredText(input.id, 'record_id_invalid', MAX_ID_LENGTH),
    accountId: requiredText(input.accountId, 'account_id_invalid', MAX_ID_LENGTH),
    ...(optionalText(input.workspaceId, 'workspace_id_invalid', MAX_ID_LENGTH)
      ? { workspaceId: input.workspaceId }
      : {}),
    ...(optionalText(input.projectId, 'project_id_invalid', MAX_ID_LENGTH)
      ? { projectId: input.projectId }
      : {}),
    ...(optionalText(input.worktreeId, 'worktree_id_invalid', MAX_ID_LENGTH)
      ? { worktreeId: input.worktreeId }
      : {}),
    sourceKind: input.sourceKind,
    sourceId: requiredText(input.sourceId, 'source_id_invalid', MAX_ID_LENGTH),
    ...(optionalText(input.parentSourceId, 'parent_source_id_invalid', MAX_ID_LENGTH)
      ? { parentSourceId: input.parentSourceId }
      : {}),
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    contentHash: contentHash(input.contentHash),
    contentRef: requiredText(input.contentRef, 'content_ref_invalid'),
    ...(optionalText(input.title, 'title_invalid') ? { title: input.title } : {}),
    ...(optionalText(input.path, 'path_invalid') ? { path: input.path } : {}),
    ...(optionalText(input.gitCommit, 'git_commit_invalid', MAX_ID_LENGTH)
      ? { gitCommit: input.gitCommit }
      : {}),
    trustLevel: requiredText(input.trustLevel, 'trust_level_invalid', 128),
    ...(optionalText(input.sensitivity, 'sensitivity_invalid', 128)
      ? { sensitivity: input.sensitivity }
      : {}),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  });
}

function exactSpan(
  start: unknown,
  end: unknown,
  minimum: number,
  code: string,
): Readonly<{ start: number; end: number }> | undefined {
  if (start === undefined && end === undefined) return undefined;
  contract(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      (start as number) >= minimum &&
      (end as number) > (start as number),
    code,
  );
  return { start: start as number, end: end as number };
}

export function createContextPointer(input: ContextPointer): Readonly<ContextPointer> {
  const bytes = exactSpan(input.byteStart, input.byteEnd, 0, 'byte_span_invalid');
  const lines = exactSpan(input.lineStart, input.lineEnd, 1, 'line_span_invalid');
  contract(Boolean(bytes) !== Boolean(lines), 'pointer_span_ambiguous');

  return Object.freeze({
    id: requiredText(input.id, 'pointer_id_invalid', MAX_ID_LENGTH),
    recordId: requiredText(input.recordId, 'pointer_record_id_invalid', MAX_ID_LENGTH),
    ...(lines ? { lineStart: lines.start, lineEnd: lines.end } : {}),
    ...(bytes ? { byteStart: bytes.start, byteEnd: bytes.end } : {}),
    ...(optionalText(input.messageId, 'message_id_invalid', MAX_ID_LENGTH)
      ? { messageId: input.messageId }
      : {}),
    ...(optionalText(input.eventId, 'event_id_invalid', MAX_ID_LENGTH)
      ? { eventId: input.eventId }
      : {}),
    ...(optionalText(input.toolCallId, 'tool_call_id_invalid', MAX_ID_LENGTH)
      ? { toolCallId: input.toolCallId }
      : {}),
    sourceVersion: requiredText(input.sourceVersion, 'source_version_invalid', MAX_ID_LENGTH),
    contentHash: contentHash(input.contentHash),
  });
}

export function pointerBounds(pointer: ContextPointer): ContextPointerBounds {
  const bytes = exactSpan(pointer.byteStart, pointer.byteEnd, 0, 'byte_span_invalid');
  if (bytes) return Object.freeze({ kind: 'bytes', ...bytes });
  const lines = exactSpan(pointer.lineStart, pointer.lineEnd, 1, 'line_span_invalid');
  contract(lines, 'pointer_span_missing');
  return Object.freeze({ kind: 'lines', ...lines });
}
