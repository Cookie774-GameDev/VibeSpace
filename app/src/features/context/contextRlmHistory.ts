import { db, openDb } from '@/lib/db';
import { classifyJarvisSource } from '@/lib/jarvis/sourcePolicy';
import type { Part } from '@/types/chat';
import {
  type ContextQueryRepository,
  type ContextScope,
  type ContextSearchHit,
} from './contextQueryService';
import {
  createContextPointer,
  createContextRecord,
  type ContextRecord,
  type ContextSourceKind,
} from './losslessContext';

const MAX_HISTORY_RECORDS = 500;
const MAX_HISTORY_BYTES = 64 * 1024;
const MAX_HISTORY_CHATS = 50;
const MAX_HISTORY_RUNS = 100;
const MAX_EVENTS_PER_RUN = 5;

export interface RlmHistoryEvidence {
  id: string;
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  sourceKind: Extract<ContextSourceKind, 'chat_message' | 'agent_trace'>;
  sourceId: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
}

interface HistoryAuthority {
  record: ContextRecord;
  content: string;
  bytes: Uint8Array;
}

function inScope(evidence: RlmHistoryEvidence, scope: ContextScope): boolean {
  return (
    evidence.accountId === scope.accountId &&
    (scope.workspaceId === undefined || evidence.workspaceId === scope.workspaceId) &&
    (scope.projectId === undefined || evidence.projectId === scope.projectId)
  );
}

function recordInScope(record: ContextRecord, scope: ContextScope): boolean {
  return (
    record.accountId === scope.accountId &&
    (scope.workspaceId === undefined || record.workspaceId === scope.workspaceId) &&
    (scope.projectId === undefined || record.projectId === scope.projectId) &&
    (scope.worktreeId === undefined || record.worktreeId === scope.worktreeId)
  );
}

function normalizedQuery(query: string): string {
  return (query.startsWith('"') && query.endsWith('"') ? query.slice(1, -1) : query)
    .trim()
    .toLocaleLowerCase('en-US');
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
}

