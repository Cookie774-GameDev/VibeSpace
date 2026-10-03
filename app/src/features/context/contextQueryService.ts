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
  /** Bounded, scope-filtered source inventory for large persisted maps. */
  listRecordsPage?(scope: ContextScope, limit: number, signal?: AbortSignal): Promise<{
    items: readonly ContextRecord[];
    truncated: boolean;
  }>;
  /** Rebuild only the authority that could own a missing durable record ID. */
  rehydrateMissingRecord?(recordId: string, scope: ContextScope, signal?: AbortSignal): Promise<void>;
  /** Scoped inventory metadata; search/open still validate exact source authority. */
  describeSummary?(scope: ContextScope, signal?: AbortSignal): Promise<{
    recordCount: number;
    sourceKinds: readonly ContextSourceKind[];
  }>;
  getRecord(recordId: string, signal?: AbortSignal): Promise<ContextRecord | undefined>;
  search(
    scope: ContextScope,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly ContextSearchHit[]>;
  readSource(record: ContextRecord, signal?: AbortSignal): Promise<ContextSourceRead | undefined>;
  canOpen(record: ContextRecord, scope: ContextScope, signal?: AbortSignal): Promise<boolean>;
  /** Check an issued pointer capability without reading source bytes. */
  authorizePointer?(
    pointer: ContextPointer,
    record: ContextRecord,
    scope: ContextScope,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
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
  authorityPointer: ContextPointer;
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

function isUtf8Continuation(bytes: Uint8Array, offset: number): boolean {
  return offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80;
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
    if (
      bounds.start >= bytes.length || bounds.end > bytes.length ||
      isUtf8Continuation(bytes, bounds.start) || isUtf8Continuation(bytes, bounds.end)
    ) {
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
      if (repository.rehydrateMissingRecord) {
        await repository.rehydrateMissingRecord(recordId, scope, signal);
      } else {
        await repository.listRecords(scope, signal);
      }
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
    // Mapped-file pointers encode their record and byte span. Reject a
    // mismatched tuple before a missing record can trigger a full map rebuild.
    // Other repositories own different pointer formats and retain their
    // existing authority checks below.
    if (validatePointer && /^rlm:[a-f0-9]{64}$/i.test(pointer.recordId) &&
        (!Number.isSafeInteger(pointer.byteStart) ||
          !Number.isSafeInteger(pointer.byteEnd) ||
          pointer.id !== `ptr:${pointer.recordId}:${pointer.byteStart}:${pointer.byteEnd}`)) {
      throw new ContextQueryError('pointer_invalid');
    }
    const record = await resolveRecord(pointer.recordId, scope, signal);
    if (validatePointer && repository.authorizePointer) {
      const authorized = await repository.authorizePointer(pointer, record, scope, signal);
      abortIfNeeded(signal);
      if (!authorized) throw new ContextQueryError('pointer_invalid');
    }
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
    abortIfNeeded(input.signal);
    const summary = repository.describeSummary
      ? await repository.describeSummary(input.scope, input.signal)
      : undefined;
    const records = summary ? undefined : await scopedRecords(input.scope, input.signal);
    abortIfNeeded(input.signal);
    const sourceKinds = [...new Set(summary?.sourceKinds ?? records?.map((record) => record.sourceKind) ?? [])].sort() as
      | ContextSourceKind[]
      | [];
    return {
      scope: input.scope,
      recordCount: summary?.recordCount ?? records?.length ?? 0,
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
    authorityPointer?: ContextPointer,
  ): Promise<ContextOpenResult> => {
    abortIfNeeded(input.signal);
    const continued = takeContinuation(input.continuation, 'open');
    if (
      continued &&
      (!sameScope(continued.scope, input.scope) || continued.pointer.id !== input.pointer.id)
    ) {
      throw new ContextQueryError('continuation_invalid');
    }
    const pointer = continued?.pointer ?? Object.freeze({ ...input.pointer });
    const originalPointer = continued?.authorityPointer ?? authorityPointer ?? pointer;
    const { record, source } = await readAuthority(
      continued ? originalPointer : pointer,
      input.scope,
      input.signal,
      continued ? true : validatePointer,
    );
    const requested = byteRangeForPointer(pointer, source.bytes);
    const start = continued?.nextByte ?? requested.start;
    const requestedEnd = continued?.requestedEnd ?? requested.end;
    const byteBudget = boundedInteger(input.maxBytes, limits.maxOpenBytes, limits.maxOpenBytes);
    let end = Math.min(requestedEnd, start + byteBudget);
    // Never widen an issued byte span or exceed the caller's byte budget.
    // Leave a partial final character for the next page, not a replacement glyph.
    while (end > start && isUtf8Continuation(source.bytes, end)) end -= 1;
    if (end <= start) throw new ContextQueryError('query_invalid');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        source.bytes.subarray(start, end),
      );
    } catch {
      throw new ContextQueryError('pointer_invalid');
    }
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
      text,
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
              // Expanded pointers are derived spans, not new independent grants.
              // Revalidate the original issued authority on every continued page.
              authorityPointer: Object.freeze({ ...originalPointer }),
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
    const authorityPointer = Object.freeze({ ...input.pointer });
    const { source } = await readAuthority(authorityPointer, input.scope, input.signal);
    const range = byteRangeForPointer(authorityPointer, source.bytes);
    const before = Math.max(0, Math.floor(input.beforeBytes ?? 0));
    const after = Math.max(0, Math.floor(input.afterBytes ?? 0));
    let expandedStart = Math.max(0, range.start - before);
    let expandedEnd = Math.min(source.bytes.length, range.end + after);
    // Trim partial neighbors inward; the original valid span remains included.
    while (expandedStart < range.start && isUtf8Continuation(source.bytes, expandedStart)) expandedStart += 1;
    while (expandedEnd > range.end && isUtf8Continuation(source.bytes, expandedEnd)) expandedEnd -= 1;
    const expanded = createContextPointer({
      ...authorityPointer,
      id: `${authorityPointer.id}:expand:${before}:${after}`,
      lineStart: undefined,
      lineEnd: undefined,
      byteStart: expandedStart,
      byteEnd: expandedEnd,
    });
    return openResolved(
      { scope: input.scope, pointer: expanded, signal: input.signal },
      false,
      authorityPointer,
    );
  };

  const sources = async (input: { scope: ContextScope; limit?: number; signal?: AbortSignal }) => {
    const maximum = boundedInteger(input.limit, limits.maxSearchResults, limits.maxSearchResults);
    const page = repository.listRecordsPage
      ? await repository.listRecordsPage(input.scope, maximum, input.signal)
      : undefined;
    abortIfNeeded(input.signal);
    const records = page
      ? page.items.filter((record) => inScope(record, input.scope) && record.deletedAt === undefined)
      : await scopedRecords(input.scope, input.signal);
    return {
      items: records.slice(0, maximum),
      truncated: Boolean(page?.truncated || records.length > maximum),
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
    const page = repository.listRecordsPage
      ? await repository.listRecordsPage(input.scope, limits.maxSearchResults, input.signal)
      : undefined;
    abortIfNeeded(input.signal);
    const records = page
      ? page.items.filter((record) => inScope(record, input.scope) && record.deletedAt === undefined)
      : await scopedRecords(input.scope, input.signal);
    const summary = page && repository.describeSummary
      ? await repository.describeSummary(input.scope, input.signal)
      : undefined;
    abortIfNeeded(input.signal);
    return {
      scope: input.scope,
      createdAt: Date.now(),
      recordCount: records.length,
      recordIds: records.map((record) => record.id),
      contentHashes: records.map((record) => record.contentHash),
      truncated: Boolean(page?.truncated || (summary && summary.recordCount > records.length)),
      ...(page ? { complete: false } : {}),
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
    return {
      query: input.query,
      evidence,
      // Successful retrieval does not imply complete evidence coverage. Missing,
      // stale, forbidden, or byte-capped spans must stay visible to the caller.
      truncated:
        found.truncated ||
        evidence.length < found.items.length ||
        evidence.some((item) => item.truncated),
    };
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
