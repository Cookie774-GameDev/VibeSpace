import { createContextPointer, type ContextPointer } from './losslessContext';
import type { ContextScope } from './contextQueryService';
import type { ExecutionIdentity } from './gateway/contextGatewayContracts';
import { routeDefaultContextQuery } from './adaptiveContextRouter';
import { recordRlmRoute, resolveRlmEnabled } from './rlmPreferenceStore';
import type { RlmBudget } from './rlmRuntime';
import { registerToolGatewayFallbackCitations } from '@/lib/harness/toolGatewayCitations';

export const RLM_OPENCODE_TOOL_NAME = 'vibespace_context' as const;
export const RLM_HIGH_LEVEL_QUERY = 'query' as const;
export const RLM_CONTEXT_OPERATIONS = [
  'query',
  'describe',
  'search',
  'open',
  'expand',
  'address',
  'related',
  'timeline',
  'sources',
  'checkpoint',
  'investigate',
  'trace',
] as const;

export type RlmContextOperation = (typeof RLM_CONTEXT_OPERATIONS)[number];

function citationScope(lease: RlmContextLease): { accountId: string; projectId: string } | undefined {
  return lease.projectId ? { accountId: lease.accountId, projectId: lease.projectId } : undefined;
}

function registerFallbackCitationsFromSearch(
  lease: RlmContextLease,
  result: unknown,
): void {
  const scope = citationScope(lease);
  if (!scope || !result || typeof result !== 'object') return;
  const items = (result as { items?: unknown }).items;
  if (!Array.isArray(items)) return;
  registerToolGatewayFallbackCitations(
    lease.sessionId,
    items.flatMap((item) => {
      const record = (item as { record?: { id?: unknown; sourceId?: unknown } }).record;
      const pointer = (item as { pointer?: { id?: unknown; sourceVersion?: unknown; contentHash?: unknown } })
        .pointer;
      return typeof record?.id === 'string' &&
        typeof pointer?.id === 'string' &&
        typeof pointer?.sourceVersion === 'string' &&
        typeof pointer?.contentHash === 'string'
        ? [
            {
              pointerId: pointer.id,
              recordId: record.id,
              sourceRevision: pointer.sourceVersion,
              contentHash: pointer.contentHash,
            },
          ]
        : [];
    }),
    scope,
  );
}

function registerFallbackCitationFromOpen(lease: RlmContextLease, result: unknown): void {
  const scope = citationScope(lease);
  if (!scope || !result || typeof result !== 'object') return;
  const record = (result as { record?: { id?: unknown } }).record;
  const pointer = (result as { pointer?: { id?: unknown; sourceVersion?: unknown; contentHash?: unknown } })
    .pointer;
  if (
    typeof record?.id !== 'string' ||
    typeof pointer?.id !== 'string' ||
    typeof pointer?.sourceVersion !== 'string' ||
    typeof pointer?.contentHash !== 'string'
  ) {
    return;
  }
  registerToolGatewayFallbackCitations(
    lease.sessionId,
    [
      {
        pointerId: pointer.id,
        recordId: record.id,
        sourceRevision: pointer.sourceVersion,
        contentHash: pointer.contentHash,
      },
    ],
    scope,
  );
}

export interface RlmContextLease {
  sessionId: string;
  /** Captured originating chat, never a model-supplied argument. */
  chatId?: string;
  /** Captured Context revision, never a provider-supplied scope override. */
  contextRevision?: string;
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  executionIdentity?: Readonly<ExecutionIdentity>;
  expiresAt: number;
}

export type RlmOpenCodeToolErrorCode = 'invalid_arguments' | 'lease_expired';

export class RlmOpenCodeToolError extends Error {
  constructor(
    readonly code: RlmOpenCodeToolErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'RlmOpenCodeToolError';
  }
}

interface QueryPort {
  describe(input: unknown): Promise<unknown>;
  search(input: unknown): Promise<unknown>;
  open(input: unknown): Promise<unknown>;
  expand(input: unknown): Promise<unknown>;
  address?(input: unknown): Promise<unknown>;
  related(input: unknown): Promise<unknown>;
  timeline(input: unknown): Promise<unknown>;
  sources(input: unknown): Promise<unknown>;
  checkpoint(input: unknown): Promise<unknown>;
}

interface RlmPort {
  investigate(input: unknown, lease?: Readonly<RlmContextLease>): Promise<unknown>;
}

const DEFAULT_RLM_BUDGET: Readonly<RlmBudget> = Object.freeze({
  maxDepth: 1,
  maxSubcalls: 4,
  maxConcurrentSubcalls: 2,
  maxInputTokens: 8_192,
  maxOutputTokens: 2_048,
  maxWallTimeMs: 60_000,
  maxToolCalls: 12,
  maxOpenBytes: 256 * 1024,
});
const SAFE_CORPUS_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/u;
const CANONICAL_POSITION = /^(?:0|[1-9][0-9]*)$/u;
const MAX_LOGICAL_POSITION = 10_000_000_000_000_000n;

