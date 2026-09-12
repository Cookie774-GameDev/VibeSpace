/**
 * Terminal command queue — bridges the action runner to TerminalsPage.
 *
 * Why a queue rather than a direct call: TerminalsPage owns its pane
 * tree as React-local state and may not be mounted when an action
 * runner wants to launch a command. The user might be on the chat
 * page, Jarvis proposes "open Claude Code in a new pane", the user
 * approves — we need to navigate to the Terminals route AND inject
 * the command, but the route component is lazy-loaded and won't exist
 * for a few hundred milliseconds while its chunk fetches.
 *
 * Lifecycle:
 *   1. The action runner enqueues a `TerminalCommand` (`shell` or
 *      `swarm`) and switches the route to 'terminal'.
 *   2. React commits the route change. The lazy chunk loads.
 *   3. TerminalsPage mounts and subscribes to this store. Its first
 *      effect drains every queued item — appending panes for `shell`
 *      items and replacing the tree with the swarm preset for `swarm`
 *      items, in arrival order.
 *   4. Subsequent enqueues while the page is mounted re-trigger the
 *      subscription, draining new items in arrival order.
 *
 * The discriminated union (rather than a separate "swarm pending"
 * flag) keeps ordering crisp: if a future flow does
 * `enqueue(claude); requestSwarm()`, the swarm runs *after* the claude
 * pane is appended, not before — the user sees what they asked for in
 * the order they asked for it.
 */

import { create } from 'zustand';
import type {
  JarvisQueuedCancellationIdentity,
  JarvisQueuedCancellationQueueAuthority,
  JarvisQueuedCancellationTombstoneV1,
} from '@/lib/jarvis/executionJournal/abortRegistry';
import type { TerminalRef } from './terminalRefs';
import type { TerminalFleetSelection } from './terminalFleet';
import { MAX_PANES } from './paneTree';

export const MAX_TERMINAL_FLEET_BATCH_SIZE = MAX_PANES;
export const MAX_TERMINAL_FLEET_STAGGER_DELAY_MS = 5_000;

export interface TerminalFleetRequestInput {
  targetTotal: number;
  selection: TerminalFleetSelection;
  batchSize?: number;
  staggerDelayMs?: number;
}

export type CanonicalTerminalCommandBinding = Readonly<{
  accountId: string;
  runId: string;
  executionId: string;
  ownerId: string;
  cancellationToken: string;
}>;

/**
 * Queue item. Discriminated union so a single drain() call can deliver
 * mixed work to the page in order.
 */
export type TerminalCommand =
  | {
      kind: 'shell';
      /** Stable id; sortable, dedupable. */
      id: string;
      /** Shell command line to run in the new pane. */
      command: string;
      /** Ordered commands written after the fresh shell is ready. */
      startupCommands?: string[];
      /** Refuse to evict any existing project terminal at native capacity. */
      preserveExisting?: boolean;
      /** Optional friendly label shown on the pane chrome. */
      label?: string;
      /**
       * Agent role slug for the new pane. Distinct from `label`: the slug
       * drives AGENTS.md briefing delivery and env vars, the label is only
       * chrome text. Orchestrated batches set both.
       */
      agentSlug?: string;
      /**
       * Optional working directory. Fresh panes pass this straight to
       * the PTY spawn command; broadcasts keep the current pane cwd.
       */
      cwd?: string;
      /** Open a new pane, send to all panes, or send to specific terminal refs. */
      target?: 'new' | 'all' | 'refs';
      /** Stable terminal refs captured from drag/drop or scheduled chat actions. */
      refs?: TerminalRef[];
      /** Canonical kernel-owned queue identity. Authority handles never enter this record. */
      canonical?: CanonicalTerminalCommandBinding;
    }
  | {
      kind: 'swarm';
      /** Stable id. */
      id: string;
    }
  | {
      kind: 'close';
      /** Stable id. */
      id: string;
      /** How many of the most-recently-added panes to close. Clamped 1–10. */
      count: number;
    }
  | {
      kind: 'fleet';
      id: string;
      requestId: string;
      targetTotal: number;
      selection: TerminalFleetSelection;
      batchSize: number;
      staggerDelayMs: number;
    };

interface TerminalCommandQueueState {
  queue: TerminalCommand[];

