import {
  createContextPointer,
  pointerBounds,
  type ContextPointer,
  type ContextRecord,
  type ContextSourceKind,
} from './losslessContext';

export interface ContextScope {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}

export interface ContextSearchHit {
  recordId: string;
  pointer: ContextPointer;
  preview: string;
  score: number;
}

export interface ContextSourceRead {
  bytes: Uint8Array;
  contentHash: string;
  sourceVersion: string;
}

export interface ContextQueryRepository {
  listRecords(scope: ContextScope, signal?: AbortSignal): Promise<readonly ContextRecord[]>;
  getRecord(recordId: string, signal?: AbortSignal): Promise<ContextRecord | undefined>;
  search(
    scope: ContextScope,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly ContextSearchHit[]>;
  readSource(record: ContextRecord, signal?: AbortSignal): Promise<ContextSourceRead | undefined>;
  canOpen(record: ContextRecord, scope: ContextScope, signal?: AbortSignal): Promise<boolean>;
  validatePointer?(
    pointer: ContextPointer,
    record: ContextRecord,
    source: ContextSourceRead,
    scope: ContextScope,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
  issuePointers?(
    items: readonly ContextSearchItem[],
    scope: ContextScope,
    signal?: AbortSignal,
  ): boolean;
  relatedRecordIds?(recordId: string, signal?: AbortSignal): Promise<readonly string[]>;
}

export interface ContextQueryLimits {
  maxSearchResults: number;
  maxPreviewCharacters: number;
  maxOpenBytes: number;
  maxRelatedResults: number;
}

export type ContextQueryErrorCode =
  | 'cancelled'
  | 'scope_denied'
  | 'permission_denied'
  | 'record_missing'
  | 'source_missing'
  | 'source_stale'
  | 'pointer_invalid'
  | 'continuation_invalid'
  | 'query_invalid';

export class ContextQueryError extends Error {
  constructor(
    readonly code: ContextQueryErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'ContextQueryError';
  }
}

interface SearchContinuation {
  kind: 'search';
  scope: ContextScope;
  query: string;
  hits: readonly ContextSearchHit[];
  offset: number;
}

interface OpenContinuation {
  kind: 'open';
  scope: ContextScope;
  pointer: ContextPointer;
  nextByte: number;
  requestedEnd: number;
}

type Continuation = SearchContinuation | OpenContinuation;

export interface ContextSearchItem {
  record: ContextRecord;
  pointer: ContextPointer;
  preview: string;
  score: number;
}

export interface ContextOpenResult {
  status: 'current';
  record: ContextRecord;
  pointer: ContextPointer;
  text: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  continuation?: string;
}

const DEFAULT_LIMITS: ContextQueryLimits = Object.freeze({
  maxSearchResults: 20,
  maxPreviewCharacters: 320,
  maxOpenBytes: 64 * 1024,
  maxRelatedResults: 20,
});

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ContextQueryError('cancelled');
}

function sameScope(left: ContextScope, right: ContextScope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId
  );
}

function inScope(record: ContextRecord, scope: ContextScope): boolean {
  if (record.accountId !== scope.accountId) return false;
  if (scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId) return false;
  if (scope.projectId !== undefined && record.projectId !== scope.projectId) return false;
  if (scope.worktreeId !== undefined && record.worktreeId !== scope.worktreeId) return false;
  return true;
}

function byteRangeForPointer(
  pointer: ContextPointer,
  bytes: Uint8Array,
): {
  start: number;
  end: number;
} {
  const bounds = pointerBounds(pointer);
  if (bounds.kind === 'bytes') {
    if (bounds.start >= bytes.length || bounds.end > bytes.length) {
      throw new ContextQueryError('pointer_invalid');
    }
    return { start: bounds.start, end: bounds.end };
  }
  const newlineOffsets = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) newlineOffsets.push(index + 1);
  }
  const start = newlineOffsets[bounds.start - 1] ?? bytes.length;
  const end = newlineOffsets[bounds.end - 1] ?? bytes.length;
  return { start, end: Math.max(start, end) };
}