function invalid(): never {
  throw new RlmOpenCodeToolError('invalid_arguments');
}

function plainObject(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = plainObject(input);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalid();
  }
  return value;
}

function text(value: unknown, maximum = 4_096): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    invalid();
  }
  return value;
}

function corpusId(value: unknown): string {
  const parsed = text(value, 200);
  if (!SAFE_CORPUS_ID.test(parsed)) invalid();
  return parsed;
}

function canonicalPosition(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_POSITION.test(value) ||
    BigInt(value) > MAX_LOGICAL_POSITION
  ) {
    invalid();
  }
  return value;
}

function optionalPositiveInteger(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return Math.min(value as number, maximum);
}

function pointer(value: unknown): ContextPointer {
  const raw = exactKeys(
    value,
    ['id', 'recordId', 'sourceVersion', 'contentHash'],
    ['lineStart', 'lineEnd', 'byteStart', 'byteEnd', 'messageId', 'eventId', 'toolCallId'],
  );
  try {
    return createContextPointer(raw as unknown as ContextPointer);
  } catch {
    invalid();
  }
}

function leaseScope(lease: RlmContextLease, now: number): ContextScope {
  if (
    !lease.sessionId ||
    !lease.accountId ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= now
  ) {
    throw new RlmOpenCodeToolError('lease_expired');
  }
  return {
    accountId: lease.accountId,
    ...(lease.workspaceId ? { workspaceId: lease.workspaceId } : {}),
    ...(lease.projectId ? { projectId: lease.projectId } : {}),
    ...(lease.worktreeId ? { worktreeId: lease.worktreeId } : {}),
  };
}

function leaseExecutionIdentity(lease: RlmContextLease): Readonly<ExecutionIdentity> {
  if (!lease.executionIdentity) throw new Error('rlm_execution_identity_required');
  return lease.executionIdentity;
}

async function executeRouted<T>(
  route: 'retrieval' | 'rlm',
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    try {
      recordRlmRoute(route, 'ok');
    } catch {
      // A diagnostic status write must never turn a successful retrieval into an error.
    }
    return result;
  } catch (error) {
    try {
      recordRlmRoute(route, 'failed');
    } catch {
      // A diagnostic status write must never replace the provider/retrieval error.
    }
    throw error;
  }
}