  /** Append a shell command; returns the assigned id. */
  enqueue: (cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind'>) => string;

  /** Insert one already-identified canonical item after its queue owner is registered. */
  enqueueCanonical: (
    cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind' | 'canonical'> &
      CanonicalTerminalCommandBinding,
  ) => string;

  /** Append a swarm-preset request; returns the assigned id. */
  requestSwarm: () => string;

  /** Append a close request for the N most-recent panes; returns the assigned id. */
  requestClose: (count: number) => string;

  /** Append one bounded target-total Fleet transaction. */
  requestFleet: (input: TerminalFleetRequestInput) => string;

  activeFleetRequestIds: string[];
  cancelledFleetRequestIds: string[];
  isFleetCancelled: (id: string) => boolean;
  completeFleet: (id: string) => void;

  /**
   * Drain everything currently queued and return it. Resets the queue
   * to empty. Idempotent on subsequent calls.
   */
  drain: () => TerminalCommand[];

  /** Remove one command before the terminal page drains it. */
  cancel: (id: string) => boolean;

  /** Clear without returning. Used on TerminalsPage unmount as a
   *  defensive cleanup (anything still in the queue is stale). */
  clear: () => void;
}

let nextId = 1;
const claimedCanonicalIds = new Set<string>();
const itemLocks = new Map<string, Promise<void>>();
const cancellationTombstones = new Map<
  string,
  { tombstone: JarvisQueuedCancellationTombstoneV1; original: TerminalCommand }
>();
const DURABLE_QUEUE_STATE_PREFIX = 'jarvis.terminal.queue-state.v1:';

type DurableCanonicalTerminalQueueStateV1 = Readonly<{
  schemaVersion: 1;
  kind: 'canonical_terminal_queue_state';
  state: 'runnable' | 'tombstone' | 'claimed';
  runnable: boolean;
  accountId: string;
  runId: string;
  queueItemId: string;
  executionId: string;
}>;

function durableQueueStateKey(accountId: string, executionId: string): string {
  return `${DURABLE_QUEUE_STATE_PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(executionId)}`;
}

function durableStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new TypeError('Durable terminal queue storage is unavailable.');
  }
  return window.localStorage;
}

function durableQueueState(
  identity: Pick<
    JarvisQueuedCancellationIdentity,
    'accountId' | 'runId' | 'queueItemId' | 'executionId'
  >,
  state: DurableCanonicalTerminalQueueStateV1['state'],
): DurableCanonicalTerminalQueueStateV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'canonical_terminal_queue_state',
    state,
    runnable: state === 'runnable',
    accountId: identity.accountId,
    runId: identity.runId,
    queueItemId: identity.queueItemId,
    executionId: identity.executionId,
  });
}

function readDurableQueueState(
  accountId: string,
  executionId: string,
): DurableCanonicalTerminalQueueStateV1 | null {
  const raw = durableStorage().getItem(durableQueueStateKey(accountId, executionId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as DurableCanonicalTerminalQueueStateV1;
    if (
      value?.schemaVersion !== 1 ||
      value.kind !== 'canonical_terminal_queue_state' ||
      !['runnable', 'tombstone', 'claimed'].includes(value.state) ||
      value.runnable !== (value.state === 'runnable') ||
      value.accountId !== accountId ||
      value.executionId !== executionId ||
      !value.runId ||
      value.queueItemId !== executionId
    ) {
      return null;
    }
    return Object.freeze({ ...value });
  } catch {
    return null;
  }
}

function durableQueueStateExists(accountId: string, executionId: string): boolean {
  return durableStorage().getItem(durableQueueStateKey(accountId, executionId)) !== null;
}

function writeDurableQueueState(state: DurableCanonicalTerminalQueueStateV1): void {
  const storage = durableStorage();
  const key = durableQueueStateKey(state.accountId, state.executionId);
  const serialized = JSON.stringify(state);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new TypeError('Durable terminal queue state readback failed.');
  }
}

function exactDurableQueueState(
  state: DurableCanonicalTerminalQueueStateV1 | null,
  identity: Pick<
    JarvisQueuedCancellationIdentity,
    'accountId' | 'runId' | 'queueItemId' | 'executionId'
  >,
  expected: DurableCanonicalTerminalQueueStateV1['state'],
): boolean {
  return (
    state?.state === expected &&
    state.accountId === identity.accountId &&
    state.runId === identity.runId &&
    state.queueItemId === identity.queueItemId &&
    state.executionId === identity.executionId
  );
}

export function readTerminalCommandQueueDurableStateForTests(
  accountId: string,
  executionId: string,
): DurableCanonicalTerminalQueueStateV1 | null {
  return readDurableQueueState(accountId, executionId);
}

export function resetTerminalCommandQueueDurabilityForTests(): void {
  const storage = durableStorage();
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(DURABLE_QUEUE_STATE_PREFIX)) storage.removeItem(key);
  }
}