function sourceMatchRange(content: string, needle: string): { start: number; end: number } | undefined {
  const folded = content.toLocaleLowerCase('en-US');
  const start = folded.indexOf(needle);
  if (start < 0) return undefined;
  const end = start + needle.length;
  if (folded.length === content.length) return { start, end };

  // Lowercasing can expand a source character (for example, İ -> i + dot).
  // Keep matching semantics, but translate offsets back to the original text.
  let sourceOffset = 0;
  let foldedOffset = 0;
  let sourceStart: number | undefined;
  for (const character of content) {
    const nextFoldedOffset = foldedOffset + character.toLocaleLowerCase('en-US').length;
    if (sourceStart === undefined && start < nextFoldedOffset) sourceStart = sourceOffset;
    sourceOffset += character.length;
    if (end <= nextFoldedOffset) return { start: sourceStart ?? 0, end: sourceOffset };
    foldedOffset = nextFoldedOffset;
  }
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.max(0, Math.floor(maxBytes)); end >= 0; end -= 1) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch {
      // Back up over the final UTF-8 code point when the byte cap splits it.
    }
  }
  return '';
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createHistoryRlmRepository(dependencies: {
  load(scope: ContextScope, signal?: AbortSignal): Promise<readonly RlmHistoryEvidence[]>;
}): ContextQueryRepository {
  const authorities = new Map<string, HistoryAuthority>();

  const load = async (scope: ContextScope, signal?: AbortSignal) => {
    abortIfNeeded(signal);
    const evidence = await dependencies.load(scope, signal);
    abortIfNeeded(signal);
    const loaded: HistoryAuthority[] = [];
    const scopeBinding = scope.worktreeId
      ? await sha256(
          new TextEncoder().encode(
            JSON.stringify([
              scope.accountId,
              scope.workspaceId ?? null,
              scope.projectId ?? null,
              scope.worktreeId,
            ]),
          ),
        )
      : '';
    abortIfNeeded(signal);
    for (const item of evidence.slice(0, MAX_HISTORY_RECORDS)) {
      abortIfNeeded(signal);
      if (!inScope(item, scope)) continue;
      const content = truncateUtf8(item.content, MAX_HISTORY_BYTES);
      if (!content.trim()) continue;
      const path = `vibespace://${item.sourceKind}/${encodeURIComponent(item.sourceId)}`;
      const policy = classifyJarvisSource({
        path,
        channel: 'automatic_scan',
        kind: 'text',
        contentSample: content,
      });
      if (!policy.allowed) continue;
      const bytes = new TextEncoder().encode(content);
      const contentHash = await sha256(bytes);
      abortIfNeeded(signal);
      let record: Readonly<ContextRecord>;
      try {
        record = createContextRecord({
          id: `rlm:history:${item.sourceKind}:${item.id}:${
            scopeBinding ? `${scopeBinding.slice(0, 16)}:` : ''
          }${contentHash.slice(0, 16)}`,
          accountId: item.accountId,
          ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
          ...(item.projectId ? { projectId: item.projectId } : {}),
          ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
          sourceKind: item.sourceKind,
          sourceId: item.sourceId,
          createdAt: item.createdAt,
          ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
          contentHash,
          contentRef: path,
          title: item.title,
          trustLevel: 'app_verified',
          sensitivity: 'private',
        });
      } catch {
        continue;
      }
      const authority = { record, content, bytes };
      // Publish the completed batch below, only after its final cancellation check.
      loaded.push(authority);
    }
    abortIfNeeded(signal);
    for (const authority of loaded) authorities.set(authority.record.id, authority);
    return loaded;
  };

  return {
    async listRecords(scope, signal) {
      return (await load(scope, signal)).map((authority) => authority.record);
    },
    async getRecord(recordId) {
      return authorities.get(recordId)?.record;
    },
    async search(scope, query, signal) {
      const needle = normalizedQuery(query);
      if (!needle) return [];
      const hits: ContextSearchHit[] = [];
      for (const authority of await load(scope, signal)) {
        const match = sourceMatchRange(authority.content, needle);
        if (!match) continue;
        let end = Math.min(authority.content.length, match.end + 512);
        if (
          end < authority.content.length &&
          /[\uD800-\uDBFF]/u.test(authority.content[end - 1] ?? '') &&
          /[\uDC00-\uDFFF]/u.test(authority.content[end] ?? '')
        ) end -= 1;
        const selected = authority.content.slice(match.start, end);
        const byteStart = new TextEncoder().encode(authority.content.slice(0, match.start)).length;
        const byteEnd = byteStart + new TextEncoder().encode(selected).length;
        hits.push({
          recordId: authority.record.id,
          pointer: createContextPointer({
            id: `ptr:${authority.record.id}:${byteStart}:${byteEnd}`,
            recordId: authority.record.id,
            byteStart,
            byteEnd,
            sourceVersion: `sha256:${authority.record.contentHash}`,
            contentHash: authority.record.contentHash,
          }),
          preview: selected.slice(0, 320),
          score: 1,
        });
      }
      return hits;
    },
    async readSource(record) {
      const authority = authorities.get(record.id);
      if (!authority) return undefined;
      return {
        bytes: authority.bytes,
        contentHash: record.contentHash,
        sourceVersion: `sha256:${record.contentHash}`,
      };
    },
    async canOpen(record, scope) {
      const authority = authorities.get(record.id);
      return Boolean(authority && recordInScope(authority.record, scope));
    },
  };
}

function messageText(parts: readonly Part[]): string {
  return parts
    .flatMap((part) => {
      if (part.kind === 'text' || part.kind === 'reasoning') return [part.text];
      if (part.kind === 'tool_result' && part.error) return [`Tool error: ${part.error}`];
      return [];
    })
    .join('\n');
}

