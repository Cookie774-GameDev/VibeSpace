import { reduceTurn } from './turnReducer';
import { readTurnCheckpoint, writeTurnCheckpoint } from './turnCheckpointStore';
import {
  isTerminalTurnStatus,
  type CanonicalTurnState,
  type TurnEvent,
  type TurnIdentity,
  type TurnPublicSnapshot,
} from './turnTypes';
import type { ProviderErrorDetails } from '@/lib/ai/providerError';

type Listener = () => void;
type CompatibilityState = Readonly<{
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancellationKey?: string;
  errorCode?: string;
  at: number;
}>;

const byRun = new Map<string, CanonicalTurnState>();
const latestByChat = new Map<string, string>();
const latestByChatId = new Map<string, string>();
const priorityChatListeners = new Map<string, Set<Listener>>();
const chatListeners = new Map<string, Set<Listener>>();
const globalListeners = new Set<Listener>();
const pendingCompatibility = new Map<string, CompatibilityState>();
const checkpointTimers = new Map<string, number>();

function runKey(accountId: string, runId: string): string {
  return accountId.length + ':' + accountId + runId;
}

function chatKey(accountId: string, chatId: string): string {
  return accountId.length + ':' + accountId + chatId;
}

function reindexLatestChat(accountId: string, chatId: string): void {
  let bestKey: string | undefined;
  let bestChatIdKey: string | undefined;
  // Map insertion order is turn admission order; late events must not reorder it.
  for (const [candidateKey, state] of byRun) {
    if (state.identity.chatId !== chatId) continue;
    bestChatIdKey = candidateKey;
    if (state.identity.accountId === accountId) bestKey = candidateKey;
  }
  const ckey = chatKey(accountId, chatId);
  if (bestKey) {
    latestByChat.set(ckey, bestKey);
  } else {
    latestByChat.delete(ckey);
  }
  if (bestChatIdKey) latestByChatId.set(chatId, bestChatIdKey);
  else latestByChatId.delete(chatId);
}

function emit(state: CanonicalTurnState): void {
  const key = chatKey(state.identity.accountId, state.identity.chatId);
  const priority = priorityChatListeners.get(key);
  if (priority) for (const listener of priority) listener();
  const scoped = chatListeners.get(key);
  if (scoped) for (const listener of scoped) listener();
  for (const listener of globalListeners) listener();
}

function scheduleCheckpoint(state: CanonicalTurnState): void {
  if (typeof window === 'undefined') return;
  const key = runKey(state.identity.accountId, state.identity.runId);
  const prior = checkpointTimers.get(key);
  if (prior !== undefined) window.clearTimeout(prior);
  checkpointTimers.delete(key);
  const ckey = chatKey(state.identity.accountId, state.identity.chatId);
  if (latestByChat.get(ckey) !== key) return;

  const writeIfCurrent = () => {
    const current = byRun.get(key);
    // A removed/rebound run or a superseded turn cannot own this checkpoint.
    if (current?.identity === state.identity && latestByChat.get(ckey) === key) {
      writeTurnCheckpoint(current);
    }
  };

  if (isTerminalTurnStatus(state.status) || state.revision <= 2) {
    queueMicrotask(writeIfCurrent);
    return;
  }

  checkpointTimers.set(
    key,
    window.setTimeout(() => {
      checkpointTimers.delete(key);
      writeIfCurrent();
    }, 250),
  );
}

function commit(state: CanonicalTurnState): CanonicalTurnState {
  const key = runKey(state.identity.accountId, state.identity.runId);
  const isNewTurn = !byRun.has(key);
  byRun.set(key, state);
  if (isNewTurn) {
    latestByChat.set(chatKey(state.identity.accountId, state.identity.chatId), key);
    latestByChatId.set(state.identity.chatId, key);
  }
  // Visibility subscribers run from committed canonical state before
  // checkpoint scheduling or global diagnostic fan-out can add hot-path work.
  emit(state);
  scheduleCheckpoint(state);
  return state;
}

function applyCompatibilityState(
  state: CanonicalTurnState,
  pending: CompatibilityState | undefined,
): CanonicalTurnState {
  if (!pending) return state;
  if (pending.status === 'running') {
    return reduceTurn(state, {
      type: 'turn.running',
      at: pending.at,
      ...(pending.cancellationKey ? { cancellationKey: pending.cancellationKey } : {}),
    });
  }
  if (pending.status === 'done') {
    return reduceTurn(state, { type: 'turn.completed', at: pending.at });
  }
  if (pending.status === 'cancelled') {
    return reduceTurn(state, { type: 'turn.cancelled', at: pending.at });
  }
  return reduceTurn(state, {
    type: 'turn.failed',
    at: pending.at,
    ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
  });
}

