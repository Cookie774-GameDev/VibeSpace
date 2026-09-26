import { sha256Text } from '@/lib/fs';
import {
  createContextPointer,
  createContextRecord,
  type ContextPointer,
  type ContextRecord,
} from './losslessContext';
import type {
  ContextQueryRepository,
  ContextScope,
  ContextSearchItem,
  ContextSourceRead,
} from './contextQueryService';

const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_QUERY_CHARACTERS = 512;
const MAX_SEARCH_RESULTS = 20;
const MAX_RELATION_RESULTS = 100;
const MAX_VERIFIED_RELATION_RESULTS = 21;
const MAX_BLOCK_CHARACTERS = 1_048_576;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_AUTHORITIES = 2_000;
const EXACT_STRUCTURED_IDENTIFIER_SCORE = 3_000_000_000;
const STRUCTURED_IDENTIFIER_QUERY_RE =
  /\b(?:artifact|record|document|item)\s+([A-Za-z0-9][A-Za-z0-9._:@/-]*[-_:][A-Za-z0-9._:@/-]+)\b/giu;
const STRUCTURED_IDENTIFIER_CHARACTER_RE = /[A-Za-z0-9._:@/-]/u;

export interface SiyuanRlmBlockSummary {
  id: string;
  notebookId: string;
  path: string;
  content: string;
}

export interface SiyuanRlmBlock {
  id: string;
  notebookId: string;
  path: string;
  markdown: string;
}

export interface SiyuanRlmPort {
  searchBlocks(projectId: string, query: string, limit: number): Promise<SiyuanRlmBlockSummary[]>;
  getBlock(projectId: string, id: string): Promise<SiyuanRlmBlock>;
  listInboundBacklinks?(projectId: string, id: string): Promise<string[]>;
}

interface SiyuanAuthority {
  record: Readonly<ContextRecord>;
  block: Readonly<SiyuanRlmBlock>;
  bytes: Uint8Array;
  sourceVersion: string;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
}

function safeNativeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_NATIVE_ID.test(value);
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validBlock(value: SiyuanRlmBlock): boolean {
  return (
    safeNativeId(value.id) &&
    safeNativeId(value.notebookId) &&
    validPath(value.path) &&
    typeof value.markdown === 'string' &&
    value.markdown.length > 0 &&
    value.markdown.length <= MAX_BLOCK_CHARACTERS &&
    !value.markdown.includes('\u0000')
  );
}

function validateScope(scope: ContextScope): asserts scope is ContextScope & { projectId: string } {
  if (!scope.projectId || !safeNativeId(scope.projectId)) {
    throw new Error('siyuan_project_scope_required');
  }
}

function scopeCanonical(scope: ContextScope & { projectId: string }): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId ?? null,
    scope.projectId,
    scope.worktreeId ?? null,
  ]);
}

async function scopeDigest(scope: ContextScope & { projectId: string }): Promise<string> {
  return (await sha256Text(scopeCanonical(scope))).slice('sha256:'.length, 'sha256:'.length + 24);
}

function recordId(digest: string, blockId: string): string {
  return `siyuan:${digest}:${blockId}`;
}

function parseRecordId(value: string): { digest: string; blockId: string } | undefined {
  const match = /^siyuan:([a-f0-9]{24}):([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(value);
  return match ? { digest: match[1]!, blockId: match[2]! } : undefined;
}

function scopeContains(record: ContextRecord, scope: ContextScope): boolean {
  return (
    record.accountId === scope.accountId &&
    (scope.workspaceId === undefined || record.workspaceId === scope.workspaceId) &&
    (scope.projectId === undefined || record.projectId === scope.projectId) &&
    (scope.worktreeId === undefined || record.worktreeId === scope.worktreeId)
  );
}

function pointerCapabilityKey(
  scope: ContextScope,
  pointer: ContextPointer,
  record: ContextRecord,
  source: Pick<ContextSourceRead, 'contentHash' | 'sourceVersion'>,
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId ?? null,
    scope.projectId ?? null,
    scope.worktreeId ?? null,
    pointer.id,
    pointer.recordId,
    pointer.byteStart,
    pointer.byteEnd,
    pointer.sourceVersion,
    pointer.contentHash,
    record.contentRef,
    source.sourceVersion,
    source.contentHash,
  ]);
}

function retainBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_AUTHORITIES) map.delete(map.keys().next().value!);
}

function structuredQueryIdentifier(query: string): string | undefined {
  const identifiers = new Set(
    [...query.matchAll(STRUCTURED_IDENTIFIER_QUERY_RE)]
      .map((match) => match[1]?.toLocaleLowerCase('en-US'))
      .filter((value): value is string => Boolean(value)),
  );
  return identifiers.size === 1 ? identifiers.values().next().value : undefined;
}

function containsExactIdentifier(content: string, identifier: string): boolean {
  const normalized = content.toLocaleLowerCase('en-US');
  let offset = normalized.indexOf(identifier);
  while (offset >= 0) {
    const before = normalized[offset - 1];
    const after = normalized[offset + identifier.length];
    if (
      (before === undefined || !STRUCTURED_IDENTIFIER_CHARACTER_RE.test(before)) &&
      (after === undefined || !STRUCTURED_IDENTIFIER_CHARACTER_RE.test(after))
    ) {
      return true;
    }
    offset = normalized.indexOf(identifier, offset + identifier.length);
  }
  return false;
}

export function createSiyuanRlmRepository(
  port: SiyuanRlmPort,
  options: Readonly<{ upstreamVersion?: string; now?: () => number }> = {},
): ContextQueryRepository {
  const upstreamVersion = options.upstreamVersion ?? '3.8.1';
  const now = options.now ?? Date.now;
  const authorities = new Map<string, SiyuanAuthority>();
  const scopesByDigest = new Map<string, ContextScope & { projectId: string }>();
  const issuedPointers = new Map<string, true>();

  const rememberScope = async (scope: ContextScope) => {
    validateScope(scope);
    const digest = await scopeDigest(scope);
    retainBounded(scopesByDigest, digest, Object.freeze({ ...scope }));
    return { digest, scope };
  };

  const loadAuthority = async (
    scope: ContextScope & { projectId: string },
    digest: string,
    blockId: string,
    signal?: AbortSignal,
  ): Promise<SiyuanAuthority | undefined> => {
    abortIfNeeded(signal);
    let block: SiyuanRlmBlock;
    try {
      block = await port.getBlock(scope.projectId, blockId);
    } catch {
      abortIfNeeded(signal);
      return undefined;
    }
    abortIfNeeded(signal);
    if (!validBlock(block) || block.id !== blockId) return undefined;
    const bytes = new TextEncoder().encode(block.markdown);
    if (bytes.length === 0 || bytes.length > MAX_BLOCK_CHARACTERS * 4) return undefined;
    const digestValue = await sha256Text(block.markdown);
    abortIfNeeded(signal);
    const contentHash = digestValue.slice('sha256:'.length);
    const id = recordId(digest, block.id);
    const previous = authorities.get(id)?.record;
    const observedAt = now();
    const updatedAt = previous && previous.contentHash !== contentHash
      ? observedAt
      : previous?.updatedAt;
    const record = createContextRecord({
      id,
      accountId: scope.accountId,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      projectId: scope.projectId,
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
      sourceKind: 'context_note',
      sourceId: block.id,
      parentSourceId: block.notebookId,
      createdAt: previous?.createdAt ?? observedAt,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      contentHash,
      contentRef: `siyuan://${block.notebookId}/${block.id}`,
      title: `SiYuan block ${block.id}`,
      path: block.path,
      trustLevel: 'app_verified',
      sensitivity: 'project_private',
    });
    const authority = Object.freeze({
      record,
      block: Object.freeze({ ...block }),
      bytes,
      sourceVersion: `siyuan:${upstreamVersion}:sha256:${contentHash}`,
    });
    retainBounded(authorities, id, authority);
    return authority;
  };

  const repository: ContextQueryRepository = {
    async listRecords(scope, signal) {
      const remembered = await rememberScope(scope);
      abortIfNeeded(signal);
      return [...authorities.values()]
        .map(({ record }) => record)
        .filter(
          (record) =>
            record.id.startsWith(`siyuan:${remembered.digest}:`) && scopeContains(record, scope),
        );
    },

    async getRecord(id, signal) {
      abortIfNeeded(signal);
      const cached = authorities.get(id);
      if (cached) return cached.record;
      const parsed = parseRecordId(id);
      if (!parsed) return undefined;
      const scope = scopesByDigest.get(parsed.digest);
      if (!scope) return undefined;
      return (await loadAuthority(scope, parsed.digest, parsed.blockId, signal))?.record;
    },

    async search(scope, query, signal) {
      const normalizedQuery = query.trim();
      if (
        !normalizedQuery ||
        normalizedQuery.length > MAX_QUERY_CHARACTERS ||
        /[\u0000-\u001f\u007f]/u.test(normalizedQuery)
      ) {
        return [];
      }
      const remembered = await rememberScope(scope);
      const exactIdentifier = structuredQueryIdentifier(normalizedQuery);
      abortIfNeeded(signal);
      let summaries: SiyuanRlmBlockSummary[];
      try {
        summaries = await port.searchBlocks(
          remembered.scope.projectId,
          exactIdentifier ?? normalizedQuery,
          MAX_SEARCH_RESULTS,
        );
      } catch {
        abortIfNeeded(signal);
        return [];
      }
      abortIfNeeded(signal);
      const hits = [];
      const seen = new Set<string>();
      for (const summary of summaries.slice(0, MAX_SEARCH_RESULTS)) {
        if (
          !safeNativeId(summary?.id) ||
          !safeNativeId(summary.notebookId) ||
          !validPath(summary.path) ||
          seen.has(summary.id)
        ) {
          continue;
        }
        seen.add(summary.id);
        const authority = await loadAuthority(
          remembered.scope,
          remembered.digest,
          summary.id,
          signal,
        );
        if (!authority || authority.block.notebookId !== summary.notebookId) continue;
        let byteEnd = Math.min(authority.bytes.length, MAX_POINTER_BYTES);
        // Keep the capped, issued byte authority on a complete UTF-8 boundary.
        while (byteEnd > 0 && (authority.bytes[byteEnd]! & 0xc0) === 0x80) byteEnd -= 1;
        const pointer = createContextPointer({
          id: `ptr:${authority.record.id}:0:${byteEnd}`,
          recordId: authority.record.id,
          byteStart: 0,
          byteEnd,
          sourceVersion: authority.sourceVersion,
          contentHash: authority.record.contentHash,
        });
        hits.push({
          recordId: authority.record.id,
          pointer,
          preview: (summary.content || authority.block.markdown).slice(0, 320),
          score:
            exactIdentifier && containsExactIdentifier(authority.block.markdown, exactIdentifier)
              ? EXACT_STRUCTURED_IDENTIFIER_SCORE + MAX_SEARCH_RESULTS - hits.length
              : MAX_SEARCH_RESULTS - hits.length,
        });
      }
      return hits;
    },

    async readSource(record, signal) {
      abortIfNeeded(signal);
      const parsed = parseRecordId(record.id);
      if (!parsed) return undefined;
      const scope = scopesByDigest.get(parsed.digest);
      if (!scope || !scopeContains(record, scope)) return undefined;
      const authority = await loadAuthority(scope, parsed.digest, parsed.blockId, signal);
      if (!authority) return undefined;
      return {
        bytes: authority.bytes,
        contentHash: authority.record.contentHash,
        sourceVersion: authority.sourceVersion,
      };
    },

    async canOpen(record, scope, signal) {
      abortIfNeeded(signal);
      const current = await this.getRecord(record.id, signal);
      return Boolean(
        current &&
        scopeContains(current, scope) &&
        JSON.stringify(current) === JSON.stringify(record),
      );
    },

    authorizePointer(pointer, record, scope, signal) {
      abortIfNeeded(signal);
      const current = authorities.get(record.id);
      if (!current || !scopeContains(record, scope) || JSON.stringify(current.record) !== JSON.stringify(record)) {
        return false;
      }
      if (
        pointer.recordId !== record.id ||
        !Number.isSafeInteger(pointer.byteStart) ||
        !Number.isSafeInteger(pointer.byteEnd) ||
        pointer.byteStart! < 0 ||
        pointer.byteEnd! <= pointer.byteStart! ||
        pointer.byteEnd! > MAX_POINTER_BYTES ||
        pointer.id !== `ptr:${record.id}:${pointer.byteStart}:${pointer.byteEnd}` ||
        pointer.contentHash !== record.contentHash ||
        pointer.sourceVersion !== current.sourceVersion
      ) {
        return false;
      }
      return issuedPointers.has(pointerCapabilityKey(scope, pointer, record, {
        contentHash: record.contentHash,
        sourceVersion: current.sourceVersion,
      }));
    },

    validatePointer(pointer, record, source, scope, signal) {
      abortIfNeeded(signal);
      if (
        pointer.recordId !== record.id ||
        pointer.id !== `ptr:${record.id}:${pointer.byteStart}:${pointer.byteEnd}` ||
        pointer.sourceVersion !== source.sourceVersion ||
        pointer.contentHash !== source.contentHash ||
        record.contentHash !== source.contentHash
      ) {
        return false;
      }
      return issuedPointers.has(pointerCapabilityKey(scope, pointer, record, source));
    },

    issuePointers(items: readonly ContextSearchItem[], scope, signal) {
      abortIfNeeded(signal);
      for (const item of items) {
        const authority = authorities.get(item.record.id);
        if (!authority || JSON.stringify(authority.record) !== JSON.stringify(item.record)) {
          return false;
        }
        const source = {
          bytes: authority.bytes,
          contentHash: authority.record.contentHash,
          sourceVersion: authority.sourceVersion,
        };
        retainBounded(
          issuedPointers,
          pointerCapabilityKey(scope, item.pointer, item.record, source),
          true,
        );
      }
      return true;
    },

    async relatedRecordIds(id, signal) {
      abortIfNeeded(signal);
      const parsed = parseRecordId(id);
      if (!parsed || !authorities.has(id)) return [];
      const scope = scopesByDigest.get(parsed.digest);
      if (!scope) return [];
      if (!port.listInboundBacklinks) return [];
      const source = await loadAuthority(scope, parsed.digest, parsed.blockId, signal);
      if (!source || source.record.id !== id) return [];
      let inboundBlockIds: string[];
      try {
        inboundBlockIds = await port.listInboundBacklinks(scope.projectId, parsed.blockId);
      } catch {
        abortIfNeeded(signal);
        return [];
      }
      abortIfNeeded(signal);
      if (
        !Array.isArray(inboundBlockIds) ||
        inboundBlockIds.length > MAX_RELATION_RESULTS ||
        inboundBlockIds.some((blockId) => !safeNativeId(blockId))
      ) {
        return [];
      }
      const relatedIds = [...new Set(inboundBlockIds)].filter(
        (blockId) => blockId !== parsed.blockId,
      );
      const verified: string[] = [];
      for (const blockId of relatedIds) {
        if (verified.length >= MAX_VERIFIED_RELATION_RESULTS) break;
        abortIfNeeded(signal);
        const authority = await loadAuthority(scope, parsed.digest, blockId, signal);
        if (authority) verified.push(authority.record.id);
      }
      return verified;
    },
  };
  return Object.freeze(repository);
}