export function createRlmOpenCodeTool(dependencies: {
  queryService: QueryPort;
  rlmRuntime: RlmPort;
  traceLookup?(runId: string, lease: Readonly<RlmContextLease>, signal?: AbortSignal): Promise<unknown | undefined>;
  now?: () => number;
  maxOpenBytes?: number;
  rlmBudget?: RlmBudget;
}) {
  const now = dependencies.now ?? Date.now;
  const maxOpenBytes = Math.max(1, Math.floor(dependencies.maxOpenBytes ?? 64 * 1024));
  const rlmBudget = Object.freeze({ ...(dependencies.rlmBudget ?? DEFAULT_RLM_BUDGET) });

  const execute = async (
    rawInput: unknown,
    lease: RlmContextLease,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const scope = leaseScope(lease, now());
    const capturedLease = Object.freeze({ ...lease,
      ...(lease.executionIdentity ? { executionIdentity: Object.freeze({ ...lease.executionIdentity }) } : {}),
    });
    signal?.throwIfAborted();
    const base = exactKeys(
      rawInput,
      ['operation'],
      [
        'query',
        'limit',
        'continuation',
        'pointer',
        'maxBytes',
        'beforeBytes',
        'afterBytes',
        'recordId',
        'corpusId',
        'position',
        'runId',
      ],
    );
    if (
      typeof base.operation !== 'string' ||
      !RLM_CONTEXT_OPERATIONS.includes(base.operation as RlmContextOperation)
    ) {
      invalid();
    }
    const operation = base.operation as RlmContextOperation;

    switch (operation) {
      case 'trace': {
        const args = exactKeys(rawInput, ['operation', 'runId']);
        const result = await dependencies.traceLookup?.(text(args.runId, 512), capturedLease, signal);
        signal?.throwIfAborted();
        return result === undefined ? { found: false } : { found: true, receipt: result };
      }
      case 'query': {
        const args = exactKeys(rawInput, ['operation', 'query'], ['limit']);
        const question = text(args.query);
        const rlmEnabled = resolveRlmEnabled({ workspaceId: lease.workspaceId, chatId: lease.chatId }).enabled;
        const decision = routeDefaultContextQuery(question, { rlmAvailable: rlmEnabled });
        if (decision.mode === 'rlm') {
          return executeRouted('rlm', () =>
            dependencies.rlmRuntime.investigate({
              question,
              scope,
              executionIdentity: leaseExecutionIdentity(lease),
              budget: rlmBudget,
              signal,
              decision,
            }, capturedLease),
          );
        }
        if (decision.mode === 'direct') {
          try {
            recordRlmRoute('direct', 'ok');
          } catch {
            // A diagnostic status write must never turn a successful direct route into an error.
          }
          return {
            mode: decision.mode,
            reasons: decision.reasons,
            skippedRecursiveSearch: true,
            evidence: [],
          };
        }
        return executeRouted('retrieval', async () => {
          const result = await dependencies.queryService.search({
            scope,
            query: question,
            ...(optionalPositiveInteger(args.limit, 100) === undefined
              ? {}
              : { limit: optionalPositiveInteger(args.limit, 100) }),
            signal,
          });
          signal?.throwIfAborted();
          registerFallbackCitationsFromSearch(lease, result);
          return result;
        });
      }
      case 'describe': {
        exactKeys(rawInput, ['operation']);
        return dependencies.queryService.describe({ scope, signal });
      }
      case 'search': {
        const args = exactKeys(rawInput, ['operation', 'query'], ['limit', 'continuation']);
        const result = await dependencies.queryService.search({
          scope,
          query: text(args.query),
          ...(optionalPositiveInteger(args.limit, 100) === undefined
            ? {}
            : { limit: optionalPositiveInteger(args.limit, 100) }),
          ...(args.continuation === undefined
            ? {}
            : { continuation: text(args.continuation, 512) }),
          signal,
        });
        signal?.throwIfAborted();
        registerFallbackCitationsFromSearch(lease, result);
        return result;
      }
      case 'open': {
        const args = exactKeys(rawInput, ['operation', 'pointer'], ['maxBytes', 'continuation']);
        const result = await dependencies.queryService.open({
          scope,
          pointer: pointer(args.pointer),
          maxBytes: optionalPositiveInteger(args.maxBytes, maxOpenBytes) ?? maxOpenBytes,
          ...(args.continuation === undefined
            ? {}
            : { continuation: text(args.continuation, 512) }),
          signal,
        });
        signal?.throwIfAborted();
        registerFallbackCitationFromOpen(lease, result);
        return result;
      }
      case 'expand': {
        const args = exactKeys(rawInput, ['operation', 'pointer'], ['beforeBytes', 'afterBytes']);
        const result = await dependencies.queryService.expand({
          scope,
          pointer: pointer(args.pointer),
          beforeBytes: optionalPositiveInteger(args.beforeBytes, maxOpenBytes) ?? 0,
          afterBytes: optionalPositiveInteger(args.afterBytes, maxOpenBytes) ?? 0,
          signal,
        });
        signal?.throwIfAborted();
        registerFallbackCitationFromOpen(lease, result);
        return result;
      }
      case 'address': {
        const args = exactKeys(rawInput, ['operation', 'corpusId', 'position']);
        if (!dependencies.queryService.address) invalid();
        return dependencies.queryService.address({
          scope,
          corpusId: corpusId(args.corpusId),
          position: canonicalPosition(args.position),
          signal,
        });
      }
      case 'related': {
        const args = exactKeys(rawInput, ['operation', 'recordId'], ['limit']);
        return dependencies.queryService.related({
          scope,
          recordId: text(args.recordId, 512),
          ...(optionalPositiveInteger(args.limit, 100) === undefined
            ? {}
            : { limit: optionalPositiveInteger(args.limit, 100) }),
          signal,
        });
      }
      case 'timeline':
      case 'sources': {
        const args = exactKeys(rawInput, ['operation'], ['limit']);
        const method = dependencies.queryService[operation].bind(dependencies.queryService);
        return method({
          scope,
          ...(optionalPositiveInteger(args.limit, 100) === undefined
            ? {}
            : { limit: optionalPositiveInteger(args.limit, 100) }),
          signal,
        });
      }
      case 'checkpoint': {
        exactKeys(rawInput, ['operation']);
        return dependencies.queryService.checkpoint({ scope, signal });
      }
      case 'investigate': {
        const args = exactKeys(rawInput, ['operation', 'query']);
        if (!resolveRlmEnabled({ workspaceId: lease.workspaceId, chatId: lease.chatId }).enabled) {
          return executeRouted('retrieval', async () => {
            const result = await dependencies.queryService.search({
              scope,
              query: text(args.query),
              signal,
            });
            signal?.throwIfAborted();
            registerFallbackCitationsFromSearch(lease, result);
            return result;
          });
        }
        return executeRouted('rlm', () =>
          dependencies.rlmRuntime.investigate({
            question: text(args.query),
            scope,
            executionIdentity: leaseExecutionIdentity(lease),
            budget: rlmBudget,
            signal,
          }, capturedLease),
        );
      }
    }
  };

  return Object.freeze({ name: RLM_OPENCODE_TOOL_NAME, execute });
}