export function acceptTurn(
  identity: TurnIdentity,
  at = Date.now(),
  cancellationKey?: string,
): CanonicalTurnState {
  const key = runKey(identity.accountId, identity.runId);
  const existing = byRun.get(key);
  let state = reduceTurn(existing, {
    type: 'turn.accepted',
    identity,
    at,
    ...(cancellationKey ? { cancellationKey } : {}),
  });

  state = applyCompatibilityState(state, pendingCompatibility.get(identity.chatId));
  pendingCompatibility.delete(identity.chatId);
  return commit(state);
}

export function publishTurnEvent(
  identity: Pick<TurnIdentity, 'accountId' | 'runId'>,
  event: Exclude<TurnEvent, { type: 'turn.accepted' }>,
): CanonicalTurnState | undefined {
  const key = runKey(identity.accountId, identity.runId);
  const current = byRun.get(key);
  if (!current) return undefined;
  const next = reduceTurn(current, event);
  return next === current ? current : commit(next);
}

export function publishTurnPublicSnapshot(input: {
  identity: TurnIdentity;
  snapshot: TurnPublicSnapshot;
}): CanonicalTurnState {
  const key = runKey(input.identity.accountId, input.identity.runId);
  let current = byRun.get(key);
  if (!current) {
    // Compatibility preview callers may publish before the canonical runtime
    // has allocated its turn. Build the accepted state in-memory and commit
    // only the first real snapshot so React receives one notification.
    current = reduceTurn(undefined, {
      type: 'turn.accepted',
      identity: input.identity,
      at: input.snapshot.updatedAt,
    });
    current = applyCompatibilityState(current, pendingCompatibility.get(input.identity.chatId));
    pendingCompatibility.delete(input.identity.chatId);
  }
  const next = reduceTurn(current, {
    type: 'public.snapshot',
    at: input.snapshot.updatedAt,
    snapshot: input.snapshot,
  });
  return commit(next);
}

export function publishTurnError(
  identity: Pick<TurnIdentity, 'accountId' | 'runId'>,
  error: Readonly<ProviderErrorDetails>,
  at = Date.now(),
): CanonicalTurnState | undefined {
  return publishTurnEvent(identity, { type: 'provider.error', at, error });
}

export function clearTurnPublic(
  accountId: string,
  runId: string,
  at = Date.now(),
): CanonicalTurnState | undefined {
  return publishTurnEvent({ accountId, runId }, { type: 'public.cleared', at });
}

export function getTurn(accountId: string, runId: string): Readonly<CanonicalTurnState> | null {
  return byRun.get(runKey(accountId, runId)) ?? null;
}

export function getLatestTurn(
  accountId: string,
  chatId: string,
): Readonly<CanonicalTurnState> | null {
  const key = latestByChat.get(chatKey(accountId, chatId));
  return key ? (byRun.get(key) ?? null) : null;
}

export function getLatestTurnByChatId(chatId: string): Readonly<CanonicalTurnState> | null {
  const key = latestByChatId.get(chatId);
  return key ? (byRun.get(key) ?? null) : null;
}

export function hydrateLatestTurn(
  accountId: string,
  chatId: string,
): Readonly<CanonicalTurnState> | null {
  const existing = getLatestTurn(accountId, chatId);
  if (existing) return existing;
  const checkpoint = readTurnCheckpoint(accountId, chatId);
  if (!checkpoint) return null;
  const key = runKey(checkpoint.identity.accountId, checkpoint.identity.runId);
  // A saved preview may predate a supported move to another chat. Never
  // replace the retained incarnation or redirect its chat's current state.
  if (byRun.has(key)) return null;
  // A renderer restart cannot prove that an old provider/controller still owns
  // a nonterminal request. Never resurrect "Running" / "Thinking" forever.
  const restored = isTerminalTurnStatus(checkpoint.status)
    ? checkpoint
    : reduceTurn(checkpoint, {
        type: 'turn.interrupted',
        at: Date.now(),
        reason: 'restored_without_live_owner',
      });
  byRun.set(key, restored);
  latestByChat.set(chatKey(accountId, chatId), key);
  latestByChatId.set(chatId, key);
  if (restored !== checkpoint) writeTurnCheckpoint(restored);
  emit(restored);
  return restored;
}

export function subscribeTurnChatPriority(
  accountId: string,
  chatId: string,
  listener: Listener,
): () => void {
  const key = chatKey(accountId, chatId);
  let listeners = priorityChatListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    priorityChatListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0 && priorityChatListeners.get(key) === listeners) {
      priorityChatListeners.delete(key);
    }
  };
}