function lineRangeForBytes(
  bytes: Uint8Array,
  byteStart: number,
  byteEnd: number,
): {
  start: number;
  end: number;
} {
  const start = Math.min(Math.max(0, byteStart), bytes.length);
  const end = Math.min(Math.max(start, byteEnd), bytes.length);
  let currentLine = 1;
  for (let index = 0; index < start; index += 1) {
    if (bytes[index] === 10) currentLine += 1;
  }
  const lineStart = currentLine;
  let lineEnd = currentLine;
  for (let index = start; index < end; index += 1) {
    lineEnd = currentLine;
    if (bytes[index] === 10) currentLine += 1;
  }
  return { start: lineStart, end: lineEnd };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new ContextQueryError('query_invalid');
  return Math.min(value, maximum);
}

export function createContextQueryService(dependencies: {
  repository: ContextQueryRepository;
  limits?: Partial<ContextQueryLimits>;
}) {
  const repository = dependencies.repository;
  const limits: ContextQueryLimits = Object.freeze({
    ...DEFAULT_LIMITS,
    ...dependencies.limits,
  });
  const continuations = new Map<string, Continuation>();
  let continuationSequence = 0;

  const saveContinuation = (value: Continuation): string => {
    continuationSequence += 1;
    const random =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replaceAll('-', '')
        : String(continuationSequence);
    const handle = `ctxc_${random}`;
    continuations.set(handle, value);
    return handle;
  };

  const takeContinuation = <Kind extends Continuation['kind']>(
    handle: string | undefined,
    kind: Kind,
  ): Extract<Continuation, { kind: Kind }> | undefined => {
    if (!handle) return undefined;
    const value = continuations.get(handle);
    continuations.delete(handle);
    if (!value || value.kind !== kind) throw new ContextQueryError('continuation_invalid');
    return value as Extract<Continuation, { kind: Kind }>;
  };

  const scopedRecords = async (scope: ContextScope, signal?: AbortSignal) => {
    abortIfNeeded(signal);
    const records = await repository.listRecords(scope, signal);
    abortIfNeeded(signal);
    return records.filter((record) => inScope(record, scope) && record.deletedAt === undefined);
  };

  const resolveRecord = async (
    recordId: string,
    scope: ContextScope,
    signal?: AbortSignal,
  ): Promise<ContextRecord> => {
    abortIfNeeded(signal);
    let record = await repository.getRecord(recordId, signal);
    if (!record) {
      // Context-map repositories rebuild their authority cache from persisted,
      // scope-filtered metadata. Rehydrate before declaring a durable pointer
      // missing (for example after an app restart).
      await repository.listRecords(scope, signal);
      abortIfNeeded(signal);
      record = await repository.getRecord(recordId, signal);
    }
    abortIfNeeded(signal);
    if (!record) throw new ContextQueryError('record_missing');
    if (!inScope(record, scope) || record.deletedAt !== undefined) {
      throw new ContextQueryError('scope_denied');
    }
    return record;
  };

  const readAuthority = async (
    pointer: ContextPointer,
    scope: ContextScope,
    signal?: AbortSignal,
    validatePointer = true,
  ) => {
    const record = await resolveRecord(pointer.recordId, scope, signal);
    if (!(await repository.canOpen(record, scope, signal))) {
      throw new ContextQueryError('permission_denied');
    }
    abortIfNeeded(signal);
    const source = await repository.readSource(record, signal);
    abortIfNeeded(signal);
    if (!source) throw new ContextQueryError('source_missing');
    if (
      record.contentHash !== pointer.contentHash ||
      source.contentHash !== pointer.contentHash ||
      source.sourceVersion !== pointer.sourceVersion
    ) {
      throw new ContextQueryError('source_stale');
    }
    if (validatePointer && repository.validatePointer) {
      const valid = await repository.validatePointer(pointer, record, source, scope, signal);
      abortIfNeeded(signal);
      if (!valid) throw new ContextQueryError('pointer_invalid');
    }
    abortIfNeeded(signal);
    return { record, source };
  };

  const describe = async (input: { scope: ContextScope; signal?: AbortSignal }) => {
    const records = await scopedRecords(input.scope, input.signal);
    const sourceKinds = [...new Set(records.map((record) => record.sourceKind))].sort() as
      | ContextSourceKind[]
      | [];
    return {
      scope: input.scope,
      recordCount: records.length,
      sourceKinds,
      indexAvailable: true,
      stale: false,
    };
  };

  const search = async (input: {
    scope: ContextScope;
    query: string;
    limit?: number;
    continuation?: string;
    signal?: AbortSignal;
  }) => {
    abortIfNeeded(input.signal);
    const continued = takeContinuation(input.continuation, 'search');
    if (
      continued &&
      (!sameScope(continued.scope, input.scope) || continued.query !== input.query)
    ) {
      throw new ContextQueryError('continuation_invalid');
    }
    if (!input.query.trim()) throw new ContextQueryError('query_invalid');
    const hits =
      continued?.hits ?? (await repository.search(input.scope, input.query, input.signal));
    abortIfNeeded(input.signal);
    const offset = continued?.offset ?? 0;
    const pageSize = boundedInteger(input.limit, limits.maxSearchResults, limits.maxSearchResults);
    const permitted = hits.filter((hit) => {
      const record = undefined;
      return hit.pointer.recordId === hit.recordId && record === undefined;
    });
    const items: ContextSearchItem[] = [];
    let cursor = offset;
    while (cursor < permitted.length && items.length < pageSize) {
      const hit = permitted[cursor];
      cursor += 1;
      const record = await repository.getRecord(hit.recordId, input.signal);
      abortIfNeeded(input.signal);
      if (!record || !inScope(record, input.scope) || record.deletedAt !== undefined) continue;
      items.push({
        record,
        pointer: hit.pointer,
        preview:
          hit.preview.length <= limits.maxPreviewCharacters
            ? hit.preview
            : hit.preview.slice(0, limits.maxPreviewCharacters),
        score: hit.score,
      });
    }
    const hasMore = cursor < permitted.length;
    abortIfNeeded(input.signal);
    if (
      items.length > 0 &&
      repository.issuePointers &&
      !repository.issuePointers(items, input.scope, input.signal)
    ) {
      throw new ContextQueryError('pointer_invalid');
    }
    return {
      items,
      truncated: hasMore,
      ...(hasMore
        ? {
            continuation: saveContinuation({
              kind: 'search',
              scope: input.scope,
              query: input.query,
              hits,
              offset: cursor,
            }),
          }
        : {}),
      indexAvailable: true,
      stale: false,
    };
  };

  const openResolved = async (
    input: {
      scope: ContextScope;
      pointer: ContextPointer;
      continuation?: string;
      maxBytes?: number;
      signal?: AbortSignal;
    },
    validatePointer: boolean,
  ): Promise<ContextOpenResult> => {
    abortIfNeeded(input.signal);
    const continued = takeContinuation(input.continuation, 'open');
    if (
      continued &&
      (!sameScope(continued.scope, input.scope) || continued.pointer.id !== input.pointer.id)
    ) {
      throw new ContextQueryError('continuation_invalid');
    }
    const pointer = continued?.pointer ?? input.pointer;
    const { record, source } = await readAuthority(
      pointer,
      input.scope,
      input.signal,
      validatePointer,
    );
    const requested = byteRangeForPointer(pointer, source.bytes);
    const start = continued?.nextByte ?? requested.start;
    const requestedEnd = continued?.requestedEnd ?? requested.end;
    const byteBudget = boundedInteger(input.maxBytes, limits.maxOpenBytes, limits.maxOpenBytes);
    const end = Math.min(requestedEnd, start + byteBudget);
    const truncated = end < requestedEnd;
    const lines = lineRangeForBytes(source.bytes, start, end);
    const exactPointer = createContextPointer({
      ...pointer,
      byteStart: start,
      byteEnd: Math.max(start + 1, end),
      lineStart: undefined,
      lineEnd: undefined,
    });
    return {
      status: 'current',
      record,
      pointer: exactPointer,
      text: new TextDecoder().decode(source.bytes.slice(start, end)),
      byteStart: start,
      byteEnd: end,
      lineStart: lines.start,
      lineEnd: lines.end,
      truncated,
      ...(truncated
        ? {
            continuation: saveContinuation({
              kind: 'open',
              scope: input.scope,
              pointer,
              nextByte: end,
              requestedEnd,
            }),
          }
        : {}),
    };
  };

  const open = async (input: {
    scope: ContextScope;
    pointer: ContextPointer;
    continuation?: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<ContextOpenResult> => openResolved(input, true);

  const expand = async (input: {
    scope: ContextScope;
    pointer: ContextPointer;
    beforeBytes?: number;
    afterBytes?: number;
    signal?: AbortSignal;
  }): Promise<ContextOpenResult> => {
    const { source } = await readAuthority(input.pointer, input.scope, input.signal);
    const range = byteRangeForPointer(input.pointer, source.bytes);
    const before = Math.max(0, Math.floor(input.beforeBytes ?? 0));
    const after = Math.max(0, Math.floor(input.afterBytes ?? 0));
    const expanded = createContextPointer({
      ...input.pointer,
      id: `${input.pointer.id}:expand:${before}:${after}`,
      lineStart: undefined,
      lineEnd: undefined,
      byteStart: Math.max(0, range.start - before),
      byteEnd: Math.min(source.bytes.length, range.end + after),
    });
    return openResolved({ scope: input.scope, pointer: expanded, signal: input.signal }, false);
  };

  const sources = async (input: { scope: ContextScope; limit?: number; signal?: AbortSignal }) => {
    const records = await scopedRecords(input.scope, input.signal);
    return {
      items: records.slice(
        0,
        boundedInteger(input.limit, limits.maxSearchResults, limits.maxSearchResults),
      ),
      truncated: records.length > limits.maxSearchResults,
    };
  };

  const timeline = async (input: { scope: ContextScope; limit?: number; signal?: AbortSignal }) => {
    const result = await sources(input);
    return {
      ...result,
      items: [...result.items].sort(
        (left, right) => (left.updatedAt ?? left.createdAt) - (right.updatedAt ?? right.createdAt),
      ),
    };
  };

  const related = async (input: {
    scope: ContextScope;
    recordId: string;
    limit?: number;
    signal?: AbortSignal;
  }) => {
    await resolveRecord(input.recordId, input.scope, input.signal);
    const ids = repository.relatedRecordIds
      ? await repository.relatedRecordIds(input.recordId, input.signal)
      : [];
    const maximum = boundedInteger(input.limit, limits.maxRelatedResults, limits.maxRelatedResults);
    const items: ContextRecord[] = [];
    for (const id of ids) {
      if (items.length >= maximum) break;
      const candidate = await repository.getRecord(id, input.signal);
      if (candidate && candidate.id !== input.recordId && inScope(candidate, input.scope)) {
        items.push(candidate);
      }
    }
    return { items, truncated: ids.length > items.length };
  };

  const checkpoint = async (input: { scope: ContextScope; signal?: AbortSignal }) => {
    const records = await scopedRecords(input.scope, input.signal);
    return {
      scope: input.scope,
      createdAt: Date.now(),
      recordCount: records.length,
      recordIds: records.map((record) => record.id),
      contentHashes: records.map((record) => record.contentHash),
    };
  };

  const investigate = async (input: {
    scope: ContextScope;
    query: string;
    signal?: AbortSignal;
  }) => {
    const found = await search({
      scope: input.scope,
      query: input.query,
      limit: limits.maxSearchResults,
      signal: input.signal,
    });
    const evidence: ContextOpenResult[] = [];
    for (const item of found.items) {
      abortIfNeeded(input.signal);
      try {
        evidence.push(
          await open({
            scope: input.scope,
            pointer: item.pointer,
            signal: input.signal,
          }),
        );
      } catch (error) {
        if (
          error instanceof ContextQueryError &&
          ['permission_denied', 'source_missing', 'source_stale'].includes(error.code)
        ) {
          continue;
        }
        throw error;
      }
    }
    return { query: input.query, evidence, truncated: found.truncated };
  };

  return Object.freeze({
    describe,
    search,
    open,
    expand,
    related,
    timeline,
    sources,
    checkpoint,
    investigate,
  });
}

export type ContextQueryService = ReturnType<typeof createContextQueryService>;
