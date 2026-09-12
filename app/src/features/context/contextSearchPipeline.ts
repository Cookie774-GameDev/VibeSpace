import { CONTEXT_SOURCE_KINDS, type ContextSourceKind } from './contracts';
import { rankContextHybrid } from './semanticSearch';

export type ContextProgressiveSearchStage = 'quick' | 'full_text' | 'semantic';

export interface ContextProgressiveSearchResult {
  documentId: string;
  title: string;
  path: string;
  sourceType: ContextSourceKind;
  excerpt: string;
  matchReason: string;
  updatedAt: number;
  score: number;
}

export interface ContextProgressiveSearchUpdate {
  stage: ContextProgressiveSearchStage;
  complete: boolean;
  results: readonly Readonly<ContextProgressiveSearchResult>[];
}

export interface ContextLexicalSearchRequest {
  accountId: string;
  mapId: string;
  mode: 'quick' | 'full_text';
  query: string;
  limit: number;
}

export type ContextLexicalSearchExecutor = (
  request: Readonly<ContextLexicalSearchRequest>,
  signal?: AbortSignal,
) => Promise<unknown>;

export type ContextSemanticSearchExecutor = (
  request: Readonly<{
    accountId: string;
    mapId: string;
    query: string;
    limit: number;
  }>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface ContextSearchDocumentInput {
  documentId: string;
  sourceId: string;
  title: string;
  path: string;
  sourceType: string;
  body: string;
  tags: readonly string[];
  properties: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
  updatedAt: number;
  contentHash: string;
}

export interface ContextSearchIndexStatus {
  documentCount: number;
  indexId: string;
  engine: string;
  schemaVersion: number;
  recoveredCorruption: boolean;
  needsRebuild: boolean;
}

export interface ContextSearchIndexMutationResult {
  affectedDocuments: number;
  documentCount: number;
}

export interface ContextSearchIndexPort {
  status(accountId: string, mapId: string): Promise<ContextSearchIndexStatus>;
  replaceDocuments(
    accountId: string,
    mapId: string,
    documents: readonly ContextSearchDocumentInput[],
  ): Promise<ContextSearchIndexMutationResult>;
  deleteDocuments(
    accountId: string,
    mapId: string,
    documentIds: readonly string[],
  ): Promise<ContextSearchIndexMutationResult>;
}

export class ContextSearchPipelineError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'invalid_result' | 'cancelled' | 'executor_failed',
    readonly detail?: string,
  ) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'ContextSearchPipelineError';
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const MAX_QUERY_CHARS = 1_024;
const MAX_RESULTS = 100;
const MAX_TEXT = 8_192;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const RESULT_KEYS = Object.freeze([
  'documentId',
  'title',
  'path',
  'sourceType',
  'excerpt',
  'matchReason',
  'updatedAt',
  'score',
]);

function fail(code: ContextSearchPipelineError['code'], detail?: string): never {
  throw new ContextSearchPipelineError(code, detail);
}

function safeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function portablePath(value: unknown): value is string {
  return (
    safeText(value, 1_000) &&
    !value.includes('\\') &&
    !value.includes('%') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/u.test(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
    value
      .split('/')
      .every(
        (segment) =>
          segment.length > 0 && segment !== '.' && segment !== '..' && !/[. ]$/u.test(segment),
      )
  );
}

function arrayValues(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw)) fail('invalid_result');
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(raw);
    descriptors = Object.getOwnPropertyDescriptors(raw) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    keys = Reflect.ownKeys(raw);
  } catch {
    return fail('invalid_result');
  }
  const length = descriptors.length?.value as unknown;
  if (
    prototype !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > MAX_RESULTS ||
    keys.length !== (length as number) + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          !/^(0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= (length as number) ||
          !descriptors[key]?.enumerable ||
          !Object.hasOwn(descriptors[key]!, 'value')),
    )
  ) {
    fail('invalid_result');
  }
  return Object.freeze(
    Array.from({ length: length as number }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_result');
      return descriptor.value as unknown;
    }),
  );
}

