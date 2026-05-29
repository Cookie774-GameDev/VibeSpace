/**
 * Live event subscriptions backed by Dexie. Re-renders whenever the events
 * table changes thanks to `dexie-react-hooks`.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { EventRow } from '@/types/event';
import type { WorkspaceId } from '@/types/common';

export interface UseEventsOptions {
  workspaceId: WorkspaceId | null;
  fromMs?: number;
  toMs?: number;
  /** Cap returned rows. Default: no cap. */
  limit?: number;
}

/**
 * Subscribe to events in a workspace, optionally bounded by [fromMs, toMs).
 * Always sorted ascending by start_at.
 */
export function useEvents(opts: UseEventsOptions): EventRow[] {
  const { workspaceId, fromMs, toMs, limit } = opts;
  return (
    useLiveQuery(async () => {
      if (!workspaceId) return [] as EventRow[];
      let rows: EventRow[];
      if (fromMs !== undefined && toMs !== undefined) {
        rows = await db.events
          .where('[workspace_id+start_at]')
          .between([workspaceId, fromMs], [workspaceId, toMs], true, false)
          .toArray();
      } else {
        rows = await db.events.where('workspace_id').equals(workspaceId).toArray();
      }
      rows.sort((a, b) => a.start_at - b.start_at);
      return limit ? rows.slice(0, limit) : rows;
    }, [workspaceId, fromMs, toMs, limit]) ?? []
  );
}

/**
 * Convenience — upcoming events from `now` for the next `windowMs`.
 * Default window = 7 days.
 */
export function useUpcomingEvents(
  workspaceId: WorkspaceId | null,
  windowMs = 7 * 24 * 60 * 60 * 1000,
  limit = 25,
): EventRow[] {
  const now = Date.now();
  return useEvents({
    workspaceId,
    fromMs: now,
    toMs: now + windowMs,
    limit,
  });
}