function newId(prefix: string): string {
  // Date-based seed so the id is sortable + unique across reloads in
  // the same second. The counter prevents collisions inside the same
  // millisecond when an action queues several commands at once.
  return `${prefix}_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

function stableIdentifier(value: string, label: string): string {
  if (!value || value !== value.trim() || value.includes('\u0000')) {
    throw new TypeError(`${label} must be a stable nonblank identifier.`);
  }
  return value;
}

function lockKey(identity: JarvisQueuedCancellationIdentity): string {
  return `${identity.accountId}\u0000${identity.runId}\u0000${identity.queueItemId}`;
}

async function withItemLock<T>(
  identity: JarvisQueuedCancellationIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const key = lockKey(identity);
  const previous = itemLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  itemLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (itemLocks.get(key) === current) itemLocks.delete(key);
  }
}

function exactCanonicalItem(
  item: TerminalCommand,
  identity: JarvisQueuedCancellationIdentity,
): item is Extract<TerminalCommand, { kind: 'shell' }> & {
  canonical: CanonicalTerminalCommandBinding;
} {
  return (
    item.kind === 'shell' &&
    item.id === identity.queueItemId &&
    item.canonical?.accountId === identity.accountId &&
    item.canonical.runId === identity.runId &&
    item.canonical.executionId === identity.executionId
  );
}

function exactTombstone(
  left: JarvisQueuedCancellationTombstoneV1,
  right: JarvisQueuedCancellationTombstoneV1,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.runnable === right.runnable &&
    left.accountId === right.accountId &&
    left.runId === right.runId &&
    left.queueItemId === right.queueItemId &&
    left.executionId === right.executionId
  );
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export const useTerminalCommandQueue = create<TerminalCommandQueueState>((set, get) => ({
  queue: [],
  activeFleetRequestIds: [],
  cancelledFleetRequestIds: [],
  enqueue: (cmd) => {
    const id = newId('tcmd');
    const next: TerminalCommand = {
      kind: 'shell',
      id,
      ...cmd,
      ...(cmd.startupCommands === undefined
        ? {}
        : { startupCommands: cmd.startupCommands.slice(0, 3) }),
      ...(cmd.preserveExisting ? { preserveExisting: true } : {}),
    };
    set((s) => ({ queue: [...s.queue, next] }));
    return id;
  },
  enqueueCanonical: (cmd) => {
    const accountId = stableIdentifier(cmd.accountId, 'accountId');
    const runId = stableIdentifier(cmd.runId, 'runId');
    const executionId = stableIdentifier(cmd.executionId, 'executionId');
    const ownerId = stableIdentifier(cmd.ownerId, 'ownerId');
    const cancellationToken = stableIdentifier(cmd.cancellationToken, 'cancellationToken');
    if (
      get().queue.some((item) => item.id === executionId) ||
      cancellationTombstones.has(executionId) ||
      claimedCanonicalIds.has(executionId) ||
      durableQueueStateExists(accountId, executionId)
    ) {
      throw new TypeError('Canonical terminal execution id is already owned.');
    }
    const next: TerminalCommand = {
      kind: 'shell',
      id: executionId,
      command: cmd.command,
      ...(cmd.startupCommands === undefined
        ? {}
        : { startupCommands: cmd.startupCommands.slice(0, 3) }),
      ...(cmd.preserveExisting ? { preserveExisting: true } : {}),
      ...(cmd.label === undefined ? {} : { label: cmd.label }),
      ...(cmd.agentSlug === undefined ? {} : { agentSlug: cmd.agentSlug }),
      ...(cmd.cwd === undefined ? {} : { cwd: cmd.cwd }),
      ...(cmd.target === undefined ? {} : { target: cmd.target }),
      ...(cmd.refs === undefined ? {} : { refs: [...cmd.refs] }),
      canonical: Object.freeze({ accountId, runId, executionId, ownerId, cancellationToken }),
    };
    writeDurableQueueState(
      durableQueueState({ accountId, runId, queueItemId: executionId, executionId }, 'runnable'),
    );
    set((state) => ({ queue: [...state.queue, next] }));
    return executionId;
  },
  requestSwarm: () => {
    const id = newId('tswm');
    set((s) => ({ queue: [...s.queue, { kind: 'swarm', id }] }));
    return id;
  },
  requestClose: (count) => {
    const id = newId('tcls');
    const clamped = Math.min(10, Math.max(1, Math.floor(count)));
    set((s) => ({ queue: [...s.queue, { kind: 'close', id, count: clamped }] }));
    return id;
  },
  requestFleet: (input) => {
    const id = newId('tflt');
    const next: TerminalCommand = {
      kind: 'fleet',
      id,
      requestId: id,
      targetTotal: boundedInteger(input.targetTotal, 1, MAX_PANES),
      selection: input.selection,
      batchSize: boundedInteger(
        input.batchSize ?? MAX_TERMINAL_FLEET_BATCH_SIZE,
        1,
        MAX_TERMINAL_FLEET_BATCH_SIZE,
      ),
      staggerDelayMs: boundedInteger(
        input.staggerDelayMs ?? 0,
        0,
        MAX_TERMINAL_FLEET_STAGGER_DELAY_MS,
      ),
    };
    set((state) => ({
      queue: [...state.queue, next],
      activeFleetRequestIds: [...new Set([...state.activeFleetRequestIds, id])],
    }));
    return id;
  },
  isFleetCancelled: (id) => get().cancelledFleetRequestIds.includes(id),
  completeFleet: (id) => {
    set((state) => ({
      activeFleetRequestIds: state.activeFleetRequestIds.filter((item) => item !== id),
      cancelledFleetRequestIds: state.cancelledFleetRequestIds.filter((item) => item !== id),
    }));
  },
  drain: () => {
    const current = get().queue;
    if (current.length === 0) return current;
    const items = current.filter((item) => item.kind !== 'shell' || !item.canonical);
    if (items.length === 0) return [];
    const ids = new Set(items.map((item) => item.id));
    set({ queue: current.filter((item) => !ids.has(item.id)) });
    return items;
  },
  cancel: (id) => {
    const current = get().queue;
    const item = current.find((candidate) => candidate.id === id);
    if (!item || (item.kind === 'shell' && item.canonical)) return false;
    set((state) => ({
      queue: current.filter((entry) => entry.id !== id),
      cancelledFleetRequestIds:
        item.kind === 'fleet'
          ? [...new Set([...state.cancelledFleetRequestIds, item.requestId])]
          : state.cancelledFleetRequestIds,
    }));
    return true;
  },
  clear: () => {
    claimedCanonicalIds.clear();
    cancellationTombstones.clear();
    itemLocks.clear();
    set({ queue: [], activeFleetRequestIds: [], cancelledFleetRequestIds: [] });
  },
}));

/** Convenience for non-React callers (the action runner). */
export function requestTerminalFleet(input: TerminalFleetRequestInput): string {
  return useTerminalCommandQueue.getState().requestFleet(input);
}

export function isTerminalFleetRequestCancelled(id: string): boolean {
  return useTerminalCommandQueue.getState().isFleetCancelled(id);
}

export function enqueueTerminalCommand(
  cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind'>,
): string {
  return useTerminalCommandQueue.getState().enqueue(cmd);
}

export function enqueueCanonicalTerminalCommand(
  cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind' | 'canonical'> &
    CanonicalTerminalCommandBinding,
): string {
  return useTerminalCommandQueue.getState().enqueueCanonical(cmd);
}

/**
 * Claim every currently visible item in arrival order. Canonical items remain
 * runnable until their private controller handoff succeeds under the same
 * exact-item lock used by queued cancellation.
 */
export async function claimTerminalCommands(
  claimCanonical: (
    item: Extract<TerminalCommand, { kind: 'shell' }> & {
      canonical: CanonicalTerminalCommandBinding;
    },
    priorClaimedItems: readonly TerminalCommand[],
  ) => Promise<boolean>,
): Promise<TerminalCommand[]> {
  const ids = useTerminalCommandQueue.getState().queue.map((item) => item.id);
  const claimed: TerminalCommand[] = [];
  for (const id of ids) {
    const initial = useTerminalCommandQueue.getState().queue.find((item) => item.id === id);
    if (!initial) continue;
    if (initial.kind !== 'shell' || !initial.canonical) {
      useTerminalCommandQueue.setState((state) => ({
        queue: state.queue.filter((item) => item.id !== id),
      }));
      claimed.push(initial);
      continue;
    }
    const identity: JarvisQueuedCancellationIdentity = {
      accountId: initial.canonical.accountId,
      runId: initial.canonical.runId,
      queueItemId: initial.id,
      executionId: initial.canonical.executionId,
      ownerId: `terminal:${initial.canonical.executionId}`,
    };
    let blocked = false;
    const item = await withItemLock(identity, async () => {
      const current = useTerminalCommandQueue
        .getState()
        .queue.find((candidate) => candidate.id === id);
      if (!current || !exactCanonicalItem(current, identity)) return null;
      if (cancellationTombstones.has(id)) {
        blocked = true;
        return null;
      }
      if (!(await claimCanonical(current, Object.freeze([...claimed])))) {
        blocked = true;
        return null;
      }
      try {
        writeDurableQueueState(durableQueueState(identity, 'claimed'));
      } catch {
        blocked = true;
        return null;
      }
      claimedCanonicalIds.add(current.id);
      useTerminalCommandQueue.setState((state) => ({
        queue: state.queue.filter((candidate) => candidate.id !== current.id),
      }));
      return current;
    });
    if (item) claimed.push(item);
    if (blocked) break;
  }
  return claimed;
}

export const jarvisTerminalCommandQueueAuthority: JarvisQueuedCancellationQueueAuthority = {
  withExclusiveItemLock: withItemLock,
  async replaceExactRunnableWithTombstone({ identity, tombstone }) {
    const queue = useTerminalCommandQueue.getState().queue;
    const index = queue.findIndex((item) => item.id === identity.queueItemId);
    if (index < 0) {
      return {
        applied: false,
        reason: cancellationTombstones.has(identity.queueItemId)
          ? 'tombstone_conflict'
          : 'claimed_or_drained',
        handoffProven: claimedCanonicalIds.has(identity.queueItemId),
      };
    }
    const original = queue[index]!;
    if (cancellationTombstones.has(identity.queueItemId)) {
      return { applied: false, reason: 'tombstone_conflict', handoffProven: false };
    }
    if (!exactCanonicalItem(original, identity)) {
      return { applied: false, reason: 'exact_item_mismatch', handoffProven: false };
    }
    if (
      tombstone.accountId !== identity.accountId ||
      tombstone.runId !== identity.runId ||
      tombstone.queueItemId !== identity.queueItemId ||
      tombstone.executionId !== identity.executionId
    ) {
      return { applied: false, reason: 'exact_item_mismatch', handoffProven: false };
    }
    const durable = readDurableQueueState(identity.accountId, identity.executionId);
    if (!exactDurableQueueState(durable, identity, 'runnable')) {
      return { applied: false, reason: 'exact_item_mismatch', handoffProven: false };
    }
    writeDurableQueueState(durableQueueState(identity, 'tombstone'));
    cancellationTombstones.set(identity.queueItemId, { tombstone, original });
    return { applied: true, tombstone };
  },
  async restoreExactRunnable(tombstone) {
    const record = cancellationTombstones.get(tombstone.queueItemId);
    if (!record || !exactTombstone(record.tombstone, tombstone)) return false;
    const queue = useTerminalCommandQueue.getState().queue;
    if (!queue.includes(record.original)) return false;
    try {
      writeDurableQueueState(
        durableQueueState(
          {
            accountId: tombstone.accountId,
            runId: tombstone.runId,
            queueItemId: tombstone.queueItemId,
            executionId: tombstone.executionId,
          },
          'runnable',
        ),
      );
    } catch {
      return false;
    }
    cancellationTombstones.delete(tombstone.queueItemId);
    claimedCanonicalIds.delete(tombstone.queueItemId);
    useTerminalCommandQueue.setState({ queue: [...queue] });
    return true;
  },
};

export function commitCanonicalTerminalCancellation(queueItemId: string): boolean {
  const record = cancellationTombstones.get(queueItemId);
  if (!record) return false;
  const queue = useTerminalCommandQueue.getState().queue;
  if (!queue.includes(record.original)) return false;
  let durable: DurableCanonicalTerminalQueueStateV1 | null;
  try {
    durable = readDurableQueueState(record.tombstone.accountId, record.tombstone.executionId);
  } catch {
    return false;
  }
  if (!exactDurableQueueState(durable, record.tombstone, 'tombstone')) return false;
  cancellationTombstones.delete(queueItemId);
  claimedCanonicalIds.delete(queueItemId);
  useTerminalCommandQueue.setState({ queue: queue.filter((item) => item !== record.original) });
  return true;
}

export function cancelQueuedTerminalCommand(id: string): boolean {
  return useTerminalCommandQueue.getState().cancel(id);
}

/** Send a command to every live terminal pane. */
export function broadcastTerminalCommand(
  cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind' | 'target'>,
): string {
  return useTerminalCommandQueue.getState().enqueue({ ...cmd, target: 'all' });
}

/** Convenience for non-React callers — enqueue a swarm-preset request. */
export function requestTerminalSwarm(): string {
  return useTerminalCommandQueue.getState().requestSwarm();
}

/** Close the N most-recently-added terminal panes. */
export function enqueueTerminalClose(count: number): string {
  return useTerminalCommandQueue.getState().requestClose(count);
}