function parseResults(raw: unknown): readonly Readonly<ContextProgressiveSearchResult>[] {
  const results = arrayValues(raw).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_result');
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    let keys: PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
      keys = Reflect.ownKeys(value);
    } catch {
      return fail('invalid_result');
    }
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== RESULT_KEYS.length ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !RESULT_KEYS.includes(key) ||
          !descriptors[key]?.enumerable ||
          !Object.hasOwn(descriptors[key]!, 'value'),
      )
    ) {
      fail('invalid_result');
    }
    const record = Object.fromEntries(
      RESULT_KEYS.map((key) => [key, descriptors[key]!.value]),
    ) as Record<string, unknown>;
    if (
      typeof record.documentId !== 'string' ||
      !ID.test(record.documentId) ||
      !safeText(record.title, 500) ||
      !portablePath(record.path) ||
      !(CONTEXT_SOURCE_KINDS as readonly unknown[]).includes(record.sourceType) ||
      !safeText(record.excerpt, MAX_TEXT) ||
      !safeText(record.matchReason, 1_000) ||
      !Number.isSafeInteger(record.updatedAt) ||
      (record.updatedAt as number) < 0 ||
      (record.updatedAt as number) > MAX_TIMESTAMP ||
      typeof record.score !== 'number' ||
      !Number.isFinite(record.score)
    ) {
      fail('invalid_result');
    }
    return Object.freeze({
      documentId: record.documentId,
      title: record.title,
      path: record.path,
      sourceType: record.sourceType as ContextSourceKind,
      excerpt: record.excerpt,
      matchReason: record.matchReason,
      updatedAt: record.updatedAt as number,
      score: record.score,
    });
  });
  if (new Set(results.map(({ documentId }) => documentId)).size !== results.length) {
    fail('invalid_result', 'duplicate_document');
  }
  return Object.freeze(results);
}

function parseSemantic(raw: unknown): readonly Readonly<{ id: string; score: number }>[] {
  const seen = new Set<string>();
  return Object.freeze(
    arrayValues(raw).map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_result');
      let prototype: object | null;
      let descriptors: PropertyDescriptorMap;
      let keys: PropertyKey[];
      try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
        keys = Reflect.ownKeys(value);
      } catch {
        return fail('invalid_result');
      }
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.length !== 2 ||
        keys.some(
          (key) =>
            (key !== 'id' && key !== 'score') ||
            !descriptors[key]?.enumerable ||
            !Object.hasOwn(descriptors[key]!, 'value'),
        )
      ) {
        fail('invalid_result');
      }
      const id = descriptors.id!.value as unknown;
      const score = descriptors.score!.value as unknown;
      if (
        typeof id !== 'string' ||
        !ID.test(id) ||
        typeof score !== 'number' ||
        !Number.isFinite(score) ||
        seen.has(id)
      ) {
        fail('invalid_result');
      }
      seen.add(id);
      return Object.freeze({ id, score });
    }),
  );
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) fail('cancelled');
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertActive(signal);
  if (!signal) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const settle = (callback: () => void) => {
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => settle(() => reject(new ContextSearchPipelineError('cancelled')));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function update(
  stage: ContextProgressiveSearchStage,
  complete: boolean,
  results: readonly Readonly<ContextProgressiveSearchResult>[],
): Readonly<ContextProgressiveSearchUpdate> {
  return Object.freeze({ stage, complete, results });
}

function validateInput(input: {
  accountId: string;
  mapId: string;
  query: string;
  limit: number;
}): void {
  if (
    !input ||
    typeof input !== 'object' ||
    !ID.test(input.accountId) ||
    !ID.test(input.mapId) ||
    !safeText(input.query, MAX_QUERY_CHARS) ||
    input.query.trim() !== input.query ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_RESULTS
  ) {
    fail('invalid_input');
  }
}

export function createContextSearchPipeline(dependencies: {
  lexical: ContextLexicalSearchExecutor;
  semantic?: ContextSemanticSearchExecutor;
}): Readonly<{
  search(
    input: Readonly<{ accountId: string; mapId: string; query: string; limit: number }>,
    onUpdate: (value: Readonly<ContextProgressiveSearchUpdate>) => void,
    signal?: AbortSignal,
  ): Promise<Readonly<ContextProgressiveSearchUpdate>>;
}> {
  if (!dependencies || typeof dependencies.lexical !== 'function') fail('invalid_input');
  return Object.freeze({
    async search(input, onUpdate, signal) {
      validateInput(input);
      if (typeof onUpdate !== 'function') fail('invalid_input');
      assertActive(signal);
      let quickRaw: unknown;
      try {
        quickRaw = await abortable(
          dependencies.lexical(
            { ...input, mode: 'quick', limit: Math.min(input.limit, 20) },
            signal,
          ),
          signal,
        );
      } catch (error) {
        if (error instanceof ContextSearchPipelineError) throw error;
        if (signal?.aborted) fail('cancelled');
        return fail('executor_failed');
      }
      const quick = Object.freeze(parseResults(quickRaw).slice(0, Math.min(input.limit, 20)));
      assertActive(signal);
      onUpdate(update('quick', false, quick));
      assertActive(signal);

      let fullRaw: unknown;
      try {
        fullRaw = await abortable(
          dependencies.lexical({ ...input, mode: 'full_text' }, signal),
          signal,
        );
      } catch (error) {
        if (error instanceof ContextSearchPipelineError) throw error;
        if (signal?.aborted) fail('cancelled');
        return fail('executor_failed');
      }
      const full = Object.freeze(
        [...parseResults(fullRaw)]
          .sort(
            (left, right) =>
              right.score - left.score || left.documentId.localeCompare(right.documentId),
          )
          .slice(0, input.limit),
      );
      const fullUpdate = update('full_text', dependencies.semantic === undefined, full);
      assertActive(signal);
      onUpdate(fullUpdate);
      assertActive(signal);
      if (!dependencies.semantic) return fullUpdate;

      const finalizeFullText = () => {
        const fallback = update('full_text', true, full);
        assertActive(signal);
        onUpdate(fallback);
        assertActive(signal);
        return fallback;
      };
      let semanticUpdate: Readonly<ContextProgressiveSearchUpdate>;
      try {
        const semanticRaw = await abortable(dependencies.semantic(input, signal), signal);
        const fullIds = new Set(full.map(({ documentId }) => documentId));
        const semantic = Object.freeze(
          parseSemantic(semanticRaw).filter(({ id }) => fullIds.has(id)),
        );
        const ranking = rankContextHybrid({
          lexical: full.map(({ documentId, score }) => ({ id: documentId, score })),
          semantic,
          limit: input.limit,
        });
        const byId = new Map(full.map((item) => [item.documentId, item]));
        const reranked = Object.freeze(
          ranking
            .map(({ id }) => byId.get(id))
            .filter((item): item is Readonly<ContextProgressiveSearchResult> => item !== undefined),
        );
        semanticUpdate = update('semantic', true, reranked);
      } catch (error) {
        if (error instanceof ContextSearchPipelineError && error.code === 'cancelled') throw error;
        if (signal?.aborted) fail('cancelled');
        return finalizeFullText();
      }
      assertActive(signal);
      onUpdate(semanticUpdate);
      assertActive(signal);
      return semanticUpdate;
    },
  });
}

export function createTauriContextLexicalSearchExecutor(): ContextLexicalSearchExecutor {
  return async (request) => {
    const { invoke } = await import('@tauri-apps/api/core');
    const response = await invoke<{ results: unknown }>('context_search_query', {
      request,
    });
    return response.results;
  };
}

function contextSearchIndexResponseInvalid(): never {
  throw new Error('context_search_index_response_invalid');
}

function parseIndexStatus(value: unknown): ContextSearchIndexStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return contextSearchIndexResponseInvalid();
  }
  const status = value as Record<string, unknown>;
  const keys = [
    'documentCount',
    'indexId',
    'engine',
    'schemaVersion',
    'recoveredCorruption',
    'needsRebuild',
  ];
  if (
    Object.keys(status).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(status, key)) ||
    !Number.isSafeInteger(status.documentCount) ||
    (status.documentCount as number) < 0 ||
    (status.documentCount as number) > 1_000_000 ||
    typeof status.indexId !== 'string' ||
    status.indexId.length < 1 ||
    status.indexId.length > 200 ||
    typeof status.engine !== 'string' ||
    status.engine.length < 1 ||
    status.engine.length > 100 ||
    !Number.isSafeInteger(status.schemaVersion) ||
    (status.schemaVersion as number) < 1 ||
    (status.schemaVersion as number) > 1_000 ||
    typeof status.recoveredCorruption !== 'boolean' ||
    typeof status.needsRebuild !== 'boolean'
  ) {
    return contextSearchIndexResponseInvalid();
  }
  return Object.freeze({
    documentCount: status.documentCount as number,
    indexId: status.indexId,
    engine: status.engine,
    schemaVersion: status.schemaVersion as number,
    recoveredCorruption: status.recoveredCorruption,
    needsRebuild: status.needsRebuild,
  });
}

