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
import type { TerminalRef } from './terminalRefs';

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
      /** Optional friendly label shown on the pane chrome. */
      label?: string;
      /**
       * Optional working directory. Fresh panes pass this straight to
       * the PTY spawn command; broadcasts keep the current pane cwd.
       */
      cwd?: string;
      /** Open a new pane, send to all panes, or send to specific terminal refs. */
      target?: 'new' | 'all' | 'refs';
      /** Stable terminal refs captured from drag/drop or scheduled chat actions. */
      refs?: TerminalRef[];
    }
  | {
      kind: 'swarm';
      /** Stable id. */
      id: string;
    };

interface TerminalCommandQueueState {
  queue: TerminalCommand[];

  /** Append a shell command; returns the assigned id. */
  enqueue: (
    cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind'>,
  ) => string;

  /** Append a swarm-preset request; returns the assigned id. */
  requestSwarm: () => string;

  /**
   * Drain everything currently queued and return it. Resets the queue
   * to empty. Idempotent on subsequent calls.
   */
  drain: () => TerminalCommand[];

  /** Clear without returning. Used on TerminalsPage unmount as a
   *  defensive cleanup (anything still in the queue is stale). */
  clear: () => void;
}

let nextId = 1;
function newId(prefix: string): string {
  // Date-based seed so the id is sortable + unique across reloads in
  // the same second. The counter prevents collisions inside the same
  // millisecond when an action queues several commands at once.
  return `${prefix}_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

export const useTerminalCommandQueue = create<TerminalCommandQueueState>(
  (set, get) => ({
    queue: [],
    enqueue: (cmd) => {
      const id = newId('tcmd');
      const next: TerminalCommand = { kind: 'shell', id, ...cmd };
      set((s) => ({ queue: [...s.queue, next] }));
      return id;
    },
    requestSwarm: () => {
      const id = newId('tswm');
      set((s) => ({ queue: [...s.queue, { kind: 'swarm', id }] }));
      return id;
    },
    drain: () => {
      const items = get().queue;
      if (items.length === 0) return items;
      set({ queue: [] });
      return items;
    },
    clear: () => set({ queue: [] }),
  }),
);

/** Convenience for non-React callers (the action runner). */
export function enqueueTerminalCommand(
  cmd: Omit<Extract<TerminalCommand, { kind: 'shell' }>, 'id' | 'kind'>,
): string {
  return useTerminalCommandQueue.getState().enqueue(cmd);
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