export async function loadProductionRlmHistory(
  scope: ContextScope,
  signal?: AbortSignal,
): Promise<readonly RlmHistoryEvidence[]> {
  await openDb();
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const workspaces = (await db.workspaces.toArray()).filter(
    (workspace) =>
      workspace.owner_id === scope.accountId &&
      (scope.workspaceId === undefined || (workspace.id as string) === scope.workspaceId),
  );
  const workspaceIds = new Set(workspaces.map((workspace) => workspace!.id as string));
  if (workspaceIds.size === 0) return [];

  const chats = (await db.chats.toArray())
    .filter(
      (chat) =>
        workspaceIds.has(chat.workspace_id as string) &&
        (scope.projectId === undefined || (chat.project_id as string | undefined) === scope.projectId),
    )
    .sort((left, right) => right.updated_at - left.updated_at)
    .slice(0, MAX_HISTORY_CHATS);
  const chatById = new Map(chats.map((chat) => [chat.id as string, chat]));
  const chatIds = [...chatById.keys()];
  const messages =
    chatIds.length === 0
      ? []
      : (await db.messages.where('chat_id').anyOf(chatIds).toArray())
          .sort((left, right) => right.updated_at - left.updated_at)
          .slice(0, MAX_HISTORY_RECORDS);
  const chatEvidence: RlmHistoryEvidence[] = messages.map((message) => {
    const chat = chatById.get(message.chat_id as string)!;
    return {
      id: message.id as string,
      accountId: scope.accountId,
      workspaceId: chat.workspace_id as string,
      ...(chat.project_id ? { projectId: chat.project_id as string } : {}),
      sourceKind: 'chat_message',
      sourceId: message.id as string,
      title: chat.title,
      content: messageText(message.parts),
      createdAt: message.created_at,
      updatedAt: message.updated_at,
    };
  });

  const runs = (await db.jarvis_runs.where('account_id').equals(scope.accountId).toArray())
    .filter(
      (run) =>
        (scope.workspaceId === undefined || run.workspace_id === scope.workspaceId) &&
        (scope.projectId === undefined || run.project_id === scope.projectId),
    )
    .sort((left, right) => right.updated_at - left.updated_at)
    .slice(0, MAX_HISTORY_RUNS);
  const events = (
    await Promise.all(
      runs.map(async (run) => ({
        run,
        events: await db.jarvis_events
          .where('run_id')
          .equals(run.id)
          .reverse()
          .limit(MAX_EVENTS_PER_RUN)
          .toArray(),
      })),
    )
  )
    .flatMap(({ run, events: runEvents }) =>
      runEvents.map(
        (event): RlmHistoryEvidence => ({
          id: `${event.run_id}:${event.seq}`,
          accountId: scope.accountId,
          ...(run.workspace_id ? { workspaceId: run.workspace_id } : {}),
          ...(run.project_id ? { projectId: run.project_id } : {}),
          sourceKind: 'agent_trace',
          sourceId: `${event.run_id}:${event.seq}`,
          title: event.title,
          content: [event.title, event.safe_summary].filter(Boolean).join('\n'),
          createdAt: event.created_at,
        }),
      ),
    )
    .slice(0, MAX_HISTORY_RECORDS);
  return [...chatEvidence, ...events].slice(0, MAX_HISTORY_RECORDS);
}

export function createFederatedRlmRepository(
  repositories: readonly ContextQueryRepository[],
): ContextQueryRepository {
  return {
    async listRecords(scope, signal) {
      return (await Promise.all(repositories.map((repository) => repository.listRecords(scope, signal)))).flat();
    },
    async getRecord(recordId, signal) {
      for (const repository of repositories) {
        const record = await repository.getRecord(recordId, signal);
        if (record) return record;
      }
      return undefined;
    },
    async search(scope, query, signal) {
      return (await Promise.all(repositories.map((repository) => repository.search(scope, query, signal))))
        .flat()
        .sort((left, right) => right.score - left.score);
    },
    async readSource(record, signal) {
      for (const repository of repositories) {
        const source = await repository.readSource(record, signal);
        if (source) return source;
      }
      return undefined;
    },
    async canOpen(record, scope, signal) {
      for (const repository of repositories) {
        if (await repository.canOpen(record, scope, signal)) return true;
      }
      return false;
    },
    async relatedRecordIds(recordId, signal) {
      return (
        await Promise.all(
          repositories.map((repository) => repository.relatedRecordIds?.(recordId, signal) ?? []),
        )
      ).flat();
    },
  };
}
