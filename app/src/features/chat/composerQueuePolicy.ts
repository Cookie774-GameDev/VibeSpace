/**
 * Pure queue policy for composer follow-up messages.
 * Keeps Enter (after-tool) vs Tab (after-run) decisions out of Composer.tsx.
 */

export type QueueFlushMode = 'after-tool' | 'after-run';

export interface QueuedChatMessage {
  id: string;
  text: string;
  createdAt: number;
  /** When this item should leave the queue and hit the model. */
  flushMode: QueueFlushMode;
}

export type ToolActivityStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'error';

export function createQueuedMessage(
  text: string,
  flushMode: QueueFlushMode,
  now = Date.now(),
  id?: string,
): QueuedChatMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    id: id ?? `queued_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    createdAt: now,
    flushMode,
  };
}

/** Terminal run statuses that release after-run (and leftover after-tool) items. */
export function shouldAutoSendQueuedOnRunStatus(status: string | undefined): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

/**
 * After-tool heads flush when a tool finishes (terminal status), not when a new tool starts.
 */
export function shouldFlushOnToolTerminal(
  head: QueuedChatMessage | null | undefined,
  toolStatus: ToolActivityStatus | string | undefined,
): boolean {
  if (!head || head.flushMode !== 'after-tool') return false;
  return toolStatus === 'done' || toolStatus === 'error' || toolStatus === 'cancelled';
}

/** Run-end flush applies to every head (after-run preferred; after-tool still drains). */
export function shouldFlushOnRunStatus(
  head: QueuedChatMessage | null | undefined,
  status: string | undefined,
): boolean {
  if (!head) return false;
  return shouldAutoSendQueuedOnRunStatus(status);
}

export function describeQueueToast(flushMode: QueueFlushMode): { title: string; body: string } {
  if (flushMode === 'after-tool') {
    return {
      title: 'Message queued',
      body: 'It will send after the current tool finishes (Enter). Esc sends now · Esc×3 cancels the run.',
    };
  }
  return {
    title: 'Message queued',
    body: 'It will send when this reply fully finishes (Tab). Esc sends now · Esc×3 cancels the run.',
  };
}

export function queueFlushModeLabel(flushMode: QueueFlushMode): string {
  return flushMode === 'after-tool' ? 'After tool' : 'After run';
}

export function takeNextQueuedMessage(queue: QueuedChatMessage[]): {
  next: QueuedChatMessage | null;
  remaining: QueuedChatMessage[];
} {
  if (!queue.length) return { next: null, remaining: queue };
  const [next, ...remaining] = queue;
  return { next: next ?? null, remaining };
}