export function subscribeTurnChat(
  accountId: string,
  chatId: string,
  listener: Listener,
): () => void {
  const key = chatKey(accountId, chatId);
  let listeners = chatListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    chatListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0 && chatListeners.get(key) === listeners) {
      chatListeners.delete(key);
    }
  };
}

export function subscribeTurns(listener: Listener): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function publishCompatibilityRunState(input: {
  chatId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancellationKey?: string;
  errorCode?: string;
  at?: number;
}): void {
  const at = input.at ?? Date.now();
  const current = getLatestTurnByChatId(input.chatId);
  if (!current) {
    pendingCompatibility.set(
      input.chatId,
      Object.freeze({
        status: input.status,
        at,
        ...(input.cancellationKey ? { cancellationKey: input.cancellationKey } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      }),
    );
    return;
  }

  let event: Exclude<TurnEvent, { type: 'turn.accepted' }>;
  if (input.status === 'running') {
    event = {
      type: 'turn.running',
      at,
      ...(input.cancellationKey ? { cancellationKey: input.cancellationKey } : {}),
    };
  } else if (input.status === 'done') {
    event = { type: 'turn.completed', at };
  } else if (input.status === 'cancelled') {
    event = { type: 'turn.cancelled', at };
  } else {
    event = {
      type: 'turn.failed',
      at,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    };
  }

  const next = reduceTurn(current, event);
  if (next !== current) commit(next);
}

export function getCompatibilityRunState(chatId: string):
  | Readonly<{
      chatId: string;
      status: 'running' | 'done' | 'error' | 'cancelled';
      cancellationKey?: string;
      errorCode?: string;
    }>
  | undefined {
  const current = getLatestTurnByChatId(chatId);
  if (!current) {
    const pending = pendingCompatibility.get(chatId);
    return pending
      ? {
          chatId,
          status: pending.status,
          ...(pending.cancellationKey ? { cancellationKey: pending.cancellationKey } : {}),
          ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
        }
      : undefined;
  }
  const status =
    current.status === 'completed'
      ? 'done'
      : current.status === 'failed' || current.status === 'interrupted'
        ? 'error'
        : current.status === 'cancelled'
          ? 'cancelled'
          : 'running';
  return {
    chatId,
    status,
    ...(current.cancellationKey ? { cancellationKey: current.cancellationKey } : {}),
    ...(current.errorCode ? { errorCode: current.errorCode } : {}),
  };
}

export function clearTurn(accountId: string, runId: string): void {
  const key = runKey(accountId, runId);
  const current = byRun.get(key);
  if (!current) return;
  byRun.delete(key);
  const ckey = chatKey(current.identity.accountId, current.identity.chatId);
  if (latestByChat.get(ckey) === key || latestByChatId.get(current.identity.chatId) === key) {
    reindexLatestChat(current.identity.accountId, current.identity.chatId);
  }
  emit(current);
}

export function clearAccountPublicSnapshots(accountId: string, at = Date.now()): void {
  const changedChats = new Map<string, CanonicalTurnState>();
  for (const [key, state] of byRun) {
    if (state.identity.accountId !== accountId) continue;
    const next = reduceTurn(state, { type: 'public.cleared', at });
    if (next === state) continue;
    byRun.set(key, next);
    scheduleCheckpoint(next);
    changedChats.set(chatKey(accountId, next.identity.chatId), next);
  }
  for (const state of changedChats.values()) emit(state);
}

export function clearAccountTurns(accountId: string): void {
  const changedChats = new Map<string, CanonicalTurnState>();
  for (const [key, state] of byRun) {
    if (state.identity.accountId !== accountId) continue;
    byRun.delete(key);
    changedChats.set(chatKey(accountId, state.identity.chatId), state);
    const ckey = chatKey(accountId, state.identity.chatId);
    if (latestByChat.get(ckey) === key) latestByChat.delete(ckey);
    if (latestByChatId.get(state.identity.chatId) === key) {
      latestByChatId.delete(state.identity.chatId);
    }
  }
  for (const state of changedChats.values()) {
    reindexLatestChat(accountId, state.identity.chatId);
    emit(state);
  }
}

export function resetTurnStoreForTests(): void {
  if (typeof window !== 'undefined') {
    for (const timer of checkpointTimers.values()) window.clearTimeout(timer);
  }
  checkpointTimers.clear();
  byRun.clear();
  latestByChat.clear();
  latestByChatId.clear();
  pendingCompatibility.clear();
  priorityChatListeners.clear();
  chatListeners.clear();
  globalListeners.clear();
}
