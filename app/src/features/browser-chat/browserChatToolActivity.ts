const SAFE_ACCOUNT = /^[A-Za-z0-9_.:@/-]{1,160}$/u;
const SAFE_CALL = /^[A-Za-z0-9_-]{12,96}$/u;
const SAFE_TOOL = /^[a-z][a-z0-9._-]{0,79}$/u;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_TOOLS = 128;
const MAX_ACTIVE_CALLS = 16;
// Relay deadlines top out at 30 seconds. Leave bounded cleanup headroom for
// scheduling/serialization after the deadline so a valid completion cannot
// strand the UI in a permanent "running" state.
const MAX_ELAPSED_MS = 60_000;

export type BrowserChatActiveToolCall = Readonly<{
  callId: string;
  toolName: string;
  startedAt: number;
}>;

export type BrowserChatToolResultSummary = Readonly<{
  callId: string;
  toolName: string;
  ok: boolean;
  errorCode?: string;
  elapsedMs: number;
  finishedAt: number;
}>;

export type BrowserChatToolActivitySnapshot = Readonly<{
  version: 1;
  accountId: string | null;
  advertisedTools: readonly string[];
  activeCalls: readonly BrowserChatActiveToolCall[];
  lastResult: BrowserChatToolResultSummary | null;
  updatedAt: number;
}>;

const EMPTY_SNAPSHOT: BrowserChatToolActivitySnapshot = Object.freeze({
  version: 1,
  accountId: null,
  advertisedTools: Object.freeze([]),
  activeCalls: Object.freeze([]),
  lastResult: null,
  updatedAt: 0,
});

let snapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

function stableNow(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0;
}

function publish(next: BrowserChatToolActivitySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const browserChatToolActivityStore = Object.freeze({
  getSnapshot: (): BrowserChatToolActivitySnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});

export function publishBrowserChatToolCatalog(input: {
  readonly accountId: string;
  readonly toolNames: readonly string[];
  readonly now: number;
}): void {
  if (
    !SAFE_ACCOUNT.test(input.accountId) ||
    !stableNow(input.now) ||
    !Array.isArray(input.toolNames) ||
    input.toolNames.length > MAX_TOOLS ||
    input.toolNames.some((toolName) => !SAFE_TOOL.test(toolName))
  ) {
    throw new Error('Browser Chat tool catalog is invalid.');
  }
  const advertisedTools = Object.freeze([...new Set(input.toolNames)].sort());
  publish(
    Object.freeze({
      version: 1,
      accountId: input.accountId,
      advertisedTools,
      activeCalls: Object.freeze([]),
      lastResult: null,
      updatedAt: input.now,
    }),
  );
}

export function beginBrowserChatToolCall(input: {
  readonly accountId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly now: number;
}): void {
  if (snapshot.accountId !== input.accountId) {
    throw new Error('Browser Chat tool call account does not match.');
  }
  if (!SAFE_CALL.test(input.callId) || !SAFE_TOOL.test(input.toolName) || !stableNow(input.now)) {
    throw new Error('Browser Chat tool call is invalid.');
  }
  if (!snapshot.advertisedTools.includes(input.toolName)) {
    throw new Error('Browser Chat tool was not advertised.');
  }
  if (snapshot.activeCalls.some((call) => call.callId === input.callId)) {
    throw new Error('Browser Chat tool call was replayed.');
  }
  if (snapshot.activeCalls.length >= MAX_ACTIVE_CALLS) {
    throw new Error('Browser Chat tool activity capacity was reached.');
  }
  const activeCalls = Object.freeze([
    ...snapshot.activeCalls,
    Object.freeze({
      callId: input.callId,
      toolName: input.toolName,
      startedAt: input.now,
    }),
  ]);
  publish(Object.freeze({ ...snapshot, activeCalls, updatedAt: input.now }));
}

export function finishBrowserChatToolCall(input: {
  readonly accountId: string;
  readonly callId: string;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly elapsedMs: number;
  readonly now: number;
}): void {
  if (snapshot.accountId !== input.accountId) {
    throw new Error('Browser Chat tool result account does not match.');
  }
  const call = snapshot.activeCalls.find((candidate) => candidate.callId === input.callId);
  if (
    !call ||
    typeof input.ok !== 'boolean' ||
    !Number.isSafeInteger(input.elapsedMs) ||
    input.elapsedMs < 0 ||
    input.elapsedMs > MAX_ELAPSED_MS ||
    !stableNow(input.now) ||
    input.now < call.startedAt ||
    (input.ok
      ? input.errorCode !== undefined
      : !input.errorCode || !SAFE_ERROR.test(input.errorCode))
  ) {
    throw new Error('Browser Chat tool result is invalid.');
  }
  const lastResult = Object.freeze({
    callId: call.callId,
    toolName: call.toolName,
    ok: input.ok,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    elapsedMs: input.elapsedMs,
    finishedAt: input.now,
  });
  publish(
    Object.freeze({
      ...snapshot,
      activeCalls: Object.freeze(
        snapshot.activeCalls.filter((candidate) => candidate.callId !== input.callId),
      ),
      lastResult,
      updatedAt: input.now,
    }),
  );
}

export function clearBrowserChatToolActivity(accountId?: string): void {
  if (accountId !== undefined && snapshot.accountId !== accountId) return;
  if (snapshot === EMPTY_SNAPSHOT) return;
  publish(EMPTY_SNAPSHOT);
}