function parseMutationResult(value: unknown): ContextSearchIndexMutationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return contextSearchIndexResponseInvalid();
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== 2 ||
    !Object.hasOwn(result, 'affectedDocuments') ||
    !Object.hasOwn(result, 'status') ||
    !Number.isSafeInteger(result.affectedDocuments) ||
    (result.affectedDocuments as number) < 0 ||
    (result.affectedDocuments as number) > 1_000
  ) {
    return contextSearchIndexResponseInvalid();
  }
  const status = parseIndexStatus(result.status);
  return Object.freeze({
    affectedDocuments: result.affectedDocuments as number,
    documentCount: status.documentCount,
  });
}

export function createTauriContextSearchIndexPort(): ContextSearchIndexPort {
  const port: ContextSearchIndexPort = {
    async status(accountId, mapId) {
      const { invoke } = await import('@tauri-apps/api/core');
      return parseIndexStatus(
        await invoke('context_search_status', { request: { accountId, mapId } }),
      );
    },
    async replaceDocuments(accountId, mapId, documents) {
      const { invoke } = await import('@tauri-apps/api/core');
      return parseMutationResult(
        await invoke('context_search_replace_documents', {
          request: { accountId, mapId, documents },
        }),
      );
    },
    async deleteDocuments(accountId, mapId, documentIds) {
      const { invoke } = await import('@tauri-apps/api/core');
      return parseMutationResult(
        await invoke('context_search_delete_documents', {
          request: { accountId, mapId, documentIds },
        }),
      );
    },
  };
  return Object.freeze(port);
}
