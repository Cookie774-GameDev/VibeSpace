import type { RlmTerminalReceipt } from '@/features/context/rlmRuntime';

export interface RlmTraceScope {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  chatId: string;
  contextRevision: string;
}

const EVENT_TYPES = new Set(['root_started', 'search_completed', 'evidence_opened', 'child_started', 'child_completed', 'child_failed', 'synthesized', 'cancelled', 'wall_time_exceeded']);
const ERROR_CODES = new Set(['cancelled', 'abort_unconfirmed', 'wall_time_exceeded', 'budget_invalid', 'execution_identity_invalid', 'execution_route_unavailable', 'no_evidence']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const MAX_EVENTS = 256;
const MAX_INVOCATIONS = 128;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function scopeKey(scope: RlmTraceScope): string | undefined {
  if (!scope || !identity(scope.accountId) || !identity(scope.chatId) || !identity(scope.contextRevision)) return undefined;
  if ([scope.workspaceId, scope.projectId, scope.worktreeId].some(value => value !== undefined && !identity(value))) return undefined;
  return JSON.stringify([scope.accountId, scope.workspaceId ?? null, scope.projectId ?? null, scope.worktreeId ?? null, scope.chatId, scope.contextRevision]);
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** A trace is metadata only. Runtime question/evidence/answers and event details never enter this store. */
function metadata(receipt: RlmTerminalReceipt) {
  if (!receipt || !identity(receipt.runId) || !TERMINAL_STATUSES.has(receipt.status)) return undefined;
  const trace = receipt.trace;
  if (!trace || trace.runId !== receipt.runId || !timestamp(receipt.startedAt) || !timestamp(receipt.endedAt) || receipt.endedAt < receipt.startedAt || !timestamp(trace.wallTimeMs) || !Array.isArray(trace.events) || !Array.isArray(trace.toolInvocations)) return undefined;
  if (!trace.usage || ![trace.usage.subcalls, trace.usage.toolCalls, trace.usage.openBytes, trace.usage.maxDepthReached].every(count)) return undefined;
  const events = trace.events.slice(0, MAX_EVENTS).flatMap(event => EVENT_TYPES.has(event.type) && timestamp(event.at) && count(event.depth) ? [{ type: event.type, at: event.at, depth: event.depth }] : []);
  const invocations = trace.toolInvocations.slice(0, MAX_INVOCATIONS).flatMap(call => {
    if (!identity(call.id) || call.runId !== receipt.runId || !['search', 'open', 'expand'].includes(call.operation) || !count(call.depth) || !timestamp(call.startedAt) || !['running', 'completed', 'failed', 'cancelled'].includes(call.status)) return [];
    if (call.finishedAt !== undefined && (!timestamp(call.finishedAt) || call.finishedAt < call.startedAt)) return [];
    return [{ id: call.id, runId: call.runId, operation: call.operation, depth: call.depth, startedAt: call.startedAt, ...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }), status: call.status }];
  });
  return freezeDeep({
    runId: receipt.runId,
    status: receipt.status,
    ...(receipt.errorCode && ERROR_CODES.has(receipt.errorCode) ? { errorCode: receipt.errorCode } : {}),
    trace: {
      mode: 'rlm' as const, runId: trace.runId, startedAt: receipt.startedAt, endedAt: receipt.endedAt, wallTimeMs: trace.wallTimeMs,
      events, toolInvocations: invocations,
      usage: { subcalls: trace.usage.subcalls, toolCalls: trace.usage.toolCalls, openBytes: trace.usage.openBytes, maxDepthReached: trace.usage.maxDepthReached },
      budgetExhausted: trace.budgetExhausted === true,
      metadataTruncated: events.length !== trace.events.length || invocations.length !== trace.toolInvocations.length,
      omittedEvents: trace.events.length - events.length,
      omittedInvocations: trace.toolInvocations.length - invocations.length,
    },
  });
}

export type StoredRlmTerminalReceipt = NonNullable<ReturnType<typeof metadata>>;
export type RlmTraceStore = ReturnType<typeof createRlmTraceStore>;

/** Captures immutable metadata authority from the internal lease, never from provider arguments. */
export function rlmTraceScopeFromLease(lease: Omit<RlmTraceScope, 'chatId' | 'contextRevision'> & { chatId?: string; contextRevision?: string }): Readonly<RlmTraceScope> | undefined {
  const scope={accountId:lease.accountId,workspaceId:lease.workspaceId,projectId:lease.projectId,worktreeId:lease.worktreeId,chatId:lease.chatId,contextRevision:lease.contextRevision};
  if (!scopeKey(scope as RlmTraceScope)) return undefined;
  return Object.freeze(scope as RlmTraceScope);
}

export function createRlmTraceSink(store: RlmTraceStore, lease: Parameters<typeof rlmTraceScopeFromLease>[0]): (receipt: RlmTerminalReceipt) => void {
  const scope=rlmTraceScopeFromLease(lease);
  return receipt=>{if(scope)store.publish(scope,receipt);};
}

export function createRlmTraceStore(options: { now?: () => number; ttlMs?: number; maxEntries?: number; maxEntriesPerAccount?: number } = {}) {
  const now = options.now ?? Date.now;
  const bounded = (value: number | undefined, fallback: number, maximum: number) => value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : (() => { throw new TypeError('invalid_trace_store_bound'); })();
  const ttlMs = bounded(options.ttlMs, 10 * 60_000, 60 * 60_000);
  const maxEntries = bounded(options.maxEntries, 128, 512);
  const maxEntriesPerAccount = Math.min(maxEntries, bounded(options.maxEntriesPerAccount, 32, 128));
  const entries = new Map<string, { accountId: string; expiresAt: number; receipt: StoredRlmTerminalReceipt }>();
  const expire = () => { const at = now(); for (const [key, value] of entries) if (at >= value.expiresAt) entries.delete(key); };
  return Object.freeze({
    publish(scope: RlmTraceScope, terminal: RlmTerminalReceipt): boolean {
      const authority = scopeKey(scope); const receipt = metadata(terminal);
      if (!authority || !receipt) return false;
      expire();
      const key = JSON.stringify([authority, receipt.runId]);
      if (entries.has(key)) return false;
      const accountKeys = [...entries].filter(([, value]) => value.accountId === scope.accountId).map(([entryKey]) => entryKey);
      while (accountKeys.length >= maxEntriesPerAccount) entries.delete(accountKeys.shift()!);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(key, { accountId: scope.accountId, expiresAt: now() + ttlMs, receipt });
      return true;
    },
    lookup(scope: RlmTraceScope, runId: string): StoredRlmTerminalReceipt | undefined {
      const authority = scopeKey(scope);
      if (!authority || !identity(runId)) return undefined;
      expire();
      const stored = entries.get(JSON.stringify([authority, runId]));
      return stored ? freezeDeep(structuredClone(stored.receipt)) : undefined;
    },
  });
}
